import type {
  CornerAnchor,
  NormalizedRect,
  PixelRect,
  PresetRegionRule,
  WatermarkPlatform,
  WatermarkPreset,
} from '../types';

const CUSTOM_PRESETS_STORAGE_KEY = 'clearmark_custom_presets_v1';

/** 平台筛选分类元信息（供右侧预设面板分组展示） */
export const PRESET_PLATFORMS: ReadonlyArray<{ id: WatermarkPlatform; label: string }> = [
  { id: 'jimeng', label: '即梦 AI' },
  { id: 'kling', label: '可灵 AI' },
  { id: 'doubao', label: '豆包 AI' },
  { id: 'tongyi', label: '通义万相' },
  { id: 'generic', label: '通用角落' },
  { id: 'custom', label: '自定义' },
];

/** 内置主流 AI 绘图平台水印预设（支持横图/竖图/方图画幅自适应） */
export const BUILTIN_PRESETS: WatermarkPreset[] = [
  // ==================== 即梦 AI ====================
  {
    id: 'jimeng-br',
    name: '即梦AI · 右下角',
    platform: 'jimeng',
    platformLabel: '即梦 AI',
    description: '适配即梦默认右下角「即梦AI」半透明徽标文字',
    regions: [
      {
        anchor: 'bottom-right',
        widthRatio: 0.175,
        heightRatio: 0.072,
        marginXRatio: 0.012,
        marginYRatio: 0.014,
        minWidthPx: 112,
        maxWidthPx: 420,
        minHeightPx: 40,
        maxHeightPx: 148,
      },
    ],
  },
  {
    id: 'jimeng-tl',
    name: '即梦AI · 左上角「AI生成」',
    platform: 'jimeng',
    platformLabel: '即梦 AI',
    description: '适配即梦左上角「AI生成」角标提示文字',
    regions: [
      {
        anchor: 'top-left',
        widthRatio: 0.135,
        heightRatio: 0.058,
        marginXRatio: 0.012,
        marginYRatio: 0.014,
        minWidthPx: 88,
        maxWidthPx: 320,
        minHeightPx: 34,
        maxHeightPx: 120,
      },
    ],
  },
  {
    id: 'jimeng-dual',
    name: '即梦AI · 双角水印',
    platform: 'jimeng',
    platformLabel: '即梦 AI',
    description: '同时覆盖右下角「即梦AI」与左上角「AI生成」双区域',
    regions: [
      {
        anchor: 'bottom-right',
        widthRatio: 0.175,
        heightRatio: 0.072,
        marginXRatio: 0.012,
        marginYRatio: 0.014,
        minWidthPx: 112,
        maxWidthPx: 420,
        minHeightPx: 40,
        maxHeightPx: 148,
      },
      {
        anchor: 'top-left',
        widthRatio: 0.135,
        heightRatio: 0.058,
        marginXRatio: 0.012,
        marginYRatio: 0.014,
        minWidthPx: 88,
        maxWidthPx: 320,
        minHeightPx: 34,
        maxHeightPx: 120,
      },
    ],
  },

  // ==================== 可灵 AI ====================
  {
    id: 'kling-br',
    name: '可灵AI · 右下角',
    platform: 'kling',
    platformLabel: '可灵 AI',
    description: '适配可灵国内版右下角「可灵AI」品牌标识',
    regions: [
      {
        anchor: 'bottom-right',
        widthRatio: 0.18,
        heightRatio: 0.074,
        marginXRatio: 0.014,
        marginYRatio: 0.015,
        minWidthPx: 116,
        maxWidthPx: 430,
        minHeightPx: 42,
        maxHeightPx: 152,
      },
    ],
  },
  {
    id: 'kling-bl',
    name: '可灵AI · 左下角 KLING AI',
    platform: 'kling',
    platformLabel: '可灵 AI',
    description: '适配可灵国际版或横向版式左下角「KLING AI」标志',
    regions: [
      {
        anchor: 'bottom-left',
        widthRatio: 0.2,
        heightRatio: 0.072,
        marginXRatio: 0.014,
        marginYRatio: 0.016,
        minWidthPx: 128,
        maxWidthPx: 460,
        minHeightPx: 42,
        maxHeightPx: 150,
      },
    ],
  },
  {
    id: 'kling-tl',
    name: '可灵AI · 左上角',
    platform: 'kling',
    platformLabel: '可灵 AI',
    description: '适配可灵左上角「可灵AI」或图生图角标位置',
    regions: [
      {
        anchor: 'top-left',
        widthRatio: 0.175,
        heightRatio: 0.068,
        marginXRatio: 0.014,
        marginYRatio: 0.015,
        minWidthPx: 110,
        maxWidthPx: 410,
        minHeightPx: 38,
        maxHeightPx: 140,
      },
    ],
  },

  // ==================== 豆包 AI ====================
  {
    id: 'doubao-br',
    name: '豆包AI · 右下角「豆包AI生成」',
    platform: 'doubao',
    platformLabel: '豆包 AI',
    description: '适配豆包右下角较长文字「豆包AI生成」标识',
    regions: [
      {
        anchor: 'bottom-right',
        widthRatio: 0.21,
        heightRatio: 0.066,
        marginXRatio: 0.012,
        marginYRatio: 0.014,
        minWidthPx: 132,
        maxWidthPx: 480,
        minHeightPx: 38,
        maxHeightPx: 138,
      },
    ],
  },

  // ==================== 通义万相 ====================
  {
    id: 'tongyi-br',
    name: '通义万相 · 右下角',
    platform: 'tongyi',
    platformLabel: '通义万相',
    description: '适配通义万相右下角「通义万相」图标及文字水印',
    regions: [
      {
        anchor: 'bottom-right',
        widthRatio: 0.195,
        heightRatio: 0.072,
        marginXRatio: 0.014,
        marginYRatio: 0.016,
        minWidthPx: 124,
        maxWidthPx: 450,
        minHeightPx: 40,
        maxHeightPx: 148,
      },
    ],
  },

  // ==================== 通用角落 ====================
  {
    id: 'generic-br',
    name: '通用 · 右下角',
    platform: 'generic',
    platformLabel: '通用角落',
    description: '适用于绝大多数图片右下角署名与版权水印',
    regions: [
      {
        anchor: 'bottom-right',
        widthRatio: 0.19,
        heightRatio: 0.08,
        marginXRatio: 0.012,
        marginYRatio: 0.014,
        minWidthPx: 108,
        maxWidthPx: 460,
        minHeightPx: 40,
        maxHeightPx: 168,
      },
    ],
  },
  {
    id: 'generic-bl',
    name: '通用 · 左下角',
    platform: 'generic',
    platformLabel: '通用角落',
    description: '适用于左下角文字或日期水印',
    regions: [
      {
        anchor: 'bottom-left',
        widthRatio: 0.19,
        heightRatio: 0.08,
        marginXRatio: 0.012,
        marginYRatio: 0.014,
        minWidthPx: 108,
        maxWidthPx: 460,
        minHeightPx: 40,
        maxHeightPx: 168,
      },
    ],
  },
  {
    id: 'generic-tr',
    name: '通用 · 右上角',
    platform: 'generic',
    platformLabel: '通用角落',
    description: '适用于右上角平台徽标与频道标识',
    regions: [
      {
        anchor: 'top-right',
        widthRatio: 0.18,
        heightRatio: 0.078,
        marginXRatio: 0.012,
        marginYRatio: 0.014,
        minWidthPx: 100,
        maxWidthPx: 440,
        minHeightPx: 38,
        maxHeightPx: 160,
      },
    ],
  },
  {
    id: 'generic-tl',
    name: '通用 · 左上角',
    platform: 'generic',
    platformLabel: '通用角落',
    description: '适用于左上角「AI生成」标签或台标水印',
    regions: [
      {
        anchor: 'top-left',
        widthRatio: 0.18,
        heightRatio: 0.078,
        marginXRatio: 0.012,
        marginYRatio: 0.014,
        minWidthPx: 100,
        maxWidthPx: 440,
        minHeightPx: 38,
        maxHeightPx: 160,
      },
    ],
  },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 将归一化矩形裁剪到 [0, 1] 合法范围 */
export function clampNormalizedRect(rect: NormalizedRect): NormalizedRect {
  const x = clamp(rect.x, 0, 0.99);
  const y = clamp(rect.y, 0, 0.99);
  const width = clamp(rect.width, 0.01, 1 - x);
  const height = clamp(rect.height, 0.01, 1 - y);
  return { x, y, width, height };
}

/** 将像素矩形转换为归一化矩形 */
export function pixelRectToNormalizedRect(
  rect: PixelRect,
  imageWidth: number,
  imageHeight: number,
): NormalizedRect {
  if (imageWidth <= 0 || imageHeight <= 0) {
    return { x: 0, y: 0, width: 0.1, height: 0.1 };
  }
  return clampNormalizedRect({
    x: rect.x / imageWidth,
    y: rect.y / imageHeight,
    width: rect.width / imageWidth,
    height: rect.height / imageHeight,
  });
}

/** 将归一化矩形转换为严格位于图像边界内的像素矩形 */
export function normalizedRectToPixelRect(
  rect: NormalizedRect,
  imageWidth: number,
  imageHeight: number,
): PixelRect {
  const safeW = Math.max(1, Math.round(imageWidth));
  const safeH = Math.max(1, Math.round(imageHeight));
  const clamped = clampNormalizedRect(rect);

  const x = clamp(Math.round(clamped.x * safeW), 0, safeW - 1);
  const y = clamp(Math.round(clamped.y * safeH), 0, safeH - 1);
  const width = clamp(Math.round(clamped.width * safeW), 1, safeW - x);
  const height = clamp(Math.round(clamped.height * safeH), 1, safeH - y);

  return { x, y, width, height };
}

/**
 * 根据图像实际宽高与画幅比例计算单个预设规则对应的像素区域。
 * 横图自动收窄宽度比例、适度增高高度比例；竖图反之，保证文字水印在 16:9 / 1:1 / 9:16 均能精准框选。
 */
function computeRegionPixelRect(
  rule: PresetRegionRule,
  imageWidth: number,
  imageHeight: number,
): PixelRect {
  const safeW = Math.max(1, Math.round(imageWidth));
  const safeH = Math.max(1, Math.round(imageHeight));

  if (rule.fixedNormalizedRect) {
    return normalizedRectToPixelRect(rule.fixedNormalizedRect, safeW, safeH);
  }

  // 画幅自适应系数：以 1:1 方图为基准，平滑补偿横竖图差异
  const aspect = safeW / safeH;
  const widthScale = clamp(Math.pow(1 / aspect, 0.35), 0.8, 1.32);
  const heightScale = clamp(Math.pow(aspect, 0.35), 0.76, 1.28);

  let boxW = Math.round(safeW * rule.widthRatio * widthScale);
  let boxH = Math.round(safeH * rule.heightRatio * heightScale);

  // 对极小图进行上限保护，避免 minWidthPx 覆盖整张图
  const effectiveMinW = rule.minWidthPx ? Math.min(rule.minWidthPx, Math.round(safeW * 0.45)) : 8;
  const effectiveMinH = rule.minHeightPx ? Math.min(rule.minHeightPx, Math.round(safeH * 0.35)) : 8;
  const effectiveMaxW = rule.maxWidthPx ? Math.min(rule.maxWidthPx, safeW) : safeW;
  const effectiveMaxH = rule.maxHeightPx ? Math.min(rule.maxHeightPx, safeH) : safeH;

  boxW = clamp(boxW, Math.min(effectiveMinW, safeW), Math.max(1, effectiveMaxW));
  boxH = clamp(boxH, Math.min(effectiveMinH, safeH), Math.max(1, effectiveMaxH));

  const marginX = Math.round(safeW * (rule.marginXRatio ?? 0.012));
  const marginY = Math.round(safeH * (rule.marginYRatio ?? 0.014));

  let x = 0;
  let y = 0;

  switch (rule.anchor) {
    case 'bottom-right':
      x = safeW - boxW - marginX;
      y = safeH - boxH - marginY;
      break;
    case 'bottom-left':
      x = marginX;
      y = safeH - boxH - marginY;
      break;
    case 'top-right':
      x = safeW - boxW - marginX;
      y = marginY;
      break;
    case 'top-left':
      x = marginX;
      y = marginY;
      break;
    case 'bottom-center':
      x = Math.round((safeW - boxW) / 2);
      y = safeH - boxH - marginY;
      break;
  }

  x = clamp(x, 0, Math.max(0, safeW - boxW));
  y = clamp(y, 0, Math.max(0, safeH - boxH));

  return {
    x,
    y,
    width: clamp(boxW, 1, safeW - x),
    height: clamp(boxH, 1, safeH - y),
  };
}

/** 计算预设在指定图像尺寸下的全部水印像素区域（支持双角/多区域） */
export function computePresetRects(
  preset: WatermarkPreset,
  width: number,
  height: number,
): PixelRect[] {
  if (width <= 0 || height <= 0 || preset.regions.length === 0) {
    return [];
  }
  return preset.regions.map((rule) => computeRegionPixelRect(rule, width, height));
}

/** 计算预设的主区域归一化框体（用于画布可拖拽预设框编辑） */
export function presetToPrimaryNormalizedRect(
  preset: WatermarkPreset,
  width: number,
  height: number,
): NormalizedRect {
  const rects = computePresetRects(preset, width, height);
  if (rects.length === 0) {
    return { x: 0.8, y: 0.9, width: 0.18, height: 0.08 };
  }
  return pixelRectToNormalizedRect(rects[0], width, height);
}

/** 根据归一化框体中心点推断最贴近的角落锚点 */
function inferAnchorFromRect(rect: NormalizedRect): CornerAnchor {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  if (cy >= 0.5) {
    if (cx > 0.35 && cx < 0.65) {
      return 'bottom-center';
    }
    return cx >= 0.5 ? 'bottom-right' : 'bottom-left';
  }
  return cx >= 0.5 ? 'top-right' : 'top-left';
}

/** 将用户当前画布上调整好的归一化框体保存为自定义预设 */
export function createCustomPresetFromRect(
  name: string,
  rect: NormalizedRect,
  description?: string,
): WatermarkPreset {
  const trimmedName = name.trim() || '我的自定义预设';
  const clamped = clampNormalizedRect(rect);
  const anchor = inferAnchorFromRect(clamped);
  const now = Date.now();
  const suffix = Math.random().toString(36).slice(2, 7);

  return {
    id: `custom-${now}-${suffix}`,
    name: trimmedName,
    platform: 'custom',
    platformLabel: '自定义',
    description:
      description?.trim() ||
      `自定义区域 (${Math.round(clamped.width * 100)}% × ${Math.round(clamped.height * 100)}%)`,
    regions: [
      {
        anchor,
        widthRatio: clamped.width,
        heightRatio: clamped.height,
        fixedNormalizedRect: clamped,
      },
    ],
    isCustom: true,
    createdAt: now,
  };
}

function isValidPreset(item: unknown): item is WatermarkPreset {
  if (!item || typeof item !== 'object') {
    return false;
  }
  const candidate = item as Partial<WatermarkPreset>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.platform === 'string' &&
    Array.isArray(candidate.regions) &&
    candidate.regions.length > 0
  );
}

/** 从 localStorage 读取用户自定义预设列表 */
export function loadCustomPresets(): WatermarkPreset[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isValidPreset).map((preset) => ({
      ...preset,
      platform: 'custom',
      platformLabel: preset.platformLabel || '自定义',
      isCustom: true,
    }));
  } catch {
    return [];
  }
}

/** 保存或更新一条自定义预设到 localStorage，并返回最新列表 */
export function saveCustomPreset(preset: WatermarkPreset): WatermarkPreset[] {
  const existing = loadCustomPresets();
  const normalized: WatermarkPreset = {
    ...preset,
    platform: 'custom',
    platformLabel: '自定义',
    isCustom: true,
    createdAt: preset.createdAt ?? Date.now(),
  };

  const next = [normalized, ...existing.filter((item) => item.id !== normalized.id)];
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 存储空间不足或隐私模式禁用时保持内存状态，不中断流程
    }
  }
  return next;
}

/** 删除指定 ID 的自定义预设，并返回最新列表 */
export function deleteCustomPreset(id: string): WatermarkPreset[] {
  const existing = loadCustomPresets();
  const next = existing.filter((item) => item.id !== id);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 忽略存储写入异常
    }
  }
  return next;
}

/** 获取全部可用预设（内置预设 + 用户自定义预设） */
export function getAllPresets(): WatermarkPreset[] {
  return [...BUILTIN_PRESETS, ...loadCustomPresets()];
}
