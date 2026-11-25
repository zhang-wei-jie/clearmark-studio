import { Keyboard, X } from 'lucide-react';
import { useEffect } from 'react';

interface ShortcutHelpModalProps {
  open: boolean;
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  items: Array<{ keys: string[]; label: string }>;
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '绘制与选区工具',
    items: [
      { keys: ['B'], label: '画笔涂抹选区' },
      { keys: ['R'], label: '矩形框选水印' },
      { keys: ['E'], label: '橡皮擦擦除选区' },
      { keys: ['P'], label: '预设框体微调' },
      { keys: ['H'], label: '抓手平移画布' },
      { keys: ['['], label: '减小画笔大小' },
      { keys: [']'], label: '增大画笔大小' },
    ],
  },
  {
    title: '画布导航与对比',
    items: [
      { keys: ['按住 Space'], label: '临时切换抓手拖拽画布' },
      { keys: ['按住 \\'], label: '即时按住对比原图' },
      { keys: ['滚轮'], label: '围绕光标平滑缩放画布' },
      { keys: ['Ctrl / ⌘', 'V'], label: '直接粘贴剪贴板图片' },
    ],
  },
  {
    title: '修补历史与流程',
    items: [
      { keys: ['Ctrl / ⌘', 'Z'], label: '撤销上一步修补' },
      { keys: ['Ctrl / ⌘', 'Shift', 'Z'], label: '重做修补记录' },
      { keys: ['Esc'], label: '取消当前预设框或关闭弹窗' },
    ],
  },
];

/** 快捷键帮助弹窗 */
export function ShortcutHelpModal({ open, onClose }: ShortcutHelpModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-xs"
      style={{ backgroundColor: 'var(--bg-overlay)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="快捷键一览"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border"
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-default)',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3.5"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-lg"
              style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              <Keyboard className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">快捷键一览</h2>
              <p className="text-[11px] text-[var(--text-muted)]">
                专业修图键盘操作，显著提升精修与批量效率
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]"
            aria-label="关闭快捷键弹窗"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-2 text-[11px] font-medium tracking-wide text-[var(--text-muted)] uppercase">
                {group.title}
              </h3>
              <div
                className="divide-y rounded-lg border"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-panel-elevated)',
                }}
              >
                {group.items.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between px-3.5 py-2 text-xs"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <span className="text-[var(--text-secondary)]">{item.label}</span>
                    <div className="flex items-center gap-1">
                      {item.keys.map((key) => (
                        <kbd
                          key={key}
                          className="rounded border px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--text-primary)]"
                          style={{
                            backgroundColor: 'var(--bg-surface)',
                            borderColor: 'var(--border-default)',
                          }}
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
