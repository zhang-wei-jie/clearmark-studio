import {
  Eraser,
  Expand,
  Eye,
  EyeOff,
  Frame,
  Hand,
  Keyboard,
  Paintbrush,
  Redo2,
  RotateCcw,
  Sliders,
  SquareDashed,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  shallowEqual,
  useActiveImageMeta,
  useAppActions,
  useAppSelector,
  useTaskBusyState,
  type AppState,
} from '../store/useAppStore';
import type { ToolType } from '../types';

const selectToolbarToolState = (s: AppState) => ({
  tool: s.tool,
  showMask: s.showMask,
  maskOpacity: s.maskOpacity,
});

interface ToolbarProps {
  onOpenShortcuts: () => void;
}

const TOOL_ITEMS: ReadonlyArray<{
  id: ToolType;
  label: string;
  shortcut: string;
  icon: typeof Paintbrush;
}> = [
  { id: 'brush', label: '画笔涂抹', shortcut: 'B', icon: Paintbrush },
  { id: 'rect', label: '矩形框选', shortcut: 'R', icon: SquareDashed },
  { id: 'eraser', label: '橡皮擦', shortcut: 'E', icon: Eraser },
  { id: 'preset-box', label: '预设框微调', shortcut: 'P', icon: Frame },
  { id: 'hand', label: '抓手平移', shortcut: 'H / Space', icon: Hand },
];

/** 左侧竖排专业修图工具栏 */
export function Toolbar({ onOpenShortcuts }: ToolbarProps) {
  const { activeImage, canUndo, canRedo, hasActiveMask } = useActiveImageMeta();
  const { tool, showMask, maskOpacity } = useAppSelector(selectToolbarToolState, shallowEqual);
  const { isBusy } = useTaskBusyState();
  const {
    setTool,
    undoActive,
    redoActive,
    resetActiveToOriginal,
    clearActiveMask,
    dilateActiveMask,
    setShowMask,
    setMaskOpacity,
  } = useAppActions();

  const [opacityPopoverOpen, setOpacityPopoverOpen] = useState(false);
  const opacityRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!opacityPopoverOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (opacityRef.current && !opacityRef.current.contains(e.target as Node)) {
        setOpacityPopoverOpen(false);
      }
    };
    window.addEventListener('mousedown', onOutside);
    return () => window.removeEventListener('mousedown', onOutside);
  }, [opacityPopoverOpen]);

  return (
    <aside
      className="z-20 flex w-[52px] shrink-0 flex-col items-center justify-between border-r py-2.5 select-none"
      style={{
        backgroundColor: 'var(--bg-panel)',
        borderColor: 'var(--border-subtle)',
      }}
      aria-label="修图工具栏"
    >
      {/* 上半部：绘制工具 + 选区与历史操作 */}
      <div className="flex flex-col items-center gap-1.5">
        {/* 主工具组 */}
        <div className="flex flex-col items-center gap-1">
          {TOOL_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = tool === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTool(item.id)}
                title={`${item.label} (${item.shortcut})`}
                aria-label={item.label}
                aria-pressed={isActive}
                className="group relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border transition-all"
                style={
                  isActive
                    ? {
                        backgroundColor: 'var(--accent-soft)',
                        borderColor: 'var(--accent-border)',
                        color: 'var(--accent)',
                      }
                    : {
                        backgroundColor: 'transparent',
                        borderColor: 'transparent',
                        color: 'var(--text-secondary)',
                      }
                }
              >
                <Icon className="h-4.5 w-4.5" />
                <span
                  className="pointer-events-none absolute right-0.5 bottom-0.5 font-mono text-[8px] opacity-65"
                  aria-hidden="true"
                >
                  {item.shortcut.split(' ')[0]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="my-1 h-px w-6" style={{ backgroundColor: 'var(--border-subtle)' }} />

        {/* 撤销 / 重做 / 恢复原图 */}
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={undoActive}
            disabled={!canUndo || isBusy}
            title="撤销上一步修补 (⌘Z / Ctrl+Z)"
            aria-label="撤销"
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Undo2 className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={redoActive}
            disabled={!canRedo || isBusy}
            title="重做修补 (⇧⌘Z / Ctrl+Shift+Z)"
            aria-label="重做"
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Redo2 className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={resetActiveToOriginal}
            disabled={!activeImage?.processed || isBusy}
            title="恢复当前图片为原始未处理状态"
            aria-label="恢复原图"
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        </div>

        <div className="my-1 h-px w-6" style={{ backgroundColor: 'var(--border-subtle)' }} />

        {/* 选区外扩与清空 */}
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={() => dilateActiveMask(4)}
            disabled={!hasActiveMask || isBusy}
            title="选区向外扩展 4px（覆盖水印柔光阴影边缘）"
            aria-label="选区外扩 4px"
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Expand className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={clearActiveMask}
            disabled={!hasActiveMask || isBusy}
            title="清空当前图片遮罩与预设框"
            aria-label="清空选区"
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 下半部：遮罩显隐、透明度浮层与快捷键帮助 */}
      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          onClick={() => setShowMask(!showMask)}
          title={showMask ? '隐藏红色遮罩层' : '显示红色遮罩层'}
          aria-label={showMask ? '隐藏遮罩' : '显示遮罩'}
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-surface)]"
          style={{
            color: showMask ? 'var(--mask-stroke)' : 'var(--text-muted)',
          }}
        >
          {showMask ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </button>

        {/* 遮罩透明度弹出浮层 */}
        <div className="relative" ref={opacityRef}>
          <button
            type="button"
            onClick={() => setOpacityPopoverOpen((prev) => !prev)}
            title={`遮罩透明度 (${Math.round(maskOpacity * 100)}%)`}
            aria-label="调整遮罩透明度"
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
            style={
              opacityPopoverOpen
                ? { backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }
                : undefined
            }
          >
            <Sliders className="h-4 w-4" />
          </button>

          {opacityPopoverOpen && (
            <div
              className="absolute bottom-0 left-[calc(100%+10px)] z-40 w-48 rounded-xl border p-3"
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-default)',
                boxShadow: 'var(--shadow-lg)',
              }}
            >
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-medium text-[var(--text-primary)]">遮罩不透明度</span>
                <span className="font-mono text-[11px] text-[var(--accent)]">
                  {Math.round(maskOpacity * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.15}
                max={0.95}
                step={0.05}
                value={maskOpacity}
                onChange={(e) => setMaskOpacity(Number(e.target.value))}
                className="studio-slider w-full"
              />
              <div className="mt-2 flex justify-between text-[10px] text-[var(--text-muted)]">
                <span>15% 轻透</span>
                <span>56% 标准</span>
                <span>95% 醒目</span>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onOpenShortcuts}
          title="查看快捷键一览"
          aria-label="快捷键帮助"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
        >
          <Keyboard className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
