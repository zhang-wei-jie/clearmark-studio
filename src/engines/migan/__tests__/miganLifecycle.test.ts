/**
 * MI-GAN Worker 生命周期、预加载复用与释放防死锁回归测试（P0-2 护栏）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createImageDataSafe } from '../../fast/inpaintCore';
import {
  disposeMiganSession,
  getMiganModelStatus,
  preloadMiganModel,
  runMiganInpaint,
} from '../index';
import type { MiganWorkerRequest, MiganWorkerResponse } from '../worker';

class MockMiganWorker {
  static instances: MockMiganWorker[] = [];
  static handler: ((worker: MockMiganWorker, req: MiganWorkerRequest) => void) | null = null;

  onmessage: ((event: MessageEvent<MiganWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  terminated = false;
  posted: MiganWorkerRequest[] = [];

  constructor() {
    MockMiganWorker.instances.push(this);
  }

  postMessage(req: MiganWorkerRequest): void {
    this.posted.push(req);
    MockMiganWorker.handler?.(this, req);
  }

  emit(msg: MiganWorkerResponse): void {
    if (this.terminated) return;
    this.onmessage?.({ data: msg } as MessageEvent<MiganWorkerResponse>);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('MI-GAN Worker 生命周期与防死锁回归', () => {
  beforeEach(async () => {
    MockMiganWorker.instances = [];
    MockMiganWorker.handler = null;
    vi.stubGlobal('Worker', MockMiganWorker);
    await disposeMiganSession();
  });

  afterEach(async () => {
    await disposeMiganSession();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preloadMiganModel 应成功预加载并在 ready 后复用既有 Worker', async () => {
    MockMiganWorker.handler = (worker, req) => {
      if (req.type === 'preload') {
        queueMicrotask(() => {
          worker.emit({
            type: 'progress',
            taskId: req.taskId,
            phase: 'loading',
            stage: '加载中',
            percent: 60,
          });
          worker.emit({ type: 'ready', taskId: req.taskId, sizeBytes: 28_079_181 });
        });
      }
    };

    const status = await preloadMiganModel();
    expect(status.state).toBe('ready');
    expect(status.backend).toBe('wasm');

    await preloadMiganModel();
    expect(MockMiganWorker.instances).toHaveLength(1);
    expect(MockMiganWorker.instances[0].posted).toHaveLength(1);
  });

  it('推理进行中调用 disposeMiganSession 应立即解锁串行队列且后续任务可正常恢复', async () => {
    const width = 32;
    const height = 32;
    const rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = 40;
      rgba[i * 4 + 1] = 80;
      rgba[i * 4 + 2] = 120;
      rgba[i * 4 + 3] = 255;
    }
    const mask = new Uint8Array(width * height);
    for (let y = 10; y < 18; y++) {
      for (let x = 10; x < 18; x++) {
        mask[y * width + x] = 255;
      }
    }

    // 第一次推理保持挂起，等待推理期 disposeMiganSession 触发
    let workerReceivedInfer = false;
    MockMiganWorker.handler = (_worker, req) => {
      if (req.type === 'infer') {
        workerReceivedInfer = true;
      }
    };

    const hungTask = runMiganInpaint({
      imageData: createImageDataSafe(rgba, width, height),
      mask,
      featherPx: 2,
    });

    // 等待前置轻量预填完成并派发至 Worker
    for (let i = 0; i < 40 && !workerReceivedInfer; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(workerReceivedInfer).toBe(true);
    expect(MockMiganWorker.instances).toHaveLength(1);

    await disposeMiganSession();
    expect(MockMiganWorker.instances[0].terminated).toBe(true);
    await expect(hungTask).rejects.toMatchObject({ name: 'AbortError' });
    expect(getMiganModelStatus().state).toBe('idle');

    // 验证串行队列未死锁：第二次推理自动创建新 Worker 并返回无损结果
    MockMiganWorker.handler = (worker, req) => {
      if (req.type === 'infer') {
        queueMicrotask(() => {
          const out = new Uint8ClampedArray(new ArrayBuffer(req.width * req.height * 4));
          for (let i = 0; i < req.width * req.height; i++) {
            out[i * 4] = 42;
            out[i * 4 + 1] = 82;
            out[i * 4 + 2] = 122;
            out[i * 4 + 3] = 255;
          }
          worker.emit({
            type: 'result',
            taskId: req.taskId,
            width: req.width,
            height: req.height,
            rgbaBuffer: out.buffer,
          });
        });
      }
    };

    const res = await runMiganInpaint({
      imageData: createImageDataSafe(rgba, width, height),
      mask,
      featherPx: 2,
    });
    expect(MockMiganWorker.instances).toHaveLength(2);
    expect(res.backend).toBe('migan-wasm');
    // 校验非遮罩区（0,0）逐字节无损
    expect(res.imageData.data[0]).toBe(40);
    expect(res.imageData.data[1]).toBe(80);
    expect(res.imageData.data[2]).toBe(120);
    expect(res.imageData.data[3]).toBe(255);
  });
});
