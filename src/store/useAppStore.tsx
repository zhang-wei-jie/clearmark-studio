/**
 * 全局应用状态 Provider 与统一导出入口
 *
 * 实际状态机、纯函数历史栈、领域 Actions 与精准订阅 Selectors 分别拆分于：
 * - `./types.ts`、`./history.ts`、`./reducer.ts`
 * - `./storeCore.ts`、`./selectors.ts`
 * - `./actions/create*Actions.ts`
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { StoreInstanceContext } from './storeContext';
import { createAppStoreInstance } from './storeCore';
import type { AppStoreInstance } from './types';

export interface AppProviderProps {
  children: ReactNode;
  /** 可选外部注入 Store 实例（用于测试或自定义初始化） */
  store?: AppStoreInstance;
}

export function AppProvider({ children, store: externalStore }: AppProviderProps) {
  const internalStoreRef = useRef<AppStoreInstance | null>(null);
  if (!externalStore && !internalStoreRef.current) {
    internalStoreRef.current = createAppStoreInstance();
  }
  const store = externalStore ?? internalStoreRef.current!;
  const ownsStore = !externalStore;

  useEffect(() => {
    // 仅对 Provider 内部自建 Store 在卸载时释放 Blob URL 与任务句柄，避免越权销毁外部注入 Store 的资源
    return store.mountEffects({ disposeOnUnmount: ownsStore });
  }, [store, ownsStore]);

  return <StoreInstanceContext.Provider value={store}>{children}</StoreInstanceContext.Provider>;
}

/* eslint-disable react-refresh/only-export-components */
export {
  shallowEqual,
  useActiveImageMeta,
  useAppActions,
  useAppSelector,
  useAppStore,
  useCanvasToolState,
  useEngineModelState,
  useExportState,
  useImageQueueState,
  usePresetDetectState,
  useProgressState,
  useStoreInstance,
  useTaskBusyState,
  useThemeMode,
  useToasts,
} from './selectors';

export { createAppStoreInstance } from './storeCore';
/* eslint-enable react-refresh/only-export-components */

export type {
  AppAction,
  AppActions,
  AppState,
  AppStoreContextValue,
  AppStoreInstance,
  CompareMode,
  ZipExportProgress,
} from './types';
