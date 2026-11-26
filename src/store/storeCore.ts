/**
 * 零依赖可控全局 Store 核心实例（供 AppProvider 与单元测试共同驱动）
 *
 * 采用「单控实例 + 领域 Action 模块 + React 19 useSyncExternalStore 精准订阅」设计：
 * - Provider 仅传递永不变更的 Store 实例引用，避免顶层 Context 广播引发全树重渲染；
 * - 每个组件或测试可按需订阅最小状态切片；
 * - 卸载与清理完全内聚且幂等，兼容 React 19 StrictMode 双重挂载。
 */

import { checkWebGpuSupport, initLamaModelStatus, subscribeLamaStatus } from '../engines/lama';
import { subscribeMiganStatus } from '../engines/migan';
import type { ImageItem, ThemeMode } from '../types';
import { createExportActions } from './actions/createExportActions';
import { createImageQueueActions } from './actions/createImageQueueActions';
import { createInpaintActions } from './actions/createInpaintActions';
import { createMaskPresetActions } from './actions/createMaskPresetActions';
import { createModelActions } from './actions/createModelActions';
import { createToastAndThemeActions } from './actions/createToastAndThemeActions';
import { revokeItemBlobUrls } from './history';
import { THEME_STORAGE_KEY, appReducer, createInitialState } from './reducer';
import type {
  AppAction,
  AppActions,
  AppState,
  AppStoreInstance,
  StoreActionContext,
  StoreRuntimeRefs,
} from './types';

function syncThemeToDomAndStorage(theme: ThemeMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 忽略隐私模式写入失败
  }
}

export interface CreateAppStoreOptions {
  /** 可选初始状态覆写（主要用于单元测试构造特定初始场景） */
  initialState?: Partial<AppState>;
}

/** 创建独立的 ClearMark Studio Store 实例 */
export function createAppStoreInstance(options?: CreateAppStoreOptions): AppStoreInstance {
  let state: AppState = options?.initialState
    ? { ...createInitialState(), ...options.initialState }
    : createInitialState();

  const listeners = new Set<() => void>();
  const refs: StoreRuntimeRefs = {
    processingAbort: null,
    modelDownloadAbort: null,
    detectTaskGen: 0,
    refineTaskGen: 0,
    toastTimers: new Map(),
  };

  const getState = (): AppState => state;

  const dispatch = (action: AppAction): void => {
    const nextState = appReducer(state, action);
    if (Object.is(nextState, state)) {
      return;
    }
    state = nextState;
    for (const listener of listeners) {
      listener();
    }
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getActiveImage = (): ImageItem | null => {
    if (!state.activeImageId) return null;
    return state.images.find((item) => item.id === state.activeImageId) ?? null;
  };

  const toastAndTheme = createToastAndThemeActions({ getState, dispatch, refs });

  const actionContext: StoreActionContext = {
    getState,
    dispatch,
    refs,
    getActiveImage,
    pushToast: toastAndTheme.pushToast,
    dismissToast: toastAndTheme.dismissToast,
  };

  const imageQueue = createImageQueueActions(actionContext);
  const maskPreset = createMaskPresetActions(actionContext);
  const inpaint = createInpaintActions(actionContext);
  const models = createModelActions(actionContext);
  const exportActions = createExportActions(actionContext);

  // Actions 对象在 Store 生命周期内保持引用恒定，消费者读取 actions 永不引起重渲染
  const actions: AppActions = {
    ...imageQueue,
    ...maskPreset,
    ...inpaint,
    ...models,
    ...exportActions,
    ...toastAndTheme,
  };

  const dispose = (): void => {
    refs.detectTaskGen += 1;
    refs.refineTaskGen += 1;
    refs.processingAbort?.abort();
    refs.processingAbort = null;
    refs.modelDownloadAbort?.abort();
    refs.modelDownloadAbort = null;
    refs.toastTimers.forEach((timer) => clearTimeout(timer));
    refs.toastTimers.clear();
    for (const item of state.images) {
      revokeItemBlobUrls(item);
    }
  };

  const mountEffects = (options?: { disposeOnUnmount?: boolean }): (() => void) => {
    const disposeOnUnmount = options?.disposeOnUnmount ?? false;
    let active = true;
    let lastSyncedTheme: ThemeMode = state.theme;
    syncThemeToDomAndStorage(lastSyncedTheme);

    const unsubscribeTheme = subscribe(() => {
      if (state.theme !== lastSyncedTheme) {
        lastSyncedTheme = state.theme;
        syncThemeToDomAndStorage(lastSyncedTheme);
      }
    });

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
        if (active) {
          dispatch({ type: 'SET_WEBGPU_SUPPORTED', supported });
        }
      })
      .catch(() => {
        if (active) {
          dispatch({ type: 'SET_WEBGPU_SUPPORTED', supported: false });
        }
      });

    return () => {
      active = false;
      unsubscribeTheme();
      unsubscribeLama();
      unsubscribeMigan();
      if (disposeOnUnmount) {
        dispose();
      }
    };
  };

  return {
    getState,
    dispatch,
    subscribe,
    actions,
    mountEffects,
    dispose,
  };
}
