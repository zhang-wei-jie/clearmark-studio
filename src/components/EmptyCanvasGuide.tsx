import { ClipboardPaste, ImagePlus, Layers, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DEMO_SAMPLES, renderDemoSampleToCanvas } from '../data/demoSamples';

interface EmptyCanvasGuideProps {
  onSelectFiles: (files: FileList | File[]) => void;
  onLoadDemoSample: (sampleId: string) => Promise<void> | void;
  onLoadAllDemoSamples: () => Promise<void> | void;
  onTriggerFilePicker: () => void;
}

/** 缓存程序化生成的演示样图缩略图 DataURL，避免组件重复挂载时反复渲染大图 */
const demoThumbnailCache = new Map<string, string>();

function getOrGenerateSampleThumbnails(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const sample of DEMO_SAMPLES) {
    const cached = demoThumbnailCache.get(sample.id);
    if (cached) {
      result[sample.id] = cached;
      continue;
    }
    try {
      const fullCanvas = renderDemoSampleToCanvas(sample.id);
      const thumbCanvas = document.createElement('canvas');
      const thumbW = 320;
      const thumbH = Math.round((sample.height / sample.width) * thumbW);
      thumbCanvas.width = thumbW;
      thumbCanvas.height = thumbH;
      const ctx = thumbCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(fullCanvas, 0, 0, thumbW, thumbH);
        const url = thumbCanvas.toDataURL('image/jpeg', 0.86);
        demoThumbnailCache.set(sample.id, url);
        result[sample.id] = url;
      }
    } catch {
      // 忽略离屏绘制异常，保留兜底渐变卡片
    }
  }
  return result;
}

/** 画布空状态专业引导区：上传入口 + 内置即梦/可灵演示样图一键体验 */
export function EmptyCanvasGuide({
  onSelectFiles,
  onLoadDemoSample,
  onLoadAllDemoSamples,
  onTriggerFilePicker,
}: EmptyCanvasGuideProps) {
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  useEffect(() => {
    setThumbnails(getOrGenerateSampleThumbnails());
  }, []);

  const handleLoadSingle = async (id: string) => {
    if (loadingId) return;
    setLoadingId(id);
    try {
      await onLoadDemoSample(id);
    } finally {
      setLoadingId(null);
    }
  };

  const handleLoadAll = async () => {
    if (loadingId) return;
    setLoadingId('__all__');
    try {
      await onLoadAllDemoSamples();
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-3xl space-y-5">
        {/* 主拖拽上传卡片 */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingOver(true);
          }}
          onDragLeave={() => setIsDraggingOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingOver(false);
            if (e.dataTransfer.files.length > 0) {
              onSelectFiles(e.dataTransfer.files);
            }
          }}
          onClick={onTriggerFilePicker}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onTriggerFilePicker();
            }
          }}
          className="group relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-9 text-center transition-all"
          style={{
            backgroundColor: isDraggingOver ? 'var(--accent-soft)' : 'var(--bg-panel)',
            borderColor: isDraggingOver ? 'var(--accent)' : 'var(--border-strong)',
            boxShadow: isDraggingOver ? 'var(--accent-glow)' : 'var(--shadow-sm)',
          }}
        >
          <div
            className="mb-3.5 flex h-13 w-13 items-center justify-center rounded-2xl border transition-transform group-hover:scale-105"
            style={{
              backgroundColor: 'var(--accent-soft)',
              borderColor: 'var(--accent-border)',
              color: 'var(--accent)',
            }}
          >
            <Upload className="h-6 w-6" />
          </div>

          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            拖拽图片至此处，或点击选择本地图片
          </h2>
          <p className="mt-1.5 max-w-md text-xs leading-relaxed text-[var(--text-secondary)]">
            支持 PNG、JPG、WebP 多图批量导入，默认零下载纯本地毫秒级无痕去水印，原图全程不离设备。
          </p>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
            <span
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-medium text-white transition-colors"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              <ImagePlus className="h-3.5 w-3.5" />
              选择图片（支持多选）
            </span>
            <span
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs text-[var(--text-secondary)]"
              style={{
                backgroundColor: 'var(--bg-surface)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <ClipboardPaste className="h-3.5 w-3.5 text-[var(--info)]" />
              支持 Ctrl / ⌘ + V 粘贴截图
            </span>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-[11px] text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 text-[var(--success)]" />
              100% 浏览器本地处理，零隐私上传
            </span>
            <span className="inline-flex items-center gap-1">
              <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
              内置即梦 / 可灵 / 豆包 / 通义一键预设
            </span>
          </div>
        </div>

        {/* 内置演示样图体验区 */}
        <div
          className="rounded-2xl border p-4"
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold text-[var(--text-primary)]">
                暂无素材？点击下方内置 AI 水印样图立即体验
              </h3>
              <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                纯前端高分辨率渲染，自带即梦 AI / 可灵 AI / 豆包 AI 真实模板角标，零网络等待
              </p>
            </div>
            <button
              type="button"
              onClick={handleLoadAll}
              disabled={loadingId !== null}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
              style={{
                backgroundColor: 'var(--accent-soft)',
                borderColor: 'var(--accent-border)',
                color: 'var(--accent)',
              }}
            >
              <Layers className="h-3.5 w-3.5" />
              {loadingId === '__all__' ? '正在生成样图...' : '一键加载全部 3 张（体验批量）'}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {DEMO_SAMPLES.map((sample) => {
              const isLoading = loadingId === sample.id || loadingId === '__all__';
              const thumb = thumbnails[sample.id];
              return (
                <button
                  key={sample.id}
                  type="button"
                  onClick={() => handleLoadSingle(sample.id)}
                  disabled={loadingId !== null}
                  className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border text-left transition-all hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-60"
                  style={{
                    backgroundColor: 'var(--bg-panel-elevated)',
                    borderColor: 'var(--border-subtle)',
                  }}
                >
                  <div className="relative aspect-video w-full overflow-hidden bg-[var(--bg-canvas)]">
                    {thumb ? (
                      <img
                        src={thumb}
                        alt={sample.title}
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[11px] text-[var(--text-muted)]">
                        渲染预览中...
                      </div>
                    )}
                    <span
                      className="absolute right-1.5 bottom-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] text-white"
                      style={{ backgroundColor: 'rgba(9, 11, 16, 0.72)' }}
                    >
                      {sample.width}×{sample.height}
                    </span>
                    {isLoading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-xs font-medium text-white">
                        加载中...
                      </div>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col justify-between p-2.5">
                    <div>
                      <div className="truncate text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)]">
                        {sample.title}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--text-muted)]">
                        {sample.subtitle}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
