/**
 * 精准平台水印模板注册表（即梦AI / 可灵AI / 可灵AI 3.0 / 豆包AI生成）
 *
 * 每个模板仅存储真实可见笔画的归一化 Alpha 覆盖图与标准参考边距：
 * - 支持多尺度双线性中心采样，保持原尺寸像素严格零偏移；
 * - 记录模板物理不透明度特性（如半透明白字、带深色描边），供检测器与逆向还原共用。
 */

import type { MatchedWatermark, WatermarkTemplateId } from '../../../types';
import doubaoRaw from './doubao-template.json';
import jimengRaw from './jimeng-template.json';
import klingRaw from './kling-template.json';
import kling30Raw from './kling30-template.json';

interface RawTemplateJson {
  width: number;
  height: number;
  referenceShortSide: number;
  right: number;
  bottom: number;
  alpha: string;
}

/** 模板分段定义：用于强制要求图标、品牌字样或版本后缀各段同时吻合，防止局部纹理误报 */
export interface TemplateSegmentRule {
  /** 横向归一化起点 [0, 1) */
  xStart: number;
  /** 横向归一化终点 (0, 1] */
  xEnd: number;
}

/** 解析后的水印模板结构 */
export interface WatermarkTemplate {
  id: WatermarkTemplateId;
  brand: 'jimeng' | 'kling' | 'doubao';
  label: string;
  width: number;
  height: number;
  referenceShortSide: number;
  /** 参考图长边尺寸（可灵等平台在竖图/横图切换时会按长边等比缩放水印） */
  referenceLongSide: number;
  right: number;
  bottom: number;
  /** 标准浅色水印前景色亮度（252~255） */
  foreground: number;
  /** 模板内部峰值 Alpha（用于跨模板自适应特征提取门槛） */
  peakAlpha: number;
  /** 是否具有环绕字形的深色描边（如豆包 AI 生成） */
  hasDarkOutline: boolean;
  /** 是否允许对内部半透明区执行逆向 Alpha / 高频细节还原 */
  supportsAlphaRecovery: boolean;
  /** 分段校验区域（所有分段必须同时通过匹配） */
  segments: readonly TemplateSegmentRule[];
  /** 按行主序存储的 8 位 Alpha 覆盖图（0~255） */
  alpha: Uint8Array;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function createTemplate(
  id: WatermarkTemplateId,
  brand: 'jimeng' | 'kling' | 'doubao',
  label: string,
  raw: RawTemplateJson,
  options: {
    referenceLongSide: number;
    foreground: number;
    hasDarkOutline: boolean;
    supportsAlphaRecovery: boolean;
    segments: readonly TemplateSegmentRule[];
  },
): WatermarkTemplate {
  const alpha = decodeBase64ToBytes(raw.alpha);
  let peakAlpha = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] > peakAlpha) peakAlpha = alpha[i];
  }

  return {
    id,
    brand,
    label,
    width: raw.width,
    height: raw.height,
    referenceShortSide: raw.referenceShortSide,
    referenceLongSide: options.referenceLongSide,
    right: raw.right,
    bottom: raw.bottom,
    foreground: options.foreground,
    peakAlpha: Math.max(1, peakAlpha),
    hasDarkOutline: options.hasDarkOutline,
    supportsAlphaRecovery: options.supportsAlphaRecovery,
    segments: options.segments,
    alpha,
  };
}

/** 已标定的全量平台模板字典 */
export const WATERMARK_TEMPLATES: Readonly<Record<WatermarkTemplateId, WatermarkTemplate>> = {
  jimeng: createTemplate('jimeng', 'jimeng', '即梦AI', jimengRaw, {
    referenceLongSide: 1920,
    foreground: 255,
    hasDarkOutline: false,
    supportsAlphaRecovery: true,
    segments: [
      // 左侧星芒图标 + 右侧「即梦AI」文字
      { xStart: 0, xEnd: 0.31 },
      { xStart: 0.31, xEnd: 1.0 },
    ],
  }),
  kling30: createTemplate('kling30', 'kling', '可灵AI 3.0', kling30Raw, {
    referenceLongSide: 2720,
    foreground: 252,
    hasDarkOutline: false,
    supportsAlphaRecovery: false,
    segments: [
      // 左侧双环图标 + 中段「可灵AI」+ 右侧「3.0」版本后缀，三段需同时匹配才命中 3.0
      { xStart: 0, xEnd: 0.215 },
      { xStart: 0.215, xEnd: 0.695 },
      { xStart: 0.695, xEnd: 1.0 },
    ],
  }),
  kling: createTemplate('kling', 'kling', '可灵AI', klingRaw, {
    referenceLongSide: 2720,
    foreground: 252,
    hasDarkOutline: false,
    supportsAlphaRecovery: false,
    segments: [
      { xStart: 0, xEnd: 0.31 },
      { xStart: 0.31, xEnd: 1.0 },
    ],
  }),
  doubao: createTemplate('doubao', 'doubao', '豆包AI生成', doubaoRaw, {
    referenceLongSide: 2047,
    foreground: 255,
    hasDarkOutline: true,
    supportsAlphaRecovery: true,
    segments: [
      // 左侧「豆包」+ 右侧「AI 生成」两段同时命中，避免单字局部误判
      { xStart: 0, xEnd: 0.43 },
      { xStart: 0.43, xEnd: 1.0 },
    ],
  }),
};

/** 模板扫描顺序：长后缀模板（kling30）排在前缀模板（kling）之前便于优先归并 */
export const TEMPLATE_LIST: readonly WatermarkTemplate[] = [
  WATERMARK_TEMPLATES.jimeng,
  WATERMARK_TEMPLATES.kling30,
  WATERMARK_TEMPLATES.kling,
  WATERMARK_TEMPLATES.doubao,
];

/** 在像素中心执行双线性 Alpha 采样，原始尺寸下严格回落到模板原像素，避免半像素偏移 */
export function sampleTemplateAlpha(template: WatermarkTemplate, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx > template.width - 1 || ty > template.height - 1) {
    return 0;
  }
  const x0 = Math.floor(tx);
  const y0 = Math.floor(ty);
  const x1 = Math.min(x0 + 1, template.width - 1);
  const y1 = Math.min(y0 + 1, template.height - 1);
  const dx = tx - x0;
  const dy = ty - y0;
  const w = template.width;
  const a = template.alpha;

  const top = a[y0 * w + x0] * (1 - dx) + a[y0 * w + x1] * dx;
  const bottom = a[y1 * w + x0] * (1 - dx) + a[y1 * w + x1] * dx;
  return top * (1 - dy) + bottom * dy;
}

/** 查询命中水印局部坐标 (localX, localY) 处的模板不透明度（0~255） */
export function sampleMatchedMarkAlpha(
  mark: Pick<MatchedWatermark, 'templateId' | 'width' | 'height'>,
  localX: number,
  localY: number,
): number {
  const template = WATERMARK_TEMPLATES[mark.templateId];
  if (!template || mark.width <= 0 || mark.height <= 0) return 0;
  const tx = ((localX + 0.5) * template.width) / mark.width - 0.5;
  const ty = ((localY + 0.5) * template.height) / mark.height - 0.5;
  return sampleTemplateAlpha(template, tx, ty);
}
