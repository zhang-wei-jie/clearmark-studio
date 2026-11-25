/**
 * 内置 MI-GAN 本地 AI 精修引擎统一入口
 *
 * 完整执行链路：
 * 1. 先运行零依赖轻量引擎（Telea + 拉普拉斯调和）预填遮罩区与透明通道，杜绝水印亮边渗色；
 * 2. 按连通选区分簇截取局部 512×512 上下文窗口（双角水印各自高分辨率独立推理）；
 * 3. 在独立 Web Worker 中按需加载并复用 28.1 MB MI-GAN ONNX 会话，全程不阻塞主线程；
 * 4. 仅将遮罩内 RGB 羽化回贴，原图非遮罩区 100% 字节级无损。
 */

import type {
  InpaintInput,
  InpaintOutput,
  InpaintProgress,
  MiganModelStatus,
} from '../../types';
import { createAbortError, createImageDataSafe, inpaintFastAsync } from '../fast/inpaintCore';
import {
  MIGAN_INPUT_SIZE,
  computeClusterCropWindows,
  prepareMiganInput,
  stitchMiganResultIntoOutput,
} from './miganUtils';
import type { MiganWorkerRequest, MiganWorkerResponse } from './worker';

export interface RunMiganInpaintOptions {
  onProgress?: (progress: InpaintProgress) => void;
  signal?: AbortSignal;
}

type StatusListener = (status: MiganModelStatus) => void;

const MIGAN_SIZE_BYTES = 28_079_181;

let currentStatus: MiganModelStatus = {
  state: 'idle',
  sizeBytes: MIGAN_SIZE_BYTES,
};
const listeners = new Set<StatusListener>();

let activeWorker: Worker | null = null;
let nextTaskId = 1;
let serialQueue: Promise<unknown> = Promise.resolve();

function updateStatus(next: MiganModelStatus): MiganModelStatus {
  currentStatus = { sizeBytes: MIGAN_SIZE_BYTES, ...next };
  for (const listener of listeners) {
    try {
      listener(currentStatus);
    } catch {
      // 忽略单个 UI 订阅者异常
    }
  }
  return currentStatus;
}

/** 获取当前 MI-GAN 模型状态快照 */
export function getMiganModelStatus(): MiganModelStatus {
  return { ...currentStatus };
}

/** 订阅 MI-GAN 模型状态变化 */
export function subscribeMiganStatus(listener: StatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getOrCreateMiganWorker(): Worker {
  if (activeWorker) return activeWorker;
  if (typeof Worker === 'undefined') {
    throw new Error('当前运行环境不支持 Web Worker，无法启动内置 MI-GAN AI 精修。');
  }
  activeWorker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return activeWorker;
}

function terminateMiganWorker(): void {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
}

/** 主动释放 MI-GAN Worker 及其占用的模型内存 */
export async function disposeMiganSession(): Promise<void> {
  terminateMiganWorker();
  updateStatus({ state: 'idle', sizeBytes: MIGAN_SIZE_BYTES });
}

function sendWorkerJob(
  req: MiganWorkerRequest,
  transfer: Transferable[],
  options: {
    signal?: AbortSignal;
    onProgress?: (msg: Extract<MiganWorkerResponse, { type: 'progress' }>) => void;
  } = {},
): Promise<MiganWorkerResponse> {
  const { signal, onProgress } = options;
  if (signal?.aborted) {
    return Promise.reject(createAbortError('已取消 MI-GAN 本地 AI 精修'));
  }

  const worker = getOrCreateMiganWorker();

  return new Promise<MiganWorkerResponse>((resolve, reject) => {
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      signal?.removeEventListener('abort', onAbort);
    };

    const failAndReset = (err: Error, isAbort = false) => {
      cleanup();
      terminateMiganWorker();
      if (isAbort) {
        updateStatus({ state: 'idle', sizeBytes: MIGAN_SIZE_BYTES });
      } else {
        updateStatus({ state: 'error', error: err.message, sizeBytes: MIGAN_SIZE_BYTES });
      }
      reject(err);
    };

    const onAbort = () => {
      failAndReset(createAbortError('已取消 MI-GAN 本地 AI 精修'), true);
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onerror = (ev: ErrorEvent) => {
      failAndReset(new Error(ev.message || '无法加载内置 MI-GAN AI 推理线程，请刷新页面后重试。'));
    };

    worker.onmessageerror = () => {
      failAndReset(new Error('读取 MI-GAN AI 推理结果失败，请重试。'));
    };

    worker.onmessage = (event: MessageEvent<MiganWorkerResponse>) => {
      const data = event.data;
      if (!data || data.taskId !== req.taskId) return;

      if (data.type === 'progress') {
        if (data.phase === 'loading') {
          updateStatus({
            state: 'loading',
            progress: data.percent,
            stage: data.stage,
            sizeBytes: MIGAN_SIZE_BYTES,
          });
        }
        onProgress?.(data);
        return;
      }

      if (data.type === 'error') {
        failAndReset(new Error(data.message));
        return;
      }

      cleanup();
      if (data.type === 'ready' || data.type === 'result') {
        updateStatus({
          state: 'ready',
          progress: 100,
          backend: 'wasm',
          sizeBytes: data.type === 'ready' ? data.sizeBytes : MIGAN_SIZE_BYTES,
        });
      }
      resolve(data);
    };

    try {
      worker.postMessage(req, transfer);
    } catch {
      failAndReset(new Error('向 MI-GAN AI 引擎发送图像数据失败，请重试。'));
    }
  });
}

/** 预加载内置 MI-GAN 模型会话（可选在模型管理弹窗中主动触发） */
export async function preloadMiganModel(signal?: AbortSignal): Promise<MiganModelStatus> {
  const run = async () => {
    if (currentStatus.state === 'ready' && activeWorker) {
      return getMiganModelStatus();
    }
    const taskId = nextTaskId++;
    updateStatus({
      state: 'loading',
      progress: 2,
      stage: '正在准备内置 MI-GAN 模型...',
      sizeBytes: MIGAN_SIZE_BYTES,
    });
    await sendWorkerJob({ type: 'preload', taskId }, [], { signal });
    return getMiganModelStatus();
  };

  const queued = serialQueue.then(run, run);
  serialQueue = queued.catch(() => undefined);
  return queued;
}

/**
 * 执行内置 MI-GAN 本地 AI 精修。
 */
export async function runMiganInpaint(
  input: InpaintInput,
  options: RunMiganInpaintOptions = {},
): Promise<InpaintOutput> {
  const task = async (): Promise<InpaintOutput> => {
    const startTime = performance.now();
    const { imageData, mask, featherPx = 2, matchedMarks } = input;
    const { onProgress, signal } = options;

    if (signal?.aborted) {
      throw createAbortError('已取消 MI-GAN 本地 AI 精修');
    }

    const { width, height, data } = imageData;
    const expectedLen = width * height;
    if (mask.length !== expectedLen) {
      throw new Error(
        `遮罩尺寸与图像不匹配：期望 ${expectedLen} 像素（${width}×${height}），实际为 ${mask.length}。`,
      );
    }

    const plans = computeClusterCropWindows(width, height, mask, MIGAN_INPUT_SIZE);
    if (plans.length === 0) {
      const copy = new Uint8ClampedArray(new ArrayBuffer(data.byteLength));
      copy.set(data);
      onProgress?.({ stage: '无有效遮罩选区，保持原图', percent: 100 });
      return {
        imageData: createImageDataSafe(copy, width, height),
        durationMs: Math.max(1, Math.round(performance.now() - startTime)),
        backend: 'migan-wasm',
      };
    }

    // 步骤 1：先用轻量引擎预填充遮罩像素及透明通道，防止水印高亮边缘渗色
    onProgress?.({ stage: '正在预平滑选区边缘...', percent: 8 });
    const prefillResult = await inpaintFastAsync(
      imageData,
      mask,
      {
        quality: 'standard',
        featherPx: 0,
        matchedMarks,
        shouldAbort: () => Boolean(signal?.aborted),
      },
      24,
    );
    const prefilledRgba = prefillResult.imageData.data;

    if (signal?.aborted) {
      throw createAbortError('已取消 MI-GAN 本地 AI 精修');
    }

    const outRgba = new Uint8ClampedArray(new ArrayBuffer(data.byteLength));
    outRgba.set(data);

    // 步骤 2：逐簇截取 512×512 上下文并送入独立 Worker 推理
    const clusterSpan = 74 / plans.length;
    for (let i = 0; i < plans.length; i++) {
      if (signal?.aborted) {
        throw createAbortError('已取消 MI-GAN 本地 AI 精修');
      }
      const plan = plans[i];
      const basePct = 18 + i * clusterSpan;
      const prefix = plans.length > 1 ? `[区域 ${i + 1}/${plans.length}] ` : '';

      onProgress?.({
        stage: `${prefix}正在准备 512×512 AI 上下文...`,
        percent: Math.round(basePct),
      });

      const { rgba512, mask512 } = prepareMiganInput(
        prefilledRgba,
        mask,
        width,
        plan.cropRect,
        MIGAN_INPUT_SIZE,
      );

      const taskId = nextTaskId++;
      const reply = await sendWorkerJob(
        {
          type: 'infer',
          taskId,
          width: MIGAN_INPUT_SIZE,
          height: MIGAN_INPUT_SIZE,
          rgbaBuffer: rgba512.buffer,
          maskBuffer: mask512.buffer,
        },
        [rgba512.buffer, mask512.buffer],
        {
          signal,
          onProgress: (p) => {
            const pct =
              p.phase === 'loading'
                ? Math.round(basePct + (p.percent / 100) * clusterSpan * 0.55)
                : Math.round(basePct + clusterSpan * 0.72);
            onProgress?.({ stage: p.phase === 'loading' ? p.stage : `${prefix}${p.stage}`, percent: pct });
          },
        },
      );

      if (reply.type !== 'result') {
        throw new Error('MI-GAN 推理返回异常结果');
      }

      onProgress?.({
        stage: `${prefix}正在无损回贴修复细节...`,
        percent: Math.round(basePct + clusterSpan * 0.92),
      });

      stitchMiganResultIntoOutput(
        outRgba,
        data,
        prefilledRgba,
        mask,
        width,
        plan.cropRect,
        new Uint8ClampedArray(reply.rgbaBuffer),
        MIGAN_INPUT_SIZE,
        featherPx,
      );
    }

    onProgress?.({ stage: 'AI 精修完成', percent: 100 });
    return {
      imageData: createImageDataSafe(outRgba, width, height),
      durationMs: Math.max(1, Math.round(performance.now() - startTime)),
      backend: 'migan-wasm',
    };
  };

  const queued = serialQueue.then(task, task);
  serialQueue = queued.catch(() => undefined);
  return queued;
}

export {
  MIGAN_INPUT_SIZE,
  computeClusterCropWindows,
  prepareMiganInput,
  stitchMiganResultIntoOutput,
} from './miganUtils';
