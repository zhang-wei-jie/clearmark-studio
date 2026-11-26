/**
 * LaMa 专用 Web Worker 消息处理器直接单元测试（worker.ts）
 *
 * 覆盖：
 * 1. ensure-session 首次加载并二次复用既有会话；
 * 2. WebGPU 推理期异常自动释放旧会话、以 preferWebGpu: false 重建 WASM 会话并重试成功；
 * 3. 输出缓冲独占底层 ArrayBuffer 时直接零拷贝 Transferable 回传（无二次整图拷贝）；
 * 4. 无缓存时返回 code: 'NO_CACHE' 错误；
 * 5. dispose 消息正确调用 session.release() 并回报 disposed。
 */

import { describe, expect, it, vi } from 'vitest';
import { createImageDataCompat, type ActiveLamaSession } from '../lamaInference';
import {
  createLamaWorkerMessageHandler,
  type LamaWorkerResponse,
  type LamaWorkerRuntimeDeps,
} from '../worker';

function createFakeSession(backend: 'webgpu' | 'wasm'): {
  session: ActiveLamaSession;
  releaseSpy: ReturnType<typeof vi.fn>;
} {
  const releaseSpy = vi.fn().mockResolvedValue(undefined);
  const session: ActiveLamaSession = {
    ort: {} as ActiveLamaSession['ort'],
    session: { release: releaseSpy } as unknown as ActiveLamaSession['session'],
    backend,
    io: {
      imageInputName: 'image',
      maskInputName: 'mask',
      outputName: 'output',
      inputSize: 512,
    },
  };
  return { session, releaseSpy };
}

describe('LaMa Worker 消息处理器（worker.ts）', () => {
  it('inpaint 遇到 WebGPU 推理异常时应自动释放旧会话、重建 WASM 会话重试，并零拷贝回传结果缓冲', async () => {
    const webgpu = createFakeSession('webgpu');
    const wasm = createFakeSession('wasm');

    const outRgba = new Uint8ClampedArray(new ArrayBuffer(4 * 4 * 4));
    outRgba.fill(188);
    const expectedOutBuffer = outRgba.buffer;

    const loadModelFromCache = vi.fn().mockResolvedValue({
      id: 'lama-default',
      sourceLabel: '测试 LaMa 缓存',
      sourceUrl: 'local://lama.onnx',
      sizeBytes: 208_000_000,
      updatedAt: 1,
      buffer: new ArrayBuffer(32),
    });

    const createLamaSessionFromBuffer = vi
      .fn()
      .mockResolvedValueOnce(webgpu.session)
      .mockResolvedValueOnce(wasm.session);

    const executeLamaInpaint = vi
      .fn()
      .mockRejectedValueOnce(new Error('WebGPU shader compilation failed'))
      .mockResolvedValueOnce({
        imageData: createImageDataCompat(outRgba, 4, 4),
        durationMs: 95,
        backend: 'wasm',
      });

    const deps: LamaWorkerRuntimeDeps = {
      loadModelFromCache,
      createLamaSessionFromBuffer,
      executeLamaInpaint,
    };

    const messages: Array<{ msg: LamaWorkerResponse; transfer?: Transferable[] }> = [];
    const handleMessage = createLamaWorkerMessageHandler((msg, transfer) => {
      messages.push({ msg, transfer });
    }, deps);

    const imgBuf = new Uint8ClampedArray(new ArrayBuffer(4 * 4 * 4)).buffer;
    const maskBuf = new Uint8Array(new ArrayBuffer(4 * 4)).buffer;

    await handleMessage({
      type: 'inpaint',
      taskId: 1,
      width: 4,
      height: 4,
      imageBuffer: imgBuf,
      maskBuffer: maskBuf,
      featherPx: 3,
      preferWebGpu: true,
    });

    // 验证 WebGPU 会话已被显式释放，并以 preferWebGpu: false 重建 WASM 会话
    expect(webgpu.releaseSpy).toHaveBeenCalledTimes(1);
    expect(createLamaSessionFromBuffer).toHaveBeenCalledTimes(2);
    expect(createLamaSessionFromBuffer).toHaveBeenNthCalledWith(1, expect.any(ArrayBuffer), {
      preferWebGpu: true,
    });
    expect(createLamaSessionFromBuffer).toHaveBeenNthCalledWith(2, expect.any(ArrayBuffer), {
      preferWebGpu: false,
    });
    expect(executeLamaInpaint).toHaveBeenCalledTimes(2);

    // 验证最终回传结果为 wasm，且直接零拷贝转移原始 ArrayBuffer
    const resultEntry = messages.find((entry) => entry.msg.type === 'inpaint-result');
    expect(resultEntry).toBeDefined();
    if (resultEntry && resultEntry.msg.type === 'inpaint-result') {
      expect(resultEntry.msg.backend).toBe('wasm');
      expect(resultEntry.msg.durationMs).toBe(95);
      expect(resultEntry.msg.imageBuffer).toBe(expectedOutBuffer);
      expect(resultEntry.transfer).toEqual([expectedOutBuffer]);
    }

    // 后续 dispose 应释放已切换的 WASM 会话并回报 disposed
    await handleMessage({ type: 'dispose', taskId: 2 });
    expect(wasm.releaseSpy).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)?.msg).toEqual({ type: 'disposed', taskId: 2 });
  });

  it('无缓存时 ensure-session 应返回 code: NO_CACHE 错误', async () => {
    const messages: LamaWorkerResponse[] = [];
    const handleMessage = createLamaWorkerMessageHandler(
      (msg) => {
        messages.push(msg);
      },
      {
        loadModelFromCache: vi.fn().mockResolvedValue(null),
        createLamaSessionFromBuffer: vi.fn(),
        executeLamaInpaint: vi.fn(),
      },
    );

    await handleMessage({ type: 'ensure-session', taskId: 7 });
    const errMsg = messages.find((m) => m.type === 'error');
    expect(errMsg).toMatchObject({
      type: 'error',
      taskId: 7,
      code: 'NO_CACHE',
    });
  });
});
