/**
 * 高阶 AI（LaMa ONNX）专用 Web Worker（Vite ES Module Worker）
 *
 * 关键架构优势：
 * 1. 直接在 Worker 线程内通过 IndexedDB 读取 208 MB 模型权重，避免主线程读取与跨线程拷贝；
 * 2. 使用 onnxruntime-web/webgpu（内置 Asyncify WebGPU + WASM 回退），无论 WebGPU 还是 WASM 编译推理均不阻塞主线程 UI；
 * 3. 若 WebGPU 运行期遭遇驱动或算子异常，在 Worker 内部自动释放会话并重建 WASM 会话完成透明回退；
 * 4. 整套预填（inpaintFastAsync）、分簇局部裁剪与羽化拼接均在后台线程完成，主线程通过 Transferable 零拷贝收发像素缓冲。
 */

import type { MatchedWatermark } from '../../types';
import {
  createImageDataCompat,
  createLamaSessionFromBuffer,
  executeLamaInpaint,
  type ActiveLamaSession,
  type LamaBackend,
} from './lamaInference';
import { loadModelFromCache } from './modelCache';

export type LamaWorkerRequest =
  | {
      type: 'ensure-session';
      taskId: number;
      preferWebGpu?: boolean;
    }
  | {
      type: 'inpaint';
      taskId: number;
      width: number;
      height: number;
      imageBuffer: ArrayBuffer;
      maskBuffer: ArrayBuffer;
      featherPx: number;
      matchedMarks?: MatchedWatermark[];
      preferWebGpu?: boolean;
    }
  | {
      type: 'dispose';
      taskId: number;
    };

export type LamaWorkerResponse =
  | {
      type: 'progress';
      taskId: number;
      phase: 'loading' | 'inferring';
      stage: string;
      percent: number;
      backend?: LamaBackend;
    }
  | {
      type: 'session-ready';
      taskId: number;
      backend: LamaBackend;
      inputSize: number;
      cachedSource: string;
      cachedSizeBytes: number;
    }
  | {
      type: 'inpaint-result';
      taskId: number;
      width: number;
      height: number;
      imageBuffer: ArrayBuffer;
      durationMs: number;
      backend: LamaBackend;
      inputSize: number;
      cachedSource: string;
      cachedSizeBytes: number;
    }
  | {
      type: 'disposed';
      taskId: number;
    }
  | {
      type: 'error';
      taskId: number;
      code?: 'NO_CACHE' | 'INFER_ERROR';
      message: string;
    };

export interface LamaWorkerRuntimeDeps {
  loadModelFromCache: typeof loadModelFromCache;
  createLamaSessionFromBuffer: typeof createLamaSessionFromBuffer;
  executeLamaInpaint: typeof executeLamaInpaint;
}

/** 构造独立可测试的 LaMa Worker 消息处理器（支持依赖注入用于单测 WebGPU→WASM 自动回退） */
export function createLamaWorkerMessageHandler(
  postMessage: (message: LamaWorkerResponse, transfer?: Transferable[]) => void,
  deps: LamaWorkerRuntimeDeps = {
    loadModelFromCache,
    createLamaSessionFromBuffer,
    executeLamaInpaint,
  },
): (req: LamaWorkerRequest) => Promise<void> {
  let activeSession: ActiveLamaSession | null = null;
  let loadedSourceLabel = '';
  let loadedSizeBytes = 0;

  const postMessageSafe = (msg: LamaWorkerResponse, transfer?: Transferable[]): void => {
    if (transfer && transfer.length > 0) {
      postMessage(msg, transfer);
    } else {
      postMessage(msg);
    }
  };

  const postProgress = (
    taskId: number,
    phase: 'loading' | 'inferring',
    stage: string,
    percent: number,
    backend?: LamaBackend,
  ): void => {
    postMessageSafe({ type: 'progress', taskId, phase, stage, percent, backend });
  };

  const releaseActiveSession = async (): Promise<void> => {
    const session = activeSession;
    activeSession = null;
    if (session) {
      await session.session.release().catch(() => undefined);
    }
  };

  const ensureWorkerSession = async (
    taskId: number,
    preferWebGpu = true,
  ): Promise<ActiveLamaSession> => {
    if (activeSession) {
      return activeSession;
    }

    postProgress(taskId, 'loading', '正在从浏览器缓存读取 LaMa 模型权重...', 6);
    const cachedRecord = await deps.loadModelFromCache();
    if (!cachedRecord) {
      const err = new Error(
        '尚未下载或导入 LaMa AI 模型，请先在「AI 模型管理」中下载模型或导入本地 .onnx 文件。',
      ) as Error & { code?: 'NO_CACHE' };
      err.code = 'NO_CACHE';
      throw err;
    }

    postProgress(
      taskId,
      'loading',
      preferWebGpu
        ? '正在后台线程初始化 LaMa 神经网络会话（优先 WebGPU）...'
        : '正在后台线程初始化 LaMa WASM 推理会话...',
      18,
    );

    const created = await deps.createLamaSessionFromBuffer(cachedRecord.buffer, { preferWebGpu });
    activeSession = created;
    loadedSourceLabel = cachedRecord.sourceLabel;
    loadedSizeBytes = cachedRecord.sizeBytes;

    postProgress(
      taskId,
      'loading',
      `LaMa 引擎已就绪（${created.backend === 'webgpu' ? 'WebGPU' : 'WASM'}）`,
      100,
      created.backend,
    );

    return created;
  };

  const handleEnsureSession = async (
    req: Extract<LamaWorkerRequest, { type: 'ensure-session' }>,
  ): Promise<void> => {
    const session = await ensureWorkerSession(req.taskId, req.preferWebGpu ?? true);
    postMessageSafe({
      type: 'session-ready',
      taskId: req.taskId,
      backend: session.backend,
      inputSize: session.io.inputSize,
      cachedSource: loadedSourceLabel,
      cachedSizeBytes: loadedSizeBytes,
    });
  };

  const handleInpaint = async (
    req: Extract<LamaWorkerRequest, { type: 'inpaint' }>,
  ): Promise<void> => {
    let session = await ensureWorkerSession(req.taskId, req.preferWebGpu ?? true);

    const imageData = createImageDataCompat(
      new Uint8ClampedArray(req.imageBuffer),
      req.width,
      req.height,
    );
    const mask = new Uint8Array(req.maskBuffer);

    const runWithSession = (targetSession: ActiveLamaSession) =>
      deps.executeLamaInpaint(
        targetSession,
        {
          imageData,
          mask,
          featherPx: req.featherPx,
          matchedMarks: req.matchedMarks,
        },
        {
          onProgress: (p) => {
            postProgress(req.taskId, 'inferring', p.stage, p.percent, targetSession.backend);
          },
        },
      );

    let output;
    try {
      output = await runWithSession(session);
    } catch (error) {
      // 若在 WebGPU 推理阶段遇到显卡驱动或算子异常，在 Worker 内部自动释放并重建 WASM 会话重试一次
      if (session.backend === 'webgpu') {
        postProgress(
          req.taskId,
          'loading',
          'WebGPU 推理受限，正在后台自动切换至 WASM 后端继续修复...',
          45,
          'wasm',
        );
        await releaseActiveSession();
        session = await ensureWorkerSession(req.taskId, false);
        output = await runWithSession(session);
      } else {
        throw error;
      }
    }

    // 当输出字节数组独占底层 ArrayBuffer 时直接零拷贝转移，避免 4K 图多占 32 MB 临时内存
    const outBytes = output.imageData.data;
    let outBuffer: ArrayBuffer;
    if (
      outBytes.buffer instanceof ArrayBuffer &&
      outBytes.byteOffset === 0 &&
      outBytes.byteLength === outBytes.buffer.byteLength
    ) {
      outBuffer = outBytes.buffer;
    } else {
      const outCopy = new Uint8ClampedArray(new ArrayBuffer(outBytes.byteLength));
      outCopy.set(outBytes);
      outBuffer = outCopy.buffer;
    }

    postMessageSafe(
      {
        type: 'inpaint-result',
        taskId: req.taskId,
        width: output.imageData.width,
        height: output.imageData.height,
        imageBuffer: outBuffer,
        durationMs: output.durationMs,
        backend: session.backend,
        inputSize: session.io.inputSize,
        cachedSource: loadedSourceLabel,
        cachedSizeBytes: loadedSizeBytes,
      },
      [outBuffer],
    );
  };

  return async (req: LamaWorkerRequest): Promise<void> => {
    try {
      if (req.type === 'dispose') {
        await releaseActiveSession();
        postMessageSafe({ type: 'disposed', taskId: req.taskId });
        return;
      }

      if (req.type === 'ensure-session') {
        await handleEnsureSession(req);
        return;
      }

      if (req.type === 'inpaint') {
        await handleInpaint(req);
      }
    } catch (error) {
      const errWithCode = error as Error & { code?: 'NO_CACHE' };
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'LaMa 后台推理执行失败，请释放显存后重试。';
      postMessageSafe({
        type: 'error',
        taskId: req.taskId,
        code: errWithCode?.code === 'NO_CACHE' ? 'NO_CACHE' : 'INFER_ERROR',
        message,
      });
    }
  };
}

interface DedicatedWorkerScopeLike {
  onmessage: ((event: MessageEvent<LamaWorkerRequest>) => void) | null;
  postMessage: (message: LamaWorkerResponse, transfer?: Transferable[]) => void;
}

// 仅在真实 Dedicated Web Worker 全局作用域中自动挂载监听，避免被单元测试导入时污染 window.onmessage
const isDedicatedWorkerGlobal =
  typeof self !== 'undefined' && typeof window === 'undefined' && 'postMessage' in self;

if (isDedicatedWorkerGlobal) {
  const workerSelf = self as unknown as DedicatedWorkerScopeLike;
  const handleMessage = createLamaWorkerMessageHandler((msg, transfer) => {
    if (transfer && transfer.length > 0) {
      workerSelf.postMessage(msg, transfer);
    } else {
      workerSelf.postMessage(msg);
    }
  });
  workerSelf.onmessage = (event: MessageEvent<LamaWorkerRequest>) => {
    if (!event.data) return;
    void handleMessage(event.data);
  };
}
