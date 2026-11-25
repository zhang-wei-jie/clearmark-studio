/**
 * 纯前端零下载快速去水印引擎统一入口
 *
 * 优先在独立 Web Worker 中执行像素修补、模板角落水印探测与框内智能抠笔画；
 * 当运行环境不支持模块 Worker（如 Vitest/jsdom 或受限 WebView）时，自动优雅降级为主线程异步执行。
 */

import type {
  CornerDetectionResult,
  DetectSensitivity,
  InpaintInput,
  InpaintOutput,
  InpaintProgress,
  StrokeRefineResult,
} from '../../types';
import { detectCornerWatermark } from './autoDetect';
import { createAbortError, createImageDataSafe, inpaintFastAsync } from './inpaintCore';
import { refineMaskToStrokes } from './strokeRefine';
import type { FastWorkerRequest, FastWorkerResponse } from './worker';

/** 快速去水印调用可选参数 */
export interface RunFastInpaintOptions {
  /** 实时进度回调 */
  onProgress?: (progress: InpaintProgress) => void;
  /** 用于取消进行中任务的 AbortSignal */
  signal?: AbortSignal;
}

type PendingResult = InpaintOutput | CornerDetectionResult | StrokeRefineResult;

interface PendingTask {
  kind: 'inpaint' | 'detect' | 'refine-mask';
  onProgress?: (progress: InpaintProgress) => void;
  resolve: (value: PendingResult) => void;
  reject: (reason: Error) => void;
  cleanupAbort?: () => void;
}

let sharedWorker: Worker | null = null;
let workerUnavailable = false;
let nextTaskId = 1;
const pendingTasks = new Map<number, PendingTask>();

/** 检测并懒创建模块 Web Worker；创建失败时标记降级，不重复尝试 */
function getOrCreateWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (sharedWorker) return sharedWorker;
  if (typeof Worker === 'undefined') {
    workerUnavailable = true;
    return null;
  }

  try {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<FastWorkerResponse>) => {
      handleWorkerMessage(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      const msg = event.message || '快速去水印 Worker 运行出错';
      failAllPendingTasks(new Error(msg));
      disposeFastWorker();
      workerUnavailable = true;
    };
    sharedWorker = worker;
    return sharedWorker;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

function handleWorkerMessage(msg: FastWorkerResponse): void {
  const task = pendingTasks.get(msg.taskId);
  if (!task) return;

  if (msg.type === 'progress') {
    task.onProgress?.({ stage: msg.stage, percent: msg.percent });
    return;
  }

  pendingTasks.delete(msg.taskId);
  task.cleanupAbort?.();

  if (msg.type === 'error') {
    task.reject(msg.aborted ? createAbortError(msg.message) : new Error(msg.message));
    return;
  }

  if (msg.type === 'inpaint-result') {
    const imageData = createImageDataSafe(
      new Uint8ClampedArray(msg.imageBuffer),
      msg.width,
      msg.height,
    );
    task.resolve({
      imageData,
      durationMs: msg.durationMs,
      backend: 'fast-worker',
    });
    return;
  }

  if (msg.type === 'detect-result') {
    const result: CornerDetectionResult = {
      detected: msg.detected,
      corner: msg.corner,
      rect: msg.rect,
      confidence: msg.confidence,
      mask: msg.maskBuffer ? new Uint8Array(msg.maskBuffer) : undefined,
      matches: msg.matches,
      method: msg.method,
      message: msg.message,
    };
    task.resolve(result);
    return;
  }

  if (msg.type === 'refine-mask-result') {
    const result: StrokeRefineResult = {
      refined: msg.refined,
      mask: new Uint8Array(msg.maskBuffer),
      matchedMarks: msg.matchedMarks,
      message: msg.message,
    };
    task.resolve(result);
  }
}

function failAllPendingTasks(error: Error): void {
  for (const [id, task] of pendingTasks.entries()) {
    pendingTasks.delete(id);
    task.cleanupAbort?.();
    task.reject(error);
  }
}

/** 主动释放后台 Worker 实例 */
export function disposeFastWorker(): void {
  if (sharedWorker) {
    sharedWorker.terminate();
    sharedWorker = null;
  }
}

/**
 * 运行纯前端零下载快速去水印引擎。
 */
export async function runFastInpaint(
  input: InpaintInput,
  options: RunFastInpaintOptions = {},
): Promise<InpaintOutput> {
  const { imageData, mask, quality = 'standard', featherPx = 3, matchedMarks } = input;
  const { onProgress, signal } = options;

  if (signal?.aborted) {
    throw createAbortError();
  }

  const expectedLen = imageData.width * imageData.height;
  if (mask.length !== expectedLen) {
    throw new Error(
      `遮罩尺寸与图像不匹配：期望 ${expectedLen} 像素（${imageData.width}×${imageData.height}），实际为 ${mask.length}。`,
    );
  }

  const worker = getOrCreateWorker();
  if (worker) {
    return new Promise<InpaintOutput>((resolve, reject) => {
      const taskId = nextTaskId++;
      const imageCopy = new Uint8ClampedArray(imageData.data);
      const maskCopy = new Uint8Array(mask);

      const onAbort = () => {
        const active = pendingTasks.get(taskId);
        if (!active) return;
        pendingTasks.delete(taskId);
        active.cleanupAbort?.();
        const cancelMsg: FastWorkerRequest = { type: 'cancel', taskId };
        worker.postMessage(cancelMsg);
        reject(createAbortError());
      };

      const cleanupAbort = signal
        ? () => {
            signal.removeEventListener('abort', onAbort);
          }
        : undefined;

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      pendingTasks.set(taskId, {
        kind: 'inpaint',
        onProgress,
        resolve: resolve as (v: PendingResult) => void,
        reject,
        cleanupAbort,
      });

      const request: FastWorkerRequest = {
        type: 'inpaint',
        taskId,
        width: imageData.width,
        height: imageData.height,
        imageBuffer: imageCopy.buffer,
        maskBuffer: maskCopy.buffer,
        quality,
        featherPx,
        matchedMarks,
      };
      worker.postMessage(request, [imageCopy.buffer, maskCopy.buffer]);
    });
  }

  const result = await inpaintFastAsync(
    imageData,
    mask,
    {
      quality,
      featherPx,
      matchedMarks,
      shouldAbort: () => Boolean(signal?.aborted),
      onProgress: onProgress
        ? (stage, percent) => {
            onProgress({ stage, percent });
          }
        : undefined,
    },
    16,
  );

  return {
    imageData: result.imageData,
    durationMs: result.durationMs,
    backend: 'fast-main',
  };
}

/**
 * 运行智能角落水印自动检测（精准平台模板优先 + 通用 Top-Hat 兜底）。
 */
export async function runCornerAutoDetect(
  imageData: ImageData,
  sensitivity: DetectSensitivity = 'medium',
): Promise<CornerDetectionResult> {
  const worker = getOrCreateWorker();
  if (worker) {
    return new Promise<CornerDetectionResult>((resolve, reject) => {
      const taskId = nextTaskId++;
      const imageCopy = new Uint8ClampedArray(imageData.data);

      pendingTasks.set(taskId, {
        kind: 'detect',
        resolve: resolve as (v: PendingResult) => void,
        reject,
      });

      const request: FastWorkerRequest = {
        type: 'detect',
        taskId,
        width: imageData.width,
        height: imageData.height,
        imageBuffer: imageCopy.buffer,
        sensitivity,
      };
      worker.postMessage(request, [imageCopy.buffer]);
    });
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return detectCornerWatermark(imageData, sensitivity);
}

/**
 * 运行选区智能紧贴笔画优化（将实心矩形或粗涂抹自动收缩为紧贴文字笔画的细遮罩）。
 */
export async function runMaskStrokeRefine(
  imageData: ImageData,
  mask: Uint8Array,
): Promise<StrokeRefineResult> {
  const worker = getOrCreateWorker();
  if (worker) {
    return new Promise<StrokeRefineResult>((resolve, reject) => {
      const taskId = nextTaskId++;
      const imageCopy = new Uint8ClampedArray(imageData.data);
      const maskCopy = new Uint8Array(mask);

      pendingTasks.set(taskId, {
        kind: 'refine-mask',
        resolve: resolve as (v: PendingResult) => void,
        reject,
      });

      const request: FastWorkerRequest = {
        type: 'refine-mask',
        taskId,
        width: imageData.width,
        height: imageData.height,
        imageBuffer: imageCopy.buffer,
        maskBuffer: maskCopy.buffer,
      };
      worker.postMessage(request, [imageCopy.buffer, maskCopy.buffer]);
    });
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return refineMaskToStrokes(imageData, mask);
}

export { detectCornerWatermark } from './autoDetect';
export { findMaskClusters, inpaintFastAsync } from './inpaintCore';
export { refineMaskToStrokes } from './strokeRefine';
export type { FastInpaintCoreOptions, FastInpaintCoreResult } from './inpaintCore';
