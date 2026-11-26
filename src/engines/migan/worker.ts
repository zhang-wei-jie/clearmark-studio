/**
 * 内置 MI-GAN v2 本地 AI 去水印推理专用 Web Worker
 *
 * - 随站分发 28.1 MB 的 migan_pipeline_v2.onnx，首次调用才按需流式加载并缓存于浏览器 HTTP 缓存；
 * - 使用 onnxruntime-web/wasm 单线程安全后端（不依赖 COOP/COEP SharedArrayBuffer），推理全程不阻塞主线程 UI；
 * - 单页生命周期内复用已初始化的 ONNX 会话，换图或批量处理无需重复初始化。
 */

import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import modelUrl from '../../assets/migan_pipeline_v2.onnx?url';

export type MiganWorkerRequest =
  | { type: 'preload'; taskId: number }
  | {
      type: 'infer';
      taskId: number;
      width: number;
      height: number;
      rgbaBuffer: ArrayBuffer;
      maskBuffer: ArrayBuffer;
    };

export type MiganWorkerResponse =
  | {
      type: 'progress';
      taskId: number;
      phase: 'loading' | 'inferring';
      stage: string;
      percent: number;
    }
  | { type: 'ready'; taskId: number; sizeBytes: number }
  | {
      type: 'result';
      taskId: number;
      width: number;
      height: number;
      rgbaBuffer: ArrayBuffer;
    }
  | { type: 'error'; taskId: number; message: string };

interface MiganWorkerContextLike {
  location: Location;
  onmessage: ((event: MessageEvent<MiganWorkerRequest>) => void) | null;
  postMessage: (message: MiganWorkerResponse, transfer?: Transferable[]) => void;
}

const workerSelf = self as unknown as MiganWorkerContextLike;

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, workerSelf.location.href).href };

const EXPECTED_MODEL_BYTES = 28_079_181;
let session: ort.InferenceSession | null = null;
let loadedModelBytes = EXPECTED_MODEL_BYTES;

function postProgress(
  taskId: number,
  phase: 'loading' | 'inferring',
  stage: string,
  percent: number,
): void {
  workerSelf.postMessage({ type: 'progress', taskId, phase, stage, percent });
}

async function fetchModelBytes(taskId: number): Promise<Uint8Array> {
  postProgress(taskId, 'loading', '正在加载内置 MI-GAN 模型（28.1 MB）...', 5);
  const response = await fetch(modelUrl, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`内置 AI 模型请求失败（HTTP ${response.status}）`);
  }

  const contentLenHeader = response.headers.get('content-length');
  const expected = contentLenHeader ? Number.parseInt(contentLenHeader, 10) : EXPECTED_MODEL_BYTES;
  const totalBytes = Number.isFinite(expected) && expected > 0 ? expected : EXPECTED_MODEL_BYTES;

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    loadedModelBytes = bytes.byteLength;
    postProgress(taskId, 'loading', '内置模型读取完成', 75);
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastPct = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    chunks.push(value);
    received += value.byteLength;
    const pct = Math.min(75, Math.floor((received / totalBytes) * 70) + 5);
    if (pct >= lastPct + 4) {
      lastPct = pct;
      const dlPct = Math.min(100, Math.round((received / totalBytes) * 100));
      postProgress(taskId, 'loading', `正在加载内置 MI-GAN 模型（${dlPct}%）...`, pct);
    }
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  loadedModelBytes = merged.byteLength;
  return merged;
}

async function ensureSession(taskId: number): Promise<ort.InferenceSession> {
  if (session) return session;
  const bytes = await fetchModelBytes(taskId);
  postProgress(taskId, 'loading', '正在初始化本地 AI 推理引擎...', 82);
  session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  postProgress(taskId, 'loading', '本地 AI 引擎已就绪', 100);
  return session;
}

async function runInference(
  engine: ort.InferenceSession,
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const count = width * height;
  const rgb = new Uint8Array(3 * count);
  for (let p = 0; p < count; p++) {
    const p4 = p * 4;
    rgb[p] = rgba[p4];
    rgb[count + p] = rgba[p4 + 1];
    rgb[2 * count + p] = rgba[p4 + 2];
  }

  const sourceTensor = new ort.Tensor('uint8', rgb, [1, 3, height, width]);
  const maskTensor = new ort.Tensor('uint8', mask, [1, 1, height, width]);
  let resultTensor: ort.Tensor | undefined;

  try {
    const outputs = await engine.run({ image: sourceTensor, mask: maskTensor });
    resultTensor = outputs.result ?? Object.values(outputs)[0];
    if (
      !resultTensor ||
      resultTensor.type !== 'uint8' ||
      resultTensor.dims.join(',') !== `1,3,${height},${width}`
    ) {
      throw new Error('MI-GAN 模型输出格式与预期不符');
    }

    const outData = resultTensor.data as Uint8Array;
    const outRgba = new Uint8ClampedArray(new ArrayBuffer(4 * count));
    for (let p = 0; p < count; p++) {
      const p4 = p * 4;
      outRgba[p4] = outData[p];
      outRgba[p4 + 1] = outData[count + p];
      outRgba[p4 + 2] = outData[2 * count + p];
      outRgba[p4 + 3] = 255;
    }
    return outRgba;
  } finally {
    sourceTensor.dispose();
    maskTensor.dispose();
    resultTensor?.dispose();
  }
}

workerSelf.onmessage = async (event: MessageEvent<MiganWorkerRequest>) => {
  const req = event.data;
  if (!req) return;

  try {
    const engine = await ensureSession(req.taskId);
    if (req.type === 'preload') {
      workerSelf.postMessage({ type: 'ready', taskId: req.taskId, sizeBytes: loadedModelBytes });
      return;
    }

    postProgress(req.taskId, 'inferring', '正在运行 MI-GAN 本地神经网络重构纹理...', 50);
    const outRgba = await runInference(
      engine,
      req.width,
      req.height,
      new Uint8ClampedArray(req.rgbaBuffer),
      new Uint8Array(req.maskBuffer),
    );
    workerSelf.postMessage(
      {
        type: 'result',
        taskId: req.taskId,
        width: req.width,
        height: req.height,
        rgbaBuffer: outRgba.buffer,
      },
      [outRgba.buffer],
    );
  } catch (err) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'MI-GAN 本地 AI 推理未能完成，请释放内存后重试。';
    workerSelf.postMessage({ type: 'error', taskId: req.taskId, message });
  }
};
