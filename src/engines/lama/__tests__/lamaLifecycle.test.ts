/**
 * LaMa 引擎独立 Web Worker 生命周期、取消与释放防死锁单元测试
 *
 * 覆盖：
 * 1. Worker 会话加载、状态订阅同步与会话复用；
 * 2. runLamaInpaint Transferable 往返与回传 ImageData；
 * 3. 推理/加载中调用 disposeLamaSession 或触发 AbortSignal 时立即终止 Worker 并解锁串行队列；
 * 4. 空闲态 disposeLamaSession 通知 Worker 优雅释放后终止线程；
 * 5. Worker 报错（NO_CACHE / 推理失败）状态回落与可恢复性；
 * 6. importLocalLamaModel 自动取消进行中的在线下载；
 * 7. 无 Worker 环境自动降级至主线程路径。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDb, type FakeIndexedDbController } from '../../../test/fakeIndexedDb';
import {
  clearLamaModelCache,
  disposeLamaSession,
  downloadLamaModel,
  ensureLamaSessionLoaded,
  getLamaModelStatus,
  importLocalLamaModel,
  initLamaModelStatus,
  runLamaInpaint,
  subscribeLamaStatus,
} from '../index';
import { createImageDataCompat } from '../lamaInference';
import { saveModelToCache } from '../modelCache';
import type { LamaWorkerRequest, LamaWorkerResponse } from '../worker';

class MockLamaWorker {
  static instances: MockLamaWorker[] = [];
  static handler: ((worker: MockLamaWorker, req: LamaWorkerRequest) => void) | null = null;

  onmessage: ((event: MessageEvent<LamaWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  terminated = false;
  posted: Array<{ req: LamaWorkerRequest; transfer?: Transferable[] }> = [];

  constructor() {
    MockLamaWorker.instances.push(this);
  }

  postMessage(req: LamaWorkerRequest, transfer?: Transferable[]): void {
    this.posted.push({ req, transfer });
    MockLamaWorker.handler?.(this, req);
  }

  emit(msg: LamaWorkerResponse): void {
    if (this.terminated) return;
    this.onmessage?.({ data: msg } as MessageEvent<LamaWorkerResponse>);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function createFakeOnnxBytes(size = 1024 * 1024 + 64): ArrayBuffer {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  bytes[0] = 0x08;
  bytes[1] = 0x08;
  bytes[2] = 0x12;
  bytes[3] = 0x04;
  bytes[4] = 0x6c;
  bytes[5] = 0x61;
  bytes[6] = 0x6d;
  bytes[7] = 0x61;
  return bytes.buffer;
}

async function waitUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('LaMa Web Worker 生命周期与防死锁调度', () => {
  let idb: FakeIndexedDbController;

  beforeEach(async () => {
    idb = installFakeIndexedDb();
    MockLamaWorker.instances = [];
    MockLamaWorker.handler = null;
    vi.stubGlobal('Worker', MockLamaWorker);
    await clearLamaModelCache();
  });

  afterEach(async () => {
    await disposeLamaSession();
    vi.unstubAllGlobals();
    idb.restore();
    vi.restoreAllMocks();
  });

  it('ensureLamaSessionLoaded 应通过 Worker 加载会话、推送状态并在二次调用时复用', async () => {
    await saveModelToCache({
      buffer: new ArrayBuffer(128),
      sourceLabel: '镜像测试源',
      sourceUrl: 'https://example.com/lama.onnx',
    });
    await initLamaModelStatus();
    expect(getLamaModelStatus().state).toBe('cached');

    const observedStates: string[] = [];
    const unsubscribe = subscribeLamaStatus((s) => observedStates.push(s.state));

    MockLamaWorker.handler = (worker, req) => {
      if (req.type === 'ensure-session') {
        queueMicrotask(() => {
          worker.emit({
            type: 'progress',
            taskId: req.taskId,
            phase: 'loading',
            stage: '正在初始化...',
            percent: 50,
          });
          worker.emit({
            type: 'session-ready',
            taskId: req.taskId,
            backend: 'webgpu',
            inputSize: 512,
            cachedSource: '镜像测试源',
            cachedSizeBytes: 128,
          });
        });
      }
    };

    const first = await ensureLamaSessionLoaded();
    expect(first).toEqual({ backend: 'webgpu', inputSize: 512 });
    expect(getLamaModelStatus()).toMatchObject({
      state: 'ready',
      backend: 'webgpu',
      cachedSource: '镜像测试源',
    });
    expect(observedStates).toContain('loading');
    expect(observedStates).toContain('ready');

    // 二次调用复用已就绪 Worker，不再创建新线程也不再发消息
    const second = await ensureLamaSessionLoaded();
    expect(second).toEqual({ backend: 'webgpu', inputSize: 512 });
    expect(MockLamaWorker.instances).toHaveLength(1);
    expect(MockLamaWorker.instances[0].posted).toHaveLength(1);

    unsubscribe();
  });

  it('runLamaInpaint 应通过 Transferable 往返并正确处理推理中 dispose 防死锁', async () => {
    await saveModelToCache({
      buffer: new ArrayBuffer(256),
      sourceLabel: '本地测试模型',
      sourceUrl: 'local://lama.onnx',
    });
    await initLamaModelStatus();

    const width = 4;
    const height = 4;
    const rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    rgba.fill(100);
    const mask = new Uint8Array(width * height);
    mask[0] = 255;

    // 第一次推理刻意挂起不回复，模拟 208 MB WASM 推理卡顿期间点击「释放显存」
    MockLamaWorker.handler = () => {
      // 保持挂起等待外部 dispose
    };

    const hungPromise = runLamaInpaint({
      imageData: createImageDataCompat(rgba, width, height),
      mask,
    });
    const hungError = hungPromise.then(
      () => null,
      (err: unknown) => err,
    );

    await waitUntil(
      () => MockLamaWorker.instances.length === 1 && MockLamaWorker.instances[0].posted.length > 0,
    );
    expect(MockLamaWorker.instances).toHaveLength(1);
    const firstWorker = MockLamaWorker.instances[0];

    // 释放会话应立即 terminate Worker 并以 AbortError 解锁串行队列
    await disposeLamaSession();
    expect(firstWorker.terminated).toBe(true);
    expect(await hungError).toMatchObject({ name: 'AbortError' });
    expect(getLamaModelStatus().state).toBe('cached');

    // 验证队列未死锁：后续新任务应新建 Worker 并正常完成返回结果
    MockLamaWorker.handler = (worker, req) => {
      if (req.type === 'inpaint') {
        queueMicrotask(() => {
          const out = new Uint8ClampedArray(new ArrayBuffer(req.width * req.height * 4));
          out.fill(200);
          worker.emit({
            type: 'inpaint-result',
            taskId: req.taskId,
            width: req.width,
            height: req.height,
            imageBuffer: out.buffer,
            durationMs: 42,
            backend: 'wasm',
            inputSize: 512,
            cachedSource: '本地测试模型',
            cachedSizeBytes: 256,
          });
        });
      } else if (req.type === 'dispose') {
        queueMicrotask(() => worker.emit({ type: 'disposed', taskId: req.taskId }));
      }
    };

    const output = await runLamaInpaint({
      imageData: createImageDataCompat(rgba, width, height),
      mask,
    });
    expect(MockLamaWorker.instances).toHaveLength(2);
    expect(output.backend).toBe('wasm');
    expect(output.durationMs).toBe(42);
    expect(output.imageData.data[0]).toBe(200);

    // 空闲态 dispose 应发送 dispose 消息并终止 Worker
    await disposeLamaSession();
    const secondWorker = MockLamaWorker.instances[1];
    expect(secondWorker.posted.some((p) => p.req.type === 'dispose')).toBe(true);
    expect(secondWorker.terminated).toBe(true);
  });

  it('推理中触发 AbortSignal 应立即终止 Worker 并恢复 cached 状态', async () => {
    await saveModelToCache({
      buffer: new ArrayBuffer(64),
      sourceLabel: '测试缓存',
      sourceUrl: 'local://lama.onnx',
    });
    await initLamaModelStatus();

    const controller = new AbortController();
    MockLamaWorker.handler = () => {
      // 模拟长耗时任务
    };

    const rgba = new Uint8ClampedArray(new ArrayBuffer(16));
    const task = runLamaInpaint(
      { imageData: createImageDataCompat(rgba, 2, 2), mask: new Uint8Array(4) },
      { signal: controller.signal },
    );
    const taskError = task.then(
      () => null,
      (err: unknown) => err,
    );

    await waitUntil(
      () => MockLamaWorker.instances.length === 1 && MockLamaWorker.instances[0].posted.length > 0,
    );
    controller.abort();

    expect(await taskError).toMatchObject({ name: 'AbortError' });
    expect(MockLamaWorker.instances[0].terminated).toBe(true);
    expect(getLamaModelStatus().state).toBe('cached');
  });

  it('Worker 返回 NO_CACHE 或推理错误时应正确同步状态', async () => {
    MockLamaWorker.handler = (worker, req) => {
      if (req.type === 'ensure-session') {
        queueMicrotask(() => {
          worker.emit({
            type: 'error',
            taskId: req.taskId,
            code: 'NO_CACHE',
            message: '尚未下载模型',
          });
        });
      }
    };

    await expect(ensureLamaSessionLoaded()).rejects.toThrow('尚未下载模型');
    expect(getLamaModelStatus().state).toBe('unloaded');

    MockLamaWorker.handler = (worker, req) => {
      if (req.type === 'ensure-session') {
        queueMicrotask(() => {
          worker.emit({
            type: 'error',
            taskId: req.taskId,
            code: 'INFER_ERROR',
            message: 'WebGPU 与 WASM 均初始化失败',
          });
        });
      }
    };

    await expect(ensureLamaSessionLoaded()).rejects.toThrow('WebGPU 与 WASM 均初始化失败');
    expect(getLamaModelStatus().state).toBe('error');
  });

  it('importLocalLamaModel 应自动中止进行中的在线下载，避免旧下载回写覆盖', async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          fetchSignal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }),
    );

    const downloadPromise = downloadLamaModel('https://example.com/remote-lama.onnx', {
      label: '远端源',
    });
    const downloadError = downloadPromise.then(
      () => null,
      (err: unknown) => err,
    );

    await waitUntil(() => getLamaModelStatus().state === 'downloading' && Boolean(fetchSignal));
    expect(getLamaModelStatus().state).toBe('downloading');

    const localBuf = createFakeOnnxBytes();
    const localFile = new File([localBuf], 'local_lama.onnx', {
      type: 'application/octet-stream',
    });
    // 兼容 jsdom 中 File.prototype.arrayBuffer 未实现的问题
    Object.defineProperty(localFile, 'arrayBuffer', {
      value: async () => localBuf,
    });
    const statusAfterImport = await importLocalLamaModel(localFile);

    expect(fetchSignal?.aborted).toBe(true);
    expect(statusAfterImport.state).toBe('cached');
    expect(statusAfterImport.cachedSource).toContain('local_lama.onnx');
    expect(await downloadError).toMatchObject({ name: 'AbortError' });
  });

  it('clearLamaModelCache 在有排队任务时应先删缓存再终止会话，防止排队任务读回旧缓存（NEW-P1-2）', async () => {
    await saveModelToCache({
      buffer: new ArrayBuffer(128),
      sourceLabel: '待清理模型',
      sourceUrl: 'local://old.onnx',
    });
    await initLamaModelStatus();

    const rgba = new Uint8ClampedArray(new ArrayBuffer(16));
    const mask = new Uint8Array(4);

    // Worker 收到第 1 个任务挂起；若收到第 2 个任务，模拟真实 Worker 检查 IndexedDB 缓存是否已清空
    let workerCallCount = 0;
    MockLamaWorker.handler = (worker, req) => {
      if (req.type !== 'inpaint') return;
      workerCallCount += 1;
      if (workerCallCount >= 2) {
        void import('../modelCache').then(async ({ loadModelFromCache }) => {
          const cached = await loadModelFromCache();
          if (!cached) {
            worker.emit({
              type: 'error',
              taskId: req.taskId,
              code: 'NO_CACHE',
              message: '缓存已清空',
            });
          } else {
            worker.emit({
              type: 'inpaint-result',
              taskId: req.taskId,
              width: req.width,
              height: req.height,
              imageBuffer: new ArrayBuffer(16),
              durationMs: 1,
              backend: 'wasm',
              inputSize: 512,
              cachedSource: cached.sourceLabel,
              cachedSizeBytes: cached.sizeBytes,
            });
          }
        });
      }
    };

    const t1Error = runLamaInpaint({
      imageData: createImageDataCompat(rgba, 2, 2),
      mask,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    const t2Error = runLamaInpaint({
      imageData: createImageDataCompat(rgba, 2, 2),
      mask,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    await waitUntil(
      () => MockLamaWorker.instances.length === 1 && MockLamaWorker.instances[0].posted.length > 0,
    );

    const status = await clearLamaModelCache();
    expect(status.state).toBe('unloaded');
    expect(await t1Error).toMatchObject({ name: 'AbortError' });
    // 排队中的 T2 绝不会读到旧缓存而成功完成
    expect(await t2Error).toBeInstanceOf(Error);
    expect(getLamaModelStatus().state).toBe('unloaded');
  });

  it('无 Worker 环境时应自动降级至主线程路径并正常检测无缓存状态', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(ensureLamaSessionLoaded()).rejects.toThrow('尚未下载或导入 LaMa AI 模型');
    expect(getLamaModelStatus().state).toBe('unloaded');
  });
});
