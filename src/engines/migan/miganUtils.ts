/**
 * MI-GAN 512×512 本地 AI 引擎纯 TS 几何裁剪、预填充打包与无损回贴工具
 *
 * 关键特性：
 * 1. 按连通选区分簇独立计算 512×512 上下文裁剪窗口，解决双角水印被合成整图压缩变糊的问题；
 * 2. 推理输入采用轻量修复预填充 RGB + 保守最大池化反转掩码（255=保留, 0=待修复），杜绝水印亮边渗色与细线丢失；
 * 3. 回贴仅写入遮罩内像素并保留轻量修复得到的透明通道，非遮罩区 100% 字节级无损。
 */

import type { PixelRect } from '../../types';
import { findMaskClusters } from '../fast/inpaintCore';
import {
  computeInnerFeatherAlpha,
  extractMaskPatch,
  extractRgbaPatch,
  resizeRgbaBilinear,
} from '../lama/lamaInference';

export const MIGAN_INPUT_SIZE = 512;

export interface ClusterCropPlan {
  cropRect: PixelRect;
  clusterRect: PixelRect;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * 为全局遮罩中各个独立选区簇规划局部上下文裁剪窗口，并自动合并裁剪范围完全一致的簇。
 */
export function computeClusterCropWindows(
  imageWidth: number,
  imageHeight: number,
  mask: Uint8Array,
  modelSize: number = MIGAN_INPUT_SIZE,
): ClusterCropPlan[] {
  const clusters = findMaskClusters(mask, imageWidth, imageHeight);
  if (clusters.length === 0) return [];

  const dedup = new Map<string, ClusterCropPlan>();

  for (const box of clusters) {
    const bw = box.maxX - box.minX + 1;
    const bh = box.maxY - box.minY + 1;
    const side = Math.max(modelSize, Math.max(bw, bh) + 256);
    const cropW = Math.min(imageWidth, side);
    const cropH = Math.min(imageHeight, side);

    let cropX = clamp(Math.round(box.minX + (bw - cropW) * 0.5), 0, Math.max(0, imageWidth - cropW));
    let cropY = clamp(Math.round(box.minY + (bh - cropH) * 0.5), 0, Math.max(0, imageHeight - cropH));

    // 确保裁剪框 100% 完整包含该簇全部像素
    if (cropX > box.minX) cropX = box.minX;
    if (cropX + cropW < box.maxX + 1) cropX = Math.max(0, box.maxX + 1 - cropW);
    if (cropY > box.minY) cropY = box.minY;
    if (cropY + cropH < box.maxY + 1) cropY = Math.max(0, box.maxY + 1 - cropH);

    const cropRect: PixelRect = { x: cropX, y: cropY, width: cropW, height: cropH };
    const clusterRect: PixelRect = { x: box.minX, y: box.minY, width: bw, height: bh };
    const key = `${cropX},${cropY},${cropW},${cropH}`;

    const existing = dedup.get(key);
    if (existing) {
      const minX = Math.min(existing.clusterRect.x, clusterRect.x);
      const minY = Math.min(existing.clusterRect.y, clusterRect.y);
      const maxX = Math.max(
        existing.clusterRect.x + existing.clusterRect.width,
        clusterRect.x + clusterRect.width,
      );
      const maxY = Math.max(
        existing.clusterRect.y + existing.clusterRect.height,
        clusterRect.y + clusterRect.height,
      );
      existing.clusterRect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    } else {
      dedup.set(key, { cropRect, clusterRect });
    }
  }

  return Array.from(dedup.values());
}

/**
 * 为单个裁剪窗口构造 MI-GAN 模型所需的 512×512 输入 RGBA 与反转二值掩码（255=保留背景，0=待修复）。
 * 传入的 prefilledRgba 已用轻量修复覆盖原始水印笔画，避免高亮笔画边缘渗入推理特征。
 */
export function prepareMiganInput(
  prefilledRgba: Uint8ClampedArray,
  fullMask: Uint8Array,
  imgW: number,
  cropRect: PixelRect,
  size: number = MIGAN_INPUT_SIZE,
): { rgba512: Uint8ClampedArray<ArrayBuffer>; mask512: Uint8Array<ArrayBuffer> } {
  const cropRgba = extractRgbaPatch(prefilledRgba, imgW, cropRect);
  const cropMask = extractMaskPatch(fullMask, imgW, cropRect);

  const rgba512 = resizeRgbaBilinear(cropRgba, cropRect.width, cropRect.height, size, size);
  const mask512 = new Uint8Array(new ArrayBuffer(size * size));
  mask512.fill(255);

  const sx = size / cropRect.width;
  const sy = size / cropRect.height;

  // 保守投影：任意原图待修像素对应的模型像素全部标记为 0，避免细笔画在缩小至 512 时消失
  for (let row = 0; row < cropRect.height; row++) {
    const my0 = Math.floor(row * sy);
    const my1 = Math.min(size, Math.ceil((row + 1) * sy));
    const rowOff = row * cropRect.width;
    for (let col = 0; col < cropRect.width; ) {
      if (cropMask[rowOff + col] === 0) {
        col++;
        continue;
      }
      const start = col;
      while (col < cropRect.width && cropMask[rowOff + col] > 0) col++;
      const mx0 = Math.floor(start * sx);
      const mx1 = Math.min(size, Math.ceil(col * sx));
      for (let my = my0; my < my1; my++) {
        mask512.fill(0, my * size + mx0, my * size + mx1);
      }
    }
  }

  let hasBackground = false;
  for (let i = 0; i < mask512.length; i++) {
    if (mask512[i] === 255) {
      hasBackground = true;
      break;
    }
  }
  if (!hasBackground) {
    throw new Error('选区过大，请缩小选区并保留一些周围背景供本地 AI 参考。');
  }

  return { rgba512, mask512 };
}

/**
 * 将 MI-GAN 512×512 推理结果还原至原裁剪分辨率，并仅回写遮罩内像素至目标输出缓冲。
 * - 非遮罩像素（fullMask === 0）完全不写入，保证 100% 字节级无损；
 * - 透明通道沿用 prefilledRgba（经轻量引擎修补后的平滑 Alpha）。
 */
export function stitchMiganResultIntoOutput(
  outputRgba: Uint8ClampedArray,
  originalRgba: Uint8ClampedArray,
  prefilledRgba: Uint8ClampedArray,
  fullMask: Uint8Array,
  imgW: number,
  cropRect: PixelRect,
  modelRgba512: Uint8ClampedArray,
  modelSize: number = MIGAN_INPUT_SIZE,
  featherPx = 2,
): void {
  const restored = resizeRgbaBilinear(
    modelRgba512,
    modelSize,
    modelSize,
    cropRect.width,
    cropRect.height,
  );
  const cropMask = extractMaskPatch(fullMask, imgW, cropRect);
  const effectiveFeather = clamp(Math.round(featherPx), 0, 4);
  const innerAlpha = computeInnerFeatherAlpha(
    cropMask,
    cropRect.width,
    cropRect.height,
    effectiveFeather,
  );

  for (let y = 0; y < cropRect.height; y++) {
    const gRow = (cropRect.y + y) * imgW + cropRect.x;
    const pRow = y * cropRect.width;
    for (let x = 0; x < cropRect.width; x++) {
      const pIdx = pRow + x;
      const gIdx = gRow + x;
      const mVal = fullMask[gIdx];
      if (mVal === 0) continue;

      const a = innerAlpha[pIdx] * (mVal / 255);
      if (a <= 0) continue;

      const p4 = pIdx * 4;
      const g4 = gIdx * 4;

      if (a >= 0.999) {
        outputRgba[g4] = restored[p4];
        outputRgba[g4 + 1] = restored[p4 + 1];
        outputRgba[g4 + 2] = restored[p4 + 2];
      } else {
        // 近边界极窄内缘与轻量预填结果柔顺衔接，杜绝生硬切边且不把原水印色混回
        const inv = 1 - a;
        const baseR = prefilledRgba[g4];
        const baseG = prefilledRgba[g4 + 1];
        const baseB = prefilledRgba[g4 + 2];
        outputRgba[g4] = Math.round(baseR * inv + restored[p4] * a);
        outputRgba[g4 + 1] = Math.round(baseG * inv + restored[p4 + 1] * a);
        outputRgba[g4 + 2] = Math.round(baseB * inv + restored[p4 + 2] * a);
      }

      // 透明度保留轻量修复结果，兼顾透明 PNG / WebP
      outputRgba[g4 + 3] = mVal >= 255 ? prefilledRgba[g4 + 3] : originalRgba[g4 + 3];
    }
  }
}
