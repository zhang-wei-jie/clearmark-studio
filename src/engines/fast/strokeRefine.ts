/**
 * 选区智能紧贴笔画模块（Smart Stroke Refinement）
 *
 * 当用户手动框选矩形或套用平台预设框时，整块实心矩形会覆盖大量干净背景，
 * 导致轻量去水印模糊或缺失细节。本模块在用户选定的局部框内：
 * 1. 先尝试以放宽门槛精准匹配已知平台模板（即梦/可灵/豆包），命中时直接对齐至像素级笔画遮罩；
 * 2. 未命中模板时，以框外一圈干净背景为参照，结合灰度形态学白/黑顶帽与背景色差自动收缩为紧贴文字笔画的细遮罩；
 * 3. 若选区内本身是大面积不透明实体/色块而非细笔画文字，则安全保留原遮罩不强行收缩。
 */

import type { PixelRect, StrokeRefineResult } from '../../types';
import {
  buildDetectionGrayscale,
  buildMaskFromMatchedMarks,
  computeTopHatSignals,
  detectTemplateWatermarks,
} from './autoDetect';

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 计算给定二值遮罩的外接矩形与选中像素数 */
function inspectMask(mask: Uint8Array, width: number, height: number): {
  bbox: PixelRect | null;
  count: number;
} {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[rowOff + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        count++;
      }
    }
  }

  if (count === 0 || maxX < minX || maxY < minY) {
    return { bbox: null, count: 0 };
  }

  return {
    bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    count,
  };
}

/**
 * 将实心矩形或粗涂抹选区智能收缩为紧贴文字/图标笔画的细遮罩。
 * @param imageData 当前图像数据
 * @param rawMask 用户当前选区遮罩（0/255）
 */
export function refineMaskToStrokes(
  imageData: ImageData,
  rawMask: Uint8Array,
): StrokeRefineResult {
  const { width, height, data } = imageData;
  const fallbackCopy = new Uint8Array(rawMask);

  if (rawMask.length !== width * height) {
    return { refined: false, mask: fallbackCopy, message: '遮罩尺寸与图像不匹配，保持当前选区。' };
  }

  const { bbox, count: origCount } = inspectMask(rawMask, width, height);
  if (!bbox || origCount < 64 || bbox.width < 12 || bbox.height < 10) {
    return { refined: false, mask: fallbackCopy, message: '选区面积较小，无需进一步收缩笔画。' };
  }

  const gray = buildDetectionGrayscale(imageData);

  // 路径一：在用户框选范围内尝试精确匹配已知平台模板（用户明确指定区域，采用 high 灵敏度）
  const localMatches = detectTemplateWatermarks(gray, width, height, 'high', bbox);
  if (localMatches.length > 0) {
    const { mask: templateMask } = buildMaskFromMatchedMarks(localMatches, width, height, gray);
    let refinedCount = 0;
    for (let i = 0; i < templateMask.length; i++) {
      if (templateMask[i] > 0) refinedCount++;
    }
    if (refinedCount > 0) {
      const ratioPct = Math.max(1, Math.round((refinedCount / origCount) * 100));
      const names = localMatches.map((m) => `「${m.label}」`).join('、');
      return {
        refined: true,
        mask: templateMask,
        matchedMarks: localMatches,
        message: `选区内精准对齐到${names}笔画轮廓（遮罩面积缩减至 ${ratioPct}%，字缝原图已保留）。`,
      };
    }
  }

  // 路径二：未知水印通用顶帽 + 背景色差抠笔画
  const pad = clamp(Math.round(Math.min(bbox.width, bbox.height) * 0.2), 6, 18);
  const rx0 = Math.max(0, bbox.x - pad);
  const ry0 = Math.max(0, bbox.y - pad);
  const rx1 = Math.min(width - 1, bbox.x + bbox.width - 1 + pad);
  const ry1 = Math.min(height - 1, bbox.y + bbox.height - 1 + pad);
  const rw = rx1 - rx0 + 1;
  const rh = ry1 - ry0 + 1;
  const total = rw * rh;

  const lum = new Float32Array(total);
  const localRawMask = new Uint8Array(total);
  const borderLuma: number[] = [];

  for (let y = 0; y < rh; y++) {
    const gy = ry0 + y;
    const gRow = gy * width + rx0;
    const rRow = y * rw;
    for (let x = 0; x < rw; x++) {
      const gIdx = gRow + x;
      const rIdx = rRow + x;
      const l = gray[gIdx];
      lum[rIdx] = l;
      if (rawMask[gIdx] > 0) {
        localRawMask[rIdx] = 1;
      } else {
        borderLuma.push(l);
      }
    }
  }

  const seRadius = clamp(Math.round(Math.min(bbox.width, bbox.height) * 0.16), 4, 14);
  const { whiteTopHat, blackTopHat } = computeTopHatSignals(lum, rw, rh, seRadius);

  // 利用框外干净像素估算自然纹理底噪（取白/黑顶帽 85 分位）
  const borderWhiteNoise: number[] = [];
  const borderBlackNoise: number[] = [];
  for (let i = 0; i < total; i++) {
    if (localRawMask[i] === 0) {
      borderWhiteNoise.push(whiteTopHat[i]);
      borderBlackNoise.push(blackTopHat[i]);
    }
  }
  borderWhiteNoise.sort((a, b) => a - b);
  borderBlackNoise.sort((a, b) => a - b);
  const wNoise85 = borderWhiteNoise[Math.floor(borderWhiteNoise.length * 0.85)] ?? 6;
  const bNoise85 = borderBlackNoise[Math.floor(borderBlackNoise.length * 0.85)] ?? 6;

  // 计算选区内部白顶帽与黑顶帽的强响应像素能量，自动判定主极性（或双极性描边）
  const wThresh = Math.max(12, wNoise85 * 1.65);
  const bThresh = Math.max(12, bNoise85 * 1.65);

  let wStrong = 0;
  let bStrong = 0;
  for (let i = 0; i < total; i++) {
    if (localRawMask[i] === 0) continue;
    if (whiteTopHat[i] >= wThresh) wStrong++;
    if (blackTopHat[i] >= bThresh) bStrong++;
  }

  // 同时纳入色彩饱和度与边界色差较弱时的补充信号（如白字落在亮黄沙地上，B通道差远大于亮度差）
  const borderB: number[] = [];
  for (let y = 0; y < rh; y++) {
    const gRow = (ry0 + y) * width + rx0;
    const rRow = y * rw;
    for (let x = 0; x < rw; x++) {
      if (localRawMask[rRow + x] === 0) {
        borderB.push(data[(gRow + x) * 4 + 2]);
      }
    }
  }
  borderB.sort((a, b) => a - b);
  const medBorderLuma =
    borderLuma.length > 0 ? borderLuma.sort((a, b) => a - b)[Math.floor(borderLuma.length * 0.5)] : 128;
  const medBorderB = borderB.length > 0 ? borderB[Math.floor(borderB.length * 0.5)] : 128;

  const useWhite = wStrong >= 12 && (wStrong >= bStrong * 0.45 || medBorderLuma < 200);
  const useBlack = bStrong >= 12 && (bStrong >= wStrong * 0.45 || medBorderLuma > 100);

  if (!useWhite && !useBlack) {
    return {
      refined: false,
      mask: fallbackCopy,
      message: '未在框内检测到清晰的文字笔画对比，已保留完整选区（复杂块状区域建议使用 AI 精修）。',
    };
  }

  const coreMask = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (localRawMask[i] === 0) continue;
    const hitW = useWhite && whiteTopHat[i] >= wThresh;
    const hitB = useBlack && blackTopHat[i] >= bThresh;
    // 对浅色文字落在暖色底上（B 通道大幅抬升）做轻量补偿
    const gIdx = (ry0 + Math.floor(i / rw)) * width + (rx0 + (i % rw));
    const hitBlueLift =
      useWhite && medBorderB < 185 && data[gIdx * 4 + 2] - medBorderB > 28 && whiteTopHat[i] >= wThresh * 0.55;
    if (hitW || hitB || hitBlueLift) {
      coreMask[i] = 1;
    }
  }

  // 过滤零星 1~3px 孤立噪点
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const cleaned = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (coreMask[i] === 0 || visited[i] === 1) continue;
    let head = 0;
    let tail = 0;
    visited[i] = 1;
    queue[tail++] = i;
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % rw;
      const cy = (cur - cx) / rw;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= rh) continue;
        const nRow = ny * rw;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= rw) continue;
          const nIdx = nRow + nx;
          if (coreMask[nIdx] === 1 && visited[nIdx] === 0) {
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
      }
    }
    if (tail >= 4) {
      for (let k = 0; k < tail; k++) cleaned[queue[k]] = 1;
    }
  }

  // 滞后补全邻近弱抗锯齿边与细描边，再执行 2~4px 圆形膨胀
  const dilateR = clamp(Math.round(Math.min(bbox.width, bbox.height) * 0.06), 2, 4);
  const offsets: Array<[number, number]> = [];
  const r2 = dilateR * dilateR;
  for (let dy = -dilateR; dy <= dilateR; dy++) {
    for (let dx = -dilateR; dx <= dilateR; dx++) {
      if (dx * dx + dy * dy <= r2) offsets.push([dx, dy]);
    }
  }

  const outMask = new Uint8Array(width * height);
  let outCount = 0;
  for (let y = 0; y < rh; y++) {
    const rRow = y * rw;
    for (let x = 0; x < rw; x++) {
      if (cleaned[rRow + x] === 0) continue;
      const gxBase = rx0 + x;
      const gyBase = ry0 + y;
      for (let k = 0; k < offsets.length; k++) {
        const gx = gxBase + offsets[k][0];
        const gy = gyBase + offsets[k][1];
        if (gx < 0 || gx >= width || gy < 0 || gy >= height) continue;
        const gIdx = gy * width + gx;
        if (outMask[gIdx] === 0) {
          outMask[gIdx] = 255;
          outCount++;
        }
      }
    }
  }

  const ratio = outCount / origCount;
  // 若提取结果过少（无明显文字）或几乎铺满原框（说明本来就是实心色块），则保留原选区
  if (outCount < 24 || ratio < 0.03 || ratio > 0.88) {
    return {
      refined: false,
      mask: fallbackCopy,
      message: '当前选区更适合整块修补，已保留原选区（建议使用 AI 精修获得最佳纹理重构）。',
    };
  }

  return {
    refined: true,
    mask: outMask,
    message: `已自动提取框内水印笔画轮廓（遮罩面积缩减至 ${Math.round(ratio * 100)}%，保留字缝原图）。`,
  };
}
