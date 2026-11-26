import {
  AlertCircle,
  Columns2,
  Eye,
  Loader2,
  Maximize2,
  Minus,
  MoveHorizontal,
  Plus,
  Redo2,
  Sparkles,
  Square,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  shallowEqual,
  useActiveImageMeta,
  useAppActions,
  useAppSelector,
  type AppState,
} from '../store/useAppStore';
import type { PixelRect } from '../types';

const selectCanvasWorkspaceState = (s: AppState) => ({
  tool: s.tool,
  brushSize: s.brushSize,
  maskOpacity: s.maskOpacity,
  showMask: s.showMask,
  compareMode: s.compareMode,
  engine: s.engine,
  isProcessing: s.isProcessing,
  isDetecting: s.isDetecting,
  isRefiningMask: s.isRefiningMask,
  currentProgress: s.currentProgress,
  imageCount: s.images.length,
});
import {
  cloneMask,
  createEmptyMask,
  drawBrushStroke,
  fillMaskRect,
  hasMaskPixels,
  renderMaskToCanvas,
} from '../utils/maskUtils';
import { EmptyCanvasGuide } from './EmptyCanvasGuide';
import { PresetBoxOverlay } from './PresetBoxOverlay';

interface CanvasWorkspaceProps {
  spacePressed: boolean;
  holdOriginal: boolean;
  onSetHoldOriginal: (value: boolean) => void;
  onTriggerFilePicker: () => void;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** 高性能多层 HTML5 Canvas 修图主视口 */
export function CanvasWorkspace({
  spacePressed,
  holdOriginal,
  onSetHoldOriginal,
  onTriggerFilePicker,
}: CanvasWorkspaceProps) {
  const state = useAppSelector(selectCanvasWorkspaceState, shallowEqual);
  const { activeImage, canUndo, canRedo, hasActiveMask } = useActiveImageMeta();
  const {
    loadDemoSampleById,
    loadAllDemos,
    setShowMask,
    setCompareMode,
    updateActiveMask,
    setActivePresetBox,
    commitActivePresetBoxToMask,
    applyActivePresetBoxToAll,
    saveCurrentBoxAsCustomPreset,
    undoActive,
    redoActive,
    processActiveImage,
    cancelProcessing,
  } = useAppActions();

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const currentCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const originalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const brushRingRef = useRef<HTMLDivElement | null>(null);

  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [splitPos, setSplitPos] = useState(50);

  // 仅在光标进入/离开视口时触发一次布尔状态切换，移动坐标直接通过 ref 写入 DOM 避免 60~120Hz 重渲染
  const [cursorVisible, setCursorVisible] = useState(false);
  const cursorPointRef = useRef({ x: 0, y: 0 });

  // 矩形框选实时草稿（原图像素坐标）
  const [rectDraft, setRectDraft] = useState<PixelRect | null>(null);

  // 已解码的原图与当前图缓存
  const [loadedCurrentImg, setLoadedCurrentImg] = useState<HTMLImageElement | null>(null);
  const [loadedOriginalImg, setLoadedOriginalImg] = useState<HTMLImageElement | null>(null);

  // 使用 ref 保存高频交互状态，避免 pointermove 期间闭包过期或重复渲染
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;

  const isPanningRef = useRef(false);
  const panStartRef = useRef({ clientX: 0, clientY: 0, panX: 0, panY: 0 });

  const isDrawingRef = useRef(false);
  const draftMaskRef = useRef<Uint8Array | null>(null);
  const lastDrawPtRef = useRef<{ x: number; y: number } | null>(null);

  const isRectSelectingRef = useRef(false);
  const rectStartRef = useRef<{ x: number; y: number } | null>(null);

  const isDraggingSplitRef = useRef(false);
  const lastFittedImageIdRef = useRef<string | null>(null);

  // 提取稳定字段，避免无关属性（如预设框拖动）触发图片重解码或遮罩重绘
  const activeImageId = activeImage?.id ?? null;
  const activeCurrentUrl = activeImage?.currentDataUrl ?? null;
  const activeOriginalUrl = activeImage?.originalUrl ?? null;
  const activeMaskBytes = activeImage?.maskBytes ?? null;
  const activeWidth = activeImage?.width ?? 0;
  const activeHeight = activeImage?.height ?? 0;

  // 监听视口尺寸变化
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const updateSize = () => {
      setViewportSize({ width: el.clientWidth, height: el.clientHeight });
    };
    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeImageId]);

  // 适应屏幕居中算法
  const fitToScreen = useCallback(
    (imgW?: number, imgH?: number) => {
      const w = imgW ?? activeImage?.width ?? 0;
      const h = imgH ?? activeImage?.height ?? 0;
      const vpW = viewportRef.current?.clientWidth ?? viewportSize.width;
      const vpH = viewportRef.current?.clientHeight ?? viewportSize.height;
      if (w <= 0 || h <= 0 || vpW <= 0 || vpH <= 0) return;

      const padX = 56;
      const padTop = 52;
      const padBottom = 92;
      const availW = Math.max(120, vpW - padX * 2);
      const availH = Math.max(120, vpH - padTop - padBottom);
      const nextZoom = clamp(Math.min(1, availW / w, availH / h), MIN_ZOOM, MAX_ZOOM);

      const nextPanX = Math.round((vpW - w * nextZoom) / 2);
      const nextPanY = Math.round(padTop + (availH - h * nextZoom) / 2);

      setZoom(nextZoom);
      setPan({ x: nextPanX, y: nextPanY });
    },
    [activeImage?.height, activeImage?.width, viewportSize.height, viewportSize.width],
  );

  // 缩放到 100% 并保持画布中心
  const resetToActualSize = useCallback(() => {
    if (!activeImage) return;
    const vpW = viewportRef.current?.clientWidth ?? viewportSize.width;
    const vpH = viewportRef.current?.clientHeight ?? viewportSize.height;
    if (vpW <= 0 || vpH <= 0) return;

    setZoom(1);
    setPan({
      x: Math.round((vpW - activeImage.width) / 2),
      y: Math.round((vpH - activeImage.height) / 2),
    });
  }, [activeImage, viewportSize.height, viewportSize.width]);

  // 以视口中心为锚点缩放（用于按钮点击 +/-）
  const zoomAroundCenter = useCallback((factor: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const cx = vp.clientWidth / 2;
    const cy = vp.clientHeight / 2;
    const prevZoom = zoomRef.current;
    const nextZoom = clamp(prevZoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (nextZoom === prevZoom) return;

    const imgX = (cx - panRef.current.x) / prevZoom;
    const imgY = (cy - panRef.current.y) / prevZoom;
    setZoom(nextZoom);
    setPan({
      x: cx - imgX * nextZoom,
      y: cy - imgY * nextZoom,
    });
  }, []);

  // 切换不同图片时自动适应屏幕（同一张图修复后保留当前视角便于细查）
  useEffect(() => {
    if (!activeImage) {
      lastFittedImageIdRef.current = null;
      return;
    }
    if (
      lastFittedImageIdRef.current !== activeImage.id &&
      viewportSize.width > 0 &&
      viewportSize.height > 0
    ) {
      lastFittedImageIdRef.current = activeImage.id;
      setSplitPos(50);
      fitToScreen(activeImage.width, activeImage.height);
    }
  }, [activeImage, fitToScreen, viewportSize.height, viewportSize.width]);

  // 切换不同图片时立即清空旧图缓存，避免新图解码完成前一帧把上一张图拉伸绘制到新尺寸画布
  const prevDecodedImageIdRef = useRef<string | null>(null);

  // 异步解码当前图与原图（防范快速切图异步竞态）
  useEffect(() => {
    if (!activeImageId || !activeCurrentUrl || !activeOriginalUrl) {
      prevDecodedImageIdRef.current = null;
      setLoadedCurrentImg(null);
      setLoadedOriginalImg(null);
      return;
    }

    if (prevDecodedImageIdRef.current !== activeImageId) {
      prevDecodedImageIdRef.current = activeImageId;
      setLoadedCurrentImg(null);
      setLoadedOriginalImg(null);
    }

    let cancelled = false;
    const currUrl = activeCurrentUrl;
    const origUrl = activeOriginalUrl;

    const curr = new Image();
    curr.decoding = 'async';
    curr.onload = () => {
      if (!cancelled) {
        setLoadedCurrentImg(curr);
        if (origUrl === currUrl) {
          setLoadedOriginalImg(curr);
        }
      }
    };
    curr.src = currUrl;

    if (origUrl !== currUrl) {
      const orig = new Image();
      orig.decoding = 'async';
      orig.onload = () => {
        if (!cancelled) {
          setLoadedOriginalImg(orig);
        }
      };
      orig.src = origUrl;
    }

    return () => {
      cancelled = true;
    };
  }, [activeCurrentUrl, activeOriginalUrl, activeImageId]);

  // 绘制主画面 Canvas（普通模式按住看原图时直接切换显示原图）
  useEffect(() => {
    const canvas = currentCanvasRef.current;
    if (!canvas || activeWidth <= 0 || activeHeight <= 0) return;

    const targetImg =
      holdOriginal && loadedOriginalImg
        ? loadedOriginalImg
        : (loadedCurrentImg ?? loadedOriginalImg);
    if (!targetImg) return;

    if (canvas.width !== activeWidth) canvas.width = activeWidth;
    if (canvas.height !== activeHeight) canvas.height = activeHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(targetImg, 0, 0, activeWidth, activeHeight);
  }, [activeHeight, activeWidth, holdOriginal, loadedCurrentImg, loadedOriginalImg]);

  // 分屏对比时绘制原图覆盖 Canvas
  const isSplitCompare = Boolean(
    activeImage?.processed && state.compareMode === 'split' && !holdOriginal,
  );

  useEffect(() => {
    if (!isSplitCompare) return;
    const canvas = originalCanvasRef.current;
    if (!canvas || activeWidth <= 0 || activeHeight <= 0 || !loadedOriginalImg) return;

    if (canvas.width !== activeWidth) canvas.width = activeWidth;
    if (canvas.height !== activeHeight) canvas.height = activeHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(loadedOriginalImg, 0, 0, activeWidth, activeHeight);
  }, [activeHeight, activeWidth, isSplitCompare, loadedOriginalImg]);

  // 当 store 中的遮罩或透明度更新时同步绘制珊瑚红遮罩 Canvas（非拖拽绘制态）
  useEffect(() => {
    const canvas = maskCanvasRef.current;
    if (
      !canvas ||
      !activeImageId ||
      activeWidth <= 0 ||
      activeHeight <= 0 ||
      isDrawingRef.current
    ) {
      return;
    }

    renderMaskToCanvas(canvas, activeMaskBytes, activeWidth, activeHeight, {
      opacity: state.maskOpacity,
    });
  }, [activeImageId, activeMaskBytes, activeWidth, activeHeight, state.maskOpacity]);

  // 原生 wheel 监听实现围绕光标平滑缩放（passive: false 禁止页面滚动）
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !activeImageId) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const vx = e.clientX - rect.left;
      const vy = e.clientY - rect.top;

      const prevZoom = zoomRef.current;
      const factor = Math.exp(-e.deltaY * 0.0016);
      const nextZoom = clamp(prevZoom * factor, MIN_ZOOM, MAX_ZOOM);
      if (Math.abs(nextZoom - prevZoom) < 1e-4) return;

      const imgX = (vx - panRef.current.x) / prevZoom;
      const imgY = (vy - panRef.current.y) / prevZoom;

      setZoom(nextZoom);
      setPan({
        x: vx - imgX * nextZoom,
        y: vy - imgY * nextZoom,
      });
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [activeImageId]);

  /** 将屏幕坐标转换为原图像素坐标 */
  const clientToImagePoint = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const el = viewportRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;
    return {
      x: (vx - panRef.current.x) / zoomRef.current,
      y: (vy - panRef.current.y) / zoomRef.current,
    };
  };

  /** 在遮罩 Canvas 上直接增量渲染单段笔触（保障 4K 大图 60fps 涂抹流畅） */
  const paintStrokeOnPreviewCanvas = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    isEraser: boolean,
  ) => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, radius * 2);

    if (isEraser) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      // 尽量与 renderMaskToCanvas 默认填充透明度 (128/255 * maskOpacity) 对齐，减少松手重绘跳变
      ctx.strokeStyle = `rgba(244, 63, 94, ${((128 / 255) * state.maskOpacity).toFixed(3)})`;
    }

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    // 起点与终点重合时画极短线段保证圆点可见
    ctx.lineTo(x1 === x0 && y1 === y0 ? x1 + 0.01 : x1, y1);
    ctx.stroke();
    ctx.restore();
  };

  const isPanMode = spacePressed || state.tool === 'hand';
  const isBusy = state.isProcessing || state.isDetecting || state.isRefiningMask;
  const showBrushRing =
    Boolean(activeImage) &&
    !isPanMode &&
    !holdOriginal &&
    !isBusy &&
    (state.tool === 'brush' || state.tool === 'eraser') &&
    cursorVisible;

  const updateBrushRingTransform = useCallback((x: number, y: number) => {
    cursorPointRef.current = { x, y };
    if (brushRingRef.current) {
      brushRingRef.current.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    }
  }, []);

  useEffect(() => {
    if (showBrushRing && brushRingRef.current) {
      const { x, y } = cursorPointRef.current;
      brushRingRef.current.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    }
  }, [showBrushRing]);

  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!activeImage) return;

    // 鼠标中键、Space 键或抓手工具均进入平移模式
    if (e.button === 1 || isPanMode) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      isPanningRef.current = true;
      panStartRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
      return;
    }

    if (e.button !== 0 || isBusy || holdOriginal) return;
    if (state.tool === 'preset-box') return;

    const pt = clientToImagePoint(e.clientX, e.clientY);
    if (!pt) return;

    // 若点击位置远离画布范围（超出图像 80px），忽略误触
    if (
      pt.x < -80 ||
      pt.y < -80 ||
      pt.x > activeImage.width + 80 ||
      pt.y > activeImage.height + 80
    ) {
      return;
    }

    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);

    if (!state.showMask) {
      setShowMask(true);
    }

    if (state.tool === 'brush' || state.tool === 'eraser') {
      const isEraser = state.tool === 'eraser';
      const baseMask = activeImage.maskBytes
        ? cloneMask(activeImage.maskBytes)
        : createEmptyMask(activeImage.width, activeImage.height);
      const radius = Math.max(2, state.brushSize / 2);

      drawBrushStroke(
        baseMask,
        activeImage.width,
        activeImage.height,
        pt.x,
        pt.y,
        pt.x,
        pt.y,
        radius,
        isEraser ? 0 : 255,
      );

      draftMaskRef.current = baseMask;
      lastDrawPtRef.current = pt;
      isDrawingRef.current = true;
      paintStrokeOnPreviewCanvas(pt.x, pt.y, pt.x, pt.y, radius, isEraser);
      return;
    }

    if (state.tool === 'rect') {
      const clampedX = clamp(pt.x, 0, activeImage.width);
      const clampedY = clamp(pt.y, 0, activeImage.height);
      rectStartRef.current = { x: clampedX, y: clampedY };
      isRectSelectingRef.current = true;
      setRectDraft({ x: clampedX, y: clampedY, width: 1, height: 1 });
    }
  };

  const handleViewportPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      updateBrushRingTransform(e.clientX - rect.left, e.clientY - rect.top);
      if (!cursorVisible) {
        setCursorVisible(true);
      }
    }

    if (!activeImage) return;

    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.clientX;
      const dy = e.clientY - panStartRef.current.clientY;
      setPan({
        x: panStartRef.current.panX + dx,
        y: panStartRef.current.panY + dy,
      });
      return;
    }

    if (isDrawingRef.current && draftMaskRef.current && lastDrawPtRef.current) {
      const pt = clientToImagePoint(e.clientX, e.clientY);
      if (!pt) return;
      const prev = lastDrawPtRef.current;
      const isEraser = state.tool === 'eraser';
      const radius = Math.max(2, state.brushSize / 2);

      drawBrushStroke(
        draftMaskRef.current,
        activeImage.width,
        activeImage.height,
        prev.x,
        prev.y,
        pt.x,
        pt.y,
        radius,
        isEraser ? 0 : 255,
      );
      paintStrokeOnPreviewCanvas(prev.x, prev.y, pt.x, pt.y, radius, isEraser);
      lastDrawPtRef.current = pt;
      return;
    }

    if (isRectSelectingRef.current && rectStartRef.current) {
      const pt = clientToImagePoint(e.clientX, e.clientY);
      if (!pt) return;
      const curX = clamp(pt.x, 0, activeImage.width);
      const curY = clamp(pt.y, 0, activeImage.height);
      const x = Math.min(rectStartRef.current.x, curX);
      const y = Math.min(rectStartRef.current.y, curY);
      const width = Math.max(1, Math.abs(curX - rectStartRef.current.x));
      const height = Math.max(1, Math.abs(curY - rectStartRef.current.y));
      setRectDraft({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      });
    }
  };

  const finishViewportInteraction = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    if (isPanningRef.current) {
      isPanningRef.current = false;
      return;
    }

    if (isDrawingRef.current) {
      isDrawingRef.current = false;
      lastDrawPtRef.current = null;
      const committed = draftMaskRef.current;
      draftMaskRef.current = null;
      if (activeImage && committed) {
        updateActiveMask(hasMaskPixels(committed) ? committed : null);
      }
      return;
    }

    if (isRectSelectingRef.current) {
      isRectSelectingRef.current = false;
      rectStartRef.current = null;
      const finalRect = rectDraft;
      setRectDraft(null);

      if (activeImage && finalRect && finalRect.width >= 3 && finalRect.height >= 3) {
        const nextMask = activeImage.maskBytes
          ? cloneMask(activeImage.maskBytes)
          : createEmptyMask(activeImage.width, activeImage.height);
        fillMaskRect(nextMask, activeImage.width, activeImage.height, finalRect, 255);
        updateActiveMask(nextMask);
      }
    }
  };

  // 分屏对比拖动处理
  const updateSplitByClientX = (clientX: number) => {
    const el = viewportRef.current;
    if (!el || !activeImage) return;
    const rect = el.getBoundingClientRect();
    const stageLeft = rect.left + panRef.current.x;
    const stageW = activeImage.width * zoomRef.current;
    if (stageW <= 0) return;
    const pct = clamp(((clientX - stageLeft) / stageW) * 100, 0, 100);
    setSplitPos(pct);
  };

  // 无图片时展示引导区
  if (!activeImage) {
    return (
      <main
        className="relative flex flex-1 flex-col overflow-hidden"
        style={{ backgroundColor: 'var(--bg-canvas)' }}
      >
        <EmptyCanvasGuide
          onLoadDemoSample={loadDemoSampleById}
          onLoadAllDemoSamples={loadAllDemos}
          onTriggerFilePicker={onTriggerFilePicker}
        />
      </main>
    );
  }

  const renderedWidth = Math.max(1, activeImage.width * zoom);
  const renderedHeight = Math.max(1, activeImage.height * zoom);
  const brushDiameterPx = Math.max(6, state.brushSize * zoom);

  const viewportCursor = isPanMode
    ? isPanningRef.current
      ? 'grabbing'
      : 'grab'
    : showBrushRing
      ? 'none'
      : state.tool === 'rect'
        ? 'crosshair'
        : 'default';

  return (
    <main
      className="relative flex flex-1 flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--bg-canvas)' }}
    >
      {/* 多层画布交互视口 */}
      <div
        ref={viewportRef}
        className="relative flex-1 overflow-hidden select-none touch-none"
        style={{
          cursor: viewportCursor,
          backgroundImage: 'radial-gradient(var(--border-subtle) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={finishViewportInteraction}
        onPointerCancel={finishViewportInteraction}
        onPointerLeave={() => setCursorVisible(false)}
      >
        {/* 左上角轻信息状态条 */}
        <div
          className="pointer-events-none absolute top-3 left-3 z-20 flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1 text-[11px] backdrop-blur-md"
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderColor: 'var(--border-subtle)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <span className="max-w-[200px] truncate font-medium text-[var(--text-primary)]">
            {activeImage.name}
          </span>
          <span className="font-mono text-[var(--text-muted)]">
            {activeImage.width} × {activeImage.height}
          </span>
          {activeImage.processed && (
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[10px] font-medium"
              style={{ backgroundColor: 'var(--success-soft)', color: 'var(--success)' }}
            >
              已修复
              {activeImage.lastDurationMs
                ? ` · ${Math.max(1, Math.round(activeImage.lastDurationMs))}ms`
                : ''}
            </span>
          )}
          {activeImage.history.length > 1 && (
            <span className="text-[10px] text-[var(--text-muted)]">
              步骤 {activeImage.historyIndex}/{activeImage.history.length - 1}
            </span>
          )}
        </div>

        {/* 顶部居中按住原图提示或单图异常条 */}
        {holdOriginal && (
          <div
            className="pointer-events-none absolute top-3 left-1/2 z-30 w-max -translate-x-1/2 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium text-white shadow-md"
            style={{
              backgroundColor: 'rgba(15, 23, 42, 0.85)',
              borderColor: 'var(--accent-border)',
            }}
          >
            正在预览原图 · 松开恢复修复画面
          </div>
        )}

        {activeImage.status === 'error' && activeImage.error && (
          <div
            className="absolute top-3 right-3 z-30 flex max-w-sm items-center gap-2 rounded-lg border px-3 py-1.5 text-xs"
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'rgba(244, 63, 94, 0.4)',
              color: 'var(--danger)',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{activeImage.error}</span>
          </div>
        )}

        {/* 图像画布舞台 */}
        <div
          className="bg-checkerboard absolute top-0 left-0 origin-top-left border"
          style={{
            width: renderedWidth,
            height: renderedHeight,
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
            borderColor: 'var(--border-default)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          {/* 图层 1：当前图（或按住原图时显示原图） */}
          <canvas
            ref={currentCanvasRef}
            className="pointer-events-none block h-full w-full"
            style={{ imageRendering: zoom >= 2.5 ? 'pixelated' : 'auto' }}
          />

          {/* 图层 1B：交互式分屏对比原图层 */}
          {isSplitCompare && (
            <>
              <canvas
                ref={originalCanvasRef}
                className="pointer-events-none absolute inset-0 block h-full w-full"
                style={{
                  imageRendering: zoom >= 2.5 ? 'pixelated' : 'auto',
                  clipPath: `inset(0 ${100 - splitPos}% 0 0)`,
                }}
              />
              <span
                className="pointer-events-none absolute top-2.5 left-2.5 z-20 rounded px-2 py-0.5 text-[11px] font-medium text-white"
                style={{ backgroundColor: 'rgba(9, 11, 16, 0.72)' }}
              >
                原图
              </span>
              <span
                className="pointer-events-none absolute top-2.5 right-2.5 z-20 rounded px-2 py-0.5 text-[11px] font-medium text-white"
                style={{ backgroundColor: 'rgba(99, 102, 241, 0.85)' }}
              >
                修复后
              </span>

              {/* 分屏滑块竖线与拖动手柄 */}
              <div
                className="pointer-events-auto absolute inset-y-0 z-25 -ml-3 flex w-6 cursor-ew-resize items-center justify-center"
                style={{ left: `${splitPos}%` }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  isDraggingSplitRef.current = true;
                  updateSplitByClientX(e.clientX);
                }}
                onPointerMove={(e) => {
                  if (!isDraggingSplitRef.current) return;
                  e.stopPropagation();
                  updateSplitByClientX(e.clientX);
                }}
                onPointerUp={(e) => {
                  if (!isDraggingSplitRef.current) return;
                  e.stopPropagation();
                  isDraggingSplitRef.current = false;
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                }}
                onPointerCancel={(e) => {
                  if (!isDraggingSplitRef.current) return;
                  e.stopPropagation();
                  isDraggingSplitRef.current = false;
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                }}
                title="左右拖动对比去水印前后效果"
              >
                <div className="h-full w-0.5 bg-white shadow-[0_0_8px_rgba(0,0,0,0.65)]" />
                <div
                  className="absolute flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-white shadow-lg"
                  style={{ backgroundColor: 'var(--accent)' }}
                >
                  <MoveHorizontal className="h-4 w-4" />
                </div>
              </div>
            </>
          )}

          {/* 图层 2：珊瑚红半透明遮罩 Canvas */}
          <canvas
            ref={maskCanvasRef}
            className="pointer-events-none absolute inset-0 block h-full w-full transition-opacity duration-100"
            style={{
              opacity: state.showMask && !holdOriginal ? 1 : 0,
              imageRendering: zoom >= 2.5 ? 'pixelated' : 'auto',
            }}
          />

          {/* 图层 3：矩形框选实时预览 */}
          {rectDraft && (
            <div
              className="pointer-events-none absolute z-20 border-[1.5px] border-dashed"
              style={{
                left: rectDraft.x * zoom,
                top: rectDraft.y * zoom,
                width: Math.max(2, rectDraft.width * zoom),
                height: Math.max(2, rectDraft.height * zoom),
                backgroundColor: 'var(--mask-fill)',
                borderColor: 'var(--mask-stroke)',
              }}
            >
              <span
                className="absolute -top-5 left-0 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] font-medium text-white"
                style={{ backgroundColor: 'var(--danger)' }}
              >
                {rectDraft.width} × {rectDraft.height} px
              </span>
            </div>
          )}

          {/* 图层 4：可视化交互预设精调框（处理/检测/抠笔画进行中暂时隐藏以防止并发改写选区） */}
          {activeImage.activePresetBox && !holdOriginal && !isBusy && (
            <PresetBoxOverlay
              box={activeImage.activePresetBox}
              imageWidth={activeImage.width}
              imageHeight={activeImage.height}
              renderedWidth={renderedWidth}
              renderedHeight={renderedHeight}
              totalImages={state.imageCount}
              onChange={(nextBox) => setActivePresetBox(nextBox)}
              onApplyToMask={() => commitActivePresetBoxToMask(false)}
              onSaveCustomPreset={(name) => {
                saveCurrentBoxAsCustomPreset(name);
              }}
              onApplyToAll={applyActivePresetBoxToAll}
              onCancel={() => setActivePresetBox(null)}
            />
          )}
        </div>

        {/* 与缩放比例同步的自定义画笔 / 橡皮擦圆环光标（通过 ref 直接更新 transform 避免重渲染） */}
        {showBrushRing && (
          <div
            ref={brushRingRef}
            className="pointer-events-none absolute top-0 left-0 z-30 rounded-full will-change-transform"
            style={{
              transform: `translate3d(${cursorPointRef.current.x}px, ${cursorPointRef.current.y}px, 0) translate(-50%, -50%)`,
              width: brushDiameterPx,
              height: brushDiameterPx,
              border:
                state.tool === 'eraser'
                  ? '1.5px dashed rgba(255, 255, 255, 0.95)'
                  : '1.5px solid rgba(251, 113, 133, 0.95)',
              backgroundColor:
                state.tool === 'eraser' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(244, 63, 94, 0.14)',
              boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.45)',
            }}
          >
            <span
              className="absolute top-1/2 left-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                backgroundColor:
                  state.tool === 'eraser' ? 'rgba(255,255,255,0.9)' : 'rgba(251,113,133,0.95)',
              }}
            />
          </div>
        )}

        {/* 底部悬浮专业控制条（w-max 防止 left-1/2 绝对定位在画布一半宽度处被强制折行） */}
        <div
          className="pointer-events-auto absolute bottom-3.5 left-1/2 z-30 flex w-max max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 overflow-x-auto whitespace-nowrap rounded-2xl border px-3 py-1.5 backdrop-blur-md"
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderColor: 'var(--border-default)',
            boxShadow: 'var(--shadow-lg)',
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* 缩放控制组 */}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => zoomAroundCenter(0.8)}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
              title="缩小画布"
              aria-label="缩小画布"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => fitToScreen()}
              className="min-w-[46px] shrink-0 cursor-pointer whitespace-nowrap rounded-md px-1.5 py-1 text-center font-mono text-[11px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)]"
              title="点击适应屏幕"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => zoomAroundCenter(1.25)}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
              title="放大画布"
              aria-label="放大画布"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => fitToScreen()}
              className="hidden h-7 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg px-2 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] sm:inline-flex"
              title="自适应铺满视口"
            >
              <Maximize2 className="h-3 w-3 shrink-0" />
              适应
            </button>
            <button
              type="button"
              onClick={resetToActualSize}
              className="hidden h-7 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg px-2 font-mono text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] md:inline-flex"
              title="1:1 原像素查看"
            >
              <Square className="h-2.5 w-2.5 shrink-0" />
              100%
            </button>
          </div>

          <div className="h-4 w-px shrink-0" style={{ backgroundColor: 'var(--border-subtle)' }} />

          {/* 快捷撤销/重做 */}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={undoActive}
              disabled={!canUndo || isBusy}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
              title="撤销 (⌘Z)"
              aria-label="撤销"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={redoActive}
              disabled={!canRedo || isBusy}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-35"
              title="重做 (⇧⌘Z)"
              aria-label="重做"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* 修复后显示前后对比控制 */}
          {activeImage.processed && (
            <>
              <div
                className="h-4 w-px shrink-0"
                style={{ backgroundColor: 'var(--border-subtle)' }}
              />
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setCompareMode(state.compareMode === 'split' ? 'off' : 'split')}
                  className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border px-2 text-[11px] font-medium transition-colors"
                  style={
                    state.compareMode === 'split'
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
                  title="开启或关闭交互式分屏前后对比滑块"
                >
                  <Columns2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">分屏对比</span>
                </button>

                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    onSetHoldOriginal(true);
                  }}
                  onPointerUp={() => onSetHoldOriginal(false)}
                  onPointerLeave={() => onSetHoldOriginal(false)}
                  onPointerCancel={() => onSetHoldOriginal(false)}
                  className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg px-2 text-[11px] font-medium transition-colors"
                  style={
                    holdOriginal
                      ? { backgroundColor: 'var(--accent)', color: '#ffffff' }
                      : { color: 'var(--text-secondary)' }
                  }
                  title="按住即时查看原图（快捷键长按 \\ ）"
                >
                  <Eye className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden md:inline">按住看原图</span>
                </button>
              </div>
            </>
          )}

          <div className="h-4 w-px shrink-0" style={{ backgroundColor: 'var(--border-subtle)' }} />

          {/* 醒目主按钮：开始去水印 / 处理进度条 */}
          {state.isProcessing ? (
            <div className="flex shrink-0 items-center gap-2.5 pl-0.5">
              <div className="flex min-w-[148px] shrink-0 flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="inline-flex max-w-[140px] items-center gap-1.5 truncate font-medium text-[var(--text-primary)]">
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--accent)]" />
                    {state.currentProgress?.stage ?? '正在无痕修补...'}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] font-semibold text-[var(--accent)]">
                    {Math.round(state.currentProgress?.percent ?? 0)}%
                  </span>
                </div>
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full"
                  style={{ backgroundColor: 'var(--bg-surface)' }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-150"
                    style={{
                      width: `${Math.max(4, Math.round(state.currentProgress?.percent ?? 0))}%`,
                      backgroundColor: 'var(--accent)',
                    }}
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={cancelProcessing}
                className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border px-2 text-[11px] font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger-soft)]"
                style={{ borderColor: 'rgba(244, 63, 94, 0.35)' }}
                title="取消当前去水印任务"
              >
                <X className="h-3 w-3 shrink-0" />
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void processActiveImage()}
              disabled={!hasActiveMask || state.isDetecting || state.isRefiningMask}
              className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-xl px-4 text-xs font-semibold text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
              style={{
                backgroundColor: 'var(--accent)',
                boxShadow:
                  hasActiveMask && !state.isDetecting && !state.isRefiningMask
                    ? 'var(--accent-glow)'
                    : 'none',
              }}
              title={
                state.isDetecting
                  ? '正在自动检测角落水印，请稍候完成'
                  : state.isRefiningMask
                    ? '正在提取框内水印笔画，请稍候完成'
                    : hasActiveMask
                      ? `使用${
                          state.engine === 'migan'
                            ? 'AI 精修 · MI-GAN'
                            : state.engine === 'lama'
                              ? '高阶 AI · LaMa'
                              : '快速轻量引擎'
                        }去除选中水印`
                      : '请先涂抹水印、套用右侧预设或点击一键检测'
              }
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span>{activeImage.processed ? '再次精修' : '开始去水印'}</span>
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
