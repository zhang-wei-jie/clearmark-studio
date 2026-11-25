import type { CornerAnchor, PresetRegionRule } from '../types';

interface PresetCornerPreviewProps {
  regions: PresetRegionRule[];
  active?: boolean;
}

/** 根据锚点或自定义归一化矩形计算迷你预览框内的百分比定位 */
function resolveRegionBox(rule: PresetRegionRule): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  if (rule.fixedNormalizedRect) {
    const r = rule.fixedNormalizedRect;
    return {
      left: `${Math.max(2, Math.min(82, r.x * 100))}%`,
      top: `${Math.max(4, Math.min(76, r.y * 100))}%`,
      width: `${Math.max(16, Math.min(92, r.width * 100))}%`,
      height: `${Math.max(18, Math.min(88, r.height * 100))}%`,
    };
  }

  const wPct = Math.max(24, Math.min(54, rule.widthRatio * 185));
  const hPct = Math.max(22, Math.min(42, rule.heightRatio * 340));
  const anchorPositions: Record<CornerAnchor, { left: number; top: number }> = {
    'bottom-right': { left: 100 - wPct - 6, top: 100 - hPct - 8 },
    'bottom-left': { left: 6, top: 100 - hPct - 8 },
    'top-right': { left: 100 - wPct - 6, top: 8 },
    'top-left': { left: 6, top: 8 },
    'bottom-center': { left: (100 - wPct) / 2, top: 100 - hPct - 8 },
  };
  const pos = anchorPositions[rule.anchor];

  return {
    left: `${pos.left}%`,
    top: `${pos.top}%`,
    width: `${wPct}%`,
    height: `${hPct}%`,
  };
}

/** 预设卡片专用的四角水印位置迷你示意图 */
export function PresetCornerPreview({ regions, active = false }: PresetCornerPreviewProps) {
  return (
    <div
      className="relative h-9 w-12 shrink-0 overflow-hidden rounded-[5px] border transition-colors"
      style={{
        backgroundColor: 'var(--bg-input)',
        borderColor: active ? 'var(--accent-border)' : 'var(--border-default)',
      }}
      aria-hidden="true"
    >
      {/* 模拟画布参考线，增强空间定位感 */}
      <div
        className="pointer-events-none absolute inset-x-1 top-1/2 h-px opacity-25"
        style={{ backgroundColor: 'var(--border-strong)' }}
      />
      <div
        className="pointer-events-none absolute inset-y-1 left-1/2 w-px opacity-25"
        style={{ backgroundColor: 'var(--border-strong)' }}
      />

      {regions.map((region, idx) => {
        const box = resolveRegionBox(region);
        return (
          <span
            key={`${region.anchor}-${idx}`}
            className="absolute rounded-[2px] border"
            style={{
              ...box,
              backgroundColor: active ? 'rgba(99, 102, 241, 0.42)' : 'var(--mask-fill)',
              borderColor: active ? 'var(--accent)' : 'var(--mask-stroke)',
            }}
          />
        );
      })}
    </div>
  );
}
