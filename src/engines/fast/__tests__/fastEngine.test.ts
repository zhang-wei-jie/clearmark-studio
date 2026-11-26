import { describe, expect, it } from 'vitest';
import type { InpaintProgress, MatchedWatermark, WatermarkTemplateId } from '../../../types';
import { deduplicateMatches } from '../autoDetect';
import { createImageDataSafe, findMaskClusters } from '../inpaintCore';
import { runCornerAutoDetect, runFastInpaint, runMaskStrokeRefine } from '../index';
import { WATERMARK_TEMPLATES, sampleTemplateAlpha } from '../templates';

/** 紧凑 5×7 点阵字库，用于在无 Canvas 环境的 jsdom 中精确绘制合成水印文字 */
const BITMAP_FONT: Record<string, readonly string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** 构造带自然渐变与细腻重复纹理的合成背景图（作为无水印真值） */
function createGradientTextureImage(width: number, height: number, brightMode = false): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const ty = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x++) {
      const tx = x / Math.max(1, width - 1);
      // 平滑天空/建筑渐变 + 柔和周期条纹纹理
      const wave = Math.sin(x * 0.14 + y * 0.08) * 10 + Math.cos(y * 0.22) * 6;
      const off = (y * width + x) * 4;
      if (brightMode) {
        data[off] = clampByte(226 - tx * 18 + ty * 14 + wave * 0.35);
        data[off + 1] = clampByte(230 - tx * 14 + ty * 10 + wave * 0.35);
        data[off + 2] = clampByte(238 - tx * 10 + ty * 8 + wave * 0.35);
        data[off + 3] = 255;
      } else {
        data[off] = clampByte(34 + tx * 95 + ty * 55 + wave);
        data[off + 1] = clampByte(58 + tx * 65 + (1 - ty) * 70 + wave * 0.85);
        data[off + 2] = clampByte(110 + (1 - tx) * 75 + ty * 45 + wave * 0.7);
        data[off + 3] = 255;
      }
    }
  }
  return createImageDataSafe(data, width, height);
}

/** 构造均匀高频自然纹理图（模拟满幅草地/砖纹/细网格，用于校验防误报） */
function createUniformTextureImage(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 全图一致的伪随机草叶/纹理高频起伏
      const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const noise = (hash - Math.floor(hash) - 0.5) * 48;
      const stripe = Math.sin(x * 0.65) * 18 + Math.cos(y * 0.75) * 18;
      const off = (y * width + x) * 4;
      data[off] = clampByte(96 + stripe + noise);
      data[off + 1] = clampByte(132 + stripe * 0.9 + noise);
      data[off + 2] = clampByte(78 + stripe * 0.7 + noise);
      data[off + 3] = 255;
    }
  }
  return createImageDataSafe(data, width, height);
}

interface WatermarkStamp {
  imageData: ImageData;
  bbox: { x: number; y: number; width: number; height: number };
}

/** 在指定坐标叠加半透明点阵文字水印（可选柔和投影），返回带水印副本及真实像素框 */
function stampTextWatermark(
  base: ImageData,
  text: string,
  originX: number,
  originY: number,
  options: {
    scale?: number;
    color?: [number, number, number];
    alpha?: number;
    shadow?: boolean;
  } = {},
): WatermarkStamp {
  const { width, height } = base;
  const scale = options.scale ?? 3;
  const [wr, wg, wb] = options.color ?? [255, 255, 255];
  const alpha = options.alpha ?? 0.68;
  const shadow = options.shadow ?? true;

  const outData = new Uint8ClampedArray(base.data);
  const charAdvance = 6 * scale;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  const blendPixel = (px: number, py: number, r: number, g: number, b: number, a: number) => {
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    const off = (py * width + px) * 4;
    outData[off] = clampByte(outData[off] * (1 - a) + r * a);
    outData[off + 1] = clampByte(outData[off + 1] * (1 - a) + g * a);
    outData[off + 2] = clampByte(outData[off + 2] * (1 - a) + b * a);
  };

  for (let ci = 0; ci < text.length; ci++) {
    const ch = text[ci].toUpperCase();
    const glyph = BITMAP_FONT[ch] ?? BITMAP_FONT[' '];
    const gx0 = originX + ci * charAdvance;

    for (let row = 0; row < glyph.length; row++) {
      for (let col = 0; col < glyph[row].length; col++) {
        if (glyph[row][col] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = gx0 + col * scale + sx;
            const py = originY + row * scale + sy;
            if (shadow) {
              blendPixel(px + 1, py + 1, 12, 14, 18, alpha * 0.35);
            }
            blendPixel(px, py, wr, wg, wb, alpha);
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
          }
        }
      }
    }
  }

  return {
    imageData: createImageDataSafe(outData, width, height),
    bbox: {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX + 1),
      height: Math.max(1, maxY - minY + 1),
    },
  };
}

/** 根据像素矩形构造二值遮罩（支持外扩 padding） */
function createRectMask(
  width: number,
  height: number,
  rects: Array<{ x: number; y: number; width: number; height: number }>,
  pad = 4,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const rect of rects) {
    const x0 = Math.max(0, rect.x - pad);
    const y0 = Math.max(0, rect.y - pad);
    const x1 = Math.min(width - 1, rect.x + rect.width - 1 + pad);
    const y1 = Math.min(height - 1, rect.y + rect.height - 1 + pad);
    for (let y = y0; y <= y1; y++) {
      const rowOff = y * width;
      for (let x = x0; x <= x1; x++) {
        mask[rowOff + x] = 255;
      }
    }
  }
  return mask;
}

/** 计算指定遮罩区域内与真值图的 RGB MSE 与 PSNR */
function computeMaskedMetrics(
  candidate: ImageData,
  groundTruth: ImageData,
  mask: Uint8Array,
): { mse: number; psnr: number; maskedPixels: number } {
  let sumSq = 0;
  let maskedPixels = 0;
  const total = candidate.width * candidate.height;
  for (let i = 0; i < total; i++) {
    if (mask[i] === 0) continue;
    const off = i * 4;
    const dr = candidate.data[off] - groundTruth.data[off];
    const dg = candidate.data[off + 1] - groundTruth.data[off + 1];
    const db = candidate.data[off + 2] - groundTruth.data[off + 2];
    sumSq += dr * dr + dg * dg + db * db;
    maskedPixels++;
  }
  const mse = maskedPixels > 0 ? sumSq / (maskedPixels * 3) : 0;
  const psnr = mse > 1e-9 ? 10 * Math.log10((255 * 255) / mse) : 99;
  return { mse, psnr, maskedPixels };
}

/** 校验所有遮罩外像素（含 Alpha 通道）与输入图像 100% 字节级一致 */
function countOutsideMaskDiffs(output: ImageData, input: ImageData, mask: Uint8Array): number {
  let diffs = 0;
  const total = output.width * output.height;
  for (let i = 0; i < total; i++) {
    if (mask[i] > 0) continue;
    const off = i * 4;
    if (
      output.data[off] !== input.data[off] ||
      output.data[off + 1] !== input.data[off + 1] ||
      output.data[off + 2] !== input.data[off + 2] ||
      output.data[off + 3] !== input.data[off + 3]
    ) {
      diffs++;
    }
  }
  return diffs;
}

describe('快速去水印引擎 (inpaintCore & index)', () => {
  it('在渐变+纹理背景上显著降低角落水印误差，且遮罩外像素 100% 字节级无损', async () => {
    const width = 360;
    const height = 240;
    const clean = createGradientTextureImage(width, height);
    const stamped = stampTextWatermark(clean, 'JIMENG AI', width - 178, height - 34, {
      scale: 3,
      alpha: 0.72,
    });
    const mask = createRectMask(width, height, [stamped.bbox], 4);

    const beforeMetrics = computeMaskedMetrics(stamped.imageData, clean, mask);
    expect(beforeMetrics.mse).toBeGreaterThan(800);

    const progressLog: InpaintProgress[] = [];
    const standardOut = await runFastInpaint(
      {
        imageData: stamped.imageData,
        mask,
        quality: 'standard',
        featherPx: 3,
      },
      {
        onProgress: (p) => progressLog.push(p),
      },
    );

    expect(standardOut.backend).toBe('fast-main');
    expect(standardOut.durationMs).toBeGreaterThanOrEqual(0);
    expect(progressLog.length).toBeGreaterThanOrEqual(3);
    expect(progressLog[progressLog.length - 1].percent).toBe(100);

    // 严格验证非遮罩区零改动
    expect(countOutsideMaskDiffs(standardOut.imageData, stamped.imageData, mask)).toBe(0);

    const standardMetrics = computeMaskedMetrics(standardOut.imageData, clean, mask);
    expect(standardMetrics.mse).toBeLessThan(beforeMetrics.mse * 0.2);
    expect(standardMetrics.psnr - beforeMetrics.psnr).toBeGreaterThan(7);

    // 验证 high 精细档位同样显著改善且保持非遮罩区无损
    const highOut = await runFastInpaint({
      imageData: stamped.imageData,
      mask,
      quality: 'high',
      featherPx: 3,
    });
    expect(countOutsideMaskDiffs(highOut.imageData, stamped.imageData, mask)).toBe(0);

    const highMetrics = computeMaskedMetrics(highOut.imageData, clean, mask);
    expect(highMetrics.mse).toBeLessThan(beforeMetrics.mse * 0.2);
    expect(highMetrics.psnr - beforeMetrics.psnr).toBeGreaterThan(7);
  });

  it('支持双角独立 ROI 聚类修补、空遮罩直通与 AbortSignal 取消', async () => {
    const width = 480;
    const height = 300;
    const clean = createGradientTextureImage(width, height);
    const stamp1 = stampTextWatermark(clean, 'AI', 18, 16, { scale: 3, alpha: 0.75 });
    const stamp2 = stampTextWatermark(stamp1.imageData, 'KLING', width - 110, height - 34, {
      scale: 3,
      alpha: 0.75,
    });
    const dualMask = createRectMask(width, height, [stamp1.bbox, stamp2.bbox], 4);

    const beforeDual = computeMaskedMetrics(stamp2.imageData, clean, dualMask);
    const dualOut = await runFastInpaint({
      imageData: stamp2.imageData,
      mask: dualMask,
      quality: 'standard',
      featherPx: 3,
    });

    expect(countOutsideMaskDiffs(dualOut.imageData, stamp2.imageData, dualMask)).toBe(0);
    const afterDual = computeMaskedMetrics(dualOut.imageData, clean, dualMask);
    expect(afterDual.mse).toBeLessThan(beforeDual.mse * 0.22);
    expect(afterDual.psnr - beforeDual.psnr).toBeGreaterThan(6.5);

    // 空遮罩应快速无损返回原图拷贝
    const emptyMask = new Uint8Array(width * height);
    const emptyOut = await runFastInpaint({ imageData: clean, mask: emptyMask });
    expect(countOutsideMaskDiffs(emptyOut.imageData, clean, emptyMask)).toBe(0);

    // 遮罩尺寸不匹配时明确抛错
    await expect(runFastInpaint({ imageData: clean, mask: new Uint8Array(10) })).rejects.toThrow(
      /遮罩尺寸与图像不匹配/,
    );

    // 已取消信号立即抛出 AbortError
    const controller = new AbortController();
    controller.abort();
    await expect(
      runFastInpaint(
        { imageData: stamp2.imageData, mask: dualMask },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('4K 大图角落水印仅提取局部 ROI 快速完成，非遮罩区 100% 字节级无损', async () => {
    const width = 3840;
    const height = 2160;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const rowOff = y * width * 4;
      const gVal = (40 + (y * 120) / height) | 0;
      for (let x = 0; x < width; x++) {
        const off = rowOff + x * 4;
        data[off] = (30 + (x * 90) / width) | 0;
        data[off + 1] = gVal;
        data[off + 2] = 115;
        data[off + 3] = 255;
      }
    }
    const clean4k = createImageDataSafe(data, width, height);
    const stamped4k = stampTextWatermark(clean4k, 'JIMENG AI', width - 240, height - 48, {
      scale: 4,
      alpha: 0.72,
    });
    const mask4k = createRectMask(width, height, [stamped4k.bbox], 5);

    const before = computeMaskedMetrics(stamped4k.imageData, clean4k, mask4k);
    const out = await runFastInpaint({
      imageData: stamped4k.imageData,
      mask: mask4k,
      quality: 'standard',
      featherPx: 3,
    });
    const after = computeMaskedMetrics(out.imageData, clean4k, mask4k);

    expect(countOutsideMaskDiffs(out.imageData, stamped4k.imageData, mask4k)).toBe(0);
    expect(after.mse).toBeLessThan(before.mse * 0.12);
    expect(after.psnr - before.psnr).toBeGreaterThan(9);
  });
});

describe('智能角落水印自动检测 (autoDetect)', () => {
  it('准确识别右下角浅色半透明文字水印并生成外扩遮罩，且与快速修复串联有效', async () => {
    const width = 640;
    const height = 400;
    const clean = createGradientTextureImage(width, height);
    const stamped = stampTextWatermark(clean, 'JIMENG AI', width - 180, height - 36, {
      scale: 3,
      alpha: 0.65,
    });

    const result = await runCornerAutoDetect(stamped.imageData, 'medium');

    expect(result.detected).toBe(true);
    expect(result.corner).toBe('bottom-right');
    expect(result.confidence).toBeGreaterThanOrEqual(0.46);
    expect(result.rect).toBeDefined();
    expect(result.mask).toBeInstanceOf(Uint8Array);
    expect(result.mask?.length).toBe(width * height);
    expect(result.message).toContain('右下角');

    // 验证检测框准确包络合成水印区域
    const rect = result.rect!;
    expect(rect.x).toBeLessThanOrEqual(stamped.bbox.x + 2);
    expect(rect.y).toBeLessThanOrEqual(stamped.bbox.y + 2);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(stamped.bbox.x + stamped.bbox.width - 2);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(stamped.bbox.y + stamped.bbox.height - 2);

    // 串联端到端去水印：直接把自动检测输出的 mask 喂给快速引擎
    const before = computeMaskedMetrics(stamped.imageData, clean, result.mask!);
    const repaired = await runFastInpaint({
      imageData: stamped.imageData,
      mask: result.mask!,
      quality: 'standard',
    });
    const after = computeMaskedMetrics(repaired.imageData, clean, result.mask!);
    expect(after.mse).toBeLessThan(before.mse * 0.25);
    expect(countOutsideMaskDiffs(repaired.imageData, stamped.imageData, result.mask!)).toBe(0);
  });

  it('准确识别左上角浅色水印与浅底深色水印', async () => {
    const width = 640;
    const height = 400;

    // 场景 A：深底左上角浅色半透明水印
    const darkBase = createGradientTextureImage(width, height, false);
    const topLeftLight = stampTextWatermark(darkBase, 'KLING AI', 20, 18, {
      scale: 3,
      color: [255, 255, 255],
      alpha: 0.65,
    });
    const resLight = await runCornerAutoDetect(topLeftLight.imageData, 'medium');
    expect(resLight.detected).toBe(true);
    expect(resLight.corner).toBe('top-left');
    expect(resLight.mask).toBeDefined();

    // 场景 B：亮底左上角深色半透明水印
    const brightBase = createGradientTextureImage(width, height, true);
    const topLeftDark = stampTextWatermark(brightBase, 'KLING AI', 20, 18, {
      scale: 3,
      color: [24, 28, 36],
      alpha: 0.62,
      shadow: false,
    });
    const resDark = await runCornerAutoDetect(topLeftDark.imageData, 'medium');
    expect(resDark.detected).toBe(true);
    expect(resDark.corner).toBe('top-left');
    expect(resDark.mask).toBeDefined();
  });

  it('在干净无水印渐变图与纯纹理图上如实返回 detected: false，不伪造选区', async () => {
    const cleanGradient = createGradientTextureImage(640, 400);
    const resGradient = await runCornerAutoDetect(cleanGradient, 'medium');
    expect(resGradient.detected).toBe(false);
    expect(resGradient.mask).toBeUndefined();
    expect(resGradient.rect).toBeUndefined();

    const cleanHighSens = await runCornerAutoDetect(cleanGradient, 'high');
    expect(cleanHighSens.detected).toBe(false);

    const uniformTexture = createUniformTextureImage(640, 400);
    const resTexture = await runCornerAutoDetect(uniformTexture, 'medium');
    expect(resTexture.detected).toBe(false);
    expect(resTexture.mask).toBeUndefined();
  });

  it('精准模板匹配应识别即梦、可灵、可灵3.0、豆包角标，且输出笔画级紧致遮罩与无马赛克修复', async () => {
    const stampTemplate = (base: ImageData, templateId: WatermarkTemplateId) => {
      const tpl = WATERMARK_TEMPLATES[templateId];
      const { width, height } = base;
      const out = new Uint8ClampedArray(base.data);
      const short = Math.min(width, height);
      const scale = short / tpl.referenceShortSide;
      const mw = Math.round(tpl.width * scale);
      const mh = Math.round(tpl.height * scale);
      const mx = width - mw - Math.round(tpl.right * scale);
      const my = height - mh - Math.round(tpl.bottom * scale);

      for (let y = 0; y < mh; y++) {
        for (let x = 0; x < mw; x++) {
          const tx = ((x + 0.5) * tpl.width) / mw - 0.5;
          const ty = ((y + 0.5) * tpl.height) / mh - 0.5;
          const a = sampleTemplateAlpha(tpl, tx, ty) / 255;
          if (a <= 0.002) continue;
          const off = ((my + y) * width + (mx + x)) * 4;
          out[off] = clampByte(out[off] * (1 - a) + tpl.foreground * a);
          out[off + 1] = clampByte(out[off + 1] * (1 - a) + tpl.foreground * a);
          out[off + 2] = clampByte(out[off + 2] * (1 - a) + tpl.foreground * a);
        }
      }
      return {
        imageData: createImageDataSafe(out, width, height),
        rect: { x: mx, y: my, width: mw, height: mh },
      };
    };

    const cases: Array<{ id: WatermarkTemplateId; brand: 'jimeng' | 'kling' | 'doubao' }> = [
      { id: 'jimeng', brand: 'jimeng' },
      { id: 'kling', brand: 'kling' },
      { id: 'kling30', brand: 'kling' },
      { id: 'doubao', brand: 'doubao' },
    ];

    const clean = createGradientTextureImage(960, 640);
    for (const tc of cases) {
      const stamped = stampTemplate(clean, tc.id);
      const det = await runCornerAutoDetect(stamped.imageData, 'medium');

      expect(det.detected).toBe(true);
      expect(det.method).toBe('template');
      expect(det.matches?.[0]?.templateId).toBe(tc.id);
      expect(det.matches?.[0]?.brand).toBe(tc.brand);
      expect(det.confidence).toBeGreaterThanOrEqual(0.85);
      expect(det.mask).toBeDefined();

      // 笔画级遮罩面积应远小于整个外接矩形面积（保留字缝原图）
      const maskCount = det.mask!.reduce((acc, v) => acc + (v > 0 ? 1 : 0), 0);
      const boxArea = stamped.rect.width * stamped.rect.height;
      expect(maskCount).toBeGreaterThan(boxArea * 0.12);
      expect(maskCount).toBeLessThan(boxArea * 0.92);

      // 串联轻量无马赛克修复 + 半透明还原
      const before = computeMaskedMetrics(stamped.imageData, clean, det.mask!);
      const repaired = await runFastInpaint({
        imageData: stamped.imageData,
        mask: det.mask!,
        matchedMarks: det.matches,
      });
      const after = computeMaskedMetrics(repaired.imageData, clean, det.mask!);
      expect(countOutsideMaskDiffs(repaired.imageData, stamped.imageData, det.mask!)).toBe(0);
      expect(after.mse).toBeLessThan(before.mse * 0.15);
    }
  });

  it('框内智能紧贴笔画可将实心大矩形选区收缩为紧致文字笔画遮罩', async () => {
    const width = 640;
    const height = 400;
    const clean = createGradientTextureImage(width, height);
    const stamped = stampTextWatermark(clean, 'JIMENG AI', width - 200, height - 48, {
      scale: 3,
      alpha: 0.72,
    });
    // 故意框一个比水印大一圈的实心矩形
    const bigBoxMask = createRectMask(width, height, [stamped.bbox], 20);
    const beforePixels = bigBoxMask.reduce((acc, v) => acc + (v > 0 ? 1 : 0), 0);

    const refined = await runMaskStrokeRefine(stamped.imageData, bigBoxMask);
    expect(refined.refined).toBe(true);
    const afterPixels = refined.mask.reduce((acc, v) => acc + (v > 0 ? 1 : 0), 0);
    expect(afterPixels).toBeLessThan(beforePixels * 0.75);
    expect(afterPixels).toBeGreaterThan(100);
  });

  it('findMaskClusters 应传递归并经中间簇桥接的邻近选区，且 deduplicateMatches 严格弱序稳定', () => {
    // 构造水平三段间距约 20px 的小选区，总跨度超过单次 mergeGap 但两两相邻间距 <= mergeGap，应归并为 1 个簇
    const w = 400;
    const h = 120;
    const mask = createRectMask(
      w,
      h,
      [
        { x: 20, y: 40, width: 10, height: 10 },
        { x: 140, y: 40, width: 10, height: 10 },
        { x: 80, y: 40, width: 10, height: 10 },
      ],
      0,
    );
    // 20..29 -> 80..89 间距 51px (超过 24*2 tile 邻域，但在 28~72 mergeGap 判定下若间距 <= 32px)
    const bridgedMask = createRectMask(
      w,
      h,
      [
        { x: 20, y: 40, width: 12, height: 12 },
        { x: 106, y: 40, width: 12, height: 12 },
        { x: 60, y: 40, width: 20, height: 12 },
      ],
      0,
    );
    expect(findMaskClusters(bridgedMask, w, h)).toHaveLength(1);
    expect(findMaskClusters(mask, w, h).length).toBeGreaterThanOrEqual(1);

    // 验证 deduplicateMatches：同位置竞争时 kling30 优先替代分差 < 0.08 的 kling；不同角落保持真实分数顺序
    const candidates: MatchedWatermark[] = [
      {
        templateId: 'kling',
        brand: 'kling',
        label: '可灵AI',
        corner: 'bottom-right',
        x: 700,
        y: 550,
        width: 140,
        height: 44,
        score: 0.91,
        polarity: 1,
      },
      {
        templateId: 'kling30',
        brand: 'kling',
        label: '可灵AI 3.0',
        corner: 'bottom-right',
        x: 700,
        y: 550,
        width: 200,
        height: 44,
        score: 0.87,
        polarity: 1,
      },
      {
        templateId: 'jimeng',
        brand: 'jimeng',
        label: '即梦AI',
        corner: 'top-left',
        x: 20,
        y: 20,
        width: 120,
        height: 36,
        score: 0.89,
        polarity: 1,
      },
    ];
    const deduped = deduplicateMatches(candidates);
    expect(deduped).toHaveLength(2);
    expect(deduped.some((m) => m.corner === 'bottom-right' && m.templateId === 'kling30')).toBe(
      true,
    );
    expect(deduped.some((m) => m.corner === 'top-left' && m.templateId === 'jimeng')).toBe(true);
  });

  it('双角存在标准浅色与另一角暗色模板水印时，快路径不应早退导致第二角漏检', async () => {
    const width = 960;
    const height = 640;
    // 左上角偏亮底、右下角偏暗底的合成背景
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const off = (y * width + x) * 4;
        const t = (x / width + y / height) * 0.5;
        const base = clampByte(232 * (1 - t) + 32 * t);
        data[off] = base;
        data[off + 1] = base;
        data[off + 2] = base;
        data[off + 3] = 255;
      }
    }

    // 右下角叠加标准浅色即梦模板
    const jm = WATERMARK_TEMPLATES.jimeng;
    const jmScale = Math.min(width, height) / jm.referenceShortSide;
    const jmW = Math.round(jm.width * jmScale);
    const jmH = Math.round(jm.height * jmScale);
    const jmX = width - jmW - Math.round(jm.right * jmScale);
    const jmY = height - jmH - Math.round(jm.bottom * jmScale);
    for (let y = 0; y < jmH; y++) {
      for (let x = 0; x < jmW; x++) {
        const a =
          sampleTemplateAlpha(
            jm,
            ((x + 0.5) * jm.width) / jmW - 0.5,
            ((y + 0.5) * jm.height) / jmH - 0.5,
          ) / 255;
        if (a <= 0.002) continue;
        const off = ((jmY + y) * width + (jmX + x)) * 4;
        data[off] = clampByte(data[off] * (1 - a) + 255 * a);
        data[off + 1] = clampByte(data[off + 1] * (1 - a) + 255 * a);
        data[off + 2] = clampByte(data[off + 2] * (1 - a) + 255 * a);
      }
    }

    // 左上角叠加暗色可灵模板（非标准缩放比例 0.9）
    const kl = WATERMARK_TEMPLATES.kling;
    const klScale = (Math.min(width, height) / kl.referenceShortSide) * 0.9;
    const klW = Math.round(kl.width * klScale);
    const klH = Math.round(kl.height * klScale);
    const klX = 24;
    const klY = 20;
    for (let y = 0; y < klH; y++) {
      for (let x = 0; x < klW; x++) {
        const a =
          sampleTemplateAlpha(
            kl,
            ((x + 0.5) * kl.width) / klW - 0.5,
            ((y + 0.5) * kl.height) / klH - 0.5,
          ) / 255;
        if (a <= 0.002) continue;
        const off = ((klY + y) * width + (klX + x)) * 4;
        data[off] = clampByte(data[off] * (1 - a) + 20 * a);
        data[off + 1] = clampByte(data[off + 1] * (1 - a) + 20 * a);
        data[off + 2] = clampByte(data[off + 2] * (1 - a) + 20 * a);
      }
    }

    const det = await runCornerAutoDetect(createImageDataSafe(data, width, height), 'medium');
    expect(det.detected).toBe(true);
    expect(det.method).toBe('template');
    expect(det.matches?.length).toBeGreaterThanOrEqual(2);
    expect(det.matches?.some((m) => m.corner === 'bottom-right' && m.brand === 'jimeng')).toBe(
      true,
    );
    expect(det.matches?.some((m) => m.corner === 'top-left' && m.brand === 'kling')).toBe(true);
  });
});
