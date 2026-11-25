/**
 * 快速去水印、智能角落检测与框内智能抠笔画专用 Web Worker（Vite ES Module Worker）
 *
 * 通过 Transferable 传输像素与遮罩底层 ArrayBuffer，避免大图主线程拷贝卡顿；
 * 协作式支持 cancel 消息中断正在运行的修补任务，并实时回传进度事件。
 */

import type {
  CornerAnchor,
  DetectSensitivity,
  FastQuality,
  MatchedWatermark,
  PixelRect,
} from '../../types';
import { detectCornerWatermark } from './autoDetect';
import { createImageDataSafe, inpaintFastAsync } from './inpaintCore';
import { refineMaskToStrokes } from './strokeRefine';

export type FastWorkerRequest =
  | {
      type: 'inpaint';
      taskId: number;
      width: number;
      height: number;
      imageBuffer: ArrayBuffer;
      maskBuffer: ArrayBuffer;
      quality: FastQuality;
      featherPx: number;
      matchedMarks?: MatchedWatermark[];
    }
  | {
      type: 'detect';
      taskId: number;
      width: number;
      height: number;
      imageBuffer: ArrayBuffer;
      sensitivity: DetectSensitivity;
    }
  | {
      type: 'refine-mask';
      taskId: number;
      width: number;
      height: number;
      imageBuffer: ArrayBuffer;
      maskBuffer: ArrayBuffer;
    }
  | {
      type: 'cancel';
      taskId: number;
    };

export type FastWorkerResponse =
  | {
      type: 'progress';
      taskId: number;
      stage: string;
      percent: number;
    }
  | {
      type: 'inpaint-result';
      taskId: number;
      width: number;
      height: number;
      imageBuffer: ArrayBuffer;
      durationMs: number;
    }
  | {
      type: 'detect-result';
      taskId: number;
      detected: boolean;
      corner?: CornerAnchor;
      rect?: PixelRect;
      confidence: number;
      maskBuffer?: ArrayBuffer;
      matches?: MatchedWatermark[];
      method?: 'template' | 'generic';
      message: string;
    }
  | {
      type: 'refine-mask-result';
      taskId: number;
      refined: boolean;
      maskBuffer: ArrayBuffer;
      matchedMarks?: MatchedWatermark[];
      message: string;
    }
  | {
      type: 'error';
      taskId: number;
      aborted: boolean;
      message: string;
    };

interface DedicatedWorkerContextLike {
  onmessage: ((event: MessageEvent<FastWorkerRequest>) => void) | null;
  postMessage: (message: FastWorkerResponse, transfer?: Transferable[]) => void;
}

const workerSelf = self as unknown as DedicatedWorkerContextLike;

/** 记录已请求取消的任务 ID，供异步时间片内实时中止计算 */
const cancelledTaskIds = new Set<number>();

function postResponse(msg: FastWorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    workerSelf.postMessage(msg, transfer);
  } else {
    workerSelf.postMessage(msg);
  }
}

async function handleInpaint(req: Extract<FastWorkerRequest, { type: 'inpaint' }>): Promise<void> {
  const { taskId, width, height, imageBuffer, maskBuffer, quality, featherPx, matchedMarks } = req;
  try {
    const imageData = createImageDataSafe(new Uint8ClampedArray(imageBuffer), width, height);
    const mask = new Uint8Array(maskBuffer);

    let lastSentPercent = -1;
    let lastSentStage = '';

    const result = await inpaintFastAsync(
      imageData,
      mask,
      {
        quality,
        featherPx,
        matchedMarks,
        shouldAbort: () => cancelledTaskIds.has(taskId),
        onProgress: (stage, percent) => {
          if (percent !== lastSentPercent || stage !== lastSentStage) {
            lastSentPercent = percent;
            lastSentStage = stage;
            postResponse({ type: 'progress', taskId, stage, percent });
          }
        },
      },
      32,
    );

    const outCopy = new Uint8ClampedArray(result.imageData.data);
    postResponse(
      {
        type: 'inpaint-result',
        taskId,
        width: result.imageData.width,
        height: result.imageData.height,
        imageBuffer: outCopy.buffer,
        durationMs: result.durationMs,
      },
      [outCopy.buffer],
    );
  } catch (err) {
    const aborted =
      cancelledTaskIds.has(taskId) || (err instanceof Error && err.name === 'AbortError');
    const message =
      err instanceof Error ? err.message : aborted ? '去水印任务已取消' : '快速去水印引擎执行异常';
    postResponse({ type: 'error', taskId, aborted, message });
  } finally {
    cancelledTaskIds.delete(taskId);
  }
}

function handleDetect(req: Extract<FastWorkerRequest, { type: 'detect' }>): void {
  const { taskId, width, height, imageBuffer, sensitivity } = req;
  if (cancelledTaskIds.has(taskId)) {
    cancelledTaskIds.delete(taskId);
    postResponse({ type: 'error', taskId, aborted: true, message: '角落水印探测已取消' });
    return;
  }

  try {
    const imageData = createImageDataSafe(new Uint8ClampedArray(imageBuffer), width, height);
    const res = detectCornerWatermark(imageData, sensitivity);

    if (res.detected && res.mask) {
      const maskCopy = new Uint8Array(res.mask);
      postResponse(
        {
          type: 'detect-result',
          taskId,
          detected: true,
          corner: res.corner,
          rect: res.rect,
          confidence: res.confidence,
          maskBuffer: maskCopy.buffer,
          matches: res.matches,
          method: res.method,
          message: res.message,
        },
        [maskCopy.buffer],
      );
    } else {
      postResponse({
        type: 'detect-result',
        taskId,
        detected: false,
        confidence: res.confidence,
        message: res.message,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '角落水印自动探测失败';
    postResponse({ type: 'error', taskId, aborted: false, message });
  } finally {
    cancelledTaskIds.delete(taskId);
  }
}

function handleRefineMask(req: Extract<FastWorkerRequest, { type: 'refine-mask' }>): void {
  const { taskId, width, height, imageBuffer, maskBuffer } = req;
  try {
    const imageData = createImageDataSafe(new Uint8ClampedArray(imageBuffer), width, height);
    const rawMask = new Uint8Array(maskBuffer);
    const res = refineMaskToStrokes(imageData, rawMask);
    const maskCopy = new Uint8Array(res.mask);
    postResponse(
      {
        type: 'refine-mask-result',
        taskId,
        refined: res.refined,
        maskBuffer: maskCopy.buffer,
        matchedMarks: res.matchedMarks,
        message: res.message,
      },
      [maskCopy.buffer],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : '智能提取水印笔画失败';
    postResponse({ type: 'error', taskId, aborted: false, message });
  } finally {
    cancelledTaskIds.delete(taskId);
  }
}

workerSelf.onmessage = (event: MessageEvent<FastWorkerRequest>) => {
  const req = event.data;
  if (!req) return;

  if (req.type === 'cancel') {
    cancelledTaskIds.add(req.taskId);
    return;
  }

  if (req.type === 'inpaint') {
    void handleInpaint(req);
    return;
  }

  if (req.type === 'detect') {
    handleDetect(req);
    return;
  }

  if (req.type === 'refine-mask') {
    handleRefineMask(req);
  }
};
