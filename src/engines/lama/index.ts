/**
 * 浏览器端 LaMa AI 高清去水印引擎统一入口
 *
 * 协调 IndexedDB 模型缓存、多源流式下载/本地导入、ONNX Runtime Web 会话生命周期，
 * 并向全局状态管理（useAppStore）与模型管理弹窗提供可订阅的状态快照。
 */

import type {
  InpaintInput,
  InpaintOutput,
  InpaintProgress,
  LamaModelSource,
  LamaModelStatus,
} from '../../types';
import {
  createLamaSessionFromBuffer,
  executeLamaInpaint,
  checkWebGpuSupport,
  type ActiveLamaSession,
  type LamaBackend,
} from './lamaInference';
import {
  deleteModelFromCache,
  getCachedModelMeta,
  getCacheStorageInfo,
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
}

/** 执行 LaMa AI 修复的可选参数 */
export interface RunLamaInpaintOptions {
  onProgress?: (progress: InpaintProgress) => void;
  signal?: AbortSignal;
}

type StatusListener = (status: LamaModelStatus) => void;

let currentStatus: LamaModelStatus = { state: 'unloaded' };
const listeners = new Set<StatusListener>();

let activeSession: ActiveLamaSession | null = null;
let sessionLoadingPromise: Promise<ActiveLamaSession> | null = null;
/** 单调递增代数：防止在加载过程中被 dispose/清缓存 后把过期会话挂回内存 */
let sessionGeneration = 0;

/** 当前活跃下载控制器（用于支持取消下载与防止重复并发下载） */
let activeDownloadController: AbortController | null = null;

/** 推理串行队列：ONNX Runtime Web 单会话不可并发执行 session.run() */
let inferenceQueue: Promise<unknown> = Promise.resolve();

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
    if (activeSession) {
      return updateStatus({
        state: 'ready',
        backend: activeSession.backend,
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
      // 用户主动取消：恢复为取消前的可用状态，而非留在错误态
      if (activeSession && previousCacheMeta) {
        updateStatus({
          state: 'ready',
          backend: activeSession.backend,
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
 */
export async function clearLamaModelCache(): Promise<LamaModelStatus> {
  cancelLamaDownload();
  await disposeLamaSession();
  await deleteModelFromCache();
  return updateStatus({ state: 'unloaded' });
}

/**
 * 释放当前常驻内存/显存的 ONNX 推理会话，避免长时间使用产生泄漏
 */
export async function disposeLamaSession(): Promise<void> {
  sessionGeneration += 1;
  sessionLoadingPromise = null;

  const sessionToRelease = activeSession;
  activeSession = null;

  if (sessionToRelease) {
    try {
      await sessionToRelease.session.release();
    } catch {
      // 忽略底层会话已释放时的重复释放报错
    }
  }

  // 若未处于下载态，根据缓存是否存在回落状态
  if (currentStatus.state !== 'downloading') {
    const meta = await getCachedModelMeta().catch(() => null);
    if (meta) {
      updateStatus({
        state: 'cached',
        cachedSource: meta.sourceLabel,
        cachedSizeBytes: meta.sizeBytes,
      });
    } else if (currentStatus.state === 'ready' || currentStatus.state === 'loading') {
      updateStatus({ state: 'unloaded' });
    }
  }
}

/** 内部会话加载逻辑，支持并发合并与过期释放保护 */
async function ensureActiveSessionInternal(
  options?: EnsureLamaSessionOptions,
): Promise<ActiveLamaSession> {
  if (activeSession) {
    return activeSession;
  }

  if (sessionLoadingPromise) {
    return sessionLoadingPromise;
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

    activeSession = created;
    updateStatus({
      state: 'ready',
      progress: 100,
      backend: created.backend,
      cachedSource: cachedRecord.sourceLabel,
      cachedSizeBytes: cachedRecord.sizeBytes,
    });

    return created;
  })();

  sessionLoadingPromise = loadTask;

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
    if (sessionLoadingPromise === loadTask) {
      sessionLoadingPromise = null;
    }
  }
}

/**
 * 确保 LaMa ONNX 推理会话已加载就绪，返回实际执行后端与模型输入尺寸
 */
export async function ensureLamaSessionLoaded(
  options?: EnsureLamaSessionOptions,
): Promise<{ backend: LamaBackend; inputSize: number }> {
  const session = await ensureActiveSessionInternal(options);
  return {
    backend: session.backend,
    inputSize: session.io.inputSize,
  };
}

/**
 * 执行 LaMa AI 高清去水印修复
 *
 * 特性：
 * - 自动确保会话就绪（已缓存时自动加载）；
 * - 串行排队执行防止 ONNX Runtime Web 并发 run 冲突；
 * - 若 WebGPU 运行期遇到显卡/着色器异常，自动重建 WASM 会话完成安全回退；
 * - 保持大图原始分辨率，非遮罩区域 100% 像素无损。
 */
export async function runLamaInpaint(
  input: InpaintInput,
  options: RunLamaInpaintOptions = {},
): Promise<InpaintOutput> {
  const runTask = async (): Promise<InpaintOutput> => {
    if (options.signal?.aborted) {
      throw new DOMException('已取消 AI 去水印任务。', 'AbortError');
    }

    const session = await ensureActiveSessionInternal({ onProgress: options.onProgress });

    try {
      return await executeLamaInpaint(session, input, options);
    } catch (error) {
      // 用户主动取消直接透传，不触发后端回退
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }

      // 若在 WebGPU 实际推理阶段触发驱动/算子异常，安全回退重建 WASM 会话并重试一次
      if (session.backend === 'webgpu') {
        const cachedRecord = await loadModelFromCache();
        if (cachedRecord) {
          options.onProgress?.({
            stage: 'WebGPU 推理受限，正在自动切换至 WASM 后端继续修复...',
            percent: 45,
          });
          await disposeLamaSession();
          const generation = sessionGeneration;
          const wasmSession = await createLamaSessionFromBuffer(cachedRecord.buffer, {
            preferWebGpu: false,
          });
          if (generation !== sessionGeneration) {
            await wasmSession.session.release().catch(() => undefined);
            throw new Error('模型会话已被释放，任务中断。');
          }
          activeSession = wasmSession;
          updateStatus({
            state: 'ready',
            backend: 'wasm',
            cachedSource: cachedRecord.sourceLabel,
            cachedSizeBytes: cachedRecord.sizeBytes,
          });
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
