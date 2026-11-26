/**
 * 全局应用状态容器类型定义与内部领域 Action 契约
 */

import type {
  BatchProgress,
  CornerDetectionResult,
  DetectSensitivity,
  EngineType,
  ExportConfig,
  FastQuality,
  ImageItem,
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

export type AppAction =
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

/** 全部稳定引用的业务动作集合（通过 Store 实例一次性装配，不触发消费者重渲染） */
export interface AppActions {
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
  copyActiveImage: () => Promise<boolean>;
  exportAllAsZip: (onlyProcessed?: boolean) => Promise<void>;
  // 主题与提示
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  pushToast: (type: ToastType, text: string, durationMs?: number) => void;
  dismissToast: (id: string) => void;
}

/** 向下兼容的聚合 Store 返回结构（供过渡与向后兼容调用） */
export interface AppStoreContextValue extends AppActions {
  state: AppState;
  activeImage: ImageItem | null;
  canUndo: boolean;
  canRedo: boolean;
  hasActiveMask: boolean;
  lamaSources: readonly LamaModelSource[];
}

/** Store 实例内部非渲染态的并发控制器与代际句柄 */
export interface StoreRuntimeRefs {
  processingAbort: AbortController | null;
  modelDownloadAbort: AbortController | null;
  detectTaskGen: number;
  refineTaskGen: number;
  toastTimers: Map<string, ReturnType<typeof setTimeout>>;
}

/** 传给各领域 Action 工厂的统一依赖上下文 */
export interface StoreActionContext {
  getState: () => AppState;
  dispatch: (action: AppAction) => void;
  refs: StoreRuntimeRefs;
  getActiveImage: () => ImageItem | null;
  pushToast: (type: ToastType, text: string, durationMs?: number) => void;
  dismissToast: (id: string) => void;
}

/** 可独立实例化的全局 Store 对象（供 AppProvider 与单元测试共同驱动） */
export interface AppStoreInstance {
  getState: () => AppState;
  dispatch: (action: AppAction) => void;
  subscribe: (listener: () => void) => () => void;
  actions: AppActions;
  mountEffects: (options?: { disposeOnUnmount?: boolean }) => () => void;
  dispose: () => void;
}
