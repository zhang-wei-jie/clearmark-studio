import {
  Check,
  ChevronDown,
  Copy,
  Cpu,
  Download,
  ImagePlus,
  Layers,
  Loader2,
  Moon,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DEMO_SAMPLES } from '../data/demoSamples';
import { useAppStore } from '../store/useAppStore';
import type { LamaModelStatus, MiganModelStatus } from '../types';

interface HeaderProps {
  onTriggerFilePicker: () => void;
}

/** 根据内置 MI-GAN 模型状态生成顶栏状态点与短标签 */
function getMiganBadgeInfo(status: MiganModelStatus): {
  dotColor: string;
  label: string;
  pulse?: boolean;
} {
  switch (status.state) {
    case 'ready':
      return { dotColor: 'var(--success)', label: 'WASM 就绪' };
    case 'loading':
      return {
        dotColor: 'var(--warning)',
        label: `加载 ${Math.round(status.progress ?? 0)}%`,
        pulse: true,
      };
    case 'error':
      return { dotColor: 'var(--danger)', label: '加载异常' };
    default:
      return { dotColor: 'var(--info)', label: '内置即用' };
  }
}

/** 根据可选 LaMa 模型状态生成顶栏状态点颜色与短标签 */
function getLamaBadgeInfo(status: LamaModelStatus): {
  dotColor: string;
  label: string;
  pulse?: boolean;
} {
  switch (status.state) {
    case 'ready':
      return {
        dotColor: 'var(--success)',
        label: status.backend === 'webgpu' ? 'WebGPU 就绪' : 'WASM 就绪',
      };
    case 'cached':
      return { dotColor: 'var(--info)', label: '已缓存' };
    case 'downloading':
      return {
        dotColor: 'var(--warning)',
        label: `下载 ${Math.round(status.progress ?? 0)}%`,
        pulse: true,
      };
    case 'loading':
      return { dotColor: 'var(--warning)', label: '加载中', pulse: true };
    case 'error':
      return { dotColor: 'var(--danger)', label: '模型异常' };
    default:
      return { dotColor: 'var(--text-muted)', label: '未下载' };
  }
}

/** 顶部专业修图工作台导航栏 */
export function Header({ onTriggerFilePicker }: HeaderProps) {
  const {
    state,
    activeImage,
    setEngine,
    setAiModelModalOpen,
    toggleTheme,
    exportActiveImage,
    copyActiveImage,
    loadDemoSampleById,
    loadAllDemos,
  } = useAppStore();

  const [demoMenuOpen, setDemoMenuOpen] = useState(false);
  const [copiedRecently, setCopiedRecently] = useState(false);
  const demoMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!demoMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (demoMenuRef.current && !demoMenuRef.current.contains(e.target as Node)) {
        setDemoMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [demoMenuOpen]);

  const miganBadge = getMiganBadgeInfo(state.miganStatus);
  const lamaBadge = getLamaBadgeInfo(state.lamaStatus);
  const showLamaTab =
    state.engine === 'lama' ||
    state.lamaStatus.state === 'cached' ||
    state.lamaStatus.state === 'ready' ||
    state.lamaStatus.state === 'downloading' ||
    state.lamaStatus.state === 'loading';

  const handleCopy = async () => {
    await copyActiveImage();
    setCopiedRecently(true);
    window.setTimeout(() => setCopiedRecently(false), 1600);
  };

  return (
    <header
      className="z-30 flex h-[52px] shrink-0 items-center justify-between gap-3 border-b px-3.5 select-none"
      style={{
        backgroundColor: 'var(--bg-panel)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* 左侧品牌标识与快捷上传 */}
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex items-center gap-2">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
            style={{
              background:
                'linear-gradient(135deg, rgba(99, 102, 241, 0.22), rgba(34, 211, 238, 0.16))',
              borderColor: 'var(--accent-border)',
            }}
          >
            <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="clearmark-brand-grad" x1="0" y1="0" x2="24" y2="24">
                  <stop offset="0%" stopColor="#818cf8" />
                  <stop offset="100%" stopColor="#22d3ee" />
                </linearGradient>
              </defs>
              <path
                d="M5 17.5L10.5 8.5L14 13L18.5 6.5"
                stroke="url(#clearmark-brand-grad)"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="18" cy="17.5" r="2.6" fill="#22d3ee" />
            </svg>
          </div>
          <div className="leading-tight">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">
                净影去水印
              </span>
              <span className="hidden text-[11px] font-medium text-[var(--text-muted)] sm:inline">
                ClearMark
              </span>
            </div>
            <div className="hidden text-[10px] text-[var(--text-muted)] md:block">
              本地零上传 · AI 图片无痕去水印工作台
            </div>
          </div>
        </div>

        <div
          className="mx-1 hidden h-5 w-px lg:block"
          style={{ backgroundColor: 'var(--border-subtle)' }}
        />

        <button
          type="button"
          onClick={onTriggerFilePicker}
          className="hidden cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface-hover)] lg:inline-flex"
          style={{
            backgroundColor: 'var(--bg-surface)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <ImagePlus className="h-3.5 w-3.5 text-[var(--accent)]" />
          导入图片
        </button>
      </div>

      {/* 中央引擎切换胶囊 + AI 模型状态入口 */}
      <div
        className="flex items-center gap-1 rounded-xl border p-1"
        style={{
          backgroundColor: 'var(--bg-input)',
          borderColor: 'var(--border-subtle)',
        }}
        role="group"
        aria-label="修复引擎切换"
      >
        <button
          type="button"
          onClick={() => setEngine('fast')}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition-all"
          style={
            state.engine === 'fast'
              ? {
                  backgroundColor: 'var(--accent)',
                  color: '#ffffff',
                  boxShadow: 'var(--shadow-sm)',
                }
              : {
                  color: 'var(--text-secondary)',
                }
          }
          title="纯前端零依赖轻量去水印（Telea + 拉普拉斯调和 + 半透明逆向还原），毫秒级无马赛克"
        >
          <Zap className="h-3.5 w-3.5" />
          <span>快速修复</span>
        </button>

        <button
          type="button"
          onClick={() => setEngine('migan')}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition-all"
          style={
            state.engine === 'migan'
              ? {
                  backgroundColor: 'var(--accent)',
                  color: '#ffffff',
                  boxShadow: 'var(--shadow-sm)',
                }
              : {
                  color: 'var(--text-secondary)',
                }
          }
          title="随站内置 MI-GAN v2 本地神经网络（28.1 MB），首次点击按需加载，适合大面积手动框选与复杂背景重构"
        >
          <Cpu className="h-3.5 w-3.5" />
          <span>AI 精修</span>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
              miganBadge.pulse ? 'animate-pulse' : ''
            }`}
            style={{
              backgroundColor:
                state.engine === 'migan' ? 'rgba(255, 255, 255, 0.18)' : 'var(--bg-surface)',
              color: state.engine === 'migan' ? '#ffffff' : 'var(--text-secondary)',
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: miganBadge.dotColor }}
            />
            <span className="hidden sm:inline">{miganBadge.label}</span>
          </span>
        </button>

        {showLamaTab && (
          <button
            type="button"
            onClick={() => {
              setEngine('lama');
              if (state.lamaStatus.state === 'unloaded' || state.lamaStatus.state === 'error') {
                setAiModelModalOpen(true);
              }
            }}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all"
            style={
              state.engine === 'lama'
                ? {
                    backgroundColor: 'var(--accent)',
                    color: '#ffffff',
                    boxShadow: 'var(--shadow-sm)',
                  }
                : {
                    color: 'var(--text-secondary)',
                  }
            }
            title="可选高阶 LaMa ONNX 模型（~208 MB），适合超大面积重绘"
          >
            <span>LaMa</span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                lamaBadge.pulse ? 'animate-pulse' : ''
              }`}
              style={{
                backgroundColor:
                  state.engine === 'lama' ? 'rgba(255, 255, 255, 0.18)' : 'var(--bg-surface)',
                color: state.engine === 'lama' ? '#ffffff' : 'var(--text-secondary)',
              }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: lamaBadge.dotColor }}
              />
              <span className="hidden md:inline">{lamaBadge.label}</span>
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={() => setAiModelModalOpen(true)}
          className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
          title="管理本地 AI 引擎（内置 MI-GAN / 可选高阶 LaMa）"
          aria-label="管理 AI 模型"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 右侧体验示例图、主题切换、复制与导出 */}
      <div className="flex items-center gap-1.5">
        {/* 体验示例图下拉菜单 */}
        <div className="relative" ref={demoMenuRef}>
          <button
            type="button"
            onClick={() => setDemoMenuOpen((prev) => !prev)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
            style={{
              backgroundColor: demoMenuOpen ? 'var(--bg-surface)' : 'transparent',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <Sparkles className="h-3.5 w-3.5 text-[var(--warning)]" />
            <span className="hidden xl:inline">体验示例图</span>
            <ChevronDown className="h-3 w-3 opacity-70" />
          </button>

          {demoMenuOpen && (
            <div
              className="absolute right-0 mt-1.5 w-72 overflow-hidden rounded-xl border p-1.5"
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-default)',
                boxShadow: 'var(--shadow-lg)',
              }}
            >
              <div className="px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-muted)]">
                内置 AI 水印演示样图（本地实时生成）
              </div>
              <div className="space-y-0.5">
                {DEMO_SAMPLES.map((sample) => (
                  <button
                    key={sample.id}
                    type="button"
                    onClick={() => {
                      setDemoMenuOpen(false);
                      void loadDemoSampleById(sample.id);
                    }}
                    className="flex w-full cursor-pointer flex-col rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-surface)]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium text-[var(--text-primary)]">
                        {sample.title}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
                        {sample.width}×{sample.height}
                      </span>
                    </div>
                    <span className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
                      {sample.subtitle}
                    </span>
                  </button>
                ))}
              </div>
              <div
                className="mt-1.5 border-t pt-1.5"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setDemoMenuOpen(false);
                    void loadAllDemos();
                  }}
                  className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: 'var(--accent-soft)',
                    color: 'var(--accent)',
                  }}
                >
                  <Layers className="h-3.5 w-3.5" />
                  一键加载全部 3 张（体验批量处理）
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 浅色/深色主题切换 */}
        <button
          type="button"
          onClick={toggleTheme}
          className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
          style={{ borderColor: 'var(--border-subtle)' }}
          title={state.theme === 'dark' ? '切换至浅色专业界面' : '切换至暗色专业工作台'}
          aria-label="切换界面主题"
        >
          {state.theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        {/* 复制剪贴板 */}
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={!activeImage || state.isProcessing}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            backgroundColor: 'var(--bg-surface)',
            borderColor: 'var(--border-subtle)',
          }}
          title="将当前图片以无损 PNG 复制到剪贴板"
        >
          {copiedRecently ? (
            <Check className="h-3.5 w-3.5 text-[var(--success)]" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          <span className="hidden md:inline">{copiedRecently ? '已复制' : '复制'}</span>
        </button>

        {/* 单图原分辨率导出 */}
        <button
          type="button"
          onClick={() => void exportActiveImage()}
          disabled={!activeImage || state.isExporting || state.isProcessing}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            backgroundColor: 'var(--accent)',
            boxShadow: activeImage ? 'var(--shadow-sm)' : 'none',
          }}
          title={`保持原图分辨率导出为 ${state.exportConfig.format.toUpperCase()}`}
        >
          {state.isExporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          <span>导出 {state.exportConfig.format.toUpperCase()}</span>
        </button>
      </div>
    </header>
  );
}
