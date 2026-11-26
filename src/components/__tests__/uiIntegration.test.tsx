/**
 * 核心 UI 组件集成与细粒度渲染隔离测试
 *
 * 覆盖：
 * 1. Store 细粒度订阅隔离验证（pushToast / currentProgress 变化不引发无关组件重渲染）
 * 2. 空画布引导卡片拖拽图片仅导入 1 次（P0-1 回归）
 * 3. 忙碌期（isDetecting / isRefiningMask / isProcessing）按钮禁用与 Ctrl+Z / Ctrl+Y 快捷键拦截
 * 4. 顶栏剪贴板复制失败时不误显绿色「已复制」（P1-3 回归）
 * 5. 混合队列 ZIP 区分「仅打包已修复」与无障碍非嵌套按钮检查（P1-8 + ARIA）
 */

import { StrictMode, act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageItem } from '../../types';
import {
  cleanupViews,
  clickElement,
  dispatchEventAsync,
  installBlobUrlTracker,
  installMockCanvasContext,
  renderView,
  type MockBlobUrlTracker,
} from '../../test/renderUtils';

const uiMocks = vi.hoisted(() => ({
  copyImageToClipboard: vi.fn(),
  downloadSingleImage: vi.fn(),
  exportBatchAsZip: vi.fn(),
  imageDataToBlobUrl: vi.fn(),
  imageSourceToImageData: vi.fn(),
  loadImageElement: vi.fn(),
}));

vi.mock('../../utils/export', () => ({
  copyImageToClipboard: uiMocks.copyImageToClipboard,
  downloadSingleImage: uiMocks.downloadSingleImage,
  exportBatchAsZip: uiMocks.exportBatchAsZip,
  imageDataToBlobUrl: uiMocks.imageDataToBlobUrl,
  imageSourceToImageData: uiMocks.imageSourceToImageData,
  loadImageElement: uiMocks.loadImageElement,
}));

vi.mock('../../engines/lama', () => ({
  DEFAULT_LAMA_SOURCES: [],
  cancelLamaDownload: vi.fn(),
  checkWebGpuSupport: vi.fn().mockResolvedValue(false),
  clearLamaModelCache: vi.fn().mockResolvedValue({ state: 'unloaded' }),
  disposeLamaSession: vi.fn().mockResolvedValue(undefined),
  downloadLamaModel: vi.fn().mockResolvedValue({ state: 'cached' }),
  ensureLamaSessionLoaded: vi.fn().mockResolvedValue({ backend: 'wasm', inputSize: 512 }),
  getLamaModelStatus: vi.fn(() => ({ state: 'unloaded' })),
  importLocalLamaModel: vi.fn().mockResolvedValue({ state: 'cached' }),
  initLamaModelStatus: vi.fn().mockResolvedValue({ state: 'unloaded' }),
  runLamaInpaint: vi.fn(),
  subscribeLamaStatus: vi.fn(() => () => undefined),
}));

vi.mock('../../engines/migan', () => ({
  disposeMiganSession: vi.fn().mockResolvedValue(undefined),
  getMiganModelStatus: vi.fn(() => ({ state: 'idle', sizeBytes: 28_079_181 })),
  preloadMiganModel: vi.fn().mockResolvedValue({ state: 'ready', sizeBytes: 28_079_181 }),
  runMiganInpaint: vi.fn(),
  subscribeMiganStatus: vi.fn(() => () => undefined),
}));

import App from '../../App';
import { BatchQueueDock } from '../BatchQueueDock';
import { Header } from '../Header';
import {
  AppProvider,
  createAppStoreInstance,
  useCanvasToolState,
  useEngineModelState,
  useProgressState,
  useToasts,
} from '../../store/useAppStore';

function createUiSampleItem(overrides: Partial<ImageItem> = {}): ImageItem {
  const id = overrides.id ?? 'ui-img-1';
  const originalUrl = overrides.originalUrl ?? `blob:ui-orig-${id}`;
  return {
    id,
    name: overrides.name ?? `${id}.png`,
    originalUrl,
    width: 640,
    height: 480,
    mimeType: 'image/png',
    currentDataUrl: overrides.currentDataUrl ?? originalUrl,
    processed: overrides.processed ?? false,
    status: overrides.status ?? 'idle',
    maskBytes: overrides.maskBytes ?? null,
    activePresetBox: overrides.activePresetBox ?? null,
    history: overrides.history ?? [
      { id: `h0-${id}`, dataUrl: originalUrl, label: '原图', timestamp: 1 },
    ],
    historyIndex: overrides.historyIndex ?? 0,
  };
}

describe('UI 组件集成与细粒度渲染隔离', () => {
  let blobTracker: MockBlobUrlTracker;
  let restoreCanvasContext: () => void;

  beforeEach(() => {
    blobTracker = installBlobUrlTracker();
    restoreCanvasContext = installMockCanvasContext();
    vi.clearAllMocks();
    uiMocks.loadImageElement.mockResolvedValue({
      naturalWidth: 800,
      naturalHeight: 600,
      width: 800,
      height: 600,
    });
    uiMocks.exportBatchAsZip.mockResolvedValue({ filename: 'out.zip', count: 1 });
  });

  afterEach(() => {
    cleanupViews();
    restoreCanvasContext();
    blobTracker.restore();
    vi.restoreAllMocks();
  });

  it('细粒度领域 Hook 应彻底隔离 Toast 与进度刷新引起的跨领域重渲染', () => {
    const store = createAppStoreInstance();
    const counts = { toast: 0, tool: 0, engine: 0, progress: 0 };

    function ToastConsumer() {
      counts.toast += 1;
      const toasts = useToasts();
      return <span data-testid="toast-count">{toasts.length}</span>;
    }

    function ToolConsumer() {
      counts.tool += 1;
      const { tool, brushSize } = useCanvasToolState();
      return (
        <span data-testid="tool-state">
          {tool}-{brushSize}
        </span>
      );
    }

    function EngineConsumer() {
      counts.engine += 1;
      const { engine } = useEngineModelState();
      return <span data-testid="engine-state">{engine}</span>;
    }

    function ProgressConsumer() {
      counts.progress += 1;
      const { currentProgress } = useProgressState();
      return <span data-testid="progress-state">{currentProgress?.percent ?? 0}</span>;
    }

    renderView(
      <AppProvider store={store}>
        <ToastConsumer />
        <ToolConsumer />
        <EngineConsumer />
        <ProgressConsumer />
      </AppProvider>,
    );

    const baseline = { ...counts };

    // 1. 推送 Toast：仅 ToastConsumer 重渲染，其余 3 个领域消费者保持零重渲染
    act(() => {
      store.actions.pushToast('info', '仅通知 Toast', 0);
    });
    expect(counts.toast).toBe(baseline.toast + 1);
    expect(counts.tool).toBe(baseline.tool);
    expect(counts.engine).toBe(baseline.engine);
    expect(counts.progress).toBe(baseline.progress);

    // 2. 高频刷新处理进度：仅 ProgressConsumer 重渲染
    act(() => {
      store.dispatch({
        type: 'SET_PROCESSING',
        isProcessing: true,
        progress: { stage: '修复中', percent: 45 },
      });
    });
    expect(counts.progress).toBe(baseline.progress + 1);
    expect(counts.toast).toBe(baseline.toast + 1);
    expect(counts.tool).toBe(baseline.tool);
    expect(counts.engine).toBe(baseline.engine);

    // 3. 调整画笔大小：仅 ToolConsumer 重渲染
    act(() => {
      store.actions.setBrushSize(64);
    });
    expect(counts.tool).toBe(baseline.tool + 1);
    expect(counts.engine).toBe(baseline.engine);
    expect(counts.progress).toBe(baseline.progress + 1);
  });

  it('空画布引导区拖拽单个图片文件冒泡至 window 时，仅触发 1 次导入（P0-1）', async () => {
    const view = renderView(<App />);
    const guideHeading = Array.from(view.container.querySelectorAll('h2')).find((el) =>
      el.textContent?.includes('拖拽图片至此处'),
    );
    expect(guideHeading).toBeDefined();

    const file = new File([new Uint8Array([137, 80, 78, 71])], 'sample.png', {
      type: 'image/png',
    });
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { files: [file], types: ['Files'] },
    });

    await dispatchEventAsync(guideHeading!, dropEvent);

    // loadImageElement 仅被调用 1 次，且队列中仅展示 1 张图片
    expect(uiMocks.loadImageElement).toHaveBeenCalledTimes(1);
    const queueHeader = view.container.querySelector('section[aria-label="多图批量队列"]');
    expect(queueHeader?.textContent).toContain('sample.png');
    expect(queueHeader?.querySelectorAll('img')).toHaveLength(1);
  });

  it('isDetecting / isRefiningMask 期间应禁用撤销/选区工具按钮并拦截 Ctrl+Z/Y 快捷键', async () => {
    const mask = new Uint8Array(640 * 480);
    mask[0] = 255;
    const imgWithHistory = createUiSampleItem({
      id: 'hist-ui',
      processed: true,
      status: 'done',
      maskBytes: mask,
      currentDataUrl: 'blob:v1',
      history: [
        { id: 'h0', dataUrl: 'blob:ui-orig-hist-ui', label: '原图', timestamp: 1 },
        { id: 'h1', dataUrl: 'blob:v1', label: '修复1', timestamp: 2 },
      ],
      historyIndex: 1,
    });

    const store = createAppStoreInstance({
      initialState: {
        images: [imgWithHistory],
        activeImageId: 'hist-ui',
        isDetecting: true,
      },
    });

    const view = renderView(<App store={store} />);

    const undoBtn = view.container.querySelector(
      'aside[aria-label="修图工具栏"] button[aria-label="撤销"]',
    ) as HTMLButtonElement;
    const dilateBtn = view.container.querySelector(
      'aside[aria-label="修图工具栏"] button[aria-label="选区外扩 4px"]',
    ) as HTMLButtonElement;
    const clearBtn = view.container.querySelector(
      'aside[aria-label="修图工具栏"] button[aria-label="清空选区"]',
    ) as HTMLButtonElement;

    expect(undoBtn.disabled).toBe(true);
    expect(dilateBtn.disabled).toBe(true);
    expect(clearBtn.disabled).toBe(true);

    // 检测期间按 Ctrl+Z 不得触发撤销
    await dispatchEventAsync(
      window,
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(store.getState().images[0].historyIndex).toBe(1);

    // 切换为 isRefiningMask 时同样保持禁用且拦截 Ctrl+Z
    act(() => {
      store.dispatch({ type: 'SET_IS_DETECTING', value: false });
      store.dispatch({ type: 'SET_IS_REFINING_MASK', value: true });
    });
    expect(undoBtn.disabled).toBe(true);
    expect(dilateBtn.disabled).toBe(true);
    await dispatchEventAsync(
      window,
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(store.getState().images[0].historyIndex).toBe(1);

    // 全部空闲后按钮解锁，且 Ctrl+Z / Ctrl+Y 恢复生效
    act(() => {
      store.dispatch({ type: 'SET_IS_REFINING_MASK', value: false });
    });
    expect(undoBtn.disabled).toBe(false);
    expect(dilateBtn.disabled).toBe(false);
    expect(clearBtn.disabled).toBe(false);

    await dispatchEventAsync(
      window,
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(store.getState().images[0].historyIndex).toBe(0);

    await dispatchEventAsync(
      window,
      new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(store.getState().images[0].historyIndex).toBe(1);
  });

  it('顶栏复制剪贴板失败时不得误显示绿色「已复制」，成功时才切换状态（P1-3）', async () => {
    const img = createUiSampleItem({ id: 'copy-1' });
    const store = createAppStoreInstance({
      initialState: { images: [img], activeImageId: 'copy-1' },
    });

    const view = renderView(
      <AppProvider store={store}>
        <Header onTriggerFilePicker={() => undefined} />
      </AppProvider>,
    );

    const copyBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.getAttribute('title')?.includes('复制到剪贴板'),
    )!;
    expect(copyBtn).toBeDefined();

    // 失败场景
    uiMocks.copyImageToClipboard.mockRejectedValueOnce(new Error('clipboard denied'));
    await clickElement(copyBtn);
    expect(copyBtn.textContent).toContain('复制');
    expect(copyBtn.textContent).not.toContain('已复制');

    // 成功场景
    uiMocks.copyImageToClipboard.mockResolvedValueOnce(undefined);
    await clickElement(copyBtn);
    expect(copyBtn.textContent).toContain('已复制');
  });

  it('BatchQueueDock 在混合队列时默认仅打包已修复图，且满足 ARIA 非嵌套交互元素规范（P1-8）', async () => {
    const imgDone = createUiSampleItem({
      id: 'q1',
      name: 'done.png',
      processed: true,
      status: 'done',
    });
    const imgIdle = createUiSampleItem({
      id: 'q2',
      name: 'raw.png',
      processed: false,
      status: 'idle',
    });
    const store = createAppStoreInstance({
      initialState: { images: [imgDone, imgIdle], activeImageId: 'q1' },
    });

    const view = renderView(
      <AppProvider store={store}>
        <BatchQueueDock onTriggerFilePicker={() => undefined} />
      </AppProvider>,
    );

    // ARIA 嵌套检查：禁止 button 内嵌套 button 或 role="button" 内嵌套 button
    expect(view.container.querySelectorAll('button button')).toHaveLength(0);
    expect(view.container.querySelectorAll('[role="button"] button')).toHaveLength(0);

    const zipBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('打包已修复 ZIP (1)'),
    );
    expect(zipBtn).toBeDefined();

    await clickElement(zipBtn!);
    expect(uiMocks.exportBatchAsZip).toHaveBeenCalledTimes(1);
    const exportedList = uiMocks.exportBatchAsZip.mock.calls[0][0] as ImageItem[];
    expect(exportedList.map((i) => i.id)).toEqual(['q1']);
  });

  it('StrictMode 下传入外部预置图片的 store 挂载并卸载时，AppProvider 不得越权吊销其 Blob URL（NEW-P1-1）', () => {
    const externalImg = createUiSampleItem({
      id: 'ext-1',
      originalUrl: 'blob:external-keep-alive',
      currentDataUrl: 'blob:external-keep-alive',
    });
    const externalStore = createAppStoreInstance({
      initialState: { images: [externalImg], activeImageId: 'ext-1' },
    });

    const view = renderView(
      <StrictMode>
        <AppProvider store={externalStore}>
          <Header onTriggerFilePicker={() => undefined} />
        </AppProvider>
      </StrictMode>,
    );

    // StrictMode 双重挂载与随后卸载均不得调用 URL.revokeObjectURL 销毁外部 Store 的图片 URL
    expect(blobTracker.revokedUrls).not.toContain('blob:external-keep-alive');
    view.unmount();
    expect(blobTracker.revokedUrls).not.toContain('blob:external-keep-alive');

    // 显式调用外部 Store 自己的 dispose() 时才真正回收资源
    externalStore.dispose();
    expect(blobTracker.revokedUrls).toContain('blob:external-keep-alive');
  });
});
