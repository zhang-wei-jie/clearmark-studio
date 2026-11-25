import {
  computePresetRects,
  normalizedRectToPixelRect,
  pixelRectToNormalizedRect,
} from '../data/presets';
import type { NormalizedRect, PixelRect, WatermarkPreset } from '../types';

/** 创建全零单通道遮罩数组（0 表示保留原图，255 表示待修复水印区域） */
export function createEmptyMask(width: number, height: number): Uint8Array {
  const safeW = Math.max(0, Math.floor(width));
  const safeH = Math.max(0, Math.floor(height));
  return new Uint8Array(safeW * safeH);
}

/** 浅拷贝遮罩数组，避免状态引用共享导致意外突变 */
export function cloneMask(mask: Uint8Array): Uint8Array {
  return new Uint8Array(mask);
}

/** 在遮罩上绘制圆形实心笔触点（原地修改，适合高频鼠标拖拽涂抹） */
export function stampBrushCircle(
  mask: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  value: 0 | 255 = 255,
): Uint8Array {
  const r = Math.max(1, radius);
  const rSq = r * r;
  const minX = Math.max(0, Math.floor(cx - r));
  const maxX = Math.min(width - 1, Math.ceil(cx + r));
  const minY = Math.max(0, Math.floor(cy - r));
  const maxY = Math.min(height - 1, Math.ceil(cy + r));

  for (let y = minY; y <= maxY; y++) {
    const dy = y - cy;
    const dySq = dy * dy;
    const rowOffset = y * width;
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      if (dx * dx + dySq <= rSq) {
        mask[rowOffset + x] = value;
      }
    }
  }
  return mask;
}

/**
 * 画笔 / 橡皮擦连续线段绘制：按步长在两点之间密集插值圆形笔触，消除快速拖拽断点。
 * value = 255 为画笔涂抹，value = 0 为橡皮擦擦除。
 */
export function drawBrushStroke(
  mask: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  value: 0 | 255 = 255,
): Uint8Array {
  const safeRadius = Math.max(1, radius);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const step = Math.max(1, safeRadius * 0.35);
  const steps = Math.max(1, Math.ceil(dist / step));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stampBrushCircle(mask, width, height, x0 + dx * t, y0 + dy * t, safeRadius, value);
  }
  return mask;
}

/** 在遮罩上填充指定像素矩形区域 */
export function fillMaskRect(
  mask: Uint8Array,
  width: number,
  height: number,
  rect: PixelRect,
  value: 0 | 255 = 255,
): Uint8Array {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));

  if (x1 <= x0 || y1 <= y0) {
    return mask;
  }

  for (let y = y0; y < y1; y++) {
    mask.fill(value, y * width + x0, y * width + x1);
  }
  return mask;
}

/** 将归一化框体直接写入遮罩 */
export function applyNormalizedRectToMask(
  mask: Uint8Array,
  width: number,
  height: number,
  rect: NormalizedRect,
  value: 0 | 255 = 255,
): Uint8Array {
  const pixelRect = normalizedRectToPixelRect(rect, width, height);
  return fillMaskRect(mask, width, height, pixelRect, value);
}

/** 根据多个像素矩形生成全新遮罩 */
export function createMaskFromPixelRects(
  width: number,
  height: number,
  rects: PixelRect[],
): Uint8Array {
  const mask = createEmptyMask(width, height);
  for (const rect of rects) {
    fillMaskRect(mask, width, height, rect, 255);
  }
  return mask;
}

/** 根据平台预设与目标图片尺寸生成完整遮罩（自动覆盖双角/多区域） */
export function createMaskFromPreset(
  preset: WatermarkPreset,
  width: number,
  height: number,
): Uint8Array {
  const rects = computePresetRects(preset, width, height);
  return createMaskFromPixelRects(width, height, rects);
}

/** 将叠加遮罩合并至基础遮罩（并集），返回新遮罩 */
export function mergeMasks(
  base: Uint8Array | null,
  overlay: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const length = width * height;
  const result = base && base.length === length ? cloneMask(base) : createEmptyMask(width, height);
  const limit = Math.min(length, overlay.length);
  for (let i = 0; i < limit; i++) {
    if (overlay[i] > 0) {
      result[i] = 255;
    }
  }
  return result;
}

/** 判断遮罩是否包含至少一个待修复像素 */
export function hasMaskPixels(mask: Uint8Array | null | undefined): boolean {
  if (!mask || mask.length === 0) {
    return false;
  }
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) {
      return true;
    }
  }
  return false;
}

/** 统计遮罩选区像素总数 */
export function countMaskPixels(mask: Uint8Array | null | undefined): number {
  if (!mask || mask.length === 0) {
    return 0;
  }
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) {
      count++;
    }
  }
  return count;
}

/** 计算遮罩所有非零像素的最小外接像素矩形，空遮罩返回 null */
export function getMaskBoundingBox(
  mask: Uint8Array | null | undefined,
  width: number,
  height: number,
): PixelRect | null {
  if (!mask || mask.length < width * height || width <= 0 || height <= 0) {
    return null;
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[rowOffset + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

/** 计算遮罩最小外接框对应的归一化矩形（便于将手绘/自动检测选区保存为自定义预设） */
export function getMaskNormalizedBoundingBox(
  mask: Uint8Array | null | undefined,
  width: number,
  height: number,
): NormalizedRect | null {
  const bbox = getMaskBoundingBox(mask, width, height);
  if (!bbox) {
    return null;
  }
  return pixelRectToNormalizedRect(bbox, width, height);
}

/**
 * 对遮罩进行圆形形态学膨胀，用于外扩选区覆盖半透明水印边缘投影/光晕。
 * 仅在现有选区外接框附近运算，4K 大图也能毫秒级完成。
 */
export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radiusPx: number,
): Uint8Array {
  const r = Math.round(radiusPx);
  if (r <= 0) {
    return cloneMask(mask);
  }

  const bbox = getMaskBoundingBox(mask, width, height);
  if (!bbox) {
    return createEmptyMask(width, height);
  }

  // 预计算圆形邻域偏移表
  const offsets: Array<[number, number]> = [];
  const rSq = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= rSq) {
        offsets.push([dx, dy]);
      }
    }
  }

  const result = cloneMask(mask);
  const startY = bbox.y;
  const endY = bbox.y + bbox.height;
  const startX = bbox.x;
  const endX = bbox.x + bbox.width;

  for (let y = startY; y < endY; y++) {
    const rowOffset = y * width;
    for (let x = startX; x < endX; x++) {
      if (mask[rowOffset + x] === 0) {
        continue;
      }
      // 仅对边界像素执行圆形外扩，跳过内部实心像素，大幅提速
      const isInterior =
        x > 0 &&
        x < width - 1 &&
        y > 0 &&
        y < height - 1 &&
        mask[rowOffset + x - 1] > 0 &&
        mask[rowOffset + x + 1] > 0 &&
        mask[(y - 1) * width + x] > 0 &&
        mask[(y + 1) * width + x] > 0;
      if (isInterior) {
        continue;
      }

      for (let k = 0; k < offsets.length; k++) {
        const nx = x + offsets[k][0];
        const ny = y + offsets[k][1];
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          result[ny * width + nx] = 255;
        }
      }
    }
  }

  return result;
}

/**
 * 将源尺寸图片的遮罩缩放映射到目标尺寸图片。
 * 用于批量套用自定义涂抹遮罩到不同分辨率队列图片时保持相对位置一致。
 */
export function scaleMaskToSize(
  sourceMask: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Uint8Array {
  if (srcWidth === dstWidth && srcHeight === dstHeight) {
    return cloneMask(sourceMask);
  }
  const dst = createEmptyMask(dstWidth, dstHeight);
  if (srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0) {
    return dst;
  }

  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;

  for (let y = 0; y < dstHeight; y++) {
    const sy = Math.min(srcHeight - 1, Math.floor((y + 0.5) * scaleY));
    const srcRow = sy * srcWidth;
    const dstRow = y * dstWidth;
    for (let x = 0; x < dstWidth; x++) {
      const sx = Math.min(srcWidth - 1, Math.floor((x + 0.5) * scaleX));
      if (sourceMask[srcRow + sx] > 0) {
        dst[dstRow + x] = 255;
      }
    }
  }

  return dst;
}

export interface MaskRenderOptions {
  /** 选区填充 RGBA（默认玫红半透明） */
  fillRgba?: [number, number, number, number];
  /** 选区 1px 边界描边 RGBA（默认亮玫红） */
  outlineRgba?: [number, number, number, number];
  /** 整体叠加不透明度倍率 (0~1) */
  opacity?: number;
}

/** 将二值遮罩直接绘制到预览 Canvas（含选区填充与高亮描边轮廓） */
export function renderMaskToCanvas(
  canvas: HTMLCanvasElement,
  mask: Uint8Array | null,
  width: number,
  height: number,
  options?: MaskRenderOptions,
): void {
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, width, height);
  if (!mask || mask.length < width * height || !hasMaskPixels(mask)) {
    return;
  }

  const opacity = options?.opacity ?? 1;
  const fill = options?.fillRgba ?? [244, 63, 94, 128];
  const outline = options?.outlineRgba ?? [251, 113, 133, 235];

  const fillA = Math.round(fill[3] * opacity);
  const outlineA = Math.round(outline[3] * opacity);

  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x;
      if (mask[idx] === 0) {
        continue;
      }

      const isEdge =
        x === 0 ||
        x === width - 1 ||
        y === 0 ||
        y === height - 1 ||
        mask[idx - 1] === 0 ||
        mask[idx + 1] === 0 ||
        mask[idx - width] === 0 ||
        mask[idx + width] === 0;

      const p = idx * 4;
      if (isEdge) {
        data[p] = outline[0];
        data[p + 1] = outline[1];
        data[p + 2] = outline[2];
        data[p + 3] = outlineA;
      } else {
        data[p] = fill[0];
        data[p + 1] = fill[1];
        data[p + 2] = fill[2];
        data[p + 3] = fillA;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}
