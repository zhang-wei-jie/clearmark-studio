import { Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AiModelModal } from './components/AiModelModal';
import { BatchQueueDock } from './components/BatchQueueDock';
import { CanvasWorkspace } from './components/CanvasWorkspace';
import { Header } from './components/Header';
import { InspectorPanel } from './components/InspectorPanel';
import { ShortcutHelpModal } from './components/ShortcutHelpModal';
import { ToastContainer } from './components/ToastContainer';
import { Toolbar } from './components/Toolbar';
import { AppProvider, useAppStore } from './store/useAppStore';

/** 判断焦点是否位于可编辑表单元素中，避免拦截用户输入文字 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** 内部工作台外壳：统筹全局拖拽、剪贴板粘贴、键盘快捷键与弹窗 */
function WorkspaceShell() {
  const {
    state,
    activeImage,
    addImages,
    setTool,
    setBrushSize,
    setActivePresetBox,
    undoActive,
    redoActive,
  } = useAppStore();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);

  const [isGlobalDragging, setIsGlobalDragging] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [holdOriginal, setHoldOriginal] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const triggerFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // 切换图片时自动退出按住原图状态
  useEffect(() => {
    setHoldOriginal(false);
  }, [activeImage?.id]);

  // 全局文件拖拽导入监听（AI 模型弹窗开启时不抢占 .onnx 拖拽）
  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files'));

    const onDragEnter = (e: DragEvent) => {
      if (state.aiModelModalOpen || !hasFiles(e)) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      setIsGlobalDragging(true);
    };

    const onDragOver = (e: DragEvent) => {
      if (state.aiModelModalOpen || !hasFiles(e)) return;
      e.preventDefault();
    };

    const onDragLeave = (e: DragEvent) => {
      if (state.aiModelModalOpen) return;
      e.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) {
        setIsGlobalDragging(false);
      }
    };

    const onDrop = (e: DragEvent) => {
      if (state.aiModelModalOpen) return;
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsGlobalDragging(false);
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        void addImages(files, false);
      }
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [addImages, state.aiModelModalOpen]);

  // 全局剪贴板图片粘贴监听（Ctrl/Cmd + V）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target) || state.aiModelModalOpen) return;
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;

      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            const ext = file.type.split('/')[1] || 'png';
            const named =
              file.name && file.name !== 'image.png'
                ? file
                : new File([file], `剪贴板图片_${Date.now()}.${ext}`, { type: file.type });
            imageFiles.push(named);
          }
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        void addImages(imageFiles, true);
      }
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addImages, state.aiModelModalOpen]);

  // 全局专业修图快捷键监听
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;

      const metaOrCtrl = e.metaKey || e.ctrlKey;
      const lower = e.key.toLowerCase();

      // 撤销 / 重做
      if (metaOrCtrl && lower === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redoActive();
        } else {
          undoActive();
        }
        return;
      }

      if (metaOrCtrl && lower === 'y') {
        e.preventDefault();
        redoActive();
        return;
      }

      // 弹窗打开时不响应画布单键工具切换
      if (state.aiModelModalOpen || shortcutsOpen) return;
      if (metaOrCtrl || e.altKey) return;

      switch (lower) {
        case 'b':
          e.preventDefault();
          setTool('brush');
          break;
        case 'r':
          e.preventDefault();
          setTool('rect');
          break;
        case 'e':
          e.preventDefault();
          setTool('eraser');
          break;
        case 'p':
          e.preventDefault();
          setTool('preset-box');
          break;
        case 'h':
          e.preventDefault();
          setTool('hand');
          break;
        case '[':
          e.preventDefault();
          setBrushSize(state.brushSize - (state.brushSize > 40 ? 8 : 4));
          break;
        case ']':
          e.preventDefault();
          setBrushSize(state.brushSize + (state.brushSize >= 40 ? 8 : 4));
          break;
        case ' ':
          e.preventDefault();
          setSpacePressed(true);
          break;
        case '\\':
          if (activeImage?.processed) {
            e.preventDefault();
            setHoldOriginal(true);
          }
          break;
        case 'escape':
          if (activeImage?.activePresetBox) {
            e.preventDefault();
            setActivePresetBox(null);
          }
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        setSpacePressed(false);
      } else if (e.key === '\\') {
        setHoldOriginal(false);
      }
    };

    const onBlur = () => {
      setSpacePressed(false);
      setHoldOriginal(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [
    activeImage?.activePresetBox,
    activeImage?.processed,
    redoActive,
    setActivePresetBox,
    setBrushSize,
    setTool,
    shortcutsOpen,
    state.aiModelModalOpen,
    state.brushSize,
    undoActive,
  ]);

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-primary)' }}
    >
      {/* 全局共享隐藏多图文件选择器 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,image/avif"
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            void addImages(e.target.files, false);
          }
          e.target.value = '';
        }}
      />

      {/* 顶部导航与引擎切换栏 */}
      <Header onTriggerFilePicker={triggerFilePicker} />

      {/* 中部三栏工作台主体 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Toolbar onOpenShortcuts={() => setShortcutsOpen(true)} />

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <CanvasWorkspace
            spacePressed={spacePressed}
            holdOriginal={holdOriginal}
            onSetHoldOriginal={setHoldOriginal}
            onTriggerFilePicker={triggerFilePicker}
          />
          <BatchQueueDock onTriggerFilePicker={triggerFilePicker} />
        </div>

        <InspectorPanel />
      </div>

      {/* 模态框与全局提示 */}
      <AiModelModal />
      <ShortcutHelpModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <ToastContainer />

      {/* 全局文件拖放高亮覆盖层 */}
      {isGlobalDragging && (
        <div
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-8 backdrop-blur-xs"
          style={{ backgroundColor: 'var(--bg-overlay)' }}
        >
          <div
            className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-12 py-10 text-center"
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--accent)',
              boxShadow: 'var(--accent-glow)',
            }}
          >
            <div
              className="flex h-14 w-14 items-center justify-center rounded-2xl"
              style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              <Upload className="h-7 w-7" />
            </div>
            <div className="text-base font-semibold text-[var(--text-primary)]">
              松开鼠标即可导入图片至工作台
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              支持单张或多张 PNG / JPG / WebP 批量导入，纯浏览器本地处理
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** 净影去水印 · 应用根组件 */
export default function App() {
  return (
    <AppProvider>
      <WorkspaceShell />
    </AppProvider>
  );
}
