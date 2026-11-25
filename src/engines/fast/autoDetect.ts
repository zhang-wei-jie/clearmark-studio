/**
 * 智能角落水印自动检测模块（双轨分级架构）
 *
 * Tier 1：精准平台模板边缘点对匹配（即梦AI / 可灵AI / 可灵AI 3.0 / 豆包AI生成）
 *   1. 对每套模板沿真实笔画法向抽取 220 组「笔画内 vs 笔画外」采样点对，按图标/文字/后缀分段；
 *   2. 支持高光饱和白底忽略（例如白底二维码压住半边水印时，仅按可见笔画计分）；
 *   3. 先检查四角标准边距快路径，再执行多尺度粗筛 + 亚像素细调；支持亮/暗双极性与多角同时检出；
 *   4. 命中后按模板真实 Alpha 生成紧贴笔画 + 阴影/描边的细窄遮罩，保留字缝原图，且附带版本后缀探测。
 *
 * Tier 2：通用 Top-Hat 形态学角落文字兜底探测（当模板未命中时触发）
 *   1. 使用可分离 O(N) 灰度形态学开/闭运算（白顶帽 / 黑顶帽）提取角落文字笔画，避免盒式均值自污染；
 *   2. 结合连通域文字行聚类、水平笔画跳变与外圈局部对比度，拒绝均匀草地/纹理误报。
 */

import type {
  CornerAnchor,
  CornerDetectionResult,
  DetectSensitivity,
  MatchedWatermark,
  PixelRect,
  WatermarkTemplateId,
} from '../../types';
import {
  TEMPLATE_LIST,
  WATERMARK_TEMPLATES,
  sampleMatchedMarkAlpha,
  type WatermarkTemplate,
} from './templates';

type ScannedCorner = Extract<
  CornerAnchor,
  'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
>;

const SCANNED_CORNERS: readonly ScannedCorner[] = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
];

const CORNER_LABELS: Record<ScannedCorner, string> = {
  'bottom-right': '右下角',
  'bottom-left': '左下角',
  'top-right': '右上角',
  'top-left': '左上角',
};

interface FeaturePair {
  ix: number;
  iy: number;
  ox: number;
  oy: number;
  segment: number;
}

interface ScaledSamples {
  inner: Int32Array;
  outer: Int32Array;
  segment: Uint8Array;
  segmentTotals: Int32Array;
  segmentCount: number;
}

interface TemplateSensitivity {
  /** 标准浅色水印命中门槛 */
  brightThreshold: number;
  /** 深色水印命中门槛（稍严以防高对比暗影误报） */
  darkThreshold: number;
  /** 粗筛门槛 */
  coarseThreshold: number;
}

const TEMPLATE_SENSITIVITY: Record<DetectSensitivity, TemplateSensitivity> = {
  low: { brightThreshold: 0.78, darkThreshold: 0.84, coarseThreshold: 0.36 },
  medium: { brightThreshold: 0.7, darkThreshold: 0.78, coarseThreshold: 0.3 },
  high: { brightThreshold: 0.62, darkThreshold: 0.72, coarseThreshold: 0.25 },
};

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 构造用于检测的灰度图：透明区域按白底合成，避免透明隐藏 RGB 干扰识别 */
export function buildDetectionGrayscale(imageData: ImageData): Uint8Array {
  const { width, height, data } = imageData;
  const total = width * height;
  const gray = new Uint8Array(total);
  for (let p = 0, i = 0; p < total; p++, i += 4) {
    const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    const a = data[i + 3];
    gray[p] = a === 255 ? luma : Math.round(255 - ((255 - luma) * a) / 255);
  }
  return gray;
}

/** 从模板 Alpha 沿笔画法向抽取跨边缘点对，并按固定确定性洗牌保证粗筛均匀覆盖各段 */
function extractTemplateFeatures(template: WatermarkTemplate): FeaturePair[] {
  const pairs: FeaturePair[] = [];
  const { alpha, width: w, height: h, peakAlpha, segments } = template;

  // 梯度与内外差门槛按模板峰值 Alpha 自适应，同时适配 255（可灵）、204（即梦）和 128（豆包）
  const gradThresh = peakAlpha * 0.24;
  const diffThresh = peakAlpha * 0.43;
  // 豆包自带外描边，外点略向外推以稳定落在描边或纯背景上
  const outerStep = template.hasDarkOutline ? 2.1 : 2.25;

  for (let y = 3; y < h - 3; y += 2) {
    for (let x = 3; x < w - 3; x += 2) {
      const p = y * w + x;
      const dx = alpha[p + 1] - alpha[p - 1];
      const dy = alpha[p + w] - alpha[p - w];
      const len = Math.hypot(dx, dy);
      if (len < gradThresh) continue;

      const nx = dx / len;
      const ny = dy / len;
      const ix = Math.round(x + 1.55 * nx);
      const iy = Math.round(y + 1.55 * ny);
      const ox = Math.round(x - outerStep * nx);
      const oy = Math.round(y - outerStep * ny);
      if (ix < 0 || ix >= w || iy < 0 || iy >= h || ox < 0 || ox >= w || oy < 0 || oy >= h) {
        continue;
      }
      if (alpha[iy * w + ix] - alpha[oy * w + ox] < diffThresh) continue;

      const normX = x / w;
      let segIdx = segments.length - 1;
      for (let s = 0; s < segments.length; s++) {
        if (normX >= segments[s].xStart && normX < segments[s].xEnd) {
          segIdx = s;
          break;
        }
      }
      pairs.push({ ix, iy, ox, oy, segment: segIdx });
    }
  }

  // 固定种子 Fisher-Yates 洗牌：保证粗筛前 20 个采样点均匀落到图标/文字/后缀各个分段
  const shuffled = [...pairs];
  let seed = 517;
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }

  // 多段模板保留稍多采样点以保障较短版本后缀（如 3.0）有充足边缘统计量
  const limit = segments.length >= 3 ? 280 : 220;
  return shuffled.slice(0, limit);
}

const TEMPLATE_FEATURES: Record<WatermarkTemplateId, FeaturePair[]> = {
  jimeng: extractTemplateFeatures(WATERMARK_TEMPLATES.jimeng),
  kling30: extractTemplateFeatures(WATERMARK_TEMPLATES.kling30),
  kling: extractTemplateFeatures(WATERMARK_TEMPLATES.kling),
  doubao: extractTemplateFeatures(WATERMARK_TEMPLATES.doubao),
};

function scaleTemplateSamples(
  template: WatermarkTemplate,
  width: number,
  height: number,
  stride: number,
): ScaledSamples {
  const sx = width / template.width;
  const sy = height / template.height;
  const features = TEMPLATE_FEATURES[template.id];
  const segCount = template.segments.length;
  const innerList: number[] = [];
  const outerList: number[] = [];
  const segList: number[] = [];
  const segmentTotals = new Int32Array(segCount);

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const inside = Math.floor((f.iy + 0.5) * sy) * stride + Math.floor((f.ix + 0.5) * sx);
    const outside = Math.floor((f.oy + 0.5) * sy) * stride + Math.floor((f.ox + 0.5) * sx);
    if (inside === outside) continue;
    innerList.push(inside);
    outerList.push(outside);
    segList.push(f.segment);
    segmentTotals[f.segment]++;
  }

  return {
    inner: Int32Array.from(innerList),
    outer: Int32Array.from(outerList),
    segment: Uint8Array.from(segList),
    segmentTotals,
    segmentCount: segCount,
  };
}

function edgeResponse(delta: number): number {
  return clamp((delta - 3) / 28, -0.6, 1);
}

/**
 * 快速粗筛评分（仅取前 20 个跨段采样点，跳过饱和白底/黑底不可观测点）
 */
function evaluateCoarseScore(
  gray: Uint8Array,
  start: number,
  samples: ScaledSamples,
  polarity: 1 | -1,
): number {
  const n = Math.min(20, samples.inner.length);
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < n; i++) {
    const gIn = gray[start + samples.inner[i]];
    const gOut = gray[start + samples.outer[i]];
    if (polarity === 1 ? gIn >= 242 && gOut >= 242 : gIn <= 13 && gOut <= 13) {
      continue;
    }
    const delta = polarity === 1 ? gIn - gOut : gOut - gIn;
    sum += edgeResponse(delta);
    valid++;
  }
  if (valid < Math.max(5, Math.floor(n * 0.35))) return -1;
  return sum / valid;
}

/**
 * 完整分段评分：
 * - 自动忽略与水印同色饱和的背景点（例如白底二维码盖住水印上半段）；
 * - 强制所有分段（如左侧图标 + 右侧品牌文字 + 版本后缀）均具备足够可观测点与高吻合度。
 */
function evaluateFullScore(
  gray: Uint8Array,
  start: number,
  samples: ScaledSamples,
  polarity: 1 | -1,
): number {
  const segCount = samples.segmentCount;
  // 使用栈上固定小数组避免热循环 GC 分配
  let s0 = 0;
  let c0 = 0;
  let s1 = 0;
  let c1 = 0;
  let s2 = 0;
  let c2 = 0;

  const inner = samples.inner;
  const outer = samples.outer;
  const seg = samples.segment;
  const len = inner.length;

  for (let i = 0; i < len; i++) {
    const gIn = gray[start + inner[i]];
    const gOut = gray[start + outer[i]];
    if (polarity === 1 ? gIn >= 242 && gOut >= 242 : gIn <= 13 && gOut <= 13) {
      continue;
    }
    const delta = polarity === 1 ? gIn - gOut : gOut - gIn;
    const r = edgeResponse(delta);
    const k = seg[i];
    if (k === 0) {
      s0 += r;
      c0++;
    } else if (k === 1) {
      s1 += r;
      c1++;
    } else {
      s2 += r;
      c2++;
    }
  }

  const minObs0 = Math.max(6, Math.floor(samples.segmentTotals[0] * 0.35));
  const minObs1 = Math.max(8, Math.floor(samples.segmentTotals[1] * 0.35));
  if (c0 < minObs0 || c1 < minObs1) return -1;

  const m0 = s0 / c0;
  const m1 = s1 / c1;

  if (segCount >= 3) {
    const minObs2 = Math.max(5, Math.floor(samples.segmentTotals[2] * 0.35));
    if (c2 < minObs2) return -1;
    const m2 = s2 / c2;
    // 版本后缀必须明确存在，否则归还给基础模板（如普通可灵AI）
    if (m2 < 0.56) return -1;
    const minSeg = Math.min(m0, m1, m2);
    const avgSeg = (m0 + m1 + m2) / 3;
    return minSeg * 0.55 + avgSeg * 0.45;
  }

  return Math.min(m0, m1) * 0.55 + (m0 + m1) * 0.225;
}

function inferCorner(x: number, y: number, bw: number, bh: number, imgW: number, imgH: number): ScannedCorner {
  const cx = x + bw * 0.5;
  const cy = y + bh * 0.5;
  if (cy >= imgH * 0.5) {
    return cx >= imgW * 0.5 ? 'bottom-right' : 'bottom-left';
  }
  return cx >= imgW * 0.5 ? 'top-right' : 'top-left';
}

function boxesOverlapRatio(a: MatchedWatermark, b: MatchedWatermark): number {
  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(a.x + a.width, b.x + b.width);
  const iy1 = Math.min(a.y + a.height, b.y + b.height);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return minArea > 0 ? inter / minArea : 0;
}

/**
 * 对同一位置的重复候选执行非极大值抑制，并优先保留覆盖更完整的版本后缀模板（如 kling30 覆盖 kling）
 */
function deduplicateMatches(candidates: MatchedWatermark[]): MatchedWatermark[] {
  const sorted = [...candidates].sort((a, b) => {
    // 若 kling30 与 kling 在同位置竞争且得分相近，优先选包含 3.0 后缀的 kling30
    if (a.templateId === 'kling30' && b.templateId === 'kling' && b.score - a.score < 0.08) {
      return -1;
    }
    if (b.templateId === 'kling30' && a.templateId === 'kling' && a.score - b.score < 0.08) {
      return 1;
    }
    return b.score - a.score;
  });

  const kept: MatchedWatermark[] = [];
  for (const cand of sorted) {
    const conflict = kept.some((existing) => {
      if (boxesOverlapRatio(existing, cand) > 0.35) return true;
      // 同一角落且同模板的近邻候选合并
      return (
        existing.corner === cand.corner &&
        existing.brand === cand.brand &&
        Math.abs(existing.x - cand.x) < cand.width * 0.35 &&
        Math.abs(existing.y - cand.y) < cand.height * 0.5
      );
    });
    if (!conflict) {
      kept.push(cand);
    }
  }
  return kept;
}

/**
 * 在指定搜索区域（四角或用户手动框选区）内执行多模板边缘点对匹配。
 * @param gray 全图灰度缓冲
 * @param imgW 图像宽度
 * @param imgH 图像高度
 * @param sensitivity 检测灵敏度
 * @param searchRect 可选限定搜索框（传入时仅在该框内查找，用于框内智能抠笔画）
 */
export function detectTemplateWatermarks(
  gray: Uint8Array,
  imgW: number,
  imgH: number,
  sensitivity: DetectSensitivity = 'medium',
  searchRect?: PixelRect,
): MatchedWatermark[] {
  const shortSide = Math.min(imgW, imgH);
  if (shortSide < 36) return [];

  const sens = TEMPLATE_SENSITIVITY[sensitivity];
  const candidates: MatchedWatermark[] = [];

  const register = (m: MatchedWatermark) => {
    const existingIdx = candidates.findIndex(
      (c) =>
        c.templateId === m.templateId &&
        Math.abs(c.x - m.x) < m.width * 0.18 &&
        Math.abs(c.y - m.y) < m.height * 0.4,
    );
    if (existingIdx >= 0) {
      if (m.score > candidates[existingIdx].score) candidates[existingIdx] = m;
    } else {
      candidates.push(m);
    }
  };

  // 快路径：无限定搜索框时，优先校验各模板按短边/长边两种比例在四角标准导出边距的瞬时命中
  const longSide = Math.max(imgW, imgH);
  if (!searchRect) {
    for (const template of TEMPLATE_LIST) {
      const fastScales = [
        shortSide / template.referenceShortSide,
        longSide / template.referenceLongSide,
      ];
      const testedWidths = new Set<number>();

      for (const scale of fastScales) {
        const width = Math.round(template.width * scale);
        if (testedWidths.has(width)) continue;
        testedWidths.add(width);
        const height = Math.round(template.height * scale);
        if (width < 28 || height < 8 || width > imgW || height > imgH) continue;

        const samples = scaleTemplateSamples(template, width, height, imgW);
        const gapX = Math.round(template.right * scale);
        const gapY = Math.round(template.bottom * scale);

        for (const right of [true, false]) {
          for (const bottom of [true, false]) {
            const x = right ? imgW - width - gapX : gapX;
            const y = bottom ? imgH - height - gapY : gapY;
            if (x < 0 || y < 0 || x + width > imgW || y + height > imgH) continue;

            // 在标准点周边 +-4px 微调以补偿竖图/横图边距与四舍五入缩放差异
            let bestVal = -1;
            let bestX = x;
            let bestY = y;
            for (let dy = -4; dy <= 4; dy++) {
              const py = y + dy;
              if (py < 0 || py + height > imgH) continue;
              for (let dx = -4; dx <= 4; dx++) {
                const px = x + dx;
                if (px < 0 || px + width > imgW) continue;
                const vBright = evaluateFullScore(gray, py * imgW + px, samples, 1);
                if (vBright > bestVal) {
                  bestVal = vBright;
                  bestX = px;
                  bestY = py;
                }
              }
            }

            if (bestVal >= sens.brightThreshold) {
              register({
                templateId: template.id,
                brand: template.brand,
                label: template.label,
                corner: inferCorner(bestX, bestY, width, height, imgW, imgH),
                x: bestX,
                y: bestY,
                width,
                height,
                score: Number(bestVal.toFixed(4)),
                polarity: 1,
              });
            }
          }
        }
      }
    }

    const fastDeduped = deduplicateMatches(candidates);
    if (fastDeduped.length > 0 && fastDeduped[0].score >= 0.88) {
      return fastDeduped;
    }
  }

  // 完整多尺度扫描路径：采用 ~7% 几何步长，确保细笔画宽角标在任意横竖画幅下都能稳定落入亚像素捕获半径
  const scaleFactors = searchRect
    ? [0.45, 0.52, 0.58, 0.65, 0.72, 0.8, 0.88, 0.96, 1.04, 1.14, 1.25, 1.4, 1.6]
    : [0.5, 0.55, 0.6, 0.66, 0.72, 0.78, 0.85, 0.92, 1.0, 1.08, 1.17, 1.27, 1.38, 1.52];

  for (const template of TEMPLATE_LIST) {
    const baseScale = searchRect
      ? Math.min(searchRect.width / template.width, searchRect.height / template.height)
      : shortSide / template.referenceShortSide;

    const widths = new Set<number>();
    widths.add(Math.round(template.width * baseScale));
    widths.add(Math.round(template.width * (longSide / template.referenceLongSide)));
    widths.add(template.width);
    for (const r of scaleFactors) {
      widths.add(Math.round(r * baseScale * template.width));
    }

    for (const width of widths) {
      const scale = width / template.width;
      const height = Math.round(template.height * scale);
      if (width < 34 || height < 9 || width > imgW || height > imgH) continue;
      if (searchRect && (width > searchRect.width + 8 || height > searchRect.height + 8)) continue;

      const samples = scaleTemplateSamples(template, width, height, imgW);
      const step = Math.max(1, Math.round(2.4 * scale));

      const scanZones: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
      if (searchRect) {
        const pad = Math.min(10, Math.round(height * 0.2));
        scanZones.push({
          x0: Math.max(0, searchRect.x - pad),
          y0: Math.max(0, searchRect.y - pad),
          x1: Math.min(imgW - width, searchRect.x + searchRect.width - width + pad),
          y1: Math.min(imgH - height, searchRect.y + searchRect.height - height + pad),
        });
      } else {
        const gapX = Math.min(imgW - width, Math.ceil(Math.min(shortSide * 0.24, width * 1.45)));
        const gapY = Math.min(imgH - height, Math.ceil(Math.min(shortSide * 0.16, height * 2.5)));
        // 右下、左下、右上、左上四角搜索区
        scanZones.push(
          { x0: imgW - width - gapX, y0: imgH - height - gapY, x1: imgW - width, y1: imgH - height },
          { x0: 0, y0: imgH - height - gapY, x1: gapX, y1: imgH - height },
          { x0: imgW - width - gapX, y0: 0, x1: imgW - width, y1: gapY },
          { x0: 0, y0: 0, x1: gapX, y1: gapY },
        );
      }

      for (const zone of scanZones) {
        if (zone.x1 < zone.x0 || zone.y1 < zone.y0) continue;

        for (const polarity of [1, -1] as const) {
          // 豆包自带暗描边，亮白底上仍呈正极性（内亮外暗），无需反极性重复扫描
          if (polarity === -1 && template.hasDarkOutline) continue;

          const minFinalScore = polarity === 1 ? sens.brightThreshold : sens.darkThreshold;
          const coarseMin = polarity === 1 ? sens.coarseThreshold : sens.coarseThreshold + 0.08;
          const seedThreshold = Math.max(0.42, minFinalScore - 0.24);

          let best = seedThreshold;
          let bestX = -1;
          let bestY = -1;

          for (let y = zone.y0; y <= zone.y1; y += step) {
            const rowOff = y * imgW;
            for (let x = zone.x0; x <= zone.x1; x += step) {
              const p = rowOff + x;
              if (evaluateCoarseScore(gray, p, samples, polarity) < coarseMin) continue;
              const v = evaluateFullScore(gray, p, samples, polarity);
              if (v > best) {
                best = v;
                bestX = x;
                bestY = y;
              }
            }
          }

          if (bestX < 0) continue;

          // 命中种子区周边做 +-5% 尺寸与逐像素微调，保证细字笔画精准对齐
          const refineFactors = [1, 0.99, 1.01, 0.975, 1.025, 0.95, 1.05];
          for (const factor of refineFactors) {
            const fw = Math.round(width * factor);
            const fh = Math.round(height * factor);
            if (fw < 28 || fh < 8 || fw > imgW || fh > imgH) continue;

            const fs = scaleTemplateSamples(template, fw, fh, imgW);
            const cx = Math.round(bestX + (width - fw) * 0.5);
            const cy = Math.round(bestY + (height - fh) * 0.5);
            const dist = Math.max(2, step);

            const ry0 = Math.max(0, cy - dist);
            const ry1 = Math.min(imgH - fh, cy + dist);
            const rx0 = Math.max(0, cx - dist);
            const rx1 = Math.min(imgW - fw, cx + dist);

            for (let y = ry0; y <= ry1; y++) {
              const rowOff = y * imgW;
              for (let x = rx0; x <= rx1; x++) {
                const value = evaluateFullScore(gray, rowOff + x, fs, polarity);
                if (value >= minFinalScore) {
                  register({
                    templateId: template.id,
                    brand: template.brand,
                    label: template.label,
                    corner: inferCorner(x, y, fw, fh, imgW, imgH),
                    x,
                    y,
                    width: fw,
                    height: fh,
                    score: Number(value.toFixed(4)),
                    polarity,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return deduplicateMatches(candidates);
}

/**
 * 若命中基础可灵AI模板，探测其右侧紧邻文字基线是否存在同极性版本后缀（如 2.1 / 2.5 / 4.0），
 * 仅在检测到清晰孤立字形时扩展对应笔画遮罩，不误碰自然草丛纹理。
 */
function extendKlingVersionSuffix(
  gray: Uint8Array,
  imgW: number,
  imgH: number,
  mark: MatchedWatermark,
  mask: Uint8Array,
): void {
  if (mark.templateId !== 'kling') return;

  const scale = mark.width / WATERMARK_TEMPLATES.kling.width;
  const textTop = Math.max(0, Math.round(mark.y + mark.height * 0.16));
  const textBot = Math.min(imgH - 1, Math.round(mark.y + mark.height * 0.84));
  const textH = textBot - textTop + 1;
  const stripX0 = Math.min(imgW - 1, mark.x + mark.width + Math.max(2, Math.round(4 * scale)));
  const stripX1 = Math.min(imgW - 1, mark.x + Math.round(mark.width * 1.48));
  const stripW = stripX1 - stripX0 + 1;
  if (stripW < 18 || textH < 10) return;

  // 估算该条带上下干净背景基准亮度（跳过高光饱和区域）
  const bgSamples: number[] = [];
  const bandAboveY = Math.max(0, mark.y - Math.max(4, Math.round(6 * scale)));
  const bandBelowY = Math.min(imgH - 1, mark.y + mark.height + Math.max(4, Math.round(6 * scale)));
  for (let x = stripX0; x <= stripX1; x += 2) {
    bgSamples.push(gray[bandAboveY * imgW + x], gray[bandBelowY * imgW + x]);
  }
  bgSamples.sort((a, b) => a - b);
  const bgMed = bgSamples[Math.floor(bgSamples.length * 0.5)] ?? 128;

  // 亮水印版本数字通常极亮（>225 且显著高于背景），并且分布在有限窄高度内
  const thresh = mark.polarity === 1 ? Math.max(220, bgMed + 42) : Math.min(35, bgMed - 42);
  let hitCount = 0;
  const hits: Array<[number, number]> = [];
  for (let y = textTop; y <= textBot; y++) {
    const rowOff = y * imgW;
    for (let x = stripX0; x <= stripX1; x++) {
      const g = gray[rowOff + x];
      const isStroke = mark.polarity === 1 ? g >= thresh : g <= thresh;
      if (isStroke) {
        hitCount++;
        hits.push([x, y]);
      }
    }
  }

  const density = hitCount / (stripW * textH);
  // 版本数字的笔画占空比通常在 8%~42% 之间；过稀是噪点，过密则是大片亮背景
  if (hitCount < 24 || density < 0.08 || density > 0.42) return;

  // 确认上下安全带本身不处于同类亮区（防止把亮天空/白墙误判成版本号）
  let borderBright = 0;
  for (let x = stripX0; x <= stripX1; x++) {
    const gTop = gray[bandAboveY * imgW + x];
    const gBot = gray[bandBelowY * imgW + x];
    if (mark.polarity === 1 ? gTop >= thresh || gBot >= thresh : gTop <= thresh || gBot <= thresh) {
      borderBright++;
    }
  }
  if (borderBright > stripW * 0.15) return;

  const ring = clamp(Math.round(1.8 * scale), 1, 5);
  for (let i = 0; i < hits.length; i++) {
    const [hx, hy] = hits[i];
    const y0 = Math.max(0, hy - ring);
    const y1 = Math.min(imgH - 1, hy + ring + 1);
    const x0 = Math.max(0, hx - ring);
    const x1 = Math.min(imgW - 1, hx + ring);
    for (let py = y0; py <= y1; py++) {
      mask.fill(255, py * imgW + x0, py * imgW + x1 + 1);
    }
  }
}

/**
 * 将命中模板列表渲染为笔画级紧致二值遮罩（0/255），仅覆盖真实笔画、外描边与柔和底影，
 * 最大化保留字缝与字孔中的干净原图背景。
 */
export function buildMaskFromMatchedMarks(
  marks: readonly MatchedWatermark[],
  imgW: number,
  imgH: number,
  gray?: Uint8Array,
): { mask: Uint8Array; unionRect: PixelRect } {
  const mask = new Uint8Array(imgW * imgH);

  for (const mark of marks) {
    const template = WATERMARK_TEMPLATES[mark.templateId];
    const scale = mark.width / template.width;

    // 豆包自带 1.5~2.5px 深色外描边，需稍大环向扩展保证无暗边残留
    const ring = template.hasDarkOutline
      ? clamp(Math.round(3.2 * scale), 2, 7)
      : clamp(Math.round(1.6 * scale), 1, 6);
    const below = template.hasDarkOutline
      ? clamp(Math.round(3.4 * scale), 2, 8)
      : clamp(Math.round(2.4 * scale), 1, 9);
    const opacityThresh = template.hasDarkOutline ? 10 : 5;

    for (let y = 0; y < mark.height; y++) {
      let start = -1;
      for (let x = 0; x <= mark.width; x++) {
        const covered = x < mark.width && sampleMatchedMarkAlpha(mark, x, y) >= opacityThresh;
        if (covered) {
          if (start < 0) start = x;
        } else if (start >= 0) {
          const rowMin = Math.max(0, mark.y + y - ring);
          const rowMax = Math.min(imgH - 1, mark.y + y + below);
          const colMin = Math.max(0, mark.x + start - ring);
          const colMax = Math.min(imgW, mark.x + x + ring);
          for (let row = rowMin; row <= rowMax; row++) {
            mask.fill(255, row * imgW + colMin, row * imgW + colMax);
          }
          start = -1;
        }
      }
    }

    if (gray && mark.templateId === 'kling') {
      extendKlingVersionSuffix(gray, imgW, imgH, mark, mask);
    }
  }

  let minX = imgW;
  let minY = imgH;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < imgH; y++) {
    const rowOff = y * imgW;
    for (let x = 0; x < imgW; x++) {
      if (mask[rowOff + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const unionRect: PixelRect =
    maxX >= minX && maxY >= minY
      ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : {
          x: marks[0]?.x ?? 0,
          y: marks[0]?.y ?? 0,
          width: marks[0]?.width ?? 0,
          height: marks[0]?.height ?? 0,
        };

  return { mask, unionRect };
}

// ============================================================================
// Tier 2：通用形态学 Top-Hat / Black-Hat 角落文字兜底探测（未命中已知模板时触发）
// ============================================================================

/** O(N) 单调队列一维滑动极值（isMax = true 求局部最大，false 求局部最小） */
function slidingExtremum1D(
  src: Float32Array,
  dst: Float32Array,
  len: number,
  radius: number,
  isMax: boolean,
  deque: Int32Array,
): void {
  let head = 0;
  let tail = 0;
  const r = Math.min(radius, len - 1);

  for (let i = 0; i < r; i++) {
    const v = src[i];
    while (tail > head && (isMax ? src[deque[tail - 1]] <= v : src[deque[tail - 1]] >= v)) {
      tail--;
    }
    deque[tail++] = i;
  }

  for (let i = 0; i < len; i++) {
    const right = i + r;
    if (right < len) {
      const v = src[right];
      while (tail > head && (isMax ? src[deque[tail - 1]] <= v : src[deque[tail - 1]] >= v)) {
        tail--;
      }
      deque[tail++] = right;
    }
    const left = i - r;
    while (tail > head && deque[head] < left) {
      head++;
    }
    dst[i] = src[deque[head]];
  }
}

/** 2D 可分离矩形窗口极值滤波（腐蚀 isMax=false / 膨胀 isMax=true） */
export function morphFilter2D(
  src: Float32Array,
  w: number,
  h: number,
  radius: number,
  isMax: boolean,
): Float32Array {
  const temp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const maxDim = Math.max(w, h);
  const lineIn = new Float32Array(maxDim);
  const lineOut = new Float32Array(maxDim);
  const deque = new Int32Array(maxDim);

  // 水平方向
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) lineIn[x] = src[off + x];
    slidingExtremum1D(lineIn, lineOut, w, radius, isMax, deque);
    for (let x = 0; x < w; x++) temp[off + x] = lineOut[x];
  }

  // 垂直方向
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) lineIn[y] = temp[y * w + x];
    slidingExtremum1D(lineIn, lineOut, h, radius, isMax, deque);
    for (let y = 0; y < h; y++) out[y * w + x] = lineOut[y];
  }

  return out;
}

/** 计算灰度形态学白顶帽（提取浅色细笔画）与黑顶帽（提取深色细笔画） */
export function computeTopHatSignals(
  lum: Float32Array,
  w: number,
  h: number,
  radius: number,
): { whiteTopHat: Float32Array; blackTopHat: Float32Array; opened: Float32Array; closed: Float32Array } {
  const eroded = morphFilter2D(lum, w, h, radius, false);
  const opened = morphFilter2D(eroded, w, h, radius, true);
  const dilated = morphFilter2D(lum, w, h, radius, true);
  const closed = morphFilter2D(dilated, w, h, radius, false);

  const total = w * h;
  const whiteTopHat = new Float32Array(total);
  const blackTopHat = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    whiteTopHat[i] = Math.max(0, lum[i] - opened[i]);
    blackTopHat[i] = Math.max(0, closed[i] - lum[i]);
  }
  return { whiteTopHat, blackTopHat, opened, closed };
}

interface GenericParams {
  minRes: number;
  noiseK: number;
  minGrad: number;
  minConfidence: number;
}

const GENERIC_PARAMS: Record<DetectSensitivity, GenericParams> = {
  low: { minRes: 22, noiseK: 2.6, minGrad: 14, minConfidence: 0.56 },
  medium: { minRes: 15, noiseK: 2.15, minGrad: 10, minConfidence: 0.44 },
  high: { minRes: 10, noiseK: 1.75, minGrad: 7, minConfidence: 0.36 },
};

interface GenericComponent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
  sumRes: number;
  sumGrad: number;
  pixels: number[];
}

interface GenericCandidate {
  corner: ScannedCorner;
  confidence: number;
  roiX: number;
  roiY: number;
  roiW: number;
  roiH: number;
  boxMinX: number;
  boxMinY: number;
  boxMaxX: number;
  boxMaxY: number;
  strokeMask: Uint8Array;
  signal: Float32Array;
  thresh: number;
}

function estimatePercentile(values: Float32Array, percentile: number): number {
  const hist = new Int32Array(256);
  const len = values.length;
  for (let i = 0; i < len; i++) {
    hist[clamp(Math.round(Math.abs(values[i])), 0, 255)]++;
  }
  const target = len * percentile;
  let acc = 0;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= target) return b;
  }
  return 255;
}

function getCornerRoi(corner: ScannedCorner, imgW: number, imgH: number) {
  const minW = Math.min(136, Math.floor(imgW * 0.45));
  const maxW = Math.min(820, Math.floor(imgW * 0.4));
  const roiW = clamp(Math.round(imgW * 0.28), Math.min(minW, maxW), Math.max(minW, maxW));

  const minH = Math.min(60, Math.floor(imgH * 0.35));
  const maxH = Math.min(300, Math.floor(imgH * 0.3));
  const roiH = clamp(Math.round(imgH * 0.14), Math.min(minH, maxH), Math.max(minH, maxH));

  const x = corner === 'bottom-right' || corner === 'top-right' ? imgW - roiW : 0;
  const y = corner === 'bottom-right' || corner === 'bottom-left' ? imgH - roiH : 0;
  return { x, y, w: roiW, h: roiH };
}

function detectGenericCornerFallback(
  gray: Uint8Array,
  imgW: number,
  imgH: number,
  sensitivity: DetectSensitivity,
): CornerDetectionResult | null {
  const params = GENERIC_PARAMS[sensitivity];
  let bestOverall: GenericCandidate | null = null;

  for (const corner of SCANNED_CORNERS) {
    const roi = getCornerRoi(corner, imgW, imgH);
    if (roi.w < 24 || roi.h < 16) continue;

    const total = roi.w * roi.h;
    const lum = new Float32Array(total);
    const grad = new Float32Array(total);

    for (let y = 0; y < roi.h; y++) {
      const gRow = (roi.y + y) * imgW + roi.x;
      const rRow = y * roi.w;
      for (let x = 0; x < roi.w; x++) {
        lum[rRow + x] = gray[gRow + x];
      }
    }

    for (let y = 1; y < roi.h - 1; y++) {
      const up = (y - 1) * roi.w;
      const mid = y * roi.w;
      const dn = (y + 1) * roi.w;
      for (let x = 1; x < roi.w - 1; x++) {
        const gx =
          -lum[up + x - 1] +
          lum[up + x + 1] -
          2 * lum[mid + x - 1] +
          2 * lum[mid + x + 1] -
          lum[dn + x - 1] +
          lum[dn + x + 1];
        const gy =
          -lum[up + x - 1] -
          2 * lum[up + x] -
          lum[up + x + 1] +
          lum[dn + x - 1] +
          2 * lum[dn + x] +
          lum[dn + x + 1];
        grad[mid + x] = (Math.abs(gx) + Math.abs(gy)) * 0.25;
      }
    }

    const seRadius = clamp(Math.round(roi.h * 0.14), 5, 14);
    const { whiteTopHat, blackTopHat, opened, closed } = computeTopHatSignals(
      lum,
      roi.w,
      roi.h,
      seRadius,
    );

    const hasEdgeNear = new Uint8Array(total);
    for (let y = 1; y < roi.h - 1; y++) {
      const rowOff = y * roi.w;
      for (let x = 1; x < roi.w - 1; x++) {
        const idx = rowOff + x;
        if (grad[idx] >= params.minGrad) {
          hasEdgeNear[idx] = 1;
          hasEdgeNear[idx - 1] = 1;
          hasEdgeNear[idx + 1] = 1;
          hasEdgeNear[idx - roi.w] = 1;
          hasEdgeNear[idx + roi.w] = 1;
        }
      }
    }

    for (const polarity of [1, -1] as const) {
      const signal = polarity === 1 ? whiteTopHat : blackTopHat;
      const bgRef = polarity === 1 ? opened : closed;
      const noiseBase = estimatePercentile(signal, 0.75);
      const thresh = Math.max(params.minRes, noiseBase * params.noiseK);

      const candMask = new Uint8Array(total);
      let candCount = 0;
      for (let i = 0; i < total; i++) {
        const v = signal[i];
        if (v < thresh) continue;
        if (polarity === -1 && bgRef[i] < 130) continue;
        if (hasEdgeNear[i] === 0 && v < thresh * 1.75) continue;
        candMask[i] = 1;
        candCount++;
      }

      if (candCount < 24 || candCount > total * 0.38) continue;

      const visited = new Uint8Array(total);
      const queue = new Int32Array(total);
      const components: GenericComponent[] = [];

      for (let y = 0; y < roi.h; y++) {
        const rowOff = y * roi.w;
        for (let x = 0; x < roi.w; x++) {
          const start = rowOff + x;
          if (candMask[start] === 0 || visited[start] === 1) continue;
          let head = 0;
          let tail = 0;
          visited[start] = 1;
          queue[tail++] = start;
          let minX = x;
          let maxX = x;
          let minY = y;
          let maxY = y;
          let sumRes = 0;
          let sumGrad = 0;
          const pixels: number[] = [];

          while (head < tail) {
            const cur = queue[head++];
            const cx = cur % roi.w;
            const cy = (cur - cx) / roi.w;
            pixels.push(cur);
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;
            sumRes += signal[cur];
            sumGrad += grad[cur];

            for (let dy = -1; dy <= 1; dy++) {
              const ny = cy + dy;
              if (ny < 0 || ny >= roi.h) continue;
              const nRow = ny * roi.w;
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = cx + dx;
                if (nx < 0 || nx >= roi.w) continue;
                const nIdx = nRow + nx;
                if (candMask[nIdx] === 1 && visited[nIdx] === 0) {
                  visited[nIdx] = 1;
                  queue[tail++] = nIdx;
                }
              }
            }
          }

          const area = pixels.length;
          const cw = maxX - minX + 1;
          const ch = maxY - minY + 1;
          if (area < 4) continue;
          if (ch > roi.h * 0.72 || cw > roi.w * 0.88 || area > total * 0.22) continue;
          if (cw > 52 && ch > 52 && area / (cw * ch) > 0.76) continue;

          components.push({ minX, minY, maxX, maxY, area, sumRes, sumGrad, pixels });
        }
      }

      if (components.length === 0) continue;

      const nComp = components.length;
      const parent = new Int32Array(nComp);
      for (let i = 0; i < nComp; i++) parent[i] = i;
      const find = (a: number): number => {
        let cur = a;
        while (parent[cur] !== cur) {
          parent[cur] = parent[parent[cur]];
          cur = parent[cur];
        }
        return cur;
      };
      const baseGapX = clamp(Math.round(roi.w * 0.14), 22, 56);
      const baseGapY = clamp(Math.round(roi.h * 0.16), 8, 22);

      for (let i = 0; i < nComp; i++) {
        const a = components[i];
        const ah = a.maxY - a.minY + 1;
        const aCy = (a.minY + a.maxY) * 0.5;
        for (let j = i + 1; j < nComp; j++) {
          const b = components[j];
          const bh = b.maxY - b.minY + 1;
          const bCy = (b.minY + b.maxY) * 0.5;
          const maxH = Math.max(ah, bh);
          const gapX = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
          const gapY = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
          const sameLine = gapY === 0 || Math.abs(aCy - bCy) <= maxH * 0.65;
          const allowedX = sameLine ? Math.max(baseGapX, Math.round(maxH * 1.55)) : Math.round(baseGapX * 0.65);
          const allowedY = Math.max(baseGapY, Math.round(maxH * 0.65));
          if (gapX > allowedX || gapY > allowedY) continue;
          if (maxH / Math.max(1, Math.min(ah, bh)) > 5.5 && gapX > 6) continue;
          const ra = find(i);
          const rb = find(j);
          if (ra !== rb) parent[ra] = rb;
        }
      }

      const groups = new Map<number, GenericComponent[]>();
      for (let i = 0; i < nComp; i++) {
        const root = find(i);
        let list = groups.get(root);
        if (!list) {
          list = [];
          groups.set(root, list);
        }
        list.push(components[i]);
      }

      for (const group of groups.values()) {
        let minX = roi.w;
        let minY = roi.h;
        let maxX = -1;
        let maxY = -1;
        let strokePixels = 0;
        let sumRes = 0;
        let sumGrad = 0;
        for (const comp of group) {
          if (comp.minX < minX) minX = comp.minX;
          if (comp.minY < minY) minY = comp.minY;
          if (comp.maxX > maxX) maxX = comp.maxX;
          if (comp.maxY > maxY) maxY = comp.maxY;
          strokePixels += comp.area;
          sumRes += comp.sumRes;
          sumGrad += comp.sumGrad;
        }

        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const boxArea = bw * bh;
        if (bw < 18 || bh < 8 || strokePixels < 26) continue;
        if (boxArea / total > 0.56 || bh > roi.h * 0.68 || bw > roi.w * 0.95) continue;
        const aspect = bw / bh;
        if (aspect < 0.7 || aspect > 16) continue;
        const fillDensity = strokePixels / boxArea;
        if (fillDensity < 0.06 || fillDensity > 0.76) continue;

        const clusterMask = new Uint8Array(total);
        for (const comp of group) {
          for (let k = 0; k < comp.pixels.length; k++) clusterMask[comp.pixels[k]] = 1;
        }

        // 水平笔画跳变特征
        let totalTrans = 0;
        let activeRows = 0;
        for (let y = minY; y <= maxY; y++) {
          const rowOff = y * roi.w;
          let rowTrans = 0;
          let prev = 0;
          for (let x = minX; x <= maxX; x++) {
            const cur = clusterMask[rowOff + x];
            if (cur !== prev) {
              rowTrans++;
              prev = cur;
            }
          }
          if (prev === 1) rowTrans++;
          if (rowTrans > 0) {
            totalTrans += rowTrans;
            activeRows++;
          }
        }
        const meanTrans = activeRows > 0 ? totalTrans / activeRows : 0;
        if (group.length < 2 && meanTrans < 4.2) continue;

        // 外圈对比度检查：排除全角均匀草地/砖纹/噪点
        const padX = Math.max(12, Math.round(bw * 0.25));
        const padY = Math.max(10, Math.round(bh * 0.55));
        const rx0 = Math.max(0, minX - padX);
        const ry0 = Math.max(0, minY - padY);
        const rx1 = Math.min(roi.w - 1, maxX + padX);
        const ry1 = Math.min(roi.h - 1, maxY + padY);
        let ringSigSum = 0;
        let ringGradSum = 0;
        let ringCandCnt = 0;
        let ringPixels = 0;
        for (let y = ry0; y <= ry1; y++) {
          const rowOff = y * roi.w;
          const inY = y >= minY - 1 && y <= maxY + 1;
          for (let x = rx0; x <= rx1; x++) {
            if (inY && x >= minX - 1 && x <= maxX + 1) continue;
            const idx = rowOff + x;
            ringSigSum += signal[idx];
            ringGradSum += grad[idx];
            if (candMask[idx] === 1) ringCandCnt++;
            ringPixels++;
          }
        }
        const ringCandDensity = ringPixels > 0 ? ringCandCnt / ringPixels : 0;
        if (ringCandDensity > fillDensity * 0.48 && ringCandDensity > 0.035) continue;

        const innerRes = sumRes / strokePixels;
        const innerGrad = sumGrad / strokePixels;
        const ringRes = ringPixels > 0 ? ringSigSum / ringPixels : 0;
        const ringGrad = ringPixels > 0 ? ringGradSum / ringPixels : 0;
        const locRatio = innerRes / (ringRes + 4.0);
        const gradRatio = innerGrad / (ringGrad + 4.0);
        if (locRatio < 1.8 && gradRatio < 1.65) continue;

        const touchesInnerLeft = (corner === 'bottom-right' || corner === 'top-right') && minX <= 2;
        const touchesInnerRight = (corner === 'bottom-left' || corner === 'top-left') && maxX >= roi.w - 3;
        const touchesInnerTop = (corner === 'bottom-right' || corner === 'bottom-left') && minY <= 2;
        const touchesInnerBottom = (corner === 'top-right' || corner === 'top-left') && maxY >= roi.h - 3;
        const innerHits =
          (touchesInnerLeft ? 1 : 0) +
          (touchesInnerRight ? 1 : 0) +
          (touchesInnerTop ? 1 : 0) +
          (touchesInnerBottom ? 1 : 0);
        if (innerHits >= 2) continue;

        const distOuterX = corner === 'bottom-right' || corner === 'top-right' ? roi.w - 1 - maxX : minX;
        const distOuterY = corner === 'bottom-right' || corner === 'bottom-left' ? roi.h - 1 - maxY : minY;
        const normDistX = distOuterX / roi.w;
        const normDistY = distOuterY / roi.h;
        if (normDistX > 0.52 || normDistY > 0.55) continue;

        const contrastScore = clamp((innerRes - thresh * 0.65) / 38, 0, 1);
        const localScore = clamp((locRatio - 1.5) / 4.2, 0, 1);
        const gradScore = clamp((gradRatio - 1.3) / 3.8, 0, 1);
        const textScore =
          0.5 * clamp((group.length - 1) / 4, 0, 1) + 0.5 * clamp((meanTrans - 3) / 8, 0, 1);
        const cornerAffinity =
          clamp(1 - (normDistX * 0.8 + normDistY * 0.9), 0.25, 1) * (innerHits === 1 ? 0.62 : 1.0);

        let confidence =
          0.28 * contrastScore +
          0.26 * localScore +
          0.16 * gradScore +
          0.2 * textScore +
          0.1 * cornerAffinity;
        if (polarity === 1) confidence += 0.03;
        if (corner === 'bottom-right') confidence += 0.015;
        confidence = clamp(confidence, 0, 0.94);

        if (!bestOverall || confidence > bestOverall.confidence) {
          bestOverall = {
            corner,
            confidence,
            roiX: roi.x,
            roiY: roi.y,
            roiW: roi.w,
            roiH: roi.h,
            boxMinX: minX,
            boxMinY: minY,
            boxMaxX: maxX,
            boxMaxY: maxY,
            strokeMask: clusterMask,
            signal,
            thresh,
          };
        }
      }
    }
  }

  if (!bestOverall || bestOverall.confidence < params.minConfidence) {
    return null;
  }

  // 滞后补全抗锯齿晕边 + 紧致圆形膨胀（3~5px）
  const { roiX, roiY, roiW, roiH, boxMinX, boxMinY, boxMaxX, boxMaxY, strokeMask, signal, thresh } =
    bestOverall;
  const weakThresh = Math.max(6, thresh * 0.45);
  const refined = new Uint8Array(strokeMask);
  const rx0 = Math.max(0, boxMinX - 3);
  const ry0 = Math.max(0, boxMinY - 3);
  const rx1 = Math.min(roiW - 1, boxMaxX + 3);
  const ry1 = Math.min(roiH - 1, boxMaxY + 3);

  for (let y = ry0; y <= ry1; y++) {
    const rowOff = y * roiW;
    for (let x = rx0; x <= rx1; x++) {
      const idx = rowOff + x;
      if (refined[idx] === 1 || signal[idx] < weakThresh) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= roiH) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < roiW && strokeMask[ny * roiW + nx] === 1) {
            near = true;
            break;
          }
        }
      }
      if (near) refined[idx] = 1;
    }
  }

  const bh = boxMaxY - boxMinY + 1;
  const dilateR = clamp(Math.round(bh * 0.14), 3, 5);
  const offsets: Array<[number, number]> = [];
  const r2 = dilateR * dilateR;
  for (let dy = -dilateR; dy <= dilateR; dy++) {
    for (let dx = -dilateR; dx <= dilateR; dx++) {
      if (dx * dx + dy * dy <= r2) offsets.push([dx, dy]);
    }
  }

  const fullMask = new Uint8Array(imgW * imgH);
  let outMinX = imgW;
  let outMinY = imgH;
  let outMaxX = -1;
  let outMaxY = -1;
  for (let y = ry0; y <= ry1; y++) {
    const rowOff = y * roiW;
    for (let x = rx0; x <= rx1; x++) {
      if (refined[rowOff + x] === 0) continue;
      const gxBase = roiX + x;
      const gyBase = roiY + y;
      for (let k = 0; k < offsets.length; k++) {
        const gx = gxBase + offsets[k][0];
        const gy = gyBase + offsets[k][1];
        if (gx < 0 || gx >= imgW || gy < 0 || gy >= imgH) continue;
        fullMask[gy * imgW + gx] = 255;
        if (gx < outMinX) outMinX = gx;
        if (gx > outMaxX) outMaxX = gx;
        if (gy < outMinY) outMinY = gy;
        if (gy > outMaxY) outMaxY = gy;
      }
    }
  }

  const rect: PixelRect =
    outMaxX >= outMinX && outMaxY >= outMinY
      ? { x: outMinX, y: outMinY, width: outMaxX - outMinX + 1, height: outMaxY - outMinY + 1 }
      : { x: roiX + boxMinX, y: roiY + boxMinY, width: boxMaxX - boxMinX + 1, height: bh };
  const conf = Number(bestOverall.confidence.toFixed(2));
  const cornerLabel = CORNER_LABELS[bestOverall.corner];

  return {
    detected: true,
    corner: bestOverall.corner,
    rect,
    confidence: conf,
    mask: fullMask,
    method: 'generic',
    message: `在${cornerLabel}检测到疑似角落文字水印（置信度 ${Math.round(conf * 100)}%），已生成紧贴笔画遮罩。`,
  };
}

/**
 * 执行智能角落水印自动探测（优先精确平台模板匹配，未命中时走通用 Top-Hat 兜底）。
 * @param imageData 待检测图像数据
 * @param sensitivity 检测灵敏度（默认 'medium'）
 */
export function detectCornerWatermark(
  imageData: ImageData,
  sensitivity: DetectSensitivity = 'medium',
): CornerDetectionResult {
  const { width, height } = imageData;
  if (width < 36 || height < 36) {
    return {
      detected: false,
      confidence: 0,
      message: '图像分辨率过小，跳过角落水印自动探测，请手动涂抹选区。',
    };
  }

  const gray = buildDetectionGrayscale(imageData);

  // Tier 1：精确模板边缘点对匹配（即梦AI / 可灵AI / 可灵AI 3.0 / 豆包AI生成）
  const matchedMarks = detectTemplateWatermarks(gray, width, height, sensitivity);
  if (matchedMarks.length > 0) {
    const { mask, unionRect } = buildMaskFromMatchedMarks(matchedMarks, width, height, gray);
    const primary = matchedMarks[0];
    const conf = Number(primary.score.toFixed(2));
    const summaryLabels = matchedMarks
      .map((m) => `${CORNER_LABELS[m.corner as ScannedCorner] ?? '角落'}「${m.label}」`)
      .join('、');

    return {
      detected: true,
      corner: primary.corner,
      rect: unionRect,
      confidence: conf,
      mask,
      matches: matchedMarks,
      method: 'template',
      message: `已精准识别${summaryLabels}水印（匹配度 ${Math.round(conf * 100)}%），已按真实笔画轮廓生成选区。`,
    };
  }

  // Tier 2：通用 Top-Hat 形态学角落文字探测兜底
  const fallback = detectGenericCornerFallback(gray, width, height, sensitivity);
  if (fallback) {
    return fallback;
  }

  return {
    detected: false,
    confidence: 0,
    message: '未在图像四角识别到已知平台或明显角落水印，请使用矩形框选、画笔涂抹或平台预设。',
  };
}
