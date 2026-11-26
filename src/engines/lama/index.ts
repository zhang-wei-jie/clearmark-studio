/**
 * 浏览器端 LaMa AI 高清去水印引擎统一入口
 *
 * 协调 IndexedDB 模型缓存、多源流式下载/本地导入、独立 Web Worker ONNX 推理会话生命周期：
 * - 现代浏览器优先在独立 ES Module Web Worker 中运行（Worker 内直接读取 IndexedDB 208 MB 权重、
 *   优先 WebGPU 并在异常时后台透明回退至 WASM，全程不阻塞主线程 UI）；
 * - 取消推理或释放显存时立即终止 Worker 并以 AbortError 解锁串行队列，杜绝假死与死锁；
 * - 当运行环境不支持 Web Worker（如 Vitest/jsdom 或受限环境）时，自动优雅降级至主线程执行。
 */

import type {
  InpaintInput,
  InpaintOutput,
  InpaintProgress,
  LamaModelSource,
  LamaModelStatus,
} from '../../types';
import {
  DEFAULT_FEATHER_PX,
  checkWebGpuSupport,
  createImageDataCompat,
  createLamaSessionFromBuffer,
  executeLamaInpaint,
  type ActiveLamaSession,
  type LamaBackend,
} from './lamaInference';
import {
  deleteModelFromCache,
  getCacheStorageInfo,
  getCachedModelMeta,
  loadModelFromCache,
  saveModelToCache,
  type CacheStorageInfo,
} from './modelCache';
import {
  DEFAULT_LAMA_SOURCES,
  LamaModelError,
  downloadModel,
  importLocalModelFile,
  validateOnnxModelBuffer,
  type ModelDownloadProgress,
} from './modelManager';
import type { LamaWorkerRequest, LamaWorkerResponse } from './worker';

export {
  DEFAULT_LAMA_SOURCES,
  LamaModelError,
  checkWebGpuSupport,
  getCacheStorageInfo,
  validateOnnxModelBuffer,
};
export type { CacheStorageInfo, LamaBackend, ModelDownloadProgress };

/** 下载 LaMa 模型的可选参数 */
export interface DownloadLamaModelOptions {
  /** 自定义展示来源名称（推荐使用） */
  sourceLabel?: string;
  /** 来源名称兼容别名 */
  label?: string;
  /** 外部取消信号 */
  signal?: AbortSignal;
  /** 流式下载进度回调 */
  onProgress?: (progress: ModelDownloadProgress) => void;
}

/** 加载推理会话的可选参数 */
export interface EnsureLamaSessionOptions {
  onProgress?: (progress: InpaintProgress) => void;
  signal?: AbortSignal;
}

/** 执行 LaMa AI 修复的可选参数 */
export interface RunLamaInpaintOptions {
  onProgress?: (progress: InpaintProgress) => void;
  signal?: AbortSignal;
}

type StatusListener = (status: LamaModelStatus) => void;

const DISPOSE_GRACEFUL_TIMEOUT_MS = 800;

let currentStatus: LamaModelStatus = { state: 'unloaded' };
const listeners = new Set<StatusListener>();

// Worker 模式运行态句柄
let activeWorker: Worker | null = null;
let activeWorkerSessionInfo: { backend: LamaBackend; inputSize: number } | null = null;
let activeJobDisposeAbort: (() => void) | null = null;
let nextWorkerTaskId = 1;

// 无 Worker 环境主线程降级态句柄
let activeMainSession: ActiveLamaSession | null = null;
let mainSessionLoadingPromise: Promise<ActiveLamaSession> | null = null;

/** 单调递增代数：防止在加载/回落期间被 dispose 或替换模型后把过期会话挂回内存 */
let sessionGeneration = 0;

/** 当前活跃下载控制器（用于支持取消下载与防止重复并发下载） */
let activeDownloadController: AbortController | null = null;

/** 推理与会话加载串行队列：单 Worker / 单 ORT 会话不可并发执行 */
let inferenceQueue: Promise<unknown> = Promise.resolve();

function createAbortError(message = '已取消 AI 去水印任务。'): Error {
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'AbortError');
  }
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function updateStatus(next: LamaModelStatus): LamaModelStatus {
  currentStatus = { ...next };
  for (const listener of listeners) {
    try {
      listener(currentStatus);
    } catch {
      // 单个订阅者异常不影响其余 UI 订阅者同步状态
    }
  }
  return currentStatus;
}

function getActiveBackend(): LamaBackend | undefined {
  if (activeWorker && activeWorkerSessionInfo) {
    return activeWorkerSessionInfo.backend;
  }
  return activeMainSession?.backend;
}

function terminateLamaWorker(): void {
  activeWorkerSessionInfo = null;
  if (activeWorker) {
    try {
      activeWorker.terminate();
    } catch {
      // 忽略已终止 Worker 异常
    }
    activeWorker = null;
  }
}

/** 检测并懒创建 LaMa ES Module Web Worker；环境不支持时返回 null 以优雅降级至主线程 */
function getOrCreateLamaWorker(): Worker | null {
  if (activeWorker) {
    return activeWorker;
  }
  if (typeof Worker !== 'function') {
    return null;
  }
  try {
    activeWorker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    return activeWorker;
  } catch {
    return null;
  }
}

async function restoreStatusFromCacheMeta(generationSnapshot: number): Promise<void> {
  if (getLamaModelStatus().state === 'downloading') {
    return;
  }
  const meta = await getCachedModelMeta().catch(() => null);
  if (generationSnapshot !== sessionGeneration || getLamaModelStatus().state === 'downloading') {
    return;
  }
  if (meta) {
    updateStatus({
      state: 'cached',
      cachedSource: meta.sourceLabel,
      cachedSizeBytes: meta.sizeBytes,
    });
  } else {
    updateStatus({ state: 'unloaded' });
  }
}

/** 向 LaMa Worker 派发单次串行任务，内置取消信号、释放防死锁与异常收口 */
function sendWorkerJob(
  worker: Worker,
  req: LamaWorkerRequest,
  transfer: Transferable[],
  options: {
    signal?: AbortSignal;
    onProgress?: (msg: Extract<LamaWorkerResponse, { type: 'progress' }>) => void;
    cachedSourceHint?: string;
    cachedSizeHint?: number;
  } = {},
): Promise<LamaWorkerResponse> {
  const { signal, onProgress, cachedSourceHint, cachedSizeHint } = options;
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise<LamaWorkerResponse>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (activeJobDisposeAbort === onDispose) {
        activeJobDisposeAbort = null;
      }
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      signal?.removeEventListener('abort', onAbort);
    };

    const failAndReset = (err: Error, mode: 'abort' | 'no-cache' | 'error') => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateLamaWorker();

      if (mode === 'abort') {
        const fallbackSource = cachedSourceHint ?? currentStatus.cachedSource;
        const fallbackSize = cachedSizeHint ?? currentStatus.cachedSizeBytes;
        if (currentStatus.state !== 'downloading') {
          if (fallbackSource || fallbackSize) {
            updateStatus({
              state: 'cached',
              cachedSource: fallbackSource,
              cachedSizeBytes: fallbackSize,
            });
          } else {
            updateStatus({ state: 'unloaded' });
          }
        }
      } else if (mode === 'no-cache') {
        updateStatus({ state: 'unloaded', error: err.message });
      } else {
        updateStatus({
          state: 'error',
          cachedSource: cachedSourceHint ?? currentStatus.cachedSource,
          cachedSizeBytes: cachedSizeHint ?? currentStatus.cachedSizeBytes,
          error: err.message,
        });
      }
      reject(err);
    };

    const onAbort = () => {
      failAndReset(createAbortError('已取消 AI 去水印任务。'), 'abort');
    };

    const onDispose = () => {
      failAndReset(createAbortError('已释放 LaMa 推理会话，当前任务已中断。'), 'abort');
    };

    activeJobDisposeAbort = onDispose;
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onerror = (ev: ErrorEvent) => {
      failAndReset(
        new Error(ev.message || 'LaMa AI 推理后台线程运行异常，请释放显存后重试。'),
        'error',
      );
    };

    worker.onmessageerror = () => {
      failAndReset(new Error('读取 LaMa AI 推理结果失败，请重试。'), 'error');
    };

    worker.onmessage = (event: MessageEvent<LamaWorkerResponse>) => {
      const data = event.data;
      if (!data || data.taskId !== req.taskId) return;

      if (data.type === 'progress') {
        if (data.phase === 'loading') {
          updateStatus({
            state: 'loading',
            progress: data.percent,
            backend: data.backend ?? currentStatus.backend,
            cachedSource: cachedSourceHint ?? currentStatus.cachedSource,
            cachedSizeBytes: cachedSizeHint ?? currentStatus.cachedSizeBytes,
          });
        }
        onProgress?.(data);
        return;
      }

      if (data.type === 'error') {
        failAndReset(new Error(data.message), data.code === 'NO_CACHE' ? 'no-cache' : 'error');
        return;
      }

      if (settled) return;
      settled = true;
      cleanup();

      if (data.type === 'session-ready' || data.type === 'inpaint-result') {
        activeWorkerSessionInfo = {
          backend: data.backend,
          inputSize: data.inputSize,
        };
        updateStatus({
          state: 'ready',
          progress: 100,
          backend: data.backend,
          cachedSource: data.cachedSource || cachedSourceHint || currentStatus.cachedSource,
          cachedSizeBytes: data.cachedSizeBytes || cachedSizeHint || currentStatus.cachedSizeBytes,
        });
      }

      resolve(data);
    };

    try {
      worker.postMessage(req, transfer);
    } catch {
      failAndReset(new Error('向 LaMa AI 后台线程发送图像数据失败，请重试。'), 'error');
    }
  });
}

/** 获取当前 LaMa 模型状态快照 */
export function getLamaModelStatus(): LamaModelStatus {
  return { ...currentStatus };
}

/** 订阅 LaMa 模型状态变更，返回取消订阅函数 */
export function subscribeLamaStatus(listener: StatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 启动时初始化检测 IndexedDB 中的模型缓存状态
 * 不会把 208MB 权重读入内存，仅读取轻量元信息。
 */
export async function initLamaModelStatus(): Promise<LamaModelStatus> {
  // 若当前正在下载或加载会话，保留进行中的状态避免覆盖
  if (currentStatus.state === 'downloading' || currentStatus.state === 'loading') {
    return getLamaModelStatus();
  }

  try {
    const meta = await getCachedModelMeta();
    const activeBackend = getActiveBackend();
    if (activeBackend) {
      return updateStatus({
        state: 'ready',
        backend: activeBackend,
        cachedSource: meta?.sourceLabel ?? currentStatus.cachedSource,
        cachedSizeBytes: meta?.sizeBytes ?? currentStatus.cachedSizeBytes,
      });
    }
    if (meta) {
      return updateStatus({
        state: 'cached',
        cachedSource: meta.sourceLabel,
        cachedSizeBytes: meta.sizeBytes,
      });
    }
    return updateStatus({ state: 'unloaded' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '检查本地模型缓存状态失败。';
    return updateStatus({
      state: 'unloaded',
      error: message,
    });
  }
}

/** 取消当前正在进行的模型下载（如无进行中下载则静默无操作） */
export function cancelLamaDownload(): void {
  if (activeDownloadController) {
    activeDownloadController.abort();
  }
}

/** 解析调用方传入的模型源参数（支持源对象、源 ID、自定义 URL 或省略使用默认国内镜像源） */
function resolveDownloadTarget(
  sourceOrUrl?: LamaModelSource | string,
  customLabel?: string,
): { url: string; label: string } {
  if (!sourceOrUrl) {
    const defaultSource = DEFAULT_LAMA_SOURCES[0];
    return { url: defaultSource.url, label: defaultSource.label };
  }
  if (typeof sourceOrUrl !== 'string') {
    return { url: sourceOrUrl.url, label: customLabel ?? sourceOrUrl.label };
  }
  const matchedSource = DEFAULT_LAMA_SOURCES.find(
    (source) => source.id === sourceOrUrl || source.url === sourceOrUrl,
  );
  if (matchedSource) {
    return { url: matchedSource.url, label: customLabel ?? matchedSource.label };
  }
  return {
    url: sourceOrUrl,
    label: customLabel ?? '自定义下载源',
  };
}

/**
 * 从内置镜像源或自定义 URL 流式下载 LaMa ONNX 模型并持久化到 IndexedDB
 */
export async function downloadLamaModel(
  sourceOrUrl?: LamaModelSource | string,
  options: DownloadLamaModelOptions = {},
): Promise<LamaModelStatus> {
  // 若存在正在进行的旧下载，先中止并接管控制权，支持用户中途切换镜像源
  if (activeDownloadController) {
    activeDownloadController.abort();
    activeDownloadController = null;
  }

  const target = resolveDownloadTarget(sourceOrUrl, options.sourceLabel ?? options.label);
  const previousCacheMeta = await getCachedModelMeta().catch(() => null);

  const controller = new AbortController();
  activeDownloadController = controller;

  const isCurrentDownload = () => activeDownloadController === controller;

  const onExternalAbort = () => {
    controller.abort();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      if (isCurrentDownload()) {
        activeDownloadController = null;
      }
      throw new LamaModelError('ABORTED', '已取消模型下载。');
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  updateStatus({
    state: 'downloading',
    progress: 0,
    loadedBytes: 0,
    totalBytes: undefined,
    cachedSource: previousCacheMeta?.sourceLabel,
    cachedSizeBytes: previousCacheMeta?.sizeBytes,
  });

  try {
    const buffer = await downloadModel(target.url, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (!isCurrentDownload()) {
          return;
        }
        updateStatus({
          state: 'downloading',
          progress: progress.percent ?? 0,
          loadedBytes: progress.loadedBytes,
          totalBytes: progress.totalBytes,
          cachedSource: previousCacheMeta?.sourceLabel,
          cachedSizeBytes: previousCacheMeta?.sizeBytes,
        });
        options.onProgress?.(progress);
      },
    });

    if (!isCurrentDownload() || controller.signal.aborted) {
      throw new LamaModelError('ABORTED', '已取消模型下载。');
    }

    // 写入新权重前释放旧会话，确保下次推理加载最新模型
    await disposeLamaSession();

    // 二次校验取消状态，防止 dispose 期间触发清空缓存/新下载后旧下载误写回
    if (!isCurrentDownload() || controller.signal.aborted) {
      throw new LamaModelError('ABORTED', '已取消模型下载。');
    }

    const savedMeta = await saveModelToCache({
      buffer,
      sourceLabel: target.label,
      sourceUrl: target.url,
    });

    return updateStatus({
      state: 'cached',
      progress: 100,
      loadedBytes: savedMeta.sizeBytes,
      totalBytes: savedMeta.sizeBytes,
      cachedSource: savedMeta.sourceLabel,
      cachedSizeBytes: savedMeta.sizeBytes,
    });
  } catch (error) {
    // 若已被更新一次的下载任务接管，不覆盖新任务的下载状态
    if (!isCurrentDownload()) {
      throw error;
    }

    if (error instanceof LamaModelError && error.code === 'ABORTED') {
      const activeBackend = getActiveBackend();
      if (activeBackend && previousCacheMeta) {
        updateStatus({
          state: 'ready',
          backend: activeBackend,
          cachedSource: previousCacheMeta.sourceLabel,
          cachedSizeBytes: previousCacheMeta.sizeBytes,
        });
      } else if (previousCacheMeta) {
        updateStatus({
          state: 'cached',
          cachedSource: previousCacheMeta.sourceLabel,
          cachedSizeBytes: previousCacheMeta.sizeBytes,
        });
      } else {
        updateStatus({ state: 'unloaded' });
      }
      throw error;
    }

    const message = error instanceof Error ? error.message : '模型下载失败，请稍后重试。';
    updateStatus({
      state: 'error',
      cachedSource: previousCacheMeta?.sourceLabel,
      cachedSizeBytes: previousCacheMeta?.sizeBytes,
      error: message,
    });
    throw error;
  } finally {
    if (options.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
    if (activeDownloadController === controller) {
      activeDownloadController = null;
    }
  }
}

/**
 * 导入本地 .onnx 模型文件并持久化到 IndexedDB
 */
export async function importLocalLamaModel(file: File): Promise<LamaModelStatus> {
  // 导入前先取消可能正在进行的在线下载，避免旧下载完成后覆盖刚导入的本地模型
  cancelLamaDownload();
  const previousCacheMeta = await getCachedModelMeta().catch(() => null);
  try {
    const savedMeta = await importLocalModelFile(file);
    // 导入成功后释放旧推理会话，让下次推理使用新模型
    await disposeLamaSession();
    return updateStatus({
      state: 'cached',
      cachedSource: savedMeta.sourceLabel,
      cachedSizeBytes: savedMeta.sizeBytes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '本地模型文件导入失败。';
    updateStatus({
      state: 'error',
      cachedSource: previousCacheMeta?.sourceLabel,
      cachedSizeBytes: previousCacheMeta?.sizeBytes,
      error: message,
    });
    throw error;
  }
}

/**
 * 释放推理会话并清空 IndexedDB 中缓存的 LaMa 模型
 * 先删除持久化缓存再中断/释放会话，防止队列中排队的任务在释放瞬间抢先读回旧缓存重建会话。
 */
export async function clearLamaModelCache(): Promise<LamaModelStatus> {
  cancelLamaDownload();
  await deleteModelFromCache();
  await disposeLamaSession();
  return updateStatus({ state: 'unloaded' });
}

/**
 * 释放当前常驻内存/显存的 ONNX 推理会话与后台 Worker
 * 若存在进行中的 Worker 任务，立即终止 Worker 并以 AbortError 解锁串行队列，杜绝死锁。
 */
export async function disposeLamaSession(): Promise<void> {
  sessionGeneration += 1;
  const generationSnapshot = sessionGeneration;
  mainSessionLoadingPromise = null;

  const abortRunning = activeJobDisposeAbort;
  activeJobDisposeAbort = null;

  if (abortRunning) {
    abortRunning();
  } else if (activeWorker) {
    const workerToClose = activeWorker;
    activeWorker = null;
    activeWorkerSessionInfo = null;
    const taskId = nextWorkerTaskId++;

    // 先通知 Worker 释放 WebGPU 显存会话，超时后强制 terminate 归还全部 WASM 线性内存
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        workerToClose.onmessage = null;
        workerToClose.onerror = null;
        try {
          workerToClose.terminate();
        } catch {
          // 忽略已终止 Worker 异常
        }
        resolve();
      };
      const timer = setTimeout(finish, DISPOSE_GRACEFUL_TIMEOUT_MS);
      workerToClose.onmessage = (event: MessageEvent<LamaWorkerResponse>) => {
        if (event.data && event.data.taskId === taskId) {
          finish();
        }
      };
      workerToClose.onerror = finish;
      try {
        workerToClose.postMessage({ type: 'dispose', taskId } satisfies LamaWorkerRequest);
      } catch {
        finish();
      }
    });
  }

  const mainSessionToRelease = activeMainSession;
  activeMainSession = null;
  if (mainSessionToRelease) {
    try {
      await mainSessionToRelease.session.release();
    } catch {
      // 忽略底层会话已释放时的重复释放报错
    }
  }

  await restoreStatusFromCacheMeta(generationSnapshot);
}

/** 无 Worker 环境主线程降级：加载推理会话（支持并发合并与过期释放保护） */
async function ensureMainThreadSessionInternal(
  options?: EnsureLamaSessionOptions,
): Promise<ActiveLamaSession> {
  if (options?.signal?.aborted) {
    throw createAbortError();
  }
  if (activeMainSession) {
    return activeMainSession;
  }

  if (mainSessionLoadingPromise) {
    const loaded = await mainSessionLoadingPromise;
    if (options?.signal?.aborted) {
      throw createAbortError();
    }
    return loaded;
  }

  const generation = sessionGeneration;
  const loadTask = (async () => {
    const cachedRecord = await loadModelFromCache();
    if (!cachedRecord) {
      const msg =
        '尚未下载或导入 LaMa AI 模型，请先在「AI 模型管理」中下载模型或导入本地 .onnx 文件。';
      updateStatus({ state: 'unloaded', error: msg });
      throw new Error(msg);
    }

    updateStatus({
      state: 'loading',
      progress: 10,
      cachedSource: cachedRecord.sourceLabel,
      cachedSizeBytes: cachedRecord.sizeBytes,
    });
    options?.onProgress?.({
      stage: '正在初始化 LaMa 神经网络推理会话（优先 WebGPU）...',
      percent: 10,
    });

    const created = await createLamaSessionFromBuffer(cachedRecord.buffer);

    // 若加载期间发生了 dispose 或替换模型，立即释放过期会话防止显存泄漏
    if (generation !== sessionGeneration) {
      await created.session.release().catch(() => undefined);
      throw new Error('模型会话加载已取消。');
    }

    activeMainSession = created;
    updateStatus({
      state: 'ready',
      progress: 100,
      backend: created.backend,
      cachedSource: cachedRecord.sourceLabel,
      cachedSizeBytes: cachedRecord.sizeBytes,
    });

    return created;
  })();

  mainSessionLoadingPromise = loadTask;

  try {
    return await loadTask;
  } catch (error) {
    if (generation === sessionGeneration && currentStatus.state === 'loading') {
      const meta = await getCachedModelMeta().catch(() => null);
      const message = error instanceof Error ? error.message : '加载 LaMa 模型会话失败。';
      updateStatus({
        state: 'error',
        cachedSource: meta?.sourceLabel,
        cachedSizeBytes: meta?.sizeBytes,
        error: message,
      });
    }
    throw error;
  } finally {
    if (mainSessionLoadingPromise === loadTask) {
      mainSessionLoadingPromise = null;
    }
  }
}

/**
 * 确保 LaMa ONNX 推理会话已加载就绪，返回实际执行后端与模型输入尺寸
 */
export async function ensureLamaSessionLoaded(
  options?: EnsureLamaSessionOptions,
): Promise<{ backend: LamaBackend; inputSize: number }> {
  const runTask = async (): Promise<{ backend: LamaBackend; inputSize: number }> => {
    if (options?.signal?.aborted) {
      throw createAbortError();
    }

    if (activeWorker && activeWorkerSessionInfo) {
      return { ...activeWorkerSessionInfo };
    }

    if (typeof Worker === 'function') {
      const generation = sessionGeneration;
      const cachedMeta = await getCachedModelMeta().catch(() => null);
      if (options?.signal?.aborted || generation !== sessionGeneration) {
        throw createAbortError();
      }

      const worker = getOrCreateLamaWorker();
      if (worker) {
        updateStatus({
          state: 'loading',
          progress: 5,
          cachedSource: cachedMeta?.sourceLabel ?? currentStatus.cachedSource,
          cachedSizeBytes: cachedMeta?.sizeBytes ?? currentStatus.cachedSizeBytes,
        });

        const taskId = nextWorkerTaskId++;
        const reply = await sendWorkerJob(
          worker,
          { type: 'ensure-session', taskId, preferWebGpu: true },
          [],
          {
            signal: options?.signal,
            cachedSourceHint: cachedMeta?.sourceLabel,
            cachedSizeHint: cachedMeta?.sizeBytes,
            onProgress: (p) => {
              options?.onProgress?.({ stage: p.stage, percent: p.percent });
            },
          },
        );

        if (reply.type !== 'session-ready') {
          throw new Error('LaMa 后台线程初始化会话返回异常结果。');
        }
        return {
          backend: reply.backend,
          inputSize: reply.inputSize,
        };
      }
    }

    const session = await ensureMainThreadSessionInternal(options);
    return {
      backend: session.backend,
      inputSize: session.io.inputSize,
    };
  };

  const queued = inferenceQueue.then(runTask, runTask);
  inferenceQueue = queued.catch(() => undefined);
  return queued;
}

/**
 * 执行 LaMa AI 高清去水印修复
 *
 * 特性：
 * - 优先在独立 Web Worker 中加载会话并执行预填、分簇推理与羽化回贴，不阻塞主线程 UI；
 * - 串行排队执行防止单会话并发冲突，取消或释放时立即终止 Worker 并解锁队列；
 * - 若 WebGPU 运行期遇到显卡/着色器异常，自动重建 WASM 会话完成安全回退；
 * - 保持大图原始分辨率，非遮罩区域 100% 像素无损。
 */
export async function runLamaInpaint(
  input: InpaintInput,
  options: RunLamaInpaintOptions = {},
): Promise<InpaintOutput> {
  const runTask = async (): Promise<InpaintOutput> => {
    if (options.signal?.aborted) {
      throw createAbortError();
    }

    const { imageData, mask, featherPx = DEFAULT_FEATHER_PX, matchedMarks } = input;
    const { width, height, data } = imageData;
    const expectedLen = width * height;
    if (mask.length !== expectedLen) {
      throw new Error(
        `遮罩尺寸与图像不匹配（图像 ${width}×${height} 需 ${expectedLen} 字节，实际遮罩 ${mask.length} 字节）。`,
      );
    }

    if (typeof Worker === 'function') {
      const generation = sessionGeneration;
      const cachedMeta = await getCachedModelMeta().catch(() => null);
      if (options.signal?.aborted || generation !== sessionGeneration) {
        throw createAbortError();
      }

      const worker = getOrCreateLamaWorker();
      if (worker) {
        const imageCopy = new Uint8ClampedArray(new ArrayBuffer(data.byteLength));
        imageCopy.set(data);
        const maskCopy = new Uint8Array(new ArrayBuffer(mask.byteLength));
        maskCopy.set(mask);

        const taskId = nextWorkerTaskId++;
        const reply = await sendWorkerJob(
          worker,
          {
            type: 'inpaint',
            taskId,
            width,
            height,
            imageBuffer: imageCopy.buffer,
            maskBuffer: maskCopy.buffer,
            featherPx,
            matchedMarks,
            preferWebGpu: true,
          },
          [imageCopy.buffer, maskCopy.buffer],
          {
            signal: options.signal,
            cachedSourceHint: cachedMeta?.sourceLabel,
            cachedSizeHint: cachedMeta?.sizeBytes,
            onProgress: (p) => {
              options.onProgress?.({ stage: p.stage, percent: p.percent });
            },
          },
        );

        if (reply.type !== 'inpaint-result') {
          throw new Error('LaMa 后台线程推理返回异常结果。');
        }

        return {
          imageData: createImageDataCompat(
            new Uint8ClampedArray(reply.imageBuffer),
            reply.width,
            reply.height,
          ),
          durationMs: reply.durationMs,
          backend: reply.backend,
        };
      }
    }

    // 无 Web Worker 环境自动降级至主线程执行
    const session = await ensureMainThreadSessionInternal({
      onProgress: options.onProgress,
      signal: options.signal,
    });

    if (options.signal?.aborted) {
      throw createAbortError();
    }

    try {
      return await executeLamaInpaint(session, input, options);
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }

      if (session.backend === 'webgpu') {
        const cachedRecord = await loadModelFromCache();
        if (options.signal?.aborted) {
          throw createAbortError();
        }
        if (cachedRecord) {
          options.onProgress?.({
            stage: 'WebGPU 推理受限，正在自动切换至 WASM 后端继续修复...',
            percent: 45,
          });
          await disposeLamaSession();
          const generation = sessionGeneration;
          let wasmSession: ActiveLamaSession;
          try {
            wasmSession = await createLamaSessionFromBuffer(cachedRecord.buffer, {
              preferWebGpu: false,
            });
          } catch (wasmErr) {
            const msg = wasmErr instanceof Error ? wasmErr.message : '回退至 WASM 推理会话失败。';
            updateStatus({
              state: 'error',
              cachedSource: cachedRecord.sourceLabel,
              cachedSizeBytes: cachedRecord.sizeBytes,
              error: msg,
            });
            throw wasmErr;
          }
          if (generation !== sessionGeneration) {
            await wasmSession.session.release().catch(() => undefined);
            throw new Error('模型会话已被释放，任务中断。');
          }
          activeMainSession = wasmSession;
          updateStatus({
            state: 'ready',
            backend: 'wasm',
            cachedSource: cachedRecord.sourceLabel,
            cachedSizeBytes: cachedRecord.sizeBytes,
          });
          if (options.signal?.aborted) {
            throw createAbortError();
          }
          return await executeLamaInpaint(wasmSession, input, options);
        }
      }

      throw error;
    }
  };

  const queued = inferenceQueue.then(runTask, runTask);
  inferenceQueue = queued.catch(() => undefined);
  return queued;
}
