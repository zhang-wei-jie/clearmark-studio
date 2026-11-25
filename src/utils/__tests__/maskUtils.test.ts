import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_PRESETS } from '../../data/presets';
import {
  applyNormalizedRectToMask,
  cloneMask,
  countMaskPixels,
  createEmptyMask,
  createMaskFromPreset,
  dilateMask,
  drawBrushStroke,
  fillMaskRect,
  getMaskBoundingBox,
  hasMaskPixels,
  mergeMasks,
  renderMaskToCanvas,
  scaleMaskToSize,
} from '../maskUtils';

describe('遮罩生成、几何运算与绘制工具 (maskUtils)', () => {
  it('空遮罩初始化、克隆与非空判断正确', () => {
    const mask = createEmptyMask(64, 48);
    expect(mask.length).toBe(64 * 48);
    expect(hasMaskPixels(mask)).toBe(false);
    expect(countMaskPixels(mask)).toBe(0);
    expect(getMaskBoundingBox(mask, 64, 48)).toBeNull();

    const copy = cloneMask(mask);
    copy[0] = 255;
    expect(mask[0]).toBe(0);
    expect(hasMaskPixels(copy)).toBe(true);
    expect(countMaskPixels(copy)).toBe(1);
  });

  it('画笔连线涂抹连续无断点，橡皮擦可精准清除', () => {
    const w = 100;
    const h = 100;
    const mask = createEmptyMask(w, h);

    drawBrushStroke(mask, w, h, 10, 50, 90, 50, 4, 255);
    // 线段中心轨迹上所有点均应被标记
    for (let x = 10; x <= 90; x++) {
      expect(mask[50 * w + x]).toBe(255);
    }

    // 用橡皮擦抹去中间一段
    drawBrushStroke(mask, w, h, 45, 50, 55, 50, 5, 0);
    expect(mask[50 * w + 50]).toBe(0);
    expect(mask[50 * w + 15]).toBe(255);
    expect(mask[50 * w + 85]).toBe(255);
  });

  it('矩形填充、归一化框应用与边界框计算精确', () => {
    const mask = createEmptyMask(200, 100);
    fillMaskRect(mask, 200, 100, { x: 20, y: 10, width: 30, height: 15 });
    expect(countMaskPixels(mask)).toBe(30 * 15);
    expect(getMaskBoundingBox(mask, 200, 100)).toEqual({
      x: 20,
      y: 10,
      width: 30,
      height: 15,
    });

    const mask2 = createEmptyMask(100, 100);
    applyNormalizedRectToMask(mask2, 100, 100, { x: 0.5, y: 0.5, width: 0.2, height: 0.1 });
    expect(getMaskBoundingBox(mask2, 100, 100)).toEqual({
      x: 50,
      y: 50,
      width: 20,
      height: 10,
    });
  });

  it('双角预设生成合并遮罩并正确计算并集', () => {
    const dual = BUILTIN_PRESETS.find((p) => p.id === 'jimeng-dual')!;
    const mask = createMaskFromPreset(dual, 640, 360);
    expect(hasMaskPixels(mask)).toBe(true);
    // 左上与右下均存在非零选区
    expect(mask[20 * 640 + 20]).toBe(255);
    expect(mask[345 * 640 + 610]).toBe(255);

    const extra = createEmptyMask(640, 360);
    fillMaskRect(extra, 640, 360, { x: 300, y: 160, width: 20, height: 20 });
    const merged = mergeMasks(mask, extra, 640, 360);
    expect(merged[170 * 640 + 310]).toBe(255);
    expect(mask[170 * 640 + 310]).toBe(0);
  });

  it('圆形遮罩膨胀正确扩大外接框且不越界', () => {
    const w = 50;
    const h = 50;
    const mask = createEmptyMask(w, h);
    mask[25 * w + 25] = 255;

    const dilated = dilateMask(mask, w, h, 3);
    expect(getMaskBoundingBox(dilated, w, h)).toEqual({
      x: 22,
      y: 22,
      width: 7,
      height: 7,
    });
    // 圆形四顶点 (dx=3, dy=3 -> d^2=18 > 9) 不应被填充
    expect(dilated[22 * w + 22]).toBe(0);
    expect(dilated[22 * w + 25]).toBe(255);
  });

  it('跨分辨率缩放映射保持相对位置与面积比例', () => {
    const src = createEmptyMask(200, 100);
    fillMaskRect(src, 200, 100, { x: 150, y: 80, width: 40, height: 15 });

    const dst = scaleMaskToSize(src, 200, 100, 400, 200);
    const bbox = getMaskBoundingBox(dst, 400, 200);
    expect(bbox).toEqual({ x: 300, y: 160, width: 80, height: 30 });
  });

  it('renderMaskToCanvas 区分边界描边与内部填充像素', () => {
    const w = 10;
    const h = 10;
    const mask = createEmptyMask(w, h);
    fillMaskRect(mask, w, h, { x: 3, y: 3, width: 4, height: 4 });

    let capturedData: Uint8ClampedArray | null = null;
    const mockCtx = {
      clearRect: vi.fn(),
      createImageData: vi.fn((cw: number, ch: number) => ({
        width: cw,
        height: ch,
        data: new Uint8ClampedArray(cw * ch * 4),
      })),
      putImageData: vi.fn((imgData: { data: Uint8ClampedArray }) => {
        capturedData = imgData.data;
      }),
    };
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => mockCtx),
    } as unknown as HTMLCanvasElement;

    renderMaskToCanvas(mockCanvas, mask, w, h, {
      fillRgba: [244, 63, 94, 120],
      outlineRgba: [251, 113, 133, 240],
    });

    expect(mockCtx.putImageData).toHaveBeenCalledTimes(1);
    expect(capturedData).not.toBeNull();
    // 边界点 (3, 3) 应为描边 alpha=240
    expect(capturedData![(3 * w + 3) * 4 + 3]).toBe(240);
    // 内部点 (4, 4) 应为填充 alpha=120
    expect(capturedData![(4 * w + 4) * 4 + 3]).toBe(120);
    // 选区外 (0, 0) 保持透明
    expect(capturedData![3]).toBe(0);
  });
});
