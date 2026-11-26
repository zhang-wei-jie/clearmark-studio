/**
 * 内置 MI-GAN 本地 AI 引擎工具单元测试
 * 覆盖：双角选区分簇裁剪、512×512 反转掩码保守投影、羽化回贴与非遮罩区逐字节无损校验。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeMiganSession, preloadMiganModel } from '../index';
import {
  MIGAN_INPUT_SIZE,
  computeClusterCropWindows,
  prepareMiganInput,
  stitchMiganResultIntoOutput,
} from '../miganUtils';

function fillRect(mask: Uint8Array, w: number, x: number, y: number, rw: number, rh: number): void {
  for (let py = y; py < y + rh; py++) {
    for (let px = x; px < x + rw; px++) {
      mask[py * w + px] = 255;
    }
  }
}

describe('MI-GAN 分簇局部裁剪、反转掩码打包与无损回贴', () => {
  it('双角分离选区应拆分为两个独立局部 512×512 窗口，避免整图压缩变糊', () => {
    const w = 1920;
    const h = 1080;
    const mask = new Uint8Array(w * h);
    fillRect(mask, w, 24, 24, 120, 48); // 左上角
    fillRect(mask, w, w - 240, h - 90, 200, 60); // 右下角

    const plans = computeClusterCropWindows(w, h, mask, MIGAN_INPUT_SIZE);
    expect(plans.length).toBe(2);

    for (const plan of plans) {
      expect(plan.cropRect.width).toBe(512);
      expect(plan.cropRect.height).toBe(512);
      expect(plan.cropRect.x).toBeLessThanOrEqual(plan.clusterRect.x);
      expect(plan.cropRect.y).toBeLessThanOrEqual(plan.clusterRect.y);
      expect(plan.cropRect.x + plan.cropRect.width).toBeGreaterThanOrEqual(
        plan.clusterRect.x + plan.clusterRect.width,
      );
      expect(plan.cropRect.y + plan.cropRect.height).toBeGreaterThanOrEqual(
        plan.clusterRect.y + plan.clusterRect.height,
      );
    }
  });

  it('prepareMiganInput 应生成反转掩码（255=保留, 0=修复），且全图遮罩时报错提示', () => {
    const w = 64;
    const h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(120);
    const mask = new Uint8Array(w * h);
    // 1px 细水平线，验证缩小后不丢失
    for (let x = 10; x < 50; x++) {
      mask[32 * w + x] = 255;
    }

    const { rgba512, mask512 } = prepareMiganInput(
      rgba,
      mask,
      w,
      { x: 0, y: 0, width: w, height: h },
      32,
    );
    expect(rgba512.length).toBe(32 * 32 * 4);
    expect(mask512.length).toBe(32 * 32);

    const holes = mask512.reduce((acc, v) => acc + (v === 0 ? 1 : 0), 0);
    const keeps = mask512.reduce((acc, v) => acc + (v === 255 ? 1 : 0), 0);
    expect(holes).toBeGreaterThanOrEqual(15);
    expect(keeps).toBeGreaterThan(500);

    // 选区完全覆盖窗口时抛出中文提示
    const fullMask = new Uint8Array(w * h).fill(255);
    expect(() =>
      prepareMiganInput(rgba, fullMask, w, { x: 0, y: 0, width: w, height: h }, 32),
    ).toThrow(/选区过大/);
  });

  it('stitchMiganResultIntoOutput 应仅写入遮罩内像素、沿用预填透明通道，并保证遮罩外零改动', () => {
    const w = 80;
    const h = 80;
    const original = new Uint8ClampedArray(w * h * 4);
    const prefilled = new Uint8ClampedArray(w * h * 4);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        original[p] = (x * 3) % 256;
        original[p + 1] = (y * 3) % 256;
        original[p + 2] = 60;
        original[p + 3] = 220;

        prefilled[p] = 100;
        prefilled[p + 1] = 110;
        prefilled[p + 2] = 120;
        prefilled[p + 3] = 200;
      }
    }

    const mask = new Uint8Array(w * h);
    fillRect(mask, w, 24, 24, 24, 24);

    const output = new Uint8ClampedArray(original);
    const modelOut = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < modelOut.length; i += 4) {
      modelOut[i] = 240;
      modelOut[i + 1] = 210;
      modelOut[i + 2] = 180;
      modelOut[i + 3] = 255;
    }

    stitchMiganResultIntoOutput(
      output,
      original,
      prefilled,
      mask,
      w,
      { x: 10, y: 10, width: 60, height: 60 },
      modelOut,
      32,
      2,
    );

    // 非遮罩区逐字节无损
    for (let i = 0; i < w * h; i++) {
      if (mask[i] === 0) {
        const p = i * 4;
        expect(output[p]).toBe(original[p]);
        expect(output[p + 1]).toBe(original[p + 1]);
        expect(output[p + 2]).toBe(original[p + 2]);
        expect(output[p + 3]).toBe(original[p + 3]);
      }
    }

    // 遮罩深处采用模型 RGB 且透明通道沿用 prefilled (200)
    const center = (36 * w + 36) * 4;
    expect(output[center]).toBe(240);
    expect(output[center + 1]).toBe(210);
    expect(output[center + 2]).toBe(180);
    expect(output[center + 3]).toBe(200);
  });

  it('传入 clusterRect 与 writtenMask 时仅回贴当前簇，避免多簇重叠裁剪窗互相覆写', () => {
    const w = 80;
    const h = 40;
    const original = new Uint8ClampedArray(w * h * 4).fill(50);
    const prefilled = new Uint8ClampedArray(w * h * 4).fill(80);
    const mask = new Uint8Array(w * h);
    fillRect(mask, w, 10, 10, 10, 10); // 簇 1
    fillRect(mask, w, 50, 10, 10, 10); // 簇 2

    const output = new Uint8ClampedArray(original);
    const writtenMask = new Uint8Array(w * h);
    const modelOut1 = new Uint8ClampedArray(32 * 32 * 4).fill(210);
    const modelOut2 = new Uint8ClampedArray(32 * 32 * 4).fill(140);

    // 即使裁剪窗口覆盖两个簇，簇 1 回贴也只应写入 clusterRect1 内的像素
    stitchMiganResultIntoOutput(
      output,
      original,
      prefilled,
      mask,
      w,
      { x: 0, y: 0, width: w, height: h },
      modelOut1,
      32,
      0,
      { clusterRect: { x: 10, y: 10, width: 10, height: 10 }, writtenMask },
    );

    expect(output[(15 * w + 15) * 4]).toBe(210);
    // 簇 2 仍保持原值尚未被簇 1 覆写
    expect(output[(15 * w + 55) * 4]).toBe(50);

    stitchMiganResultIntoOutput(
      output,
      original,
      prefilled,
      mask,
      w,
      { x: 0, y: 0, width: w, height: h },
      modelOut2,
      32,
      0,
      { clusterRect: { x: 50, y: 10, width: 10, height: 10 }, writtenMask },
    );

    expect(output[(15 * w + 15) * 4]).toBe(210);
    expect(output[(15 * w + 55) * 4]).toBe(140);
  });
});

describe('MI-GAN 会话生命周期与队列防死锁', () => {
  afterEach(async () => {
    await disposeMiganSession();
    vi.unstubAllGlobals();
  });

  it('任务挂起期间调用 disposeMiganSession 应立即中止当前任务并保持后续队列可用', async () => {
    let instanceCount = 0;
    class FakeWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      private readonly id: number;

      constructor() {
        instanceCount += 1;
        this.id = instanceCount;
      }

      postMessage(msg: { type: string; taskId: number }) {
        // 第一个 Worker 模拟永久卡住，第二个 Worker 正常返回 ready
        if (this.id >= 2 && msg.type === 'preload') {
          queueMicrotask(() => {
            if (!this.terminated) {
              this.onmessage?.({
                data: { type: 'ready', taskId: msg.taskId, sizeBytes: 28_079_181 },
              } as MessageEvent);
            }
          });
        }
      }

      terminate() {
        this.terminated = true;
      }
    }

    vi.stubGlobal('Worker', FakeWorker);

    const firstAttempt = preloadMiganModel();
    // 等待微任务让 sendWorkerJob 注册到队列
    await Promise.resolve();
    await disposeMiganSession();

    await expect(firstAttempt).rejects.toMatchObject({ name: 'AbortError' });

    // 验证 serialQueue 未死锁，后续预加载可正常完成
    const status = await preloadMiganModel();
    expect(status.state).toBe('ready');
    expect(status.backend).toBe('wasm');
  });
});
