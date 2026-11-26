import {
  Archive,
  CheckCircle2,
  Copy,
  Cpu,
  Download,
  Expand,
  Frame,
  Layers,
  Loader2,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Wand2,
  Zap,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { PRESET_PLATFORMS } from '../data/presets';
import {
  shallowEqual,
  useActiveImageMeta,
  useAppActions,
  useAppSelector,
  type AppState,
} from '../store/useAppStore';
import type { CornerAnchor, DetectSensitivity, ExportFormat, WatermarkPlatform } from '../types';
import { PresetCornerPreview } from './PresetCornerPreview';

const selectInspectorState = (s: AppState) => {
  let processedCount = 0;
  for (const item of s.images) {
    if (item.processed) processedCount += 1;
  }
  return {
    brushSize: s.brushSize,
    featherPx: s.featherPx,
    presets: s.presets,
    selectedPresetId: s.selectedPresetId,
    detectSensitivity: s.detectSensitivity,
    isDetecting: s.isDetecting,
    isRefiningMask: s.isRefiningMask,
    lastDetectionResult: s.lastDetectionResult,
    engine: s.engine,
    fastQuality: s.fastQuality,
    miganStatus: s.miganStatus,
    lamaStatus: s.lamaStatus,
    isProcessing: s.isProcessing,
    exportConfig: s.exportConfig,
    isExporting: s.isExporting,
    zipExportProgress: s.zipExportProgress,
    totalImages: s.images.length,
    processedCount,
  };
};

type PlatformFilter = 'all' | WatermarkPlatform;

const CORNER_LABEL: Record<CornerAnchor, string> = {
  'bottom-right': '右下角',
  'bottom-left': '左下角',
  'top-right': '右上角',
  'top-left': '左上角',
  'bottom-center': '底部居中',
};

const SENSITIVITY_OPTIONS: ReadonlyArray<{ id: DetectSensitivity; label: string }> = [
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
];

const EXPORT_FORMATS: ReadonlyArray<{ id: ExportFormat; label: string; hint: string }> = [
  { id: 'png', label: 'PNG 无损', hint: '支持透明通道' },
  { id: 'jpeg', label: 'JPEG', hint: '体积小巧' },
  { id: 'webp', label: 'WebP', hint: '高压缩高清' },
];

function formatModelSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** 右侧专业属性与功能面板（约 308px 宽） */
export function InspectorPanel() {
  const state = useAppSelector(selectInspectorState, shallowEqual);
  const { activeImage, hasActiveMask } = useActiveImageMeta();
  const {
    setBrushSize,
    setFeatherPx,
    dilateActiveMask,
    refineActiveMaskToStrokes,
    clearActiveMask,
    applyPresetToActive,
    openPresetBoxForActive,
    applyPresetToAll,
    removeCustomPreset,
    setDetectSensitivity,
    autoDetectActive,
    setEngine,
    setFastQuality,
    setAiModelModalOpen,
    setExportConfig,
    exportActiveImage,
    copyActiveImage,
    exportAllAsZip,
  } = useAppActions();

  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');

  const customCount = useMemo(
    () => state.presets.filter((p) => p.isCustom).length,
    [state.presets],
  );

  const filteredPresets = useMemo(() => {
    if (platformFilter === 'all') return state.presets;
    return state.presets.filter((p) => p.platform === platformFilter);
  }, [platformFilter, state.presets]);

  const filterTabs: Array<{ id: PlatformFilter; label: string; count?: number }> = [
    { id: 'all', label: '全部' },
    ...PRESET_PLATFORMS.map((p) => ({
      id: p.id as PlatformFilter,
      label: p.label.replace(' AI', ''),
      count: p.id === 'custom' ? customCount : undefined,
    })),
  ];

  const detection = state.lastDetectionResult;
  const miganStatus = state.miganStatus;
  const lamaStatus = state.lamaStatus;
  const processedCount = state.processedCount;
  const zipOnlyProcessed = processedCount > 0 && processedCount < state.totalImages;

  const lamaBadge =
    lamaStatus.state === 'ready'
      ? {
          text: `${lamaStatus.backend === 'webgpu' ? 'WebGPU' : 'WASM'} 就绪`,
          bg: 'var(--success-soft)',
          color: 'var(--success)',
        }
      : lamaStatus.state === 'cached'
        ? {
            text: `已缓存 ${formatModelSize(lamaStatus.cachedSizeBytes)}`,
            bg: 'var(--info-soft)',
            color: 'var(--info)',
          }
        : lamaStatus.state === 'downloading'
          ? {
              text: `下载中 ${Math.round(lamaStatus.progress ?? 0)}%`,
              bg: 'var(--warning-soft)',
              color: 'var(--warning)',
            }
          : lamaStatus.state === 'loading'
            ? {
                text: '加载中',
                bg: 'var(--warning-soft)',
                color: 'var(--warning)',
              }
            : lamaStatus.state === 'error'
              ? {
                  text: '模型异常',
                  bg: 'var(--danger-soft)',
                  color: 'var(--danger)',
                }
              : {
                  text: '未下载',
                  bg: 'var(--bg-surface)',
                  color: 'var(--text-muted)',
                };

  return (
    <aside
      className="z-20 flex w-[308px] shrink-0 flex-col border-l select-none"
      style={{
        backgroundColor: 'var(--bg-panel)',
        borderColor: 'var(--border-subtle)',
      }}
      aria-label="属性与预设面板"
    >
      <div className="flex-1 space-y-4 overflow-y-auto p-3.5">
        {/* ================= 1. 智能角落水印检测与平台预设 ================= */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
              <Wand2 className="h-3.5 w-3.5 text-[var(--accent)]" />
              水印预设与智能检测
            </h2>
            <span className="text-[10px] text-[var(--text-muted)]">画幅自适应</span>
          </div>

          {/* 一键智能检测卡 */}
          <div
            className="space-y-2.5 rounded-xl border p-2.5"
            style={{
              backgroundColor: 'var(--bg-panel-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <button
              type="button"
              onClick={() => void autoDetectActive()}
              disabled={
                !activeImage || state.isDetecting || state.isRefiningMask || state.isProcessing
              }
              className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-45"
              style={{
                backgroundColor: 'var(--accent-soft)',
                borderColor: 'var(--accent-border)',
                color: 'var(--accent)',
              }}
            >
              {state.isDetecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ScanSearch className="h-3.5 w-3.5" />
              )}
              <span>{state.isDetecting ? '正在扫描四角水印...' : '一键智能检测角落水印'}</span>
            </button>

            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[var(--text-secondary)]">检测灵敏度</span>
              <div
                className="flex items-center gap-0.5 rounded-lg border p-0.5"
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                {SENSITIVITY_OPTIONS.map((opt) => {
                  const active = state.detectSensitivity === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setDetectSensitivity(opt.id)}
                      className="cursor-pointer rounded-md px-2.5 py-0.5 text-[11px] font-medium transition-colors"
                      style={
                        active
                          ? { backgroundColor: 'var(--accent)', color: '#ffffff' }
                          : { color: 'var(--text-secondary)' }
                      }
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 检测结果实时反馈 */}
            {detection && (
              <div
                className="rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed"
                style={
                  detection.detected
                    ? {
                        backgroundColor: 'var(--success-soft)',
                        borderColor: 'rgba(34, 197, 94, 0.3)',
                        color: 'var(--text-primary)',
                      }
                    : {
                        backgroundColor: 'var(--bg-surface)',
                        borderColor: 'var(--border-subtle)',
                        color: 'var(--text-secondary)',
                      }
                }
              >
                {detection.detected ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1 font-medium text-[var(--success)]">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {detection.method === 'template' && detection.matches?.length
                          ? `精准命中 ${detection.matches.map((m) => m.label).join(' + ')}`
                          : `命中 ${detection.corner ? CORNER_LABEL[detection.corner] : '角落区域'}`}
                      </span>
                      <span className="font-mono text-[10px] text-[var(--text-secondary)]">
                        {Math.round(detection.confidence * 100)}%
                      </span>
                    </div>
                    <p className="text-[11px] text-[var(--text-secondary)]">{detection.message}</p>
                  </div>
                ) : (
                  <p>{detection.message}</p>
                )}
              </div>
            )}
          </div>

          {/* 平台筛选标签 */}
          <div className="flex flex-wrap gap-1">
            {filterTabs.map((tab) => {
              const active = platformFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setPlatformFilter(tab.id)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors"
                  style={
                    active
                      ? {
                          backgroundColor: 'var(--accent-soft)',
                          borderColor: 'var(--accent-border)',
                          color: 'var(--accent)',
                        }
                      : {
                          backgroundColor: 'var(--bg-surface)',
                          borderColor: 'transparent',
                          color: 'var(--text-secondary)',
                        }
                  }
                >
                  <span>{tab.label}</span>
                  {tab.count !== undefined && tab.count > 0 && (
                    <span className="rounded-full bg-[var(--accent)] px-1 font-mono text-[9px] text-white">
                      {tab.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* 预设卡片列表 */}
          <div className="max-h-[246px] space-y-1.5 overflow-y-auto pr-0.5">
            {filteredPresets.length === 0 ? (
              <div
                className="rounded-xl border border-dashed px-3 py-5 text-center text-[11px] text-[var(--text-muted)]"
                style={{ borderColor: 'var(--border-default)' }}
              >
                暂无自定义预设。点击任意预设的「微调框」图标或在工具栏按 P
                调整水印位置后，即可保存为专属预设。
              </div>
            ) : (
              filteredPresets.map((preset) => {
                const selected = state.selectedPresetId === preset.id;
                return (
                  <div
                    key={preset.id}
                    className="group flex items-center gap-2.5 rounded-xl border p-2 transition-all"
                    style={{
                      backgroundColor: selected ? 'var(--accent-soft)' : 'var(--bg-panel-elevated)',
                      borderColor: selected ? 'var(--accent-border)' : 'var(--border-subtle)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => applyPresetToActive(preset.id)}
                      disabled={
                        !activeImage ||
                        state.isProcessing ||
                        state.isDetecting ||
                        state.isRefiningMask
                      }
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
                      title={`点击直接套用到当前图片：${preset.description}`}
                    >
                      <PresetCornerPreview regions={preset.regions} active={selected} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-[var(--text-primary)]">
                          {preset.name}
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-[var(--text-muted)]">
                          {preset.description}
                        </div>
                      </div>
                    </button>

                    {/* 右侧操作小图标：框体微调 / 批量套用 / 删除自定义 */}
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => openPresetBoxForActive(preset.id)}
                        disabled={
                          !activeImage ||
                          state.isProcessing ||
                          state.isDetecting ||
                          state.isRefiningMask
                        }
                        className="flex h-6.5 w-6.5 cursor-pointer items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-35"
                        title="在画布上打开可拖拽微调框"
                        aria-label={`微调 ${preset.name}`}
                      >
                        <Frame className="h-3.5 w-3.5" />
                      </button>

                      {state.totalImages > 1 && (
                        <button
                          type="button"
                          onClick={() => applyPresetToAll(preset.id)}
                          disabled={state.isProcessing || state.isDetecting || state.isRefiningMask}
                          className="flex h-6.5 w-6.5 cursor-pointer items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--success)] disabled:cursor-not-allowed disabled:opacity-35"
                          title={`按画幅自适应套用到全部 ${state.totalImages} 张图片`}
                          aria-label={`将 ${preset.name} 套用到全部`}
                        >
                          <Layers className="h-3.5 w-3.5" />
                        </button>
                      )}

                      {preset.isCustom && (
                        <button
                          type="button"
                          onClick={() => removeCustomPreset(preset.id)}
                          className="flex h-6.5 w-6.5 cursor-pointer items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                          title="删除此自定义预设"
                          aria-label={`删除 ${preset.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <div className="h-px w-full" style={{ backgroundColor: 'var(--border-subtle)' }} />

        {/* ================= 2. 工具与引擎参数 ================= */}
        <section className="space-y-3">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
            <SlidersHorizontal className="h-3.5 w-3.5 text-[var(--accent)]" />
            画笔与修复参数
          </h2>

          {/* 画笔大小滑块 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--text-secondary)]">画笔 / 橡皮擦大小</span>
              <span className="font-mono font-medium text-[var(--text-primary)]">
                {state.brushSize} px
              </span>
            </div>
            <input
              type="range"
              min={4}
              max={200}
              step={2}
              value={state.brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="studio-slider w-full"
            />
          </div>

          {/* 边缘羽化像素滑块 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--text-secondary)]">边缘羽化融合</span>
              <span className="font-mono font-medium text-[var(--text-primary)]">
                {state.featherPx} px
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={16}
              step={1}
              value={state.featherPx}
              onChange={(e) => setFeatherPx(Number(e.target.value))}
              className="studio-slider w-full"
            />
            <p className="text-[10px] text-[var(--text-muted)]">
              {state.engine === 'fast'
                ? '快速引擎为 1px 保边抗锯齿（0 关闭，≥4 达上限）'
                : state.engine === 'migan'
                  ? 'MI-GAN 引擎内缘平滑限幅 0–4 px'
                  : 'LaMa 引擎支持 0–16 px 平滑羽化过渡'}
            </p>
          </div>

          {/* 选区微调快捷按钮 */}
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => void refineActiveMaskToStrokes()}
              disabled={
                !hasActiveMask || state.isRefiningMask || state.isDetecting || state.isProcessing
              }
              className="inline-flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border py-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                backgroundColor: 'var(--accent-soft)',
                borderColor: 'var(--accent-border)',
                color: 'var(--accent)',
              }}
              title="将实心框选或预设框自动收缩为紧贴文字/图标笔画的细遮罩，大幅保留字缝原图细节"
            >
              {state.isRefiningMask ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
              <span>{state.isRefiningMask ? '正在提取框内水印笔画...' : '框内智能紧贴笔画'}</span>
            </button>

            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => dilateActiveMask(4)}
                disabled={
                  !hasActiveMask || state.isProcessing || state.isDetecting || state.isRefiningMask
                }
                className="inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg border py-1.5 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  backgroundColor: 'var(--bg-panel-elevated)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <Expand className="h-3 w-3" />
                选区外扩 +4px
              </button>
              <button
                type="button"
                onClick={clearActiveMask}
                disabled={
                  !hasActiveMask || state.isProcessing || state.isDetecting || state.isRefiningMask
                }
                className="inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg border py-1.5 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  backgroundColor: 'var(--bg-panel-elevated)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <Trash2 className="h-3 w-3" />
                清空选区
              </button>
            </div>
          </div>

          {/* 快速引擎质量档位 */}
          {state.engine === 'fast' && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="inline-flex items-center gap-1 text-[var(--text-secondary)]">
                  <Zap className="h-3 w-3 text-[var(--warning)]" />
                  快速修复档位
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setFastQuality('standard')}
                  className="flex cursor-pointer flex-col rounded-lg border px-2.5 py-2 text-left transition-all"
                  style={
                    state.fastQuality === 'standard'
                      ? {
                          backgroundColor: 'var(--accent-soft)',
                          borderColor: 'var(--accent-border)',
                        }
                      : {
                          backgroundColor: 'var(--bg-panel-elevated)',
                          borderColor: 'var(--border-subtle)',
                        }
                  }
                >
                  <span className="text-xs font-medium text-[var(--text-primary)]">标准快速</span>
                  <span className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                    毫秒调和 · 适合批处理
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setFastQuality('high')}
                  className="flex cursor-pointer flex-col rounded-lg border px-2.5 py-2 text-left transition-all"
                  style={
                    state.fastQuality === 'high'
                      ? {
                          backgroundColor: 'var(--accent-soft)',
                          borderColor: 'var(--accent-border)',
                        }
                      : {
                          backgroundColor: 'var(--bg-panel-elevated)',
                          borderColor: 'var(--border-subtle)',
                        }
                  }
                >
                  <span className="text-xs font-medium text-[var(--text-primary)]">精细纹理</span>
                  <span className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                    高精调和 · 细腻微纹理
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* 本地 AI 精修状态卡 */}
          <div
            className="rounded-xl border p-2.5"
            style={{
              backgroundColor: 'var(--bg-panel-elevated)',
              borderColor:
                state.engine !== 'fast' ? 'var(--accent-border)' : 'var(--border-subtle)',
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-primary)]">
                <Cpu className="h-3.5 w-3.5 text-[var(--info)]" />
                <span>{state.engine === 'lama' ? '高阶 LaMa AI' : '内置 MI-GAN AI'}</span>
              </div>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  backgroundColor:
                    state.engine === 'lama'
                      ? lamaBadge.bg
                      : miganStatus.state === 'ready'
                        ? 'var(--success-soft)'
                        : miganStatus.state === 'loading'
                          ? 'var(--warning-soft)'
                          : miganStatus.state === 'error'
                            ? 'var(--danger-soft)'
                            : 'var(--info-soft)',
                  color:
                    state.engine === 'lama'
                      ? lamaBadge.color
                      : miganStatus.state === 'ready'
                        ? 'var(--success)'
                        : miganStatus.state === 'loading'
                          ? 'var(--warning)'
                          : miganStatus.state === 'error'
                            ? 'var(--danger)'
                            : 'var(--info)',
                }}
              >
                {state.engine === 'lama'
                  ? lamaBadge.text
                  : miganStatus.state === 'ready'
                    ? 'WASM 就绪'
                    : miganStatus.state === 'loading'
                      ? `加载中 ${Math.round(miganStatus.progress ?? 0)}%`
                      : miganStatus.state === 'error'
                        ? '加载异常'
                        : '内置 28.1 MB'}
              </span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">
              {state.engine === 'lama'
                ? '当前使用高阶 AI（LaMa），支持分簇 512×512 局部高清重构。'
                : '随站内置 MI-GAN 本地神经网络，大面积手动框选或复杂背景可一键 AI 无痕重构。'}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setEngine(state.engine === 'fast' ? 'migan' : 'fast')}
                disabled={state.isProcessing}
                className="cursor-pointer rounded-lg border py-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                style={
                  state.engine !== 'fast'
                    ? {
                        backgroundColor: 'var(--accent-soft)',
                        borderColor: 'var(--accent-border)',
                        color: 'var(--accent)',
                      }
                    : {
                        backgroundColor: 'var(--accent)',
                        borderColor: 'var(--accent)',
                        color: '#ffffff',
                      }
                }
              >
                {state.engine !== 'fast' ? '切回快速修复' : '启用 AI 精修'}
              </button>
              <button
                type="button"
                onClick={() => setAiModelModalOpen(true)}
                className="cursor-pointer rounded-lg border py-1.5 text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]"
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-default)',
                }}
              >
                模型管理
              </button>
            </div>
          </div>
        </section>

        <div className="h-px w-full" style={{ backgroundColor: 'var(--border-subtle)' }} />

        {/* ================= 3. 导出与隐私设置 ================= */}
        <section className="space-y-3 pb-2">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
              <Download className="h-3.5 w-3.5 text-[var(--accent)]" />
              导出设置
            </h2>
            {activeImage && (
              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                原图 {activeImage.width}×{activeImage.height}
              </span>
            )}
          </div>

          {/* 格式三选 */}
          <div className="grid grid-cols-3 gap-1.5">
            {EXPORT_FORMATS.map((fmt) => {
              const active = state.exportConfig.format === fmt.id;
              return (
                <button
                  key={fmt.id}
                  type="button"
                  onClick={() => setExportConfig({ format: fmt.id })}
                  className="flex cursor-pointer flex-col items-center rounded-lg border px-1.5 py-1.5 text-center transition-all"
                  style={
                    active
                      ? {
                          backgroundColor: 'var(--accent-soft)',
                          borderColor: 'var(--accent-border)',
                          color: 'var(--accent)',
                        }
                      : {
                          backgroundColor: 'var(--bg-panel-elevated)',
                          borderColor: 'var(--border-subtle)',
                          color: 'var(--text-secondary)',
                        }
                  }
                  title={fmt.hint}
                >
                  <span className="text-[11px] font-semibold">{fmt.label}</span>
                  <span className="mt-0.5 text-[9px] opacity-75">{fmt.hint}</span>
                </button>
              );
            })}
          </div>

          {/* JPEG / WebP 质量滑块 */}
          {state.exportConfig.format !== 'png' && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[var(--text-secondary)]">导出画质</span>
                <span className="font-mono font-medium text-[var(--text-primary)]">
                  {Math.round(state.exportConfig.quality * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.02}
                value={state.exportConfig.quality}
                onChange={(e) => setExportConfig({ quality: Number(e.target.value) })}
                className="studio-slider w-full"
              />
            </div>
          )}

          {/* 导出文件名后缀 */}
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="export-filename-suffix"
              className="text-[11px] text-[var(--text-secondary)]"
            >
              文件名后缀
            </label>
            <input
              id="export-filename-suffix"
              type="text"
              value={state.exportConfig.filenameSuffix}
              onChange={(e) => setExportConfig({ filenameSuffix: e.target.value })}
              placeholder="_clean"
              className="w-28 rounded-md border px-2 py-1 font-mono text-[11px] text-[var(--text-primary)] outline-none"
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-subtle)',
              }}
            />
          </div>

          {/* 隐私与分辨率保护标识 */}
          <div
            className="flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px]"
            style={{
              backgroundColor: 'var(--success-soft)',
              borderColor: 'rgba(34, 197, 94, 0.25)',
            }}
          >
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--success)]" />
            <div className="leading-snug">
              <div className="font-medium text-[var(--success)]">自动剥离 EXIF / AIGC 元数据</div>
              <div className="mt-0.5 text-[10px] text-[var(--text-secondary)]">
                保持原始像素分辨率输出，非遮罩区域 100% 像素级无损保留
              </div>
            </div>
          </div>

          {/* 导出操作按钮组 */}
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => void exportActiveImage()}
              disabled={!activeImage || state.isExporting || state.isProcessing}
              className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              {state.isExporting && !state.zipExportProgress ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span>下载当前图片</span>
            </button>

            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => void copyActiveImage()}
                disabled={!activeImage || state.isProcessing}
                className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)] disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  backgroundColor: 'var(--bg-panel-elevated)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                复制剪贴板
              </button>

              <button
                type="button"
                onClick={() => void exportAllAsZip(zipOnlyProcessed)}
                disabled={state.totalImages === 0 || state.isExporting || state.isProcessing}
                className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)] disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  backgroundColor: 'var(--bg-panel-elevated)',
                  borderColor: 'var(--border-subtle)',
                }}
                title={
                  zipOnlyProcessed
                    ? `仅打包已完成去水印的 ${processedCount} 张图片`
                    : '将队列中全部图片按原分辨率打包下载为 ZIP'
                }
              >
                {state.zipExportProgress ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
                    <span>
                      {state.zipExportProgress.completed}/{state.zipExportProgress.total}
                    </span>
                  </>
                ) : (
                  <>
                    <Archive className="h-3.5 w-3.5 text-[var(--info)]" />
                    <span>{zipOnlyProcessed ? `打包已修 (${processedCount})` : '打包 ZIP'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </section>
      </div>
    </aside>
  );
}
