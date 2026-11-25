import { BookmarkPlus, Check, Layers, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { clampNormalizedRect, normalizedRectToPixelRect } from '../data/presets';
import type { NormalizedRect } from '../types';

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface PresetBoxOverlayProps {
  /** 当前归一化预设框 (0~1) */
  box: NormalizedRect;
  /** 原图像素宽度 */
  imageWidth: number;
  /** 原图像素高度 */
  imageHeight: number;
  /** 当前画布渲染在屏幕上的宽度（包含 zoom 缩放后） */
  renderedWidth: number;
  /** 当前画布渲染在屏幕上的高度（包含 zoom 缩放后） */
  renderedHeight: number;
  /** 队列是否有多张图片，用于提示批量套用 */
  totalImages: number;
  onChange: (nextBox: NormalizedRect) => void;
  onApplyToMask: () => void;
  onSaveCustomPreset: (name: string) => void;
  onApplyToAll: () => void;
  onCancel: () => void;
}

const MIN_NORM_SIZE = 0.02;

const HANDLE_CONFIG: Array<{
  id: ResizeHandle;
  cursor: string;
  style: React.CSSProperties;
}> = [
  { id: 'nw', cursor: 'nwse-resize', style: { left: -5, top: -5 } },
  { id: 'n', cursor: 'ns-resize', style: { left: '50%', top: -5, transform: 'translateX(-50%)' } },
  { id: 'ne', cursor: 'nesw-resize', style: { right: -5, top: -5 } },
  { id: 'e', cursor: 'ew-resize', style: { right: -5, top: '50%', transform: 'translateY(-50%)' } },
  { id: 'se', cursor: 'nwse-resize', style: { right: -5, bottom: -5 } },
  {
    id: 's',
    cursor: 'ns-resize',
    style: { left: '50%', bottom: -5, transform: 'translateX(-50%)' },
  },
  { id: 'sw', cursor: 'nesw-resize', style: { left: -5, bottom: -5 } },
  { id: 'w', cursor: 'ew-resize', style: { left: -5, top: '50%', transform: 'translateY(-50%)' } },
];

/**
 * 画布可视化交互预设框：
 * 支持主体拖拽平移、8 向手柄精细缩放、实时原图像素尺寸提示，
 * 以及框旁快捷操作条（应用到选区 / 存为自定义预设 / 应用到全部图片 / 取消）。
 */
export function PresetBoxOverlay({
  box,
  imageWidth,
  imageHeight,
  renderedWidth,
  renderedHeight,
  totalImages,
  onChange,
  onApplyToMask,
  onSaveCustomPreset,
  onApplyToAll,
  onCancel,
}: PresetBoxOverlayProps) {
  const [savingCustom, setSavingCustom] = useState(false);
  const [presetName, setPresetName] = useState('');

  const dragRef = useRef<{
    mode: 'move' | ResizeHandle;
    startClientX: number;
    startClientY: number;
    startBox: NormalizedRect;
  } | null>(null);

  const pixelRect = normalizedRectToPixelRect(box, imageWidth, imageHeight);
  const leftPx = box.x * renderedWidth;
  const topPx = box.y * renderedHeight;
  const widthPx = Math.max(16, box.width * renderedWidth);
  const heightPx = Math.max(16, box.height * renderedHeight);

  // 智能决定快捷操作条放在框上方还是下方，避免靠近边缘时被遮挡
  const placeToolbarAbove = box.y + box.height > 0.72;
  const alignToolbarRight = box.x + box.width / 2 > 0.52;

  const beginDrag = (e: React.PointerEvent, mode: 'move' | ResizeHandle) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startBox: { ...box },
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || renderedWidth <= 0 || renderedHeight <= 0) return;

    e.stopPropagation();
    const dx = (e.clientX - drag.startClientX) / renderedWidth;
    const dy = (e.clientY - drag.startClientY) / renderedHeight;
    const s = drag.startBox;

    if (drag.mode === 'move') {
      const nextX = Math.max(0, Math.min(1 - s.width, s.x + dx));
      const nextY = Math.max(0, Math.min(1 - s.height, s.y + dy));
      onChange(clampNormalizedRect({ x: nextX, y: nextY, width: s.width, height: s.height }));
      return;
    }

    let left = s.x;
    let top = s.y;
    let right = s.x + s.width;
    let bottom = s.y + s.height;

    if (drag.mode.includes('w')) {
      left = Math.max(0, Math.min(right - MIN_NORM_SIZE, s.x + dx));
    }
    if (drag.mode.includes('e')) {
      right = Math.min(1, Math.max(left + MIN_NORM_SIZE, s.x + s.width + dx));
    }
    if (drag.mode.includes('n')) {
      top = Math.max(0, Math.min(bottom - MIN_NORM_SIZE, s.y + dy));
    }
    if (drag.mode.includes('s')) {
      bottom = Math.min(1, Math.max(top + MIN_NORM_SIZE, s.y + s.height + dy));
    }

    onChange(
      clampNormalizedRect({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      }),
    );
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
  };

  const handleConfirmSavePreset = (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = presetName.trim() || `自定义预设 ${pixelRect.width}×${pixelRect.height}`;
    onSaveCustomPreset(finalName);
    setPresetName('');
    setSavingCustom(false);
  };

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      style={{ width: renderedWidth, height: renderedHeight }}
    >
      {/* 可拖拽主体精调框 */}
      <div
        className="pointer-events-auto absolute cursor-move select-none"
        style={{
          left: leftPx,
          top: topPx,
          width: widthPx,
          height: heightPx,
          backgroundColor: 'var(--preset-box-fill)',
          border: '1.5px solid var(--preset-box-stroke)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.2)',
        }}
        onPointerDown={(e) => beginDrag(e, 'move')}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* 像素尺寸实时指示徽标 */}
        <div
          className="pointer-events-none absolute -top-6 left-0 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] font-medium text-white shadow-sm"
          style={{ backgroundColor: 'var(--accent)' }}
        >
          {pixelRect.width} × {pixelRect.height} px
        </div>

        {/* 8 向精细缩放手柄 */}
        {HANDLE_CONFIG.map((h) => (
          <div
            key={h.id}
            role="presentation"
            className="absolute h-2.5 w-2.5 rounded-[2px] border border-[var(--accent)] bg-white shadow-xs transition-transform hover:scale-125"
            style={{ ...h.style, cursor: h.cursor }}
            onPointerDown={(e) => beginDrag(e, h.id)}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        ))}

        {/* 框旁快捷悬浮操作条 */}
        <div
          className="pointer-events-auto absolute z-30 flex items-center gap-1 whitespace-nowrap rounded-lg border p-1"
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderColor: 'var(--border-default)',
            boxShadow: 'var(--shadow-md)',
            ...(placeToolbarAbove ? { bottom: 'calc(100% + 28px)' } : { top: 'calc(100% + 10px)' }),
            ...(alignToolbarRight ? { right: 0 } : { left: 0 }),
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {savingCustom ? (
            <form onSubmit={handleConfirmSavePreset} className="flex items-center gap-1 px-0.5">
              <input
                type="text"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="输入预设名称..."
                autoFocus
                className="w-32 rounded border px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--accent-border)',
                }}
              />
              <button
                type="submit"
                className="inline-flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs font-medium text-white"
                style={{ backgroundColor: 'var(--accent)' }}
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => setSavingCustom(false)}
                className="cursor-pointer rounded px-1.5 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]"
              >
                返回
              </button>
            </form>
          ) : (
            <>
              <button
                type="button"
                onClick={onApplyToMask}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-white transition-colors hover:brightness-110"
                style={{ backgroundColor: 'var(--accent)' }}
                title="将此框体转为遮罩选区"
              >
                <Check className="h-3.5 w-3.5" />
                应用到选区
              </button>

              <button
                type="button"
                onClick={() => setSavingCustom(true)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]"
                title="将当前位置和比例存为自定义预设，便于以后复用"
              >
                <BookmarkPlus className="h-3.5 w-3.5 text-[var(--info)]" />
                存为预设
              </button>

              <button
                type="button"
                onClick={onApplyToAll}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]"
                title={
                  totalImages > 1
                    ? `将该预设框比例同步应用至全部 ${totalImages} 张图片`
                    : '将该预设框同步应用至队列中所有图片'
                }
              >
                <Layers className="h-3.5 w-3.5 text-[var(--success)]" />
                应用到全部
              </button>

              <button
                type="button"
                onClick={onCancel}
                className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
                title="取消预设框 (Esc)"
                aria-label="取消预设框"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
