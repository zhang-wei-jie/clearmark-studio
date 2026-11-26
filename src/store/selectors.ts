/**
 * 基于 React 19 useSyncExternalStore 的细粒度精准订阅 Hooks
 *
 * 每个领域 Hook 仅在所选字段真正变化（shallowEqual 返回 false）时才触发组件重渲染，
 * 避免 Toast 提示、处理进度刷新或画笔滑块拖动引起无关工作台区域全量重绘。
 */

import { useCallback, useContext, useMemo, useRef, useSyncExternalStore } from 'react';
import { DEFAULT_LAMA_SOURCES } from '../engines/lama';
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
  ThemeMode,
  ToastMessage,
  ToolType,
  WatermarkPreset,
} from '../types';
import { StoreInstanceContext } from './storeContext';
import type {
  AppActions,
  AppState,
  AppStoreContextValue,
  AppStoreInstance,
  CompareMode,
  ZipExportProgress,
} from './types';

/** 浅层相等比较器：供对象切片 selector 判断快照是否实质变更 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    ) {
      return false;
    }
  }
  return true;
}

/** 获取当前 AppProvider 作用域内的 Store 实例 */
export function useStoreInstance(): AppStoreInstance {
  const store = useContext(StoreInstanceContext);
  if (!store) {
    throw new Error('useAppStore / 领域 Store Hook 必须在 AppProvider 内部调用');
  }
  return store;
}

/**
 * 细粒度状态选择器 Hook
 *
 * 通过缓存 (state, selector) 与可选 isEqual 比较器保证 getSnapshot 引用稳定，
 * 兼容 React 19 StrictMode 与返回新派生对象的 selector，不会产生死循环或多余重渲染。
 */
export function useAppSelector<T>(
  selector: (state: AppState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useStoreInstance();
  const cacheRef = useRef<{
    initialized: boolean;
    state: AppState;
    selector: (state: AppState) => T;
    selected: T;
  }>({
    initialized: false,
    state: store.getState(),
    selector,
    selected: undefined as T,
  });

  const getSnapshot = useCallback((): T => {
    const nextState = store.getState();
    if (
      cacheRef.current.initialized &&
      Object.is(cacheRef.current.state, nextState) &&
      Object.is(cacheRef.current.selector, selector)
    ) {
      return cacheRef.current.selected;
    }
    const nextSelected = selector(nextState);
    if (cacheRef.current.initialized && isEqual(cacheRef.current.selected, nextSelected)) {
      cacheRef.current.state = nextState;
      cacheRef.current.selector = selector;
      return cacheRef.current.selected;
    }
    cacheRef.current = {
      initialized: true,
      state: nextState,
      selector,
      selected: nextSelected,
    };
    return nextSelected;
  }, [store, selector, isEqual]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** 获取引用恒定的业务动作集合（永不触发组件重渲染） */
export function useAppActions(): AppActions {
  return useStoreInstance().actions;
}

// ==================== 预封装领域选择器（模块级常量函数确保 O(1) 快照命中） ====================

const selectToasts = (s: AppState): ToastMessage[] => s.toasts;
const selectTheme = (s: AppState): ThemeMode => s.theme;

export interface ActiveImageMeta {
  activeImage: ImageItem | null;
  canUndo: boolean;
  canRedo: boolean;
  hasActiveMask: boolean;
}

const selectActiveImageMeta = (s: AppState): ActiveImageMeta => {
  const activeImage = s.activeImageId
    ? (s.images.find((item) => item.id === s.activeImageId) ?? null)
    : null;
  return {
    activeImage,
    canUndo: Boolean(activeImage && activeImage.historyIndex > 0),
    canRedo: Boolean(activeImage && activeImage.historyIndex < activeImage.history.length - 1),
    hasActiveMask: Boolean(
      activeImage && (activeImage.maskBytes !== null || activeImage.activePresetBox !== null),
    ),
  };
};

export interface TaskBusyState {
  isProcessing: boolean;
  isDetecting: boolean;
  isRefiningMask: boolean;
  isBusy: boolean;
}

const selectTaskBusyState = (s: AppState): TaskBusyState => ({
  isProcessing: s.isProcessing,
  isDetecting: s.isDetecting,
  isRefiningMask: s.isRefiningMask,
  isBusy: s.isProcessing || s.isDetecting || s.isRefiningMask,
});

export interface ProgressState {
  currentProgress: InpaintProgress | null;
  batchProgress: BatchProgress;
}

const selectProgressState = (s: AppState): ProgressState => ({
  currentProgress: s.currentProgress,
  batchProgress: s.batchProgress,
});

export interface CanvasToolState {
  tool: ToolType;
  brushSize: number;
  featherPx: number;
  maskOpacity: number;
  showMask: boolean;
  compareMode: CompareMode;
}

const selectCanvasToolState = (s: AppState): CanvasToolState => ({
  tool: s.tool,
  brushSize: s.brushSize,
  featherPx: s.featherPx,
  maskOpacity: s.maskOpacity,
  showMask: s.showMask,
  compareMode: s.compareMode,
});

export interface EngineModelState {
  engine: EngineType;
  fastQuality: FastQuality;
  miganStatus: MiganModelStatus;
  lamaStatus: LamaModelStatus;
  webGpuSupported: boolean;
  aiModelModalOpen: boolean;
  lamaSources: readonly LamaModelSource[];
}

const selectEngineModelState = (s: AppState): EngineModelState => ({
  engine: s.engine,
  fastQuality: s.fastQuality,
  miganStatus: s.miganStatus,
  lamaStatus: s.lamaStatus,
  webGpuSupported: s.webGpuSupported,
  aiModelModalOpen: s.aiModelModalOpen,
  lamaSources: DEFAULT_LAMA_SOURCES,
});

export interface ExportState {
  exportConfig: ExportConfig;
  isExporting: boolean;
  zipExportProgress: ZipExportProgress | null;
}

const selectExportState = (s: AppState): ExportState => ({
  exportConfig: s.exportConfig,
  isExporting: s.isExporting,
  zipExportProgress: s.zipExportProgress,
});

export interface PresetDetectState {
  presets: WatermarkPreset[];
  selectedPresetId: string | null;
  detectSensitivity: DetectSensitivity;
  lastDetectionResult: CornerDetectionResult | null;
}

const selectPresetDetectState = (s: AppState): PresetDetectState => ({
  presets: s.presets,
  selectedPresetId: s.selectedPresetId,
  detectSensitivity: s.detectSensitivity,
  lastDetectionResult: s.lastDetectionResult,
});

export interface ImageQueueState {
  images: ImageItem[];
  activeImageId: string | null;
}

const selectImageQueueState = (s: AppState): ImageQueueState => ({
  images: s.images,
  activeImageId: s.activeImageId,
});

/** 仅订阅 Toast 列表（弹出/消失提示不触发其他面板重渲染） */
export function useToasts(): ToastMessage[] {
  return useAppSelector(selectToasts);
}

/** 仅订阅当前明暗主题 */
export function useThemeMode(): ThemeMode {
  return useAppSelector(selectTheme);
}

/** 订阅当前激活图片及其撤销/重做/选区派生标志 */
export function useActiveImageMeta(): ActiveImageMeta {
  return useAppSelector(selectActiveImageMeta, shallowEqual);
}

/** 订阅图片队列列表与当前激活 ID */
export function useImageQueueState(): ImageQueueState {
  return useAppSelector(selectImageQueueState, shallowEqual);
}

/** 订阅互斥任务忙碌状态（处理中 / 检测中 / 抠笔画中） */
export function useTaskBusyState(): TaskBusyState {
  return useAppSelector(selectTaskBusyState, shallowEqual);
}

/** 订阅高频进度信息（单图进度 + 批量进度） */
export function useProgressState(): ProgressState {
  return useAppSelector(selectProgressState, shallowEqual);
}

/** 订阅画布绘制工具与显示参数 */
export function useCanvasToolState(): CanvasToolState {
  return useAppSelector(selectCanvasToolState, shallowEqual);
}

/** 订阅三套去水印引擎与本地 AI 模型状态 */
export function useEngineModelState(): EngineModelState {
  return useAppSelector(selectEngineModelState, shallowEqual);
}

/** 订阅导出配置与 ZIP 导出进度 */
export function useExportState(): ExportState {
  return useAppSelector(selectExportState, shallowEqual);
}

/** 订阅平台预设列表与智能检测设置/结果 */
export function usePresetDetectState(): PresetDetectState {
  return useAppSelector(selectPresetDetectState, shallowEqual);
}

/**
 * 向下兼容的全量聚合 Store Hook
 *
 * 新代码与核心组件应优先使用上方细粒度领域 Hook 或 `useAppSelector` + `useAppActions`，
 * 仅在需要同时读取完整 AppState 的过渡或测试场景下使用本函数。
 */
export function useAppStore(): AppStoreContextValue {
  const store = useStoreInstance();
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const activeMeta = useMemo(() => selectActiveImageMeta(state), [state]);

  return useMemo<AppStoreContextValue>(
    () => ({
      state,
      ...activeMeta,
      lamaSources: DEFAULT_LAMA_SOURCES,
      ...store.actions,
    }),
    [state, activeMeta, store.actions],
  );
}
