/**
 * LaMa AI 引擎核心工具单元测试
 * 覆盖：局部裁剪拼接几何边界、NCHW 张量打包与 [0,1]/[0,255] 双值域解包、羽化回贴无损校验、无效文件与流式下载错误处理。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeCropWindow,
  computeInnerFeatherAlpha,
  detectOutputValueRange,
  packLamaInputs,
  resizeMaskForModel,
  resizeRgbaBilinear,
  resolveSessionIO,
  stitchFeatheredPatch,
  unpackLamaOutput,
} from '../lamaInference';
import {
  DEFAULT_LAMA_SOURCES,
  LamaModelError,
  downloadModel,
  importLocalModelFile,
  validateModelUrl,
  validateOnnxModelBuffer,
} from '../modelManager';

/** 构造带合法 ONNX ModelProto 头部（ir_version = 8）的测试缓冲区 */
function createFakeOnnxBuffer(byteLength: number): ArrayBuffer {
  const bytes = new Uint8Array(new ArrayBuffer(byteLength));
  // field 1 (ir_version), wire type 0 -> 0x08, value 8 -> 0x08
  bytes[0] = 0x08;
  bytes[1] = 0x08;
  // field 2 (producer_name), wire type 2 -> 0x12, len 4 -> "lama"
  bytes[2] = 0x12;
  bytes[3] = 0x04;
  bytes[4] = 0x6c;
  bytes[5] = 0x61;
  bytes[6] = 0x6d;
  bytes[7] = 0x61;
  return bytes.buffer;
}

/** 在单通道遮罩中填充矩形区域 */
function fillMaskRect(
  mask: Uint8Array,
  imgW: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      mask[py * imgW + px] = 255;
    }
  }
}

describe('computeCropWindow - 局部裁剪拼接几何边界', () => {
  it('空遮罩应返回 null', () => {
    const mask = new Uint8Array(1280 * 720);
    expect(computeCropWindow(1280, 720, mask, 512)).toBeNull();
  });

  it('1920×1080 右下角小水印应截取贴边 512×512 正方形窗口且完整包含遮罩', () => {
    const w = 1920;
    const h = 1080;
    const mask = new Uint8Array(w * h);
    fillMaskRect(mask, w, 1740, 1015, 160, 48);

    const result = computeCropWindow(w, h, mask, 512);
    expect(result).not.toBeNull();
    const { cropRect, maskBounds } = result!;

    expect(maskBounds).toEqual({ x: 1740, y: 1015, width: 160, height: 48 });
    expect(cropRect.width).toBe(512);
    expect(cropRect.height).toBe(512);
    expect(cropRect.x).toBe(w - 512);
    expect(cropRect.y).toBe(h - 512);
    // 确认遮罩完整位于裁剪窗口内且未越界
    expect(cropRect.x).toBeLessThanOrEqual(maskBounds.x);
    expect(cropRect.y).toBeLessThanOrEqual(maskBounds.y);
    expect(cropRect.x + cropRect.width).toBeGreaterThanOrEqual(maskBounds.x + maskBounds.width);
    expect(cropRect.y + cropRect.height).toBeGreaterThanOrEqual(maskBounds.y + maskBounds.height);
  });

  it('4K 大图较大水印应按至少 2.2 倍遮罩最大边截取正方形上下文窗口', () => {
    const w = 3840;
    const h = 2160;
    const mask = new Uint8Array(w * h);
    fillMaskRect(mask, w, 1600, 900, 400, 150);

    const result = computeCropWindow(w, h, mask, 512, 2.2);
    expect(result).not.toBeNull();
    const { cropRect, maskBounds } = result!;

    // ceil(400 * 2.2) = 880
    expect(cropRect.width).toBe(880);
    expect(cropRect.height).toBe(880);
    expect(cropRect.x).toBeGreaterThanOrEqual(0);
    expect(cropRect.y).toBeGreaterThanOrEqual(0);
    expect(cropRect.x + cropRect.width).toBeLessThanOrEqual(w);
    expect(cropRect.y + cropRect.height).toBeLessThanOrEqual(h);
    expect(cropRect.x).toBeLessThanOrEqual(maskBounds.x);
    expect(cropRect.y).toBeLessThanOrEqual(maskBounds.y);
    expect(cropRect.x + cropRect.width).toBeGreaterThanOrEqual(maskBounds.x + maskBounds.width);
    expect(cropRect.y + cropRect.height).toBeGreaterThanOrEqual(maskBounds.y + maskBounds.height);
  });

  it('小于 512 的小图裁剪窗口应严格受限于图像尺寸', () => {
    const w = 320;
    const h = 200;
    const mask = new Uint8Array(w * h);
    fillMaskRect(mask, w, 10, 10, 80, 30);

    const result = computeCropWindow(w, h, mask, 512);
    expect(result).not.toBeNull();
    expect(result!.cropRect).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });

  it('超宽横幅水印超过短边时仍应完整覆盖整个遮罩区域', () => {
    const w = 1920;
    const h = 1080;
    const mask = new Uint8Array(w * h);
    fillMaskRect(mask, w, 200, 500, 1400, 80);

    const result = computeCropWindow(w, h, mask, 512);
    expect(result).not.toBeNull();
    const { cropRect, maskBounds } = result!;
    expect(cropRect.x).toBeLessThanOrEqual(maskBounds.x);
    expect(cropRect.x + cropRect.width).toBeGreaterThanOrEqual(maskBounds.x + maskBounds.width);
    expect(cropRect.y).toBeLessThanOrEqual(maskBounds.y);
    expect(cropRect.y + cropRect.height).toBeGreaterThanOrEqual(maskBounds.y + maskBounds.height);
    expect(cropRect.width).toBeLessThanOrEqual(w);
    expect(cropRect.height).toBeLessThanOrEqual(h);
  });
});

describe('NCHW 张量打包与 [0,1]/[0,255] 双值域自适应解包', () => {
  it('packLamaInputs 应正确生成 NCHW 通道布局与二值遮罩', () => {
    const size = 2;
    const rgba = new Uint8ClampedArray([
      255,
      0,
      128,
      255, // (0,0)
      0,
      255,
      64,
      200, // (1,0)
      51,
      102,
      153,
      255, // (0,1)
      0,
      0,
      0,
      255, // (1,1)
    ]);
    const mask = new Uint8Array([0, 255, 128, 0]);

    const { imageData, maskData, imageDims, maskDims } = packLamaInputs(rgba, mask, size);
    expect(imageDims).toEqual([1, 3, 2, 2]);
    expect(maskDims).toEqual([1, 1, 2, 2]);

    // R 平面 (0..3)
    expect(imageData[0]).toBeCloseTo(1.0, 5);
    expect(imageData[1]).toBeCloseTo(0.0, 5);
    expect(imageData[2]).toBeCloseTo(51 / 255, 5);
    expect(imageData[3]).toBeCloseTo(0.0, 5);

    // G 平面 (4..7)
    expect(imageData[4]).toBeCloseTo(0.0, 5);
    expect(imageData[5]).toBeCloseTo(1.0, 5);
    expect(imageData[6]).toBeCloseTo(102 / 255, 5);

    // B 平面 (8..11)
    expect(imageData[8]).toBeCloseTo(128 / 255, 5);
    expect(imageData[9]).toBeCloseTo(64 / 255, 5);
    expect(imageData[10]).toBeCloseTo(153 / 255, 5);

    // 遮罩二值化：非零即 1.0
    expect(Array.from(maskData)).toEqual([0, 1, 1, 0]);
  });

  it('unpackLamaOutput 应自动识别 [0,1] 浮点输出并还原至 0..255（含越界截断）', () => {
    const size = 2;
    const unitTensor = new Float32Array([
      // R
      -0.05, 0.5, 1.04, 0.2,
      // G
      0.0, 1.0, 0.25, 0.8,
      // B
      0.5, 0.0, 1.0, 0.0,
    ]);

    expect(detectOutputValueRange(unitTensor)).toBe('unit');
    const { rgba, detectedRange } = unpackLamaOutput(unitTensor, size, size, [1, 3, 2, 2]);
    expect(detectedRange).toBe('unit');

    // 像素 0: (-0.05->0, 0, 0.5->128, 255)
    expect(Array.from(rgba.slice(0, 4))).toEqual([0, 0, 128, 255]);
    // 像素 1: (0.5->128, 1->255, 0, 255)
    expect(Array.from(rgba.slice(4, 8))).toEqual([128, 255, 0, 255]);
    // 像素 2: (1.04->255, 0.25->64, 1->255, 255)
    expect(Array.from(rgba.slice(8, 12))).toEqual([255, 64, 255, 255]);
  });

  it('unpackLamaOutput 应自动识别 [0,255] 浮点输出并直接截断回 0..255', () => {
    const size = 2;
    const byteTensor = new Float32Array([
      // R
      -5.2, 120.4, 260.8, 12.6,
      // G
      10, 200, 30, 40,
      // B
      255, 0, 128, 64,
    ]);

    expect(detectOutputValueRange(byteTensor)).toBe('byte');
    const { rgba, detectedRange } = unpackLamaOutput(byteTensor, size, size, [1, 3, 2, 2]);
    expect(detectedRange).toBe('byte');

    expect(Array.from(rgba.slice(0, 4))).toEqual([0, 10, 255, 255]);
    expect(Array.from(rgba.slice(4, 8))).toEqual([120, 200, 0, 255]);
    expect(Array.from(rgba.slice(8, 12))).toEqual([255, 30, 128, 255]);
    expect(Array.from(rgba.slice(12, 16))).toEqual([13, 40, 64, 255]);
  });

  it('resolveSessionIO 应兼容常见 LaMa 输入/输出命名及元数据分辨率', () => {
    const standard = resolveSessionIO(
      ['image', 'mask'],
      ['output'],
      [
        { name: 'image', isTensor: true, shape: [1, 3, 512, 512] },
        { name: 'mask', isTensor: true, shape: [1, 1, 512, 512] },
      ],
    );
    expect(standard).toEqual({
      imageInputName: 'image',
      maskInputName: 'mask',
      outputName: 'output',
      inputSize: 512,
    });

    const variant = resolveSessionIO(
      ['inpaint_mask', 'input_img'],
      ['inpainted'],
      [
        { name: 'inpaint_mask', isTensor: true, shape: [1, 1, 800, 800] },
        { name: 'input_img', isTensor: true, shape: [1, 3, 800, 800] },
      ],
    );
    expect(variant).toEqual({
      imageInputName: 'input_img',
      maskInputName: 'inpaint_mask',
      outputName: 'inpainted',
      inputSize: 800,
    });
  });
});

describe('羽化回贴与缩放工具 - 保证非遮罩区 100% 无损', () => {
  it('stitchFeatheredPatch 不应改动任何非遮罩像素，且对遮罩内缘实现平滑过渡', () => {
    const imgW = 64;
    const imgH = 64;
    const original = new Uint8ClampedArray(imgW * imgH * 4);

    // 填充确定性渐变底图（含自定义 Alpha 测试透明度保留）
    for (let y = 0; y < imgH; y += 1) {
      for (let x = 0; x < imgW; x += 1) {
        const p = (y * imgW + x) * 4;
        original[p] = (x * 3) % 256;
        original[p + 1] = (y * 3) % 256;
        original[p + 2] = 40;
        original[p + 3] = 240;
      }
    }

    const mask = new Uint8Array(imgW * imgH);
    fillMaskRect(mask, imgW, 20, 20, 20, 20);

    const cropRect = { x: 10, y: 10, width: 40, height: 40 };
    // 构造全白修复结果块（250, 250, 250）
    const patchRgba = new Uint8ClampedArray(cropRect.width * cropRect.height * 4);
    for (let i = 0; i < patchRgba.length; i += 4) {
      patchRgba[i] = 250;
      patchRgba[i + 1] = 250;
      patchRgba[i + 2] = 250;
      patchRgba[i + 3] = 255;
    }

    const stitched = stitchFeatheredPatch(original, imgW, imgH, mask, patchRgba, cropRect, 4);

    // 1. 严格校验每一个非遮罩像素 100% 字节级未改动
    for (let i = 0; i < imgW * imgH; i += 1) {
      if (mask[i] === 0) {
        const p = i * 4;
        expect(stitched[p]).toBe(original[p]);
        expect(stitched[p + 1]).toBe(original[p + 1]);
        expect(stitched[p + 2]).toBe(original[p + 2]);
        expect(stitched[p + 3]).toBe(original[p + 3]);
      }
    }

    // 2. 遮罩中心深处应完全替换为修复色，并保留原图 Alpha (240)
    const centerIdx = (30 * imgW + 30) * 4;
    expect(stitched[centerIdx]).toBe(250);
    expect(stitched[centerIdx + 1]).toBe(250);
    expect(stitched[centerIdx + 2]).toBe(250);
    expect(stitched[centerIdx + 3]).toBe(240);

    // 3. 遮罩内缘 (x=20, y=30) 应处于原图值与修复值之间，实现柔和过渡
    const edgeIdx = (30 * imgW + 20) * 4;
    expect(stitched[edgeIdx]).toBeGreaterThan(original[edgeIdx]);
    expect(stitched[edgeIdx]).toBeLessThan(250);
  });

  it('紧贴画布右下角的遮罩边缘应完全替换，不被画布外边界错误衰减', () => {
    const w = 16;
    const h = 16;
    const mask = new Uint8Array(w * h);
    // 右下角 8×8 区域直接贴边至 (15, 15)
    fillMaskRect(mask, w, 8, 8, 8, 8);

    const alpha = computeInnerFeatherAlpha(mask, w, h, 3);
    // 右下角最外缘像素 (15, 15) 距离最近非遮罩像素 > 3，应为 1.0
    expect(alpha[15 * w + 15]).toBe(1);
    // 遮罩外部 (0, 0) 恒为 0
    expect(alpha[0]).toBe(0);
    // 与非遮罩直接相邻的内缘像素 (8, 12) 应处于 (0, 1)
    expect(alpha[12 * w + 8]).toBeGreaterThan(0);
    expect(alpha[12 * w + 8]).toBeLessThan(1);
  });

  it('resizeMaskForModel 下采样应保留 1px 细水印笔画不丢失，resizeRgbaBilinear 尺寸准确', () => {
    const srcW = 64;
    const srcH = 64;
    const srcMask = new Uint8Array(srcW * srcH);
    // 放置一条 1px 细线
    for (let x = 10; x < 50; x += 1) {
      srcMask[32 * srcW + x] = 255;
    }

    const downMask = resizeMaskForModel(srcMask, srcW, srcH, 16, 16);
    const activeCount = downMask.reduce((acc, v) => acc + (v > 0 ? 1 : 0), 0);
    expect(activeCount).toBeGreaterThanOrEqual(10);

    const srcRgba = new Uint8ClampedArray(16 * 16 * 4).fill(180);
    const upRgba = resizeRgbaBilinear(srcRgba, 16, 16, 32, 32);
    expect(upRgba.length).toBe(32 * 32 * 4);
    expect(upRgba[0]).toBe(180);
  });
});

describe('模型文件校验与多源流式下载管理', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DEFAULT_LAMA_SOURCES 首位应为 hf-mirror 国内镜像且包含 HuggingFace 官方源', () => {
    expect(DEFAULT_LAMA_SOURCES.length).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_LAMA_SOURCES[0].url).toContain('hf-mirror.com/Carve/LaMa-ONNX');
    expect(DEFAULT_LAMA_SOURCES.some((s) => s.url.includes('huggingface.co/Carve/LaMa-ONNX'))).toBe(
      true,
    );
  });

  it('validateOnnxModelBuffer 应拦截空文件、HTML/JSON 错误页、图片/ZIP 文件及过小残缺文件', () => {
    expect(validateOnnxModelBuffer(new ArrayBuffer(0)).valid).toBe(false);

    const htmlBytes = new TextEncoder().encode('<!DOCTYPE html><html><body>404</body></html>');
    const htmlRes = validateOnnxModelBuffer(htmlBytes, { minBytes: 10 });
    expect(htmlRes.valid).toBe(false);
    if (!htmlRes.valid) expect(htmlRes.reason).toContain('网页');

    const jsonBytes = new TextEncoder().encode('{"error": "Repository not found"}');
    expect(validateOnnxModelBuffer(jsonBytes, { minBytes: 10 }).valid).toBe(false);

    const pngBytes = new Uint8Array(2048);
    pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pngRes = validateOnnxModelBuffer(pngBytes, { minBytes: 1024 });
    expect(pngRes.valid).toBe(false);
    if (!pngRes.valid) expect(pngRes.reason).toContain('PNG');

    // 头部有效但体积小于阈值
    const tinyOnnx = createFakeOnnxBuffer(512);
    const tinyRes = validateOnnxModelBuffer(tinyOnnx, { minBytes: 4096 });
    expect(tinyRes.valid).toBe(false);
    if (!tinyRes.valid) expect(tinyRes.reason).toContain('体积过小');

    // 合法 ONNX 头部且体积达标应通过校验
    const validOnnx = createFakeOnnxBuffer(4096);
    expect(validateOnnxModelBuffer(validOnnx, { minBytes: 1024 })).toEqual({ valid: true });
  });

  it('importLocalModelFile 应拒绝非 .onnx 扩展名与空文件', async () => {
    const wrongExt = new File([new Uint8Array(100)], 'model.bin');
    await expect(importLocalModelFile(wrongExt, { minBytes: 16 })).rejects.toMatchObject({
      code: 'INVALID_MODEL',
    });

    const emptyOnnx = new File([], 'lama.onnx');
    await expect(importLocalModelFile(emptyOnnx, { minBytes: 16 })).rejects.toMatchObject({
      code: 'INVALID_MODEL',
    });
  });

  it('validateModelUrl 应拦截非法协议与空地址', () => {
    expect(() => validateModelUrl('')).toThrow(LamaModelError);
    expect(() => validateModelUrl('file:///etc/passwd')).toThrow(LamaModelError);
    expect(
      validateModelUrl('https://hf-mirror.com/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx'),
    ).toBe('https://hf-mirror.com/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx');
  });

  it('downloadModel 应正确处理流式进度、HTTP 404、CORS 网络异常、HTML 误响应与取消信号', async () => {
    // 1. 正常流式下载 + 进度回调
    const fakePayload = new Uint8Array(createFakeOnnxBuffer(4096));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(fakePayload.slice(0, 2048));
        controller.enqueue(fakePayload.slice(2048));
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': '4096',
        },
      }),
    );

    const progressUpdates: number[] = [];
    const buf = await downloadModel('https://example.com/lama_fp32.onnx', {
      minBytes: 1024,
      onProgress: (p) => {
        if (typeof p.percent === 'number') progressUpdates.push(p.percent);
      },
    });
    expect(buf.byteLength).toBe(4096);
    expect(progressUpdates[progressUpdates.length - 1]).toBe(100);

    // 2. HTTP 404 错误区分
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );
    await expect(
      downloadModel('https://example.com/missing.onnx', { minBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR', httpStatus: 404 });

    // 3. 网络/CORS 异常区分
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(
      downloadModel('https://example.com/cors-blocked.onnx', { minBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'NETWORK_OR_CORS' });

    // 4. text/html 响应拦截
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html>login</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    await expect(
      downloadModel('https://example.com/html-page.onnx', { minBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL' });

    // 5. AbortController 取消区分
    const ac = new AbortController();
    ac.abort();
    await expect(
      downloadModel('https://example.com/lama_fp32.onnx', { signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
