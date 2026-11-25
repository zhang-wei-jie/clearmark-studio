import {
  AlertCircle,
  CheckCircle2,
  CloudDownload,
  Cpu,
  FileUp,
  HardDrive,
  Link2,
  Loader2,
  Play,
  PowerOff,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 浏览器端 LaMa ONNX AI 模型管理弹窗 */
export function AiModelModal() {
  const {
    state,
    lamaSources,
    setAiModelModalOpen,
    setEngine,
    preloadMiganAiModel,
    unloadMiganAiSession,
    downloadAiModel,
    cancelAiModelDownload,
    importAiModelFile,
    clearAiModelCache,
    loadAiModelSession,
    unloadAiModelSession,
  } = useAppStore();

  const [selectedSourceId, setSelectedSourceId] = useState<string>(
    () => lamaSources[0]?.id ?? 'custom',
  );
  const [customUrl, setCustomUrl] = useState('');
  const [draggingFile, setDraggingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const open = state.aiModelModalOpen;
  const miganStatus = state.miganStatus;
  const status = state.lamaStatus;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAiModelModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, setAiModelModalOpen]);

  if (!open) {
    return null;
  }

  const isDownloading = status.state === 'downloading';
  const isLoadingSession = status.state === 'loading';
  const isCachedOrReady = status.state === 'cached' || status.state === 'ready';
  const selectedSource = lamaSources.find((src) => src.id === selectedSourceId);

  const handleStartDownload = () => {
    if (selectedSourceId === 'custom') {
      void downloadAiModel(customUrl, '自定义模型源');
      return;
    }
    if (selectedSource) {
      void downloadAiModel(selectedSource.url, selectedSource.label);
    }
  };

  const handleLocalFile = (file?: File) => {
    if (!file) return;
    void importAiModelFile(file);
  };

  const progressPct = Math.min(100, Math.max(0, Math.round(status.progress ?? 0)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-xs"
      style={{ backgroundColor: 'var(--bg-overlay)' }}
      onClick={() => setAiModelModalOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="LaMa AI 模型管理"
    >
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border"
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-default)',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl border"
              style={{
                backgroundColor: 'var(--accent-soft)',
                borderColor: 'var(--accent-border)',
                color: 'var(--accent)',
              }}
            >
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                本地 AI 模型管理 · 内置 MI-GAN 与高阶 LaMa
              </h2>
              <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                默认内置 28.1 MB MI-GAN 离线即用，也支持可选下载或导入 208 MB LaMa 模型，推理 100% 在本地完成
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setAiModelModalOpen(false)}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
            aria-label="关闭弹窗"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 内容滚动体 */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* 内置主力 AI 引擎：MI-GAN v2（28.1 MB 随站分发，离线即用） */}
          <section
            className="rounded-xl border p-4"
            style={{
              backgroundColor: 'var(--bg-panel-elevated)',
              borderColor:
                state.engine === 'migan' ? 'var(--accent-border)' : 'var(--border-subtle)',
            }}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Sparkles className="h-4 w-4 text-[var(--accent)]" />
                  <h3 className="text-xs font-semibold text-[var(--text-primary)]">
                    主力本地 AI · MI-GAN v2（随站内置 · 推荐）
                  </h3>
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor:
                        miganStatus.state === 'ready'
                          ? 'var(--success-soft)'
                          : miganStatus.state === 'error'
                            ? 'var(--danger-soft)'
                            : 'var(--info-soft)',
                      color:
                        miganStatus.state === 'ready'
                          ? 'var(--success)'
                          : miganStatus.state === 'error'
                            ? 'var(--danger)'
                            : 'var(--info)',
                    }}
                  >
                    {miganStatus.state === 'ready'
                      ? 'WASM 会话已就绪'
                      : miganStatus.state === 'loading'
                        ? `加载中 ${Math.round(miganStatus.progress ?? 0)}%`
                        : miganStatus.state === 'error'
                          ? '加载异常'
                          : '28.1 MB · 首次使用按需加载'}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  独立 Web Worker 推理不卡界面；自动先用轻量引擎平滑预填选区再分簇截取
                  512×512 局部高清重构，适合手动框选大面积水印与复杂人物/建筑纹理。
                </p>
                {miganStatus.state === 'error' && miganStatus.error && (
                  <p className="mt-1 text-[11px] text-[var(--danger)]">{miganStatus.error}</p>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {state.engine !== 'migan' && (
                  <button
                    type="button"
                    onClick={() => {
                      setEngine('migan');
                      setAiModelModalOpen(false);
                    }}
                    className="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                    style={{ backgroundColor: 'var(--accent)' }}
                  >
                    使用 MI-GAN 精修
                  </button>
                )}
                {miganStatus.state === 'ready' ? (
                  <button
                    type="button"
                    onClick={() => void unloadMiganAiSession()}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]"
                    style={{ borderColor: 'var(--border-default)' }}
                  >
                    <PowerOff className="h-3 w-3" />
                    释放内存
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void preloadMiganAiModel()}
                    disabled={miganStatus.state === 'loading'}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-surface)] disabled:opacity-45"
                    style={{ borderColor: 'var(--border-default)' }}
                  >
                    {miganStatus.state === 'loading' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                    {miganStatus.state === 'loading' ? '加载中...' : '提前预加载'}
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* 可选高阶模型标题分隔 */}
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11px] font-semibold text-[var(--text-secondary)]">
              可选高阶模型 · LaMa ONNX（~208 MB，按需外部下载或本地导入）
            </span>
            <div className="h-px flex-1" style={{ backgroundColor: 'var(--border-subtle)' }} />
          </div>

          {/* 运行环境与本地缓存状态卡 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div
              className="rounded-xl border p-3.5"
              style={{
                backgroundColor: 'var(--bg-panel-elevated)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div className="text-[11px] font-medium text-[var(--text-muted)]">
                浏览器推理环境检测
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
                  style={{
                    backgroundColor: state.webGpuSupported
                      ? 'var(--success-soft)'
                      : 'var(--bg-surface)',
                    color: state.webGpuSupported ? 'var(--success)' : 'var(--text-muted)',
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      backgroundColor: state.webGpuSupported
                        ? 'var(--success)'
                        : 'var(--text-muted)',
                    }}
                  />
                  WebGPU {state.webGpuSupported ? '可用（优先加速）' : '不可用'}
                </span>
                <span
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
                  style={{
                    backgroundColor: 'var(--info-soft)',
                    color: 'var(--info)',
                  }}
                >
                  WASM 兼容就绪
                </span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
                {state.webGpuSupported
                  ? '已检测到 WebGPU，推理时优先启用显卡加速，异常时安全回退 WASM。'
                  : '当前浏览器未启用 WebGPU，将自动使用 WebAssembly 本地执行 LaMa 模型。'}
              </p>
            </div>

            <div
              className="rounded-xl border p-3.5"
              style={{
                backgroundColor: 'var(--bg-panel-elevated)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-[var(--text-muted)]">
                  本地模型缓存状态
                </span>
                <HardDrive className="h-3.5 w-3.5 text-[var(--text-muted)]" />
              </div>

              <div className="mt-2 flex items-center gap-2">
                {status.state === 'ready' ? (
                  <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
                ) : isDownloading || isLoadingSession ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--warning)]" />
                ) : status.state === 'error' ? (
                  <AlertCircle className="h-4 w-4 text-[var(--danger)]" />
                ) : (
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      backgroundColor:
                        status.state === 'cached' ? 'var(--info)' : 'var(--text-muted)',
                    }}
                  />
                )}
                <span className="text-xs font-semibold text-[var(--text-primary)]">
                  {status.state === 'ready'
                    ? `推理会话已就绪 (${status.backend === 'webgpu' ? 'WebGPU' : 'WASM'})`
                    : status.state === 'cached'
                      ? '模型已缓存（待加载）'
                      : status.state === 'downloading'
                        ? `正在下载模型 (${progressPct}%)`
                        : status.state === 'loading'
                          ? '正在初始化 ONNX 会话...'
                          : status.state === 'error'
                            ? '下载或加载异常'
                            : '尚未下载模型'}
                </span>
              </div>

              {isCachedOrReady ? (
                <div className="mt-2 space-y-2">
                  <div className="truncate text-[11px] text-[var(--text-secondary)]">
                    来源：{status.cachedSource || '本地缓存'} · 占用{' '}
                    <span className="font-mono">{formatBytes(status.cachedSizeBytes)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {status.state === 'cached' ? (
                      <button
                        type="button"
                        onClick={() => void loadAiModelSession()}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-white"
                        style={{ backgroundColor: 'var(--accent)' }}
                      >
                        <Play className="h-3 w-3" />
                        预加载引擎
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void unloadAiModelSession()}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]"
                        style={{ borderColor: 'var(--border-default)' }}
                      >
                        <PowerOff className="h-3 w-3" />
                        释放显存
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => void clearAiModelCache()}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger-soft)]"
                      style={{ borderColor: 'rgba(244, 63, 94, 0.3)' }}
                    >
                      <Trash2 className="h-3 w-3" />
                      清除缓存
                    </button>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                  首次下载约 198~208 MB；如无需 AI 大面积重绘，可直接使用零下载「快速引擎」。
                </p>
              )}
            </div>
          </div>

          {/* 明确的网络 / CORS / 文件错误提示卡 */}
          {status.state === 'error' && status.error && (
            <div
              className="rounded-xl border p-3.5 text-xs"
              style={{
                backgroundColor: 'var(--danger-soft)',
                borderColor: 'rgba(244, 63, 94, 0.35)',
              }}
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]" />
                <div className="space-y-1">
                  <div className="font-semibold text-[var(--danger)]">模型操作未完成</div>
                  <p className="leading-relaxed text-[var(--text-primary)]">{status.error}</p>
                  <p className="text-[11px] text-[var(--text-secondary)]">
                    排障建议：优先选择「国内镜像
                    hf-mirror」；若网络环境限制跨域（CORS），可直接在浏览器新标签页下载 .onnx
                    文件后，拖拽到下方本地导入区域使用。
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* 方式一：在线选择下载源 */}
          <section
            className="rounded-xl border p-4"
            style={{
              backgroundColor: 'var(--bg-panel-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CloudDownload className="h-4 w-4 text-[var(--accent)]" />
                <h3 className="text-xs font-semibold text-[var(--text-primary)]">
                  方式一：在线下载公开 LaMa ONNX 模型
                </h3>
              </div>
              <span className="text-[11px] text-[var(--text-muted)]">支持断点取消与流式进度</span>
            </div>

            <div className="space-y-2">
              {lamaSources.map((src, idx) => {
                const checked = selectedSourceId === src.id;
                return (
                  <label
                    key={src.id}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition-colors"
                    style={{
                      backgroundColor: checked ? 'var(--accent-soft)' : 'var(--bg-panel)',
                      borderColor: checked ? 'var(--accent-border)' : 'var(--border-subtle)',
                    }}
                  >
                    <input
                      type="radio"
                      name="lama-model-source"
                      checked={checked}
                      onChange={() => setSelectedSourceId(src.id)}
                      disabled={isDownloading}
                      className="mt-0.5 accent-[var(--accent)]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-[var(--text-primary)]">
                          {src.label}
                        </span>
                        {idx === 0 && (
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: 'var(--success-soft)',
                              color: 'var(--success)',
                            }}
                          >
                            推荐
                          </span>
                        )}
                        <span className="font-mono text-[10px] text-[var(--text-muted)]">
                          约 {src.sizeHintMB} MB
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                        {src.description}
                      </p>
                      <div className="mt-1 truncate font-mono text-[10px] text-[var(--text-muted)]">
                        {src.url}
                      </div>
                    </div>
                  </label>
                );
              })}

              {/* 自定义 URL 选项 */}
              <label
                className="flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition-colors"
                style={{
                  backgroundColor:
                    selectedSourceId === 'custom' ? 'var(--accent-soft)' : 'var(--bg-panel)',
                  borderColor:
                    selectedSourceId === 'custom' ? 'var(--accent-border)' : 'var(--border-subtle)',
                }}
              >
                <input
                  type="radio"
                  name="lama-model-source"
                  checked={selectedSourceId === 'custom'}
                  onChange={() => setSelectedSourceId('custom')}
                  disabled={isDownloading}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-primary)]">
                    <Link2 className="h-3.5 w-3.5 text-[var(--info)]" />
                    自定义 HTTPS 模型地址（需支持 CORS）
                  </div>
                  {selectedSourceId === 'custom' && (
                    <input
                      type="url"
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      placeholder="https://example.com/lama_fp32.onnx"
                      disabled={isDownloading}
                      className="mt-2 w-full rounded-lg border px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] outline-none"
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-default)',
                      }}
                    />
                  )}
                </div>
              </label>
            </div>

            {/* 下载进度与操作栏 */}
            <div className="mt-3.5">
              {isDownloading ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-[var(--text-primary)]">
                      正在下载模型权重... {progressPct}%
                    </span>
                    <span className="font-mono text-[11px] text-[var(--text-secondary)]">
                      {formatBytes(status.loadedBytes)}
                      {status.totalBytes ? ` / ${formatBytes(status.totalBytes)}` : ''}
                    </span>
                  </div>
                  <div
                    className="h-2 w-full overflow-hidden rounded-full"
                    style={{ backgroundColor: 'var(--bg-surface)' }}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-200"
                      style={{
                        width: `${Math.max(2, progressPct)}%`,
                        backgroundColor: 'var(--accent)',
                      }}
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={cancelAiModelDownload}
                      className="cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger-soft)]"
                      style={{ borderColor: 'rgba(244, 63, 94, 0.32)' }}
                    >
                      取消下载
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-[var(--text-muted)]">
                    下载完成后下次打开网页无需重复下载
                  </span>
                  <button
                    type="button"
                    onClick={handleStartDownload}
                    disabled={
                      isLoadingSession ||
                      (selectedSourceId === 'custom' && customUrl.trim().length === 0)
                    }
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-medium text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
                    style={{ backgroundColor: 'var(--accent)' }}
                  >
                    <CloudDownload className="h-3.5 w-3.5" />
                    {isCachedOrReady ? '重新下载覆盖缓存' : '下载并缓存模型'}
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* 方式二：本地 .onnx 文件拖拽 / 选择导入 */}
          <section
            className="rounded-xl border p-4"
            style={{
              backgroundColor: 'var(--bg-panel-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="mb-2.5 flex items-center gap-2">
              <FileUp className="h-4 w-4 text-[var(--info)]" />
              <h3 className="text-xs font-semibold text-[var(--text-primary)]">
                方式二：导入本地 .onnx 模型文件（离线可用）
              </h3>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDraggingFile(true);
              }}
              onDragLeave={(e) => {
                e.stopPropagation();
                setDraggingFile(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDraggingFile(false);
                handleLocalFile(e.dataTransfer.files[0]);
              }}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-4 py-5 text-center transition-colors"
              style={{
                backgroundColor: draggingFile ? 'var(--accent-soft)' : 'var(--bg-panel)',
                borderColor: draggingFile ? 'var(--accent)' : 'var(--border-default)',
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".onnx,application/octet-stream"
                className="hidden"
                onChange={(e) => {
                  handleLocalFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <p className="text-xs font-medium text-[var(--text-primary)]">
                拖拽本地 <span className="font-mono">lama_fp32.onnx</span> 到此，或点击选择文件
              </p>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                兼容标准 LaMa 512×512 ONNX 权重，自动校验文件头并写入本地缓存
              </p>
            </div>
          </section>

          {/* 引擎选择建议 */}
          <div
            className="rounded-xl border px-3.5 py-2.5 text-[11px] leading-relaxed text-[var(--text-secondary)]"
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <strong className="text-[var(--text-primary)]">引擎选择建议：</strong>
            即梦 AI、可灵 AI、豆包等角落水印，自动识别后使用「快速修复」即可在毫秒内按真实笔画无痕去除；当手动框选大面积不透明水印或复杂背景时，直接切换顶栏「AI
            精修（MI-GAN）」即可离线高保真重构；如需超大规模结构补全，可按需配置下方 LaMa 模型。
          </div>
        </div>

        {/* 底部操作栏 */}
        <div
          className="flex items-center justify-between border-t px-5 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <span className="text-[11px] text-[var(--text-muted)]">
            {isCachedOrReady
              ? '已就绪，可随时使用 AI 增强引擎修复'
              : '可随时关闭窗口，继续使用快速引擎'}
          </span>
          <div className="flex items-center gap-2">
            {isCachedOrReady && state.engine !== 'lama' && (
              <button
                type="button"
                onClick={() => {
                  setEngine('lama');
                  setAiModelModalOpen(false);
                }}
                className="cursor-pointer rounded-lg px-3.5 py-1.5 text-xs font-medium text-white"
                style={{ backgroundColor: 'var(--accent)' }}
              >
                切换至 AI 增强引擎
              </button>
            )}
            <button
              type="button"
              onClick={() => setAiModelModalOpen(false)}
              className="cursor-pointer rounded-lg border px-3.5 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]"
              style={{ borderColor: 'var(--border-default)' }}
            >
              完成
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
