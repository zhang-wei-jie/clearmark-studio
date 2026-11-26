/**
 * 全局 Toast 提示与明暗主题切换领域 Actions
 */

import type { ThemeMode, ToastType } from '../../types';
import { createId } from '../history';
import type { AppAction, AppState, StoreRuntimeRefs } from '../types';

export interface ToastAndThemeActions {
  pushToast: (type: ToastType, text: string, durationMs?: number) => void;
  dismissToast: (id: string) => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

export function createToastAndThemeActions(params: {
  getState: () => AppState;
  dispatch: (action: AppAction) => void;
  refs: StoreRuntimeRefs;
}): ToastAndThemeActions {
  const { getState, dispatch, refs } = params;

  const dismissToast = (id: string) => {
    const timer = refs.toastTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      refs.toastTimers.delete(id);
    }
    dispatch({ type: 'DISMISS_TOAST', id });
  };

  const pushToast = (type: ToastType, text: string, durationMs = 3600) => {
    const id = createId('toast');
    dispatch({ type: 'PUSH_TOAST', toast: { id, type, text } });
    if (durationMs > 0) {
      const timer = setTimeout(() => {
        refs.toastTimers.delete(id);
        dispatch({ type: 'DISMISS_TOAST', id });
      }, durationMs);
      refs.toastTimers.set(id, timer);
    }
  };

  const setTheme = (theme: ThemeMode) => {
    dispatch({ type: 'SET_THEME', theme });
  };

  const toggleTheme = () => {
    dispatch({
      type: 'SET_THEME',
      theme: getState().theme === 'dark' ? 'light' : 'dark',
    });
  };

  return {
    pushToast,
    dismissToast,
    setTheme,
    toggleTheme,
  };
}
