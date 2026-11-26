import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useAppActions, useToasts } from '../store/useAppStore';
import type { ToastType } from '../types';

const TOAST_STYLE: Record<
  ToastType,
  { icon: typeof Info; color: string; bg: string; border: string }
> = {
  info: {
    icon: Info,
    color: 'var(--info)',
    bg: 'var(--info-soft)',
    border: 'rgba(56, 189, 248, 0.35)',
  },
  success: {
    icon: CheckCircle2,
    color: 'var(--success)',
    bg: 'var(--success-soft)',
    border: 'rgba(34, 197, 94, 0.35)',
  },
  warning: {
    icon: AlertTriangle,
    color: 'var(--warning)',
    bg: 'var(--warning-soft)',
    border: 'rgba(245, 158, 11, 0.35)',
  },
  error: {
    icon: AlertCircle,
    color: 'var(--danger)',
    bg: 'var(--danger-soft)',
    border: 'rgba(244, 63, 94, 0.38)',
  },
};

/** 全局画布区顶部居中轻量 Toast 容器（避开右侧属性面板与画布四角徽标） */
export function ToastContainer() {
  const toasts = useToasts();
  const { dismissToast } = useAppActions();

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-[60px] z-60 flex flex-col items-center gap-1.5 px-4 sm:pl-[68px] sm:pr-[324px]"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const meta = TOAST_STYLE[toast.type];
        const Icon = meta.icon;
        return (
          <div
            key={toast.id}
            className="pointer-events-auto flex w-fit max-w-[min(420px,100%)] items-center gap-2 rounded-xl border px-3 py-2 backdrop-blur-md transition-all"
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: meta.border,
              boxShadow: 'var(--shadow-md)',
            }}
            role="status"
          >
            <span
              className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: meta.bg, color: meta.color }}
            >
              <Icon className="h-3 w-3" />
            </span>
            <p className="text-xs leading-snug text-[var(--text-primary)]">{toast.text}</p>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
              aria-label="关闭提示"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
