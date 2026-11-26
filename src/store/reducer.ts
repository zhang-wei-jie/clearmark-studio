/**
 * 全局应用状态初始化与纯函数 Reducer
 */

import { getAllPresets } from '../data/presets';
import { getLamaModelStatus } from '../engines/lama';
import { getMiganModelStatus } from '../engines/migan';
import type { BatchProgress, ThemeMode } from '../types';
import type { AppAction, AppState } from './types';

export const THEME_STORAGE_KEY = 'clearmark_theme';

export const INITIAL_BATCH_PROGRESS: BatchProgress = {
  running: false,
  total: 0,
  completed: 0,
  failed: 0,
  currentImageId: undefined,
  currentPercent: 0,
};

export function readInitialTheme(): ThemeMode {
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

export function createInitialState(): AppState {
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

export function appReducer(state: AppState, action: AppAction): AppState {
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
