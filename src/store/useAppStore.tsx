import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { DEMO_SAMPLES, loadAllDemoSamples, loadDemoSample } from '../data/demoSamples';
import {
  createCustomPresetFromRect,
  deleteCustomPreset,
  getAllPresets,
  presetToPrimaryNormalizedRect,
  saveCustomPreset,
} from '../data/presets';
import { runCornerAutoDetect, runFastInpaint, runMaskStrokeRefine } from '../engines/fast';
import {
  DEFAULT_LAMA_SOURCES,
  cancelLamaDownload,
  checkWebGpuSupport,
  clearLamaModelCache,
  disposeLamaSession,
  downloadLamaModel,
  ensureLamaSessionLoaded,
  getLamaModelStatus,
  importLocalLamaModel,
  initLamaModelStatus,
  runLamaInpaint,
  subscribeLamaStatus,
} from '../engines/lama';
import {
  disposeMiganSession,
  getMiganModelStatus,
  preloadMiganModel,
  runMiganInpaint,
  subscribeMiganStatus,
} from '../engines/migan';
import type {
  BatchProgress,
  CornerDetectionResult,
  DetectSensitivity,
  EngineType,
  ExportConfig,
  FastQuality,
  HistoryEntry,
  ImageItem,
  InpaintOutput,
  InpaintProgress,
  LamaModelSource,
  LamaModelStatus,
  MiganModelStatus,
  NormalizedRect,
  StrokeRefineResult,
  ThemeMode,
  ToastMessage,
  ToastType,
  ToolType,
  WatermarkPreset,
} from '../types';
import {
  copyImageToClipboard,
  downloadSingleImage,
  exportBatchAsZip,
  imageDataToDataUrl,
  imageSourceToImageData,
  loadImageElement,
} from '../utils/export';
import {
  applyNormalizedRectToMask,
  cloneMask,
  createEmptyMask,
  createMaskFromPreset,
  dilateMask,
  getMaskNormalizedBoundingBox,
  hasMaskPixels,
  scaleMaskToSize,
} from '../utils/maskUtils';

const THEME_STORAGE_KEY = 'clearmark_theme';
const MAX_HISTORY_ENTRIES = 20;
const ACCEPTED_IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|avif)$/i;

export type CompareMode = 'off' | 'split';

export interface ZipExportProgress {
  completed: number;
  total: number;
  currentName: string;
}

export interface AppState {
  images: ImageItem[];
  activeImageId: string | null;
  tool: ToolType;
  brushSize: number;
  featherPx: number;
  maskOpacity: number;
  showMask: boolean;
  compareMode: CompareMode;
  presets: WatermarkPreset[];
  selectedPresetId: string | null;
  detectSensitivity: DetectSensitivity;
  isDetecting: boolean;
  isRefiningMask: boolean;
  lastDetectionResult: CornerDetectionResult | null;
  engine: EngineType;
  fastQuality: FastQuality;
  miganStatus: MiganModelStatus;
  lamaStatus: LamaModelStatus;
  webGpuSupported: boolean;
  aiModelModalOpen: boolean;
  isProcessing: boolean;
  currentProgress: InpaintProgress | null;
  batchProgress: BatchProgress;
  theme: ThemeMode;
  exportConfig: ExportConfig;
  isExporting: boolean;
  zipExportProgress: ZipExportProgress | null;
  toasts: ToastMessage[];
}

type AppAction =
  | { type: 'ADD_IMAGES'; items: ImageItem[]; activateId?: string }
  | { type: 'SELECT_IMAGE'; id: string | null }
  | { type: 'REMOVE_IMAGE'; id: string }
  | { type: 'CLEAR_IMAGES' }
  | { type: 'UPDATE_IMAGE'; id: string; updater: (item: ImageItem) => ImageItem }
  | { type: 'UPDATE_ALL_IMAGES'; updater: (item: ImageItem) => ImageItem }
  | { type: 'SET_TOOL'; tool: ToolType }
  | { type: 'SET_BRUSH_SIZE'; size: number }
  | { type: 'SET_FEATHER_PX'; px: number }
  | { type: 'SET_MASK_OPACITY'; opacity: number }
  | { type: 'SET_SHOW_MASK'; show: boolean }
  | { type: 'SET_COMPARE_MODE'; mode: CompareMode }
  | { type: 'SET_PRESETS'; presets: WatermarkPreset[] }
  | { type: 'SET_SELECTED_PRESET_ID'; id: string | null }
  | { type: 'SET_DETECT_SENSITIVITY'; sensitivity: DetectSensitivity }
  | { type: 'SET_IS_DETECTING'; value: boolean }
  | { type: 'SET_IS_REFINING_MASK'; value: boolean }
  | { type: 'SET_LAST_DETECTION'; result: CornerDetectionResult | null }
  | { type: 'SET_ENGINE'; engine: EngineType }
  | { type: 'SET_FAST_QUALITY'; quality: FastQuality }
  | { type: 'SET_MIGAN_STATUS'; status: MiganModelStatus }
  | { type: 'SET_LAMA_STATUS'; status: LamaModelStatus }
  | { type: 'SET_WEBGPU_SUPPORTED'; supported: boolean }
  | { type: 'SET_AI_MODEL_MODAL_OPEN'; open: boolean }
  | { type: 'SET_PROCESSING'; isProcessing: boolean; progress: InpaintProgress | null }
  | { type: 'SET_BATCH_PROGRESS'; progress: BatchProgress }
  | { type: 'SET_THEME'; theme: ThemeMode }
  | { type: 'PATCH_EXPORT_CONFIG'; patch: Partial<ExportConfig> }
  | { type: 'SET_EXPORTING'; isExporting: boolean; zipProgress?: ZipExportProgress | null }
  | { type: 'PUSH_TOAST'; toast: ToastMessage }
  | { type: 'DISMISS_TOAST'; id: string };

const INITIAL_BATCH_PROGRESS: BatchProgress = {
  running: false,
  total: 0,
  completed: 0,
  failed: 0,
  currentImageId: undefined,
  currentPercent: 0,
};

function readInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'dark';
  }
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') {
      return saved;
    }
  } catch {
    // 隐私模式禁用 localStorage 时回退到默认暗色主题
  }
  return 'dark';
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const maybeError = err as { name?: string; code?: string };
  return maybeError.name === 'AbortError' || maybeError.code === 'ABORTED';
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  if (typeof err === 'string' && err.trim()) {
    return err;
  }
  return fallback;
}

function revokeIfBlobUrl(url: string): void {
  if (url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // 忽略已释放 URL 的重复回收
    }
  }
}

/** 合并图片当前有效选区：同时兼容画笔/框选遮罩与未提交的交互预设框 */
function resolveEffectiveMask(item: ImageItem): Uint8Array | null {
  let mask = hasMaskPixels(item.maskBytes) ? cloneMask(item.maskBytes!) : null;
  if (item.activePresetBox) {
    if (!mask) {
      mask = createEmptyMask(item.width, item.height);
    }
    applyNormalizedRectToMask(mask, item.width, item.height, item.activePresetBox, 255);
  }
  return hasMaskPixels(mask) ? mask : null;
}

/** 追加单图历史记录并保持索引 0 恒为原图 */
function appendHistoryEntry(item: ImageItem, entry: HistoryEntry): ImageItem {
  const truncated = item.history.slice(0, item.historyIndex + 1);
  truncated.push(entry);

  let nextHistory = truncated;
  if (nextHistory.length > MAX_HISTORY_ENTRIES) {
    // 始终保留 index 0 原图，淘汰最早的中间历史节点
    nextHistory = [nextHistory[0], ...nextHistory.slice(-(MAX_HISTORY_ENTRIES - 1))];
  }

  return {
    ...item,
    currentDataUrl: entry.dataUrl,
    processed: true,
    status: 'done',
    error: undefined,
    maskBytes: null,
    matchedMarks: undefined,
    activePresetBox: null,
    history: nextHistory,
    historyIndex: nextHistory.length - 1,
    lastDurationMs: entry.durationMs,
    lastBackend: entry.backend,
  };
}

function createInitialState(): AppState {
  return {
    images: [],
    activeImageId: null,
    tool: 'brush',
    brushSize: 36,
    featherPx: 3,
    maskOpacity: 0.56,
    showMask: true,
    compareMode: 'off',
    presets: getAllPresets(),
    selectedPresetId: null,
    detectSensitivity: 'medium',
    isDetecting: false,
    isRefiningMask: false,
    lastDetectionResult: null,
    engine: 'fast',
    fastQuality: 'standard',
    miganStatus: getMiganModelStatus(),
    lamaStatus: getLamaModelStatus(),
    webGpuSupported: false,
    aiModelModalOpen: false,
    isProcessing: false,
    currentProgress: null,
    batchProgress: INITIAL_BATCH_PROGRESS,
    theme: readInitialTheme(),
    exportConfig: {
      format: 'png',
      quality: 0.92,
      filenameSuffix: '_clean',
      stripMetadata: true,
    },
    isExporting: false,
    zipExportProgress: null,
    toasts: [],
  };
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'ADD_IMAGES': {
      const images = [...state.images, ...action.items];
      const nextActiveId = action.activateId ?? state.activeImageId ?? action.items[0]?.id ?? null;
      return {
        ...state,
        images,
        activeImageId: nextActiveId,
      };
    }

    case 'SELECT_IMAGE': {
      const target = state.images.find((item) => item.id === action.id);
      return {
        ...state,
        activeImageId: action.id,
        lastDetectionResult: null,
        compareMode: target?.processed ? state.compareMode : 'off',
      };
    }

    case 'REMOVE_IMAGE': {
      const idx = state.images.findIndex((item) => item.id === action.id);
      if (idx === -1) {
        return state;
      }
      const nextImages = state.images.filter((item) => item.id !== action.id);
      let nextActiveId = state.activeImageId;
      if (state.activeImageId === action.id) {
        nextActiveId = nextImages[idx]?.id ?? nextImages[idx - 1]?.id ?? null;
      }
      return {
        ...state,
        images: nextImages,
        activeImageId: nextActiveId,
        lastDetectionResult: null,
        compareMode: nextActiveId ? state.compareMode : 'off',
      };
    }

    case 'CLEAR_IMAGES':
      return {
        ...state,
        images: [],
        activeImageId: null,
        lastDetectionResult: null,
        compareMode: 'off',
        batchProgress: INITIAL_BATCH_PROGRESS,
      };

    case 'UPDATE_IMAGE':
      return {
        ...state,
        images: state.images.map((item) => (item.id === action.id ? action.updater(item) : item)),
      };

    case 'UPDATE_ALL_IMAGES':
      return {
        ...state,
        images: state.images.map(action.updater),
      };

    case 'SET_TOOL':
      return { ...state, tool: action.tool };

    case 'SET_BRUSH_SIZE':
      return { ...state, brushSize: Math.min(200, Math.max(4, Math.round(action.size))) };

    case 'SET_FEATHER_PX':
      return { ...state, featherPx: Math.min(16, Math.max(0, Math.round(action.px))) };

    case 'SET_MASK_OPACITY':
      return { ...state, maskOpacity: Math.min(0.95, Math.max(0.1, action.opacity)) };

    case 'SET_SHOW_MASK':
      return { ...state, showMask: action.show };

    case 'SET_COMPARE_MODE':
      return { ...state, compareMode: action.mode };

    case 'SET_PRESETS':
      return { ...state, presets: action.presets };

    case 'SET_SELECTED_PRESET_ID':
      return { ...state, selectedPresetId: action.id };

    case 'SET_DETECT_SENSITIVITY':
      return { ...state, detectSensitivity: action.sensitivity };

    case 'SET_IS_DETECTING':
      return { ...state, isDetecting: action.value };

    case 'SET_IS_REFINING_MASK':
      return { ...state, isRefiningMask: action.value };

    case 'SET_LAST_DETECTION':
      return { ...state, lastDetectionResult: action.result };

    case 'SET_ENGINE':
      return { ...state, engine: action.engine };

    case 'SET_FAST_QUALITY':
      return { ...state, fastQuality: action.quality };

    case 'SET_MIGAN_STATUS':
      return { ...state, miganStatus: action.status };

    case 'SET_LAMA_STATUS':
      return { ...state, lamaStatus: action.status };

    case 'SET_WEBGPU_SUPPORTED':
      return { ...state, webGpuSupported: action.supported };

    case 'SET_AI_MODEL_MODAL_OPEN':
      return { ...state, aiModelModalOpen: action.open };

    case 'SET_PROCESSING':
      return {
        ...state,
        isProcessing: action.isProcessing,
        currentProgress: action.progress,
      };

    case 'SET_BATCH_PROGRESS':
      return { ...state, batchProgress: action.progress };

    case 'SET_THEME':
      return { ...state, theme: action.theme };

    case 'PATCH_EXPORT_CONFIG':
      return {
        ...state,
        exportConfig: { ...state.exportConfig, ...action.patch },
      };

    case 'SET_EXPORTING':
      return {
        ...state,
        isExporting: action.isExporting,
        zipExportProgress:
          action.zipProgress === undefined ? state.zipExportProgress : action.zipProgress,
      };

    case 'PUSH_TOAST':
      return {
        ...state,
        // 最多同时展示 4 条提示，避免消息堆叠遮挡画布
        toasts: [...state.toasts.slice(-3), action.toast],
      };

    case 'DISMISS_TOAST':
      return {
        ...state,
        toasts: state.toasts.filter((toast) => toast.id !== action.id),
      };

    default:
      return state;
  }
}

export interface AppStoreContextValue {
  state: AppState;
  activeImage: ImageItem | null;
  canUndo: boolean;
  canRedo: boolean;
  hasActiveMask: boolean;
  lamaSources: readonly LamaModelSource[];
  // 图片队列管理
  addImages: (
    files: FileList | File[],
    activateFirst?: boolean,
    options?: { silentToast?: boolean },
  ) => Promise<number>;
  loadDemoSampleById: (id: string) => Promise<void>;
  loadAllDemos: () => Promise<void>;
  selectImage: (id: string) => void;
  removeImage: (id: string) => void;
  clearImages: () => void;
  // 画布工具与遮罩编辑
  setTool: (tool: ToolType) => void;
  setBrushSize: (size: number) => void;
  setFeatherPx: (px: number) => void;
  setMaskOpacity: (opacity: number) => void;
  setShowMask: (show: boolean) => void;
  setCompareMode: (mode: CompareMode) => void;
  updateActiveMask: (mask: Uint8Array | null) => void;
  setActivePresetBox: (rect: NormalizedRect | null) => void;
  commitActivePresetBoxToMask: (keepBox?: boolean) => void;
  dilateActiveMask: (radiusPx?: number) => void;
  refineActiveMaskToStrokes: () => Promise<StrokeRefineResult | null>;
  clearActiveMask: () => void;
  // 平台预设与自定义预设
  applyPresetToActive: (presetId: string) => void;
  openPresetBoxForActive: (presetId?: string) => void;
  applyPresetToAll: (presetId: string) => void;
  applyActivePresetBoxToAll: () => void;
  applyActiveMaskToAll: () => void;
  saveCurrentBoxAsCustomPreset: (name: string, description?: string) => WatermarkPreset | null;
  removeCustomPreset: (id: string) => void;
  // 智能角落检测
  setDetectSensitivity: (sensitivity: DetectSensitivity) => void;
  autoDetectActive: () => Promise<CornerDetectionResult | null>;
  autoDetectAll: () => Promise<{ detectedCount: number; total: number }>;
  // 每张图独立历史栈
  undoActive: () => void;
  redoActive: () => void;
  resetActiveToOriginal: () => void;
  jumpToHistory: (index: number) => void;
  // 引擎与去水印执行
  setEngine: (engine: EngineType) => void;
  setFastQuality: (quality: FastQuality) => void;
  setAiModelModalOpen: (open: boolean) => void;
  processActiveImage: () => Promise<boolean>;
  processBatchImages: (targetIds?: string[]) => Promise<void>;
  cancelProcessing: () => void;
  // 内置 MI-GAN 本地 AI 管理
  preloadMiganAiModel: () => Promise<void>;
  unloadMiganAiSession: () => Promise<void>;
  // LaMa AI 模型管理
  downloadAiModel: (url: string, label?: string) => Promise<void>;
  cancelAiModelDownload: () => void;
  importAiModelFile: (file: File) => Promise<void>;
  clearAiModelCache: () => Promise<void>;
  loadAiModelSession: () => Promise<void>;
  unloadAiModelSession: () => Promise<void>;
  // 导出与剪贴板
  setExportConfig: (patch: Partial<ExportConfig>) => void;
  exportActiveImage: () => Promise<void>;
  copyActiveImage: () => Promise<void>;
  exportAllAsZip: (onlyProcessed?: boolean) => Promise<void>;
  // 主题与提示
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  pushToast: (type: ToastType, text: string, durationMs?: number) => void;
  dismissToast: (id: string) => void;
}

const AppStoreContext = createContext<AppStoreContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, undefined, createInitialState);
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;

  const processingAbortRef = useRef<AbortController | null>(null);
  const modelDownloadAbortRef = useRef<AbortController | null>(null);
  const toastTimersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    dispatch({ type: 'DISMISS_TOAST', id });
  }, []);

  const pushToast = useCallback((type: ToastType, text: string, durationMs = 3600) => {
    const id = createId('toast');
    dispatch({ type: 'PUSH_TOAST', toast: { id, type, text } });
    if (durationMs > 0 && typeof window !== 'undefined') {
      const timer = window.setTimeout(() => {
        toastTimersRef.current.delete(id);
        dispatch({ type: 'DISMISS_TOAST', id });
      }, durationMs);
      toastTimersRef.current.set(id, timer);
    }
  }, []);

  // 同步主题到 html[data-theme] 与 localStorage
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', state.theme);
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, state.theme);
    } catch {
      // 忽略隐私模式写入失败
    }
  }, [state.theme]);

  // 初始化 MI-GAN & LaMa 模型状态与 WebGPU 检测，并订阅状态推送
  useEffect(() => {
    const unsubscribeLama = subscribeLamaStatus((nextStatus) => {
      dispatch({ type: 'SET_LAMA_STATUS', status: nextStatus });
    });
    const unsubscribeMigan = subscribeMiganStatus((nextStatus) => {
      dispatch({ type: 'SET_MIGAN_STATUS', status: nextStatus });
    });

    void initLamaModelStatus().catch(() => {
      // 缓存检测异常由模型状态本身承载，不阻塞工作台启动
    });

    void checkWebGpuSupport()
      .then((supported) => {
        dispatch({ type: 'SET_WEBGPU_SUPPORTED', supported });
      })
      .catch(() => {
        dispatch({ type: 'SET_WEBGPU_SUPPORTED', supported: false });
      });

    return () => {
      unsubscribeLama();
      unsubscribeMigan();
    };
  }, []);

  // 组件卸载时中止进行中任务、清理定时器并释放临时 ObjectURL
  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      processingAbortRef.current?.abort();
      modelDownloadAbortRef.current?.abort();
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
      for (const item of stateRef.current.images) {
        revokeIfBlobUrl(item.originalUrl);
      }
    };
  }, []);

  // ==================== 图片队列管理 ====================

  const addImages = useCallback(
    async (
      fileInput: FileList | File[],
      activateFirst = false,
      options?: { silentToast?: boolean },
    ): Promise<number> => {
      const rawFiles = Array.from(fileInput);
      if (rawFiles.length === 0) {
        return 0;
      }

      const validFiles = rawFiles.filter(
        (file) => file.type.startsWith('image/') || ACCEPTED_IMAGE_EXT.test(file.name),
      );
      const skippedCount = rawFiles.length - validFiles.length;
      if (validFiles.length === 0) {
        pushToast('warning', '未识别到有效图片文件，请选择 PNG、JPG 或 WebP 格式');
        return 0;
      }

      const createdItems: ImageItem[] = [];
      let failedDecode = 0;

      for (const file of validFiles) {
        const objectUrl = URL.createObjectURL(file);
        try {
          const img = await loadImageElement(objectUrl);
          const width = img.naturalWidth || img.width;
          const height = img.naturalHeight || img.height;
          if (width <= 0 || height <= 0) {
            throw new Error('图片尺寸无效');
          }

          const now = Date.now();
          const item: ImageItem = {
            id: createId('img'),
            name: file.name || `粘贴图片_${now}.png`,
            originalUrl: objectUrl,
            width,
            height,
            mimeType: file.type || 'image/png',
            currentDataUrl: objectUrl,
            processed: false,
            status: 'idle',
            maskBytes: null,
            activePresetBox: null,
            history: [
              {
                id: createId('hist'),
                dataUrl: objectUrl,
                label: '原图',
                timestamp: now,
              },
            ],
            historyIndex: 0,
          };
          createdItems.push(item);
        } catch {
          revokeIfBlobUrl(objectUrl);
          failedDecode++;
        }
      }

      if (createdItems.length > 0) {
        const shouldActivate = activateFirst || !stateRef.current.activeImageId;
        dispatch({
          type: 'ADD_IMAGES',
          items: createdItems,
          activateId: shouldActivate ? createdItems[0].id : undefined,
        });

        if (!options?.silentToast) {
          const suffixParts: string[] = [];
          if (skippedCount > 0) suffixParts.push(`跳过 ${skippedCount} 个非图片文件`);
          if (failedDecode > 0) suffixParts.push(`${failedDecode} 张解码失败`);
          const extra = suffixParts.length > 0 ? `（${suffixParts.join('，')}）` : '';
          pushToast('success', `已导入 ${createdItems.length} 张图片${extra}`);
        }
      } else {
        pushToast('error', '所选图片均无法解码，请检查文件是否损坏');
      }

      return createdItems.length;
    },
    [pushToast],
  );

  const loadDemoSampleById = useCallback(
    async (id: string) => {
      try {
        const file = await loadDemoSample(id);
        const added = await addImages([file], true, { silentToast: true });
        if (added > 0) {
          const meta = DEMO_SAMPLES.find((s) => s.id === id);
          pushToast(
            'success',
            meta ? `已载入「${meta.title}」，可套用平台预设或一键检测` : '已载入内置演示样图',
          );
        }
      } catch (err) {
        pushToast('error', extractErrorMessage(err, '加载演示样图失败'));
      }
    },
    [addImages, pushToast],
  );

  const loadAllDemos = useCallback(async () => {
    try {
      const files = await loadAllDemoSamples();
      const added = await addImages(files, true, { silentToast: true });
      if (added > 0) {
        pushToast('success', '已载入全部 3 张演示样图，可体验批量检测与批量去水印');
      }
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '批量加载演示样图失败'));
    }
  }, [addImages, pushToast]);

  const selectImage = useCallback((id: string) => {
    dispatch({ type: 'SELECT_IMAGE', id });
  }, []);

  const removeImage = useCallback((id: string) => {
    const target = stateRef.current.images.find((item) => item.id === id);
    if (target) {
      revokeIfBlobUrl(target.originalUrl);
    }
    dispatch({ type: 'REMOVE_IMAGE', id });
  }, []);

  const clearImages = useCallback(() => {
    processingAbortRef.current?.abort();
    for (const item of stateRef.current.images) {
      revokeIfBlobUrl(item.originalUrl);
    }
    dispatch({ type: 'CLEAR_IMAGES' });
    dispatch({ type: 'SET_PROCESSING', isProcessing: false, progress: null });
    pushToast('info', '已清空图片队列');
  }, [pushToast]);

  // ==================== 画布工具与遮罩编辑 ====================

  const getActiveImageFromRef = useCallback((): ImageItem | null => {
    const { images, activeImageId } = stateRef.current;
    if (!activeImageId) return null;
    return images.find((item) => item.id === activeImageId) ?? null;
  }, []);

  const openPresetBoxForActive = useCallback(
    (presetId?: string) => {
      const active = getActiveImageFromRef();
      if (!active) {
        pushToast('warning', '请先导入一张图片');
        return;
      }

      const targetPresetId = presetId ?? stateRef.current.selectedPresetId;
      const preset = targetPresetId
        ? stateRef.current.presets.find((p) => p.id === targetPresetId)
        : undefined;

      let rect: NormalizedRect;
      if (preset) {
        rect = presetToPrimaryNormalizedRect(preset, active.width, active.height);
        dispatch({ type: 'SET_SELECTED_PRESET_ID', id: preset.id });
      } else {
        const maskNorm = getMaskNormalizedBoundingBox(
          active.maskBytes,
          active.width,
          active.height,
        );
        rect = maskNorm ?? { x: 0.78, y: 0.88, width: 0.2, height: 0.095 };
      }

      dispatch({
        type: 'UPDATE_IMAGE',
        id: active.id,
        updater: (item) => ({ ...item, activePresetBox: rect }),
      });
      dispatch({ type: 'SET_TOOL', tool: 'preset-box' });
    },
    [getActiveImageFromRef, pushToast],
  );

  const setTool = useCallback(
    (tool: ToolType) => {
      dispatch({ type: 'SET_TOOL', tool });
      if (tool === 'preset-box') {
        const active = getActiveImageFromRef();
        if (active && !active.activePresetBox) {
          openPresetBoxForActive();
        }
      }
    },
    [getActiveImageFromRef, openPresetBoxForActive],
  );

  const setBrushSize = useCallback((size: number) => {
    dispatch({ type: 'SET_BRUSH_SIZE', size });
  }, []);

  const setFeatherPx = useCallback((px: number) => {
    dispatch({ type: 'SET_FEATHER_PX', px });
  }, []);

  const setMaskOpacity = useCallback((opacity: number) => {
    dispatch({ type: 'SET_MASK_OPACITY', opacity });
  }, []);

  const setShowMask = useCallback((show: boolean) => {
    dispatch({ type: 'SET_SHOW_MASK', show });
  }, []);

  const setCompareMode = useCallback((mode: CompareMode) => {
    dispatch({ type: 'SET_COMPARE_MODE', mode });
  }, []);

  const updateActiveMask = useCallback((mask: Uint8Array | null) => {
    const activeId = stateRef.current.activeImageId;
    if (!activeId) return;
    const valid = hasMaskPixels(mask);
    dispatch({
      type: 'UPDATE_IMAGE',
      id: activeId,
      updater: (item) => ({
        ...item,
        maskBytes: valid ? mask : null,
        matchedMarks: valid ? item.matchedMarks : undefined,
      }),
    });
  }, []);

  const setActivePresetBox = useCallback((rect: NormalizedRect | null) => {
    const activeId = stateRef.current.activeImageId;
    if (!activeId) return;
    dispatch({
      type: 'UPDATE_IMAGE',
      id: activeId,
      updater: (item) => ({
        ...item,
        activePresetBox: rect,
      }),
    });
  }, []);

  const commitActivePresetBoxToMask = useCallback(
    (keepBox = false) => {
      const active = getActiveImageFromRef();
      if (!active || !active.activePresetBox) {
        return;
      }

      const nextMask = active.maskBytes
        ? cloneMask(active.maskBytes)
        : createEmptyMask(active.width, active.height);
      applyNormalizedRectToMask(nextMask, active.width, active.height, active.activePresetBox, 255);

      dispatch({
        type: 'UPDATE_IMAGE',
        id: active.id,
        updater: (item) => ({
          ...item,
          maskBytes: nextMask,
          activePresetBox: keepBox ? item.activePresetBox : null,
        }),
      });
      if (!keepBox) {
        dispatch({ type: 'SET_TOOL', tool: 'brush' });
      }
      pushToast('success', '已将预设框应用到当前选区');
    },
    [getActiveImageFromRef, pushToast],
  );

  const dilateActiveMask = useCallback(
    (radiusPx = 4) => {
      const active = getActiveImageFromRef();
      if (!active || !hasMaskPixels(active.maskBytes)) {
        pushToast('warning', '请先绘制或套用遮罩选区后再外扩');
        return;
      }
      const expanded = dilateMask(active.maskBytes!, active.width, active.height, radiusPx);
      dispatch({
        type: 'UPDATE_IMAGE',
        id: active.id,
        updater: (item) => ({ ...item, maskBytes: expanded }),
      });
      pushToast('info', `已将选区向外扩展 ${radiusPx}px`);
    },
    [getActiveImageFromRef, pushToast],
  );

  const refineActiveMaskToStrokes = useCallback(async (): Promise<StrokeRefineResult | null> => {
    const active = getActiveImageFromRef();
    if (!active) {
      pushToast('warning', '请先导入一张图片');
      return null;
    }
    if (stateRef.current.isRefiningMask || stateRef.current.isProcessing) {
      return null;
    }
    const effectiveMask = resolveEffectiveMask(active);
    if (!effectiveMask) {
      pushToast('warning', '请先框选水印区域或套用平台预设后再提取笔画');
      return null;
    }

    dispatch({ type: 'SET_IS_REFINING_MASK', value: true });
    try {
      const imageData = await imageSourceToImageData(active.currentDataUrl);
      const result = await runMaskStrokeRefine(imageData, effectiveMask);

      if (result.refined && hasMaskPixels(result.mask)) {
        dispatch({
          type: 'UPDATE_IMAGE',
          id: active.id,
          updater: (item) => ({
            ...item,
            maskBytes: result.mask,
            matchedMarks: result.matchedMarks,
            activePresetBox: null,
          }),
        });
        dispatch({ type: 'SET_SHOW_MASK', show: true });
        pushToast('success', result.message);
      } else {
        pushToast('info', result.message);
      }
      return result;
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '框内智能提取水印笔画失败'));
      return null;
    } finally {
      dispatch({ type: 'SET_IS_REFINING_MASK', value: false });
    }
  }, [getActiveImageFromRef, pushToast]);

  const clearActiveMask = useCallback(() => {
    const activeId = stateRef.current.activeImageId;
    if (!activeId) return;
    dispatch({
      type: 'UPDATE_IMAGE',
      id: activeId,
      updater: (item) => ({
        ...item,
        maskBytes: null,
        matchedMarks: undefined,
        activePresetBox: null,
      }),
    });
    dispatch({ type: 'SET_LAST_DETECTION', result: null });
  }, []);

  // ==================== 平台预设与自定义预设 ====================

  const applyPresetToActive = useCallback(
    (presetId: string) => {
      const active = getActiveImageFromRef();
      if (!active) {
        pushToast('warning', '请先导入一张图片');
        return;
      }
      const preset = stateRef.current.presets.find((p) => p.id === presetId);
      if (!preset) {
        return;
      }

      const mask = createMaskFromPreset(preset, active.width, active.height);
      dispatch({ type: 'SET_SELECTED_PRESET_ID', id: preset.id });
      dispatch({
        type: 'UPDATE_IMAGE',
        id: active.id,
        updater: (item) => ({
          ...item,
          maskBytes: mask,
          matchedMarks: undefined,
          activePresetBox: null,
        }),
      });
      dispatch({ type: 'SET_SHOW_MASK', show: true });
      pushToast('success', `已套用预设「${preset.name}」`);
    },
    [getActiveImageFromRef, pushToast],
  );

  const applyPresetToAll = useCallback(
    (presetId: string) => {
      const { images, presets } = stateRef.current;
      if (images.length === 0) {
        pushToast('warning', '当前图片队列为空');
        return;
      }
      const preset = presets.find((p) => p.id === presetId);
      if (!preset) {
        return;
      }

      dispatch({ type: 'SET_SELECTED_PRESET_ID', id: preset.id });
      dispatch({
        type: 'UPDATE_ALL_IMAGES',
        updater: (item) => ({
          ...item,
          maskBytes: createMaskFromPreset(preset, item.width, item.height),
          activePresetBox: null,
        }),
      });
      dispatch({ type: 'SET_SHOW_MASK', show: true });
      pushToast(
        'success',
        `已将预设「${preset.name}」按画幅自适应套用到全部 ${images.length} 张图片`,
      );
    },
    [pushToast],
  );

  const applyActivePresetBoxToAll = useCallback(() => {
    const active = getActiveImageFromRef();
    const { images } = stateRef.current;
    if (!active || !active.activePresetBox || images.length === 0) {
      return;
    }

    const box = active.activePresetBox;
    dispatch({
      type: 'UPDATE_ALL_IMAGES',
      updater: (item) => {
        const nextMask = createEmptyMask(item.width, item.height);
        applyNormalizedRectToMask(nextMask, item.width, item.height, box, 255);
        return {
          ...item,
          maskBytes: nextMask,
          activePresetBox: null,
        };
      },
    });
    dispatch({ type: 'SET_TOOL', tool: 'brush' });
    dispatch({ type: 'SET_SHOW_MASK', show: true });
    pushToast('success', `已将当前精调框比例应用到全部 ${images.length} 张图片`);
  }, [getActiveImageFromRef, pushToast]);

  const applyActiveMaskToAll = useCallback(() => {
    const active = getActiveImageFromRef();
    const { images, selectedPresetId } = stateRef.current;
    if (images.length === 0) {
      pushToast('warning', '当前图片队列为空');
      return;
    }

    if (active?.activePresetBox) {
      applyActivePresetBoxToAll();
      return;
    }

    if (active && hasMaskPixels(active.maskBytes)) {
      const srcMask = active.maskBytes!;
      const srcW = active.width;
      const srcH = active.height;
      dispatch({
        type: 'UPDATE_ALL_IMAGES',
        updater: (item) => ({
          ...item,
          maskBytes: scaleMaskToSize(srcMask, srcW, srcH, item.width, item.height),
          activePresetBox: null,
        }),
      });
      dispatch({ type: 'SET_SHOW_MASK', show: true });
      pushToast('success', `已将当前选区按比例映射至全部 ${images.length} 张图片`);
      return;
    }

    if (selectedPresetId) {
      applyPresetToAll(selectedPresetId);
      return;
    }

    pushToast('warning', '请先在当前图片上套用预设、绘制选区或框选水印位置');
  }, [applyActivePresetBoxToAll, applyPresetToAll, getActiveImageFromRef, pushToast]);

  const saveCurrentBoxAsCustomPreset = useCallback(
    (name: string, description?: string): WatermarkPreset | null => {
      const active = getActiveImageFromRef();
      if (!active) {
        pushToast('warning', '请先打开一张图片');
        return null;
      }

      const rect =
        active.activePresetBox ??
        getMaskNormalizedBoundingBox(active.maskBytes, active.width, active.height);

      if (!rect) {
        pushToast('warning', '当前没有可保存的水印选区或预设框');
        return null;
      }

      const created = createCustomPresetFromRect(name, rect, description);
      saveCustomPreset(created);
      const refreshed = getAllPresets();
      dispatch({ type: 'SET_PRESETS', presets: refreshed });
      dispatch({ type: 'SET_SELECTED_PRESET_ID', id: created.id });
      pushToast('success', `已保存自定义预设「${created.name}」`);
      return created;
    },
    [getActiveImageFromRef, pushToast],
  );

  const removeCustomPreset = useCallback(
    (id: string) => {
      deleteCustomPreset(id);
      const refreshed = getAllPresets();
      dispatch({ type: 'SET_PRESETS', presets: refreshed });
      if (stateRef.current.selectedPresetId === id) {
        dispatch({ type: 'SET_SELECTED_PRESET_ID', id: null });
      }
      pushToast('info', '已删除自定义预设');
    },
    [pushToast],
  );

  // ==================== 智能角落水印自动检测 ====================

  const setDetectSensitivity = useCallback((sensitivity: DetectSensitivity) => {
    dispatch({ type: 'SET_DETECT_SENSITIVITY', sensitivity });
  }, []);

  const autoDetectActive = useCallback(async (): Promise<CornerDetectionResult | null> => {
    const active = getActiveImageFromRef();
    if (!active) {
      pushToast('warning', '请先导入需要检测的图片');
      return null;
    }
    if (stateRef.current.isDetecting || stateRef.current.isProcessing) {
      return null;
    }

    dispatch({ type: 'SET_IS_DETECTING', value: true });
    try {
      const imageData = await imageSourceToImageData(active.currentDataUrl);
      const result = await runCornerAutoDetect(imageData, stateRef.current.detectSensitivity);
      dispatch({ type: 'SET_LAST_DETECTION', result });

      if (result.detected && result.mask && hasMaskPixels(result.mask)) {
        dispatch({
          type: 'UPDATE_IMAGE',
          id: active.id,
          updater: (item) => ({
            ...item,
            maskBytes: result.mask!,
            matchedMarks: result.matches,
            activePresetBox: null,
          }),
        });
        dispatch({ type: 'SET_SHOW_MASK', show: true });
        pushToast('success', result.message);
      } else {
        pushToast('info', result.message);
      }
      return result;
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '自动检测角落水印失败'));
      return null;
    } finally {
      dispatch({ type: 'SET_IS_DETECTING', value: false });
    }
  }, [getActiveImageFromRef, pushToast]);

  const autoDetectAll = useCallback(async (): Promise<{
    detectedCount: number;
    total: number;
  }> => {
    const targets = stateRef.current.images;
    if (targets.length === 0) {
      pushToast('warning', '当前图片队列为空');
      return { detectedCount: 0, total: 0 };
    }
    if (stateRef.current.isDetecting || stateRef.current.isProcessing) {
      return { detectedCount: 0, total: targets.length };
    }

    dispatch({ type: 'SET_IS_DETECTING', value: true });
    let detectedCount = 0;

    try {
      for (const item of targets) {
        try {
          const imageData = await imageSourceToImageData(item.currentDataUrl);
          const result = await runCornerAutoDetect(imageData, stateRef.current.detectSensitivity);
          if (item.id === stateRef.current.activeImageId) {
            dispatch({ type: 'SET_LAST_DETECTION', result });
          }
          if (result.detected && result.mask && hasMaskPixels(result.mask)) {
            detectedCount++;
            dispatch({
              type: 'UPDATE_IMAGE',
              id: item.id,
              updater: (prev) => ({
                ...prev,
                maskBytes: result.mask!,
                matchedMarks: result.matches,
                activePresetBox: null,
              }),
            });
          }
        } catch {
          // 单张检测异常时继续检测其余图片
        }
      }

      if (detectedCount > 0) {
        dispatch({ type: 'SET_SHOW_MASK', show: true });
        pushToast(
          'success',
          `批量检测完成：${detectedCount} / ${targets.length} 张已自动标出角落水印`,
        );
      } else {
        pushToast(
          'info',
          `批量检测完成：未在 ${targets.length} 张图片中发现明显角落水印，可改用平台预设或手动涂抹`,
        );
      }
      return { detectedCount, total: targets.length };
    } finally {
      dispatch({ type: 'SET_IS_DETECTING', value: false });
    }
  }, [pushToast]);

  // ==================== 单图历史栈：撤销 / 重做 / 重置 ====================

  const jumpToHistory = useCallback(
    (index: number) => {
      const active = getActiveImageFromRef();
      if (!active) return;
      if (index < 0 || index >= active.history.length || index === active.historyIndex) {
        return;
      }

      const entry = active.history[index];
      dispatch({
        type: 'UPDATE_IMAGE',
        id: active.id,
        updater: (item) => ({
          ...item,
          currentDataUrl: entry.dataUrl,
          historyIndex: index,
          processed: index > 0,
          status: index > 0 ? 'done' : 'idle',
          error: undefined,
          lastDurationMs: entry.durationMs,
          lastBackend: entry.backend,
        }),
      });
      if (index === 0) {
        dispatch({ type: 'SET_COMPARE_MODE', mode: 'off' });
      }
    },
    [getActiveImageFromRef],
  );

  const undoActive = useCallback(() => {
    const active = getActiveImageFromRef();
    if (!active || active.historyIndex <= 0) return;
    jumpToHistory(active.historyIndex - 1);
  }, [getActiveImageFromRef, jumpToHistory]);

  const redoActive = useCallback(() => {
    const active = getActiveImageFromRef();
    if (!active || active.historyIndex >= active.history.length - 1) return;
    jumpToHistory(active.historyIndex + 1);
  }, [getActiveImageFromRef, jumpToHistory]);

  const resetActiveToOriginal = useCallback(() => {
    const active = getActiveImageFromRef();
    if (!active || active.historyIndex === 0) return;
    jumpToHistory(0);
    pushToast('info', '已恢复为原始图片');
  }, [getActiveImageFromRef, jumpToHistory, pushToast]);

  // ==================== 引擎与去水印任务执行 ====================

  const setEngine = useCallback((engine: EngineType) => {
    dispatch({ type: 'SET_ENGINE', engine });
  }, []);

  const setFastQuality = useCallback((quality: FastQuality) => {
    dispatch({ type: 'SET_FAST_QUALITY', quality });
  }, []);

  const setAiModelModalOpen = useCallback((open: boolean) => {
    dispatch({ type: 'SET_AI_MODEL_MODAL_OPEN', open });
  }, []);

  /** 内部统一调用当前选中引擎执行单图修补 */
  const executeInpaintForItem = useCallback(
    async (
      item: ImageItem,
      mask: Uint8Array,
      signal: AbortSignal,
      onProgress: (progress: InpaintProgress) => void,
    ): Promise<InpaintOutput> => {
      const { engine, fastQuality, featherPx } = stateRef.current;
      const imageData = await imageSourceToImageData(item.currentDataUrl);

      if (engine === 'migan') {
        return runMiganInpaint(
          { imageData, mask, featherPx, matchedMarks: item.matchedMarks },
          { onProgress, signal },
        );
      }

      if (engine === 'lama') {
        onProgress({ stage: '正在准备 LaMa AI 推理会话...', percent: 5 });
        await ensureLamaSessionLoaded({ onProgress });
        return runLamaInpaint(
          { imageData, mask, featherPx, matchedMarks: item.matchedMarks },
          { onProgress, signal },
        );
      }

      return runFastInpaint(
        { imageData, mask, quality: fastQuality, featherPx, matchedMarks: item.matchedMarks },
        { onProgress, signal },
      );
    },
    [],
  );

  /** 在启动 LaMa 引擎前验证模型是否已缓存或加载，避免静默回退 */
  const ensureLamaReadyBeforeRun = useCallback((): boolean => {
    const { engine, lamaStatus } = stateRef.current;
    if (engine !== 'lama') {
      return true;
    }
    if (lamaStatus.state === 'ready' || lamaStatus.state === 'cached') {
      return true;
    }
    if (lamaStatus.state === 'downloading' || lamaStatus.state === 'loading') {
      pushToast('info', 'AI 模型正在下载或加载中，请稍候完成');
      dispatch({ type: 'SET_AI_MODEL_MODAL_OPEN', open: true });
      return false;
    }
    pushToast('warning', '请先在 AI 模型管理中下载或导入 LaMa ONNX 模型后再使用 AI 精修');
    dispatch({ type: 'SET_AI_MODEL_MODAL_OPEN', open: true });
    return false;
  }, [pushToast]);

  const cancelProcessing = useCallback(() => {
    if (!processingAbortRef.current) {
      return;
    }
    processingAbortRef.current.abort();
    processingAbortRef.current = null;
    dispatch({ type: 'SET_PROCESSING', isProcessing: false, progress: null });
    dispatch({
      type: 'SET_BATCH_PROGRESS',
      progress: { ...stateRef.current.batchProgress, running: false },
    });
    pushToast('info', '已取消当前去水印任务');
  }, [pushToast]);

  const processActiveImage = useCallback(async (): Promise<boolean> => {
    if (stateRef.current.isProcessing) {
      return false;
    }
    const active = getActiveImageFromRef();
    if (!active) {
      pushToast('warning', '请先导入需要处理的图片');
      return false;
    }

    const effectiveMask = resolveEffectiveMask(active);
    if (!effectiveMask) {
      pushToast('warning', '请先涂抹水印区域、套用平台预设或点击一键自动检测');
      return false;
    }

    if (!ensureLamaReadyBeforeRun()) {
      return false;
    }

    const controller = new AbortController();
    processingAbortRef.current = controller;

    dispatch({
      type: 'SET_PROCESSING',
      isProcessing: true,
      progress: { stage: '正在准备图像数据...', percent: 2 },
    });
    dispatch({
      type: 'UPDATE_IMAGE',
      id: active.id,
      updater: (item) => ({ ...item, status: 'processing', error: undefined }),
    });

    try {
      const usedEngine = stateRef.current.engine;
      const output = await executeInpaintForItem(
        active,
        effectiveMask,
        controller.signal,
        (progress) => {
          dispatch({ type: 'SET_PROCESSING', isProcessing: true, progress });
        },
      );

      if (controller.signal.aborted) {
        return false;
      }

      const nextDataUrl = imageDataToDataUrl(output.imageData, 'image/png');
      const entry: HistoryEntry = {
        id: createId('hist'),
        dataUrl: nextDataUrl,
        label:
          usedEngine === 'migan'
            ? 'AI 精修 (MI-GAN)'
            : usedEngine === 'lama'
              ? 'AI 高清修复 (LaMa)'
              : '快速无痕修复',
        timestamp: Date.now(),
        engine: usedEngine,
        durationMs: output.durationMs,
        backend: output.backend,
      };

      dispatch({
        type: 'UPDATE_IMAGE',
        id: active.id,
        updater: (item) => appendHistoryEntry(item, entry),
      });

      const ms = Math.max(1, Math.round(output.durationMs));
      pushToast('success', `去水印完成（耗时 ${ms} ms · ${output.backend}）`);
      return true;
    } catch (err) {
      if (isAbortError(err)) {
        dispatch({
          type: 'UPDATE_IMAGE',
          id: active.id,
          updater: (item) => ({
            ...item,
            status: item.processed ? 'done' : 'idle',
          }),
        });
        return false;
      }

      const msg = extractErrorMessage(err, '去水印处理失败');
      dispatch({
        type: 'UPDATE_IMAGE',
        id: active.id,
        updater: (item) => ({ ...item, status: 'error', error: msg }),
      });
      pushToast('error', msg, 5000);
      return false;
    } finally {
      if (processingAbortRef.current === controller) {
        processingAbortRef.current = null;
      }
      dispatch({ type: 'SET_PROCESSING', isProcessing: false, progress: null });
    }
  }, [ensureLamaReadyBeforeRun, executeInpaintForItem, getActiveImageFromRef, pushToast]);

  const processBatchImages = useCallback(
    async (targetIds?: string[]) => {
      if (stateRef.current.isProcessing) {
        return;
      }
      const pool = targetIds
        ? stateRef.current.images.filter((img) => targetIds.includes(img.id))
        : stateRef.current.images;

      if (pool.length === 0) {
        pushToast('warning', '当前图片队列为空');
        return;
      }

      const runnable = pool
        .map((item) => ({ item, mask: resolveEffectiveMask(item) }))
        .filter((entry): entry is { item: ImageItem; mask: Uint8Array } => entry.mask !== null);

      if (runnable.length === 0) {
        pushToast('warning', '队列中暂无已标记水印区域的图片，请先批量套用预设或运行全部自动检测');
        return;
      }

      if (!ensureLamaReadyBeforeRun()) {
        return;
      }

      const controller = new AbortController();
      processingAbortRef.current = controller;

      let completed = 0;
      let failed = 0;
      const total = runnable.length;
      const skipped = pool.length - runnable.length;

      dispatch({
        type: 'SET_PROCESSING',
        isProcessing: true,
        progress: { stage: `准备批量处理 ${total} 张图片...`, percent: 0 },
      });
      dispatch({
        type: 'SET_BATCH_PROGRESS',
        progress: {
          running: true,
          total,
          completed: 0,
          failed: 0,
          currentImageId: runnable[0].item.id,
          currentPercent: 0,
        },
      });

      try {
        for (let i = 0; i < runnable.length; i++) {
          if (controller.signal.aborted) {
            break;
          }

          const { item, mask } = runnable[i];
          const latestItem = stateRef.current.images.find((img) => img.id === item.id);
          if (!latestItem) {
            continue;
          }

          dispatch({
            type: 'UPDATE_IMAGE',
            id: latestItem.id,
            updater: (prev) => ({ ...prev, status: 'processing', error: undefined }),
          });
          dispatch({
            type: 'SET_BATCH_PROGRESS',
            progress: {
              running: true,
              total,
              completed,
              failed,
              currentImageId: latestItem.id,
              currentPercent: 0,
            },
          });

          try {
            const usedEngine = stateRef.current.engine;
            const output = await executeInpaintForItem(
              latestItem,
              mask,
              controller.signal,
              (progress) => {
                dispatch({
                  type: 'SET_PROCESSING',
                  isProcessing: true,
                  progress: {
                    stage: `[${i + 1}/${total}] ${latestItem.name} · ${progress.stage}`,
                    percent: progress.percent,
                  },
                });
                dispatch({
                  type: 'SET_BATCH_PROGRESS',
                  progress: {
                    running: true,
                    total,
                    completed,
                    failed,
                    currentImageId: latestItem.id,
                    currentPercent: progress.percent,
                  },
                });
              },
            );

            if (controller.signal.aborted) {
              break;
            }

            const nextDataUrl = imageDataToDataUrl(output.imageData, 'image/png');
            const entry: HistoryEntry = {
              id: createId('hist'),
              dataUrl: nextDataUrl,
              label:
                usedEngine === 'migan'
                  ? '批量 AI 精修 (MI-GAN)'
                  : usedEngine === 'lama'
                    ? '批量 AI 修复 (LaMa)'
                    : '批量快速修复',
              timestamp: Date.now(),
              engine: usedEngine,
              durationMs: output.durationMs,
              backend: output.backend,
            };

            dispatch({
              type: 'UPDATE_IMAGE',
              id: latestItem.id,
              updater: (prev) => appendHistoryEntry(prev, entry),
            });
            completed++;
          } catch (err) {
            if (isAbortError(err)) {
              dispatch({
                type: 'UPDATE_IMAGE',
                id: latestItem.id,
                updater: (prev) => ({
                  ...prev,
                  status: prev.processed ? 'done' : 'idle',
                }),
              });
              break;
            }

            failed++;
            const msg = extractErrorMessage(err, '处理失败');
            dispatch({
              type: 'UPDATE_IMAGE',
              id: latestItem.id,
              updater: (prev) => ({ ...prev, status: 'error', error: msg }),
            });
          }

          dispatch({
            type: 'SET_BATCH_PROGRESS',
            progress: {
              running: true,
              total,
              completed,
              failed,
              currentImageId: latestItem.id,
              currentPercent: 100,
            },
          });
        }

        if (!controller.signal.aborted) {
          const skippedText = skipped > 0 ? `，跳过 ${skipped} 张无选区图` : '';
          if (failed === 0) {
            pushToast('success', `批量去水印完成：成功 ${completed} 张${skippedText}`);
          } else {
            pushToast(
              'warning',
              `批量处理结束：成功 ${completed} 张，失败 ${failed} 张${skippedText}`,
              5000,
            );
          }
        }
      } finally {
        if (processingAbortRef.current === controller) {
          processingAbortRef.current = null;
        }
        dispatch({ type: 'SET_PROCESSING', isProcessing: false, progress: null });
        dispatch({
          type: 'SET_BATCH_PROGRESS',
          progress: {
            running: false,
            total,
            completed,
            failed,
            currentImageId: undefined,
            currentPercent: 100,
          },
        });
      }
    },
    [ensureLamaReadyBeforeRun, executeInpaintForItem, pushToast],
  );

  // ==================== 内置 MI-GAN 本地 AI 管理 ====================

  const preloadMiganAiModel = useCallback(async () => {
    try {
      await preloadMiganModel();
      pushToast('success', '内置 MI-GAN 本地 AI 引擎已预加载就绪（WASM）');
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '预加载内置 MI-GAN 模型失败'), 5000);
    }
  }, [pushToast]);

  const unloadMiganAiSession = useCallback(async () => {
    try {
      await disposeMiganSession();
      pushToast('info', '已释放内置 MI-GAN 推理线程内存');
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '释放 MI-GAN 会话失败'));
    }
  }, [pushToast]);

  // ==================== LaMa AI 模型管理 ====================

  const downloadAiModel = useCallback(
    async (url: string, label?: string) => {
      const trimmed = url.trim();
      if (!trimmed) {
        pushToast('warning', '请输入有效的 ONNX 模型下载地址');
        return;
      }

      modelDownloadAbortRef.current?.abort();
      const controller = new AbortController();
      modelDownloadAbortRef.current = controller;

      try {
        await downloadLamaModel(trimmed, {
          label,
          signal: controller.signal,
        });
        pushToast('success', 'LaMa AI 模型已下载并缓存至本地浏览器');
      } catch (err) {
        if (isAbortError(err)) {
          pushToast('info', '已取消 AI 模型下载');
        } else {
          pushToast(
            'error',
            extractErrorMessage(err, '模型下载失败，请切换镜像源或本地导入'),
            5500,
          );
        }
      } finally {
        if (modelDownloadAbortRef.current === controller) {
          modelDownloadAbortRef.current = null;
        }
      }
    },
    [pushToast],
  );

  const cancelAiModelDownload = useCallback(() => {
    modelDownloadAbortRef.current?.abort();
    modelDownloadAbortRef.current = null;
    cancelLamaDownload();
  }, []);

  const importAiModelFile = useCallback(
    async (file: File) => {
      try {
        await importLocalLamaModel(file);
        pushToast('success', `已导入本地模型「${file.name}」并缓存至浏览器`);
      } catch (err) {
        pushToast('error', extractErrorMessage(err, '导入本地 ONNX 模型失败'), 5000);
      }
    },
    [pushToast],
  );

  const clearAiModelCacheAction = useCallback(async () => {
    try {
      await clearLamaModelCache();
      pushToast('info', '已清除本地缓存的 LaMa AI 模型');
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '清除模型缓存失败'));
    }
  }, [pushToast]);

  const loadAiModelSession = useCallback(async () => {
    try {
      await ensureLamaSessionLoaded();
      const backend = getLamaModelStatus().backend;
      pushToast(
        'success',
        `LaMa 推理引擎已就绪（后端：${backend === 'webgpu' ? 'WebGPU 加速' : 'WASM'}）`,
      );
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '初始化 LaMa 推理会话失败'), 5000);
    }
  }, [pushToast]);

  const unloadAiModelSession = useCallback(async () => {
    try {
      await disposeLamaSession();
      pushToast('info', '已释放 LaMa 推理显存/内存会话');
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '释放推理会话失败'));
    }
  }, [pushToast]);

  // ==================== 导出与剪贴板 ====================

  const setExportConfig = useCallback((patch: Partial<ExportConfig>) => {
    dispatch({ type: 'PATCH_EXPORT_CONFIG', patch });
  }, []);

  const exportActiveImage = useCallback(async () => {
    const active = getActiveImageFromRef();
    if (!active) {
      pushToast('warning', '当前没有可导出的图片');
      return;
    }
    dispatch({ type: 'SET_EXPORTING', isExporting: true });
    try {
      const filename = await downloadSingleImage(active, stateRef.current.exportConfig);
      pushToast('success', `已原分辨率导出：${filename}`);
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '图片导出失败'));
    } finally {
      dispatch({ type: 'SET_EXPORTING', isExporting: false });
    }
  }, [getActiveImageFromRef, pushToast]);

  const copyActiveImage = useCallback(async () => {
    const active = getActiveImageFromRef();
    if (!active) {
      pushToast('warning', '当前没有可复制的图片');
      return;
    }
    try {
      await copyImageToClipboard(active.currentDataUrl);
      pushToast('success', '已复制当前图片到剪贴板');
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '复制到剪贴板失败'), 4500);
    }
  }, [getActiveImageFromRef, pushToast]);

  const exportAllAsZip = useCallback(
    async (onlyProcessed = false) => {
      const candidates = onlyProcessed
        ? stateRef.current.images.filter((item) => item.processed)
        : stateRef.current.images;

      if (candidates.length === 0) {
        pushToast(
          'warning',
          onlyProcessed ? '暂无已完成去水印的图片可打包' : '当前队列没有可导出的图片',
        );
        return;
      }

      dispatch({
        type: 'SET_EXPORTING',
        isExporting: true,
        zipProgress: { completed: 0, total: candidates.length, currentName: candidates[0].name },
      });

      try {
        const result = await exportBatchAsZip(candidates, stateRef.current.exportConfig, {
          onProgress: (completed, total, currentName) => {
            dispatch({
              type: 'SET_EXPORTING',
              isExporting: true,
              zipProgress: { completed, total, currentName },
            });
          },
        });
        pushToast('success', `已打包下载 ${result.count} 张图片（${result.filename}）`);
      } catch (err) {
        if (!isAbortError(err)) {
          pushToast('error', extractErrorMessage(err, '批量 ZIP 打包导出失败'));
        }
      } finally {
        dispatch({ type: 'SET_EXPORTING', isExporting: false, zipProgress: null });
      }
    },
    [pushToast],
  );

  // ==================== 主题切换 ====================

  const setTheme = useCallback((theme: ThemeMode) => {
    dispatch({ type: 'SET_THEME', theme });
  }, []);

  const toggleTheme = useCallback(() => {
    dispatch({
      type: 'SET_THEME',
      theme: stateRef.current.theme === 'dark' ? 'light' : 'dark',
    });
  }, []);

  // ==================== 派生状态与 Context 值 ====================

  const activeImage = useMemo(
    () => state.images.find((item) => item.id === state.activeImageId) ?? null,
    [state.images, state.activeImageId],
  );

  const canUndo = Boolean(activeImage && activeImage.historyIndex > 0);
  const canRedo = Boolean(activeImage && activeImage.historyIndex < activeImage.history.length - 1);
  const hasActiveMask = Boolean(
    activeImage && (hasMaskPixels(activeImage.maskBytes) || activeImage.activePresetBox !== null),
  );

  const value = useMemo<AppStoreContextValue>(
    () => ({
      state,
      activeImage,
      canUndo,
      canRedo,
      hasActiveMask,
      lamaSources: DEFAULT_LAMA_SOURCES,
      addImages,
      loadDemoSampleById,
      loadAllDemos,
      selectImage,
      removeImage,
      clearImages,
      setTool,
      setBrushSize,
      setFeatherPx,
      setMaskOpacity,
      setShowMask,
      setCompareMode,
      updateActiveMask,
      setActivePresetBox,
      commitActivePresetBoxToMask,
      dilateActiveMask,
      refineActiveMaskToStrokes,
      clearActiveMask,
      applyPresetToActive,
      openPresetBoxForActive,
      applyPresetToAll,
      applyActivePresetBoxToAll,
      applyActiveMaskToAll,
      saveCurrentBoxAsCustomPreset,
      removeCustomPreset,
      setDetectSensitivity,
      autoDetectActive,
      autoDetectAll,
      undoActive,
      redoActive,
      resetActiveToOriginal,
      jumpToHistory,
      setEngine,
      setFastQuality,
      setAiModelModalOpen,
      processActiveImage,
      processBatchImages,
      cancelProcessing,
      preloadMiganAiModel,
      unloadMiganAiSession,
      downloadAiModel,
      cancelAiModelDownload,
      importAiModelFile,
      clearAiModelCache: clearAiModelCacheAction,
      loadAiModelSession,
      unloadAiModelSession,
      setExportConfig,
      exportActiveImage,
      copyActiveImage,
      exportAllAsZip,
      setTheme,
      toggleTheme,
      pushToast,
      dismissToast,
    }),
    [
      state,
      activeImage,
      canUndo,
      canRedo,
      hasActiveMask,
      addImages,
      loadDemoSampleById,
      loadAllDemos,
      selectImage,
      removeImage,
      clearImages,
      setTool,
      setBrushSize,
      setFeatherPx,
      setMaskOpacity,
      setShowMask,
      setCompareMode,
      updateActiveMask,
      setActivePresetBox,
      commitActivePresetBoxToMask,
      dilateActiveMask,
      refineActiveMaskToStrokes,
      clearActiveMask,
      applyPresetToActive,
      openPresetBoxForActive,
      applyPresetToAll,
      applyActivePresetBoxToAll,
      applyActiveMaskToAll,
      saveCurrentBoxAsCustomPreset,
      removeCustomPreset,
      setDetectSensitivity,
      autoDetectActive,
      autoDetectAll,
      undoActive,
      redoActive,
      resetActiveToOriginal,
      jumpToHistory,
      setEngine,
      setFastQuality,
      setAiModelModalOpen,
      processActiveImage,
      processBatchImages,
      cancelProcessing,
      preloadMiganAiModel,
      unloadMiganAiSession,
      downloadAiModel,
      cancelAiModelDownload,
      importAiModelFile,
      clearAiModelCacheAction,
      loadAiModelSession,
      unloadAiModelSession,
      setExportConfig,
      exportActiveImage,
      copyActiveImage,
      exportAllAsZip,
      setTheme,
      toggleTheme,
      pushToast,
      dismissToast,
    ],
  );

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppStore(): AppStoreContextValue {
  const ctx = useContext(AppStoreContext);
  if (!ctx) {
    throw new Error('useAppStore 必须在 AppProvider 内部调用');
  }
  return ctx;
}
