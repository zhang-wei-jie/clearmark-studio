import {
  AlertCircle,
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ImagePlus,
  Layers,
  Loader2,
  Play,
  ScanSearch,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { ImageItem } from '../types';
import { hasMaskPixels } from '../utils/maskUtils';

interface BatchQueueDockProps {
  onTriggerFilePicker: () => void;
}

function StatusBadge({ status }: { status: ImageItem['status'] }) {
  switch (status) {
    case 'processing':
      return (
        <span
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
          style={{ backgroundColor: 'rgba(99, 102, 241, 0.9)' }}
        >
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          处理中
        </span>
      );
    case 'done':
      return (
        <span
          className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
          style={{ backgroundColor: 'rgba(22, 163, 74, 0.88)' }}
        >
          <CheckCircle2 className="h-2.5 w-2.5" />
          已完成
        </span>
      );
    case 'error':
      return (
        <span
          className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
          style={{ backgroundColor: 'rgba(225, 29, 72, 0.9)' }}
        >
          <AlertCircle className="h-2.5 w-2.5" />
          失败
        </span>
      );
    default:
      return (
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-white/90"
          style={{ backgroundColor: 'rgba(15, 23, 42, 0.7)' }}
        >
          待处理
        </span>
      );
  }
}

/** 底部可折叠多图批量处理队列栏 */
export function BatchQueueDock({ onTriggerFilePicker }: BatchQueueDockProps) {
  const {
    state,
    activeImage,
    selectImage,
    removeImage,
    clearImages,
    applyActiveMaskToAll,
    autoDetectAll,
    processBatchImages,
    cancelProcessing,
    exportAllAsZip,
  } = useAppStore();

  const [collapsed, setCollapsed] = useState(false);

  const totalCount = state.images.length;
  const doneCount = state.images.filter((item) => item.processed).length;
  const markedCount = state.images.filter(
    (item) => hasMaskPixels(item.maskBytes) || item.activePresetBox !== null,
  ).length;

  const batch = state.batchProgress;
  const batchPercent =
    batch.running && batch.total > 0
      ? Math.min(
          100,
          Math.round(
            ((batch.completed + batch.failed + batch.currentPercent / 100) / batch.total) * 100,
          ),
        )
      : 0;

  // 队列为空时折叠为极简提示条，不占用画布空间
  if (totalCount === 0) {
    return (
      <div
        className="z-20 flex h-9 shrink-0 items-center justify-between border-t px-3.5 text-[11px] text-[var(--text-muted)] select-none"
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <span>批量队列就绪：可一次拖入多张图片，套用预设或自动检测后一键批量去水印并打包 ZIP</span>
        <button
          type="button"
          onClick={onTriggerFilePicker}
          className="inline-flex cursor-pointer items-center gap-1 font-medium text-[var(--accent)] hover:underline"
        >
          <ImagePlus className="h-3.5 w-3.5" />
          批量添加图片
        </button>
      </div>
    );
  }

  return (
    <section
      className="z-20 flex shrink-0 flex-col border-t select-none"
      style={{
        backgroundColor: 'var(--bg-panel)',
        borderColor: 'var(--border-subtle)',
      }}
      aria-label="多图批量队列"
    >
      {/* 顶部控制与批量操作栏 */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5"
        style={{
          borderBottom: collapsed ? 'none' : '1px solid var(--border-subtle)',
        }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed((prev) => !prev)}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]"
            title={collapsed ? '展开图片队列缩略图' : '折叠队列以增大画布视野'}
          >
            {collapsed ? (
              <ChevronUp className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            )}
            <span>图片队列</span>
            <span
              className="rounded-full px-1.5 py-0.5 font-mono text-[10px]"
              style={{
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-secondary)',
              }}
            >
              {totalCount}
            </span>
          </button>

          <span className="hidden text-[11px] text-[var(--text-muted)] sm:inline">
            已标记 {markedCount} · 已完成 {doneCount}
          </span>

          <button
            type="button"
            onClick={onTriggerFilePicker}
            disabled={state.isProcessing}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] disabled:opacity-40"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <ImagePlus className="h-3 w-3 text-[var(--accent)]" />
            继续添加
          </button>

          <button
            type="button"
            onClick={clearImages}
            disabled={state.isProcessing}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] disabled:opacity-40"
            title="清空队列中全部图片"
          >
            <Trash2 className="h-3 w-3" />
            <span className="hidden md:inline">清空</span>
          </button>
        </div>

        {/* 右侧批量动作条 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={applyActiveMaskToAll}
            disabled={state.isProcessing || (!activeImage && !state.selectedPresetId)}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)] disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              backgroundColor: 'var(--bg-panel-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
            title="将当前图片的预设/选区按比例同步应用到队列全部图片"
          >
            <Layers className="h-3.5 w-3.5 text-[var(--accent)]" />
            <span>预设/选区应用到全部</span>
          </button>

          <button
            type="button"
            onClick={() => void autoDetectAll()}
            disabled={state.isDetecting || state.isProcessing}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)] disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              backgroundColor: 'var(--bg-panel-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
            title="自动扫描队列中所有图片的四角水印并标出选区"
          >
            {state.isDetecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
            ) : (
              <ScanSearch className="h-3.5 w-3.5 text-[var(--info)]" />
            )}
            <span>全部自动检测</span>
          </button>

          {batch.running ? (
            <div
              className="flex items-center gap-2 rounded-lg border px-2.5 py-1"
              style={{
                backgroundColor: 'var(--accent-soft)',
                borderColor: 'var(--accent-border)',
              }}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] font-medium text-[var(--text-primary)]">
                  批量处理 {batch.completed + batch.failed}/{batch.total} ({batchPercent}%)
                </span>
                <div
                  className="hidden h-1.5 w-20 overflow-hidden rounded-full sm:block"
                  style={{ backgroundColor: 'var(--bg-surface)' }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-150"
                    style={{
                      width: `${Math.max(4, batchPercent)}%`,
                      backgroundColor: 'var(--accent)',
                    }}
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={cancelProcessing}
                className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--danger)] hover:bg-[var(--danger-soft)]"
              >
                <X className="h-3 w-3" />
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void processBatchImages()}
              disabled={state.isProcessing || markedCount === 0}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1 text-[11px] font-semibold text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
              style={{ backgroundColor: 'var(--accent)' }}
              title={
                markedCount > 0
                  ? `批量去除已标记的 ${markedCount} 张图片水印`
                  : '请先使用「预设/选区应用到全部」或「全部自动检测」标记水印区域'
              }
            >
              <Play className="h-3 w-3 fill-current" />
              <span>一键批量去水印 ({markedCount})</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => void exportAllAsZip(false)}
            disabled={state.isExporting || state.isProcessing}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)] disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              backgroundColor: 'var(--bg-panel-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
            title="将队列中所有图片按原分辨率打包下载为 ZIP"
          >
            {state.zipExportProgress ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--info)]" />
                <span>
                  打包中 {state.zipExportProgress.completed}/{state.zipExportProgress.total}
                </span>
              </>
            ) : (
              <>
                <Archive className="h-3.5 w-3.5 text-[var(--success)]" />
                <span>打包下载 ZIP</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 横向缩略图队列区 */}
      {!collapsed && (
        <div className="flex items-center gap-2 overflow-x-auto px-3 py-2">
          {state.images.map((item) => {
            const isSelected = item.id === state.activeImageId;
            const hasMask = hasMaskPixels(item.maskBytes) || item.activePresetBox !== null;

            return (
              <div
                key={item.id}
                onClick={() => selectImage(item.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectImage(item.id);
                  }
                }}
                className="group relative flex w-[136px] shrink-0 cursor-pointer flex-col overflow-hidden rounded-xl border transition-all"
                style={{
                  backgroundColor: isSelected ? 'var(--accent-soft)' : 'var(--bg-panel-elevated)',
                  borderColor: isSelected ? 'var(--accent)' : 'var(--border-subtle)',
                  boxShadow: isSelected ? 'var(--shadow-sm)' : 'none',
                }}
              >
                <div className="bg-checkerboard-sm relative h-[64px] w-full overflow-hidden">
                  <img
                    src={item.currentDataUrl}
                    alt={item.name}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />

                  {/* 左下角状态徽标 */}
                  <div className="absolute bottom-1 left-1">
                    <StatusBadge status={item.status} />
                  </div>

                  {/* 右下角已标记选区指示点 */}
                  {hasMask && (
                    <span
                      className="absolute right-1 bottom-1 rounded px-1 py-0.5 text-[9px] font-medium text-white"
                      style={{ backgroundColor: 'rgba(244, 63, 94, 0.88)' }}
                      title="已标记水印选区"
                    >
                      已标选区
                    </span>
                  )}

                  {/* 右上角单项删除按钮 */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeImage(item.id);
                    }}
                    disabled={state.isProcessing}
                    className="absolute top-1 right-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-black/65 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--danger)] disabled:hidden"
                    title={`从队列移除 ${item.name}`}
                    aria-label={`移除 ${item.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>

                <div className="flex items-center justify-between gap-1 px-2 py-1">
                  <span className="truncate text-[11px] font-medium text-[var(--text-primary)]">
                    {item.name}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-[var(--text-muted)]">
                    {item.width}×{item.height}
                  </span>
                </div>
              </div>
            );
          })}

          {/* 末尾快捷添加卡片 */}
          <button
            type="button"
            onClick={onTriggerFilePicker}
            disabled={state.isProcessing}
            className="flex h-[90px] w-[84px] shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] disabled:opacity-40"
            style={{ borderColor: 'var(--border-default)' }}
          >
            <ImagePlus className="h-4 w-4" />
            <span>添加图片</span>
          </button>
        </div>
      )}
    </section>
  );
}
