/**
 * 全局 Store 状态机、并发竞态护栏、历史栈与 Blob URL 回收单元测试
 *
 * 覆盖：
 * - 历史栈 20 步上限与淘汰 Blob URL 收集（computeNextHistory）
 * - 删图 / 清空 / 卸载全量释放 ObjectURL
 * - 多路径选区变更清除旧 matchedMarks（P0-4）
 * - 取消并立即重启任务不误关新任务进度与锁，取消瞬间 resolve 不卡死 processing（P1-1）
 * - 异步检测/抠笔画切图与清空队列防污染（P1-2）
 * - isDetecting / isRefiningMask 与去水印任务并发互斥锁
 * - 剪贴板返回值（P1-3）、导出防重入与混合队列 onlyProcessed ZIP 打包（P1-8）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CornerDetectionResult, ImageItem, InpaintOutput } from '../../types';
import { installBlobUrlTracker, type MockBlobUrlTracker } from '../../test/renderUtils';

const mocks = vi.hoisted(() => ({
  runFastInpaint: vi.fn(),
  runCornerAutoDetect: vi.fn(),
  runMaskStrokeRefine: vi.fn(),
  runMiganInpaint: vi.fn(),
  runLamaInpaint: vi.fn(),
  imageSourceToImageData: vi.fn(),
  imageDataToBlobUrl: vi.fn(),
  copyImageToClipboard: vi.fn(),
  downloadSingleImage: vi.fn(),
  exportBatchAsZip: vi.fn(),
  loadImageElement: vi.fn(),
}));

vi.mock('../../engines/fast', () => ({
  runFastInpaint: mocks.runFastInpaint,
  runCornerAutoDetect: mocks.runCornerAutoDetect,
  runMaskStrokeRefine: mocks.runMaskStrokeRefine,
}));

vi.mock('../../engines/migan', () => ({
  disposeMiganSession: vi.fn().mockResolvedValue(undefined),
  getMiganModelStatus: vi.fn(() => ({ state: 'idle', sizeBytes: 28_079_181 })),
  preloadMiganModel: vi.fn().mockResolvedValue({ state: 'ready', sizeBytes: 28_079_181 }),
  runMiganInpaint: mocks.runMiganInpaint,
  subscribeMiganStatus: vi.fn(() => () => undefined),
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
  runLamaInpaint: mocks.runLamaInpaint,
  subscribeLamaStatus: vi.fn(() => () => undefined),
}));

vi.mock('../../utils/export', () => ({
  copyImageToClipboard: mocks.copyImageToClipboard,
  downloadSingleImage: mocks.downloadSingleImage,
  exportBatchAsZip: mocks.exportBatchAsZip,
  imageDataToBlobUrl: mocks.imageDataToBlobUrl,
  imageSourceToImageData: mocks.imageSourceToImageData,
  loadImageElement: mocks.loadImageElement,
}));

import { MAX_HISTORY_ENTRIES, computeNextHistory } from '../history';
import { createAppStoreInstance } from '../storeCore';

function createFakeImageData(w = 16, h = 16): ImageData {
  return {
    width: w,
    height: h,
    data: new Uint8ClampedArray(new ArrayBuffer(w * h * 4)),
    colorSpace: 'srgb',
  } as ImageData;
}

function createSampleItem(overrides: Partial<ImageItem> = {}): ImageItem {
  const id = overrides.id ?? 'img-1';
  const originalUrl = overrides.originalUrl ?? `blob:orig-${id}`;
  return {
    id,
    name: overrides.name ?? `${id}.png`,
    originalUrl,
    width: overrides.width ?? 16,
    height: overrides.height ?? 16,
    mimeType: 'image/png',
    currentDataUrl: overrides.currentDataUrl ?? originalUrl,
    processed: overrides.processed ?? false,
    status: overrides.status ?? 'idle',
    maskBytes: overrides.maskBytes ?? null,
    matchedMarks: overrides.matchedMarks,
    activePresetBox: overrides.activePresetBox ?? null,
    history: overrides.history ?? [
      { id: `hist-0-${id}`, dataUrl: originalUrl, label: '原图', timestamp: 1 },
    ],
    historyIndex: overrides.historyIndex ?? 0,
  };
}

function createNonEmptyMask(w = 16, h = 16): Uint8Array {
  const mask = new Uint8Array(w * h);
  mask[0] = 255;
  mask[1] = 255;
  return mask;
}

function deferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AppStore 核心状态机与并发护栏', () => {
  let blobTracker: MockBlobUrlTracker;
  let blobOutSeq = 1;

  beforeEach(() => {
    blobTracker = installBlobUrlTracker();
    blobOutSeq = 1;
    vi.clearAllMocks();
    mocks.imageSourceToImageData.mockResolvedValue(createFakeImageData(16, 16));
    mocks.imageDataToBlobUrl.mockImplementation(async () => `blob:result-${blobOutSeq++}`);
  });

  afterEach(() => {
    blobTracker.restore();
    vi.restoreAllMocks();
  });

  it('computeNextHistory 应在超出 20 步时保留原图并准确收集淘汰的 Blob URL', () => {
    let item = createSampleItem({ id: 'hist-cap', originalUrl: 'blob:orig' });
    // 连续追加 21 个版本（总计 22 条，触发 2 次淘汰）
    const evictedAll: string[] = [];
    for (let i = 1; i <= MAX_HISTORY_ENTRIES + 1; i++) {
      const entry = {
        id: `h-${i}`,
        dataUrl: `blob:step-${i}`,
        label: `step-${i}`,
        timestamp: i,
      };
      const { nextHistory, evictedUrls } = computeNextHistory(item, entry);
      evictedAll.push(...evictedUrls);
      item = { ...item, history: nextHistory, historyIndex: nextHistory.length - 1 };
    }

    expect(item.history).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(item.history[0].dataUrl).toBe('blob:orig');
    expect(evictedAll).toContain('blob:step-1');
    expect(evictedAll).toContain('blob:step-2');
    expect(evictedAll).not.toContain('blob:orig');

    // 撤销两步后新增记录，应截断重做分支并回收被丢弃的节点 URL
    const undone = { ...item, historyIndex: item.history.length - 3 };
    const discardedUrlA = item.history[item.history.length - 2].dataUrl;
    const discardedUrlB = item.history[item.history.length - 1].dataUrl;
    const { evictedUrls } = computeNextHistory(undone, {
      id: 'h-branch',
      dataUrl: 'blob:branch',
      label: 'branch',
      timestamp: 999,
    });
    expect(evictedUrls).toEqual(expect.arrayContaining([discardedUrlA, discardedUrlB]));
  });

  it('removeImage、clearImages 与 dispose 应全量回收关联的 Blob ObjectURL', () => {
    const img1 = createSampleItem({
      id: 'a',
      originalUrl: 'blob:a-orig',
      currentDataUrl: 'blob:a-v1',
      history: [
        { id: 'h0', dataUrl: 'blob:a-orig', label: '原图', timestamp: 1 },
        { id: 'h1', dataUrl: 'blob:a-v1', label: '修复1', timestamp: 2 },
      ],
      historyIndex: 1,
    });
    const img2 = createSampleItem({
      id: 'b',
      originalUrl: 'blob:b-orig',
      currentDataUrl: 'blob:b-orig',
    });

    const store = createAppStoreInstance({
      initialState: { images: [img1, img2], activeImageId: 'a' },
    });

    store.actions.removeImage('a');
    expect(blobTracker.revokedUrls).toEqual(expect.arrayContaining(['blob:a-orig', 'blob:a-v1']));
    expect(store.getState().activeImageId).toBe('b');

    store.actions.clearImages();
    expect(blobTracker.revokedUrls).toContain('blob:b-orig');
    expect(store.getState().images).toHaveLength(0);
    store.dispose();
  });

  it('手动修改选区、提交预设框、外扩与批量套用预设均应清空旧 matchedMarks（P0-4）', () => {
    const fakeMarks = [
      {
        templateId: 'doubao' as const,
        brand: 'doubao' as const,
        label: '豆包AI生成',
        corner: 'bottom-right' as const,
        x: 2,
        y: 2,
        width: 6,
        height: 4,
        score: 0.95,
        polarity: 1 as const,
      },
    ];
    const img1 = createSampleItem({
      id: 'm1',
      maskBytes: createNonEmptyMask(),
      matchedMarks: fakeMarks,
      activePresetBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
    });
    const img2 = createSampleItem({
      id: 'm2',
      matchedMarks: fakeMarks,
    });

    const store = createAppStoreInstance({
      initialState: { images: [img1, img2], activeImageId: 'm1' },
    });

    // 1. 手动涂抹更新选区
    store.actions.updateActiveMask(createNonEmptyMask());
    expect(store.getState().images[0].matchedMarks).toBeUndefined();

    // 2. 提交预设框
    store.dispatch({
      type: 'UPDATE_IMAGE',
      id: 'm1',
      updater: (i) => ({ ...i, matchedMarks: fakeMarks }),
    });
    store.actions.commitActivePresetBoxToMask(false);
    expect(store.getState().images[0].matchedMarks).toBeUndefined();

    // 3. 选区外扩
    store.dispatch({
      type: 'UPDATE_IMAGE',
      id: 'm1',
      updater: (i) => ({ ...i, matchedMarks: fakeMarks }),
    });
    store.actions.dilateActiveMask(2);
    expect(store.getState().images[0].matchedMarks).toBeUndefined();

    // 4. 批量套用预设到全部图片
    const presetId = store.getState().presets[0].id;
    store.dispatch({
      type: 'UPDATE_ALL_IMAGES',
      updater: (i) => ({ ...i, matchedMarks: fakeMarks }),
    });
    store.actions.applyPresetToAll(presetId);
    expect(store.getState().images.every((i) => i.matchedMarks === undefined)).toBe(true);

    store.dispose();
  });

  it('取消旧任务并立即启动新任务时，旧任务迟到结束不得关闭新任务的 isProcessing 与进度（P1-1）', async () => {
    const taskA = deferred<InpaintOutput>();
    const taskB = deferred<InpaintOutput>();
    let callIdx = 0;

    mocks.runFastInpaint.mockImplementation(() => {
      callIdx += 1;
      return callIdx === 1 ? taskA.promise : taskB.promise;
    });

    const img = createSampleItem({ id: 'race-1', maskBytes: createNonEmptyMask() });
    const store = createAppStoreInstance({
      initialState: { images: [img], activeImageId: 'race-1' },
    });

    const pA = store.actions.processActiveImage();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().isProcessing).toBe(true);

    // 取消任务 A
    store.actions.cancelProcessing();
    expect(store.getState().isProcessing).toBe(false);
    expect(store.getState().images[0].status).toBe('idle');

    // 立刻启动任务 B
    const pB = store.actions.processActiveImage();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().isProcessing).toBe(true);

    // 旧任务 A 在取消后才 resolve：不能关闭任务 B 的处理锁，也不能写入脏结果
    taskA.resolve({
      imageData: createFakeImageData(),
      durationMs: 12,
      backend: 'fast-worker',
    });
    expect(await pA).toBe(false);
    expect(store.getState().isProcessing).toBe(true);
    expect(store.getState().images[0].processed).toBe(false);

    // 新任务 B 正常完成
    taskB.resolve({
      imageData: createFakeImageData(),
      durationMs: 25,
      backend: 'fast-worker',
    });
    expect(await pB).toBe(true);
    expect(store.getState().isProcessing).toBe(false);
    expect(store.getState().images[0].processed).toBe(true);
    expect(store.getState().images[0].status).toBe('done');

    store.dispose();
  });

  it('异步检测期间切图与清空队列应隔离过期结果，且忙碌期间拦截并发修复（P1-2 + 并发锁）', async () => {
    const detectDef = deferred<CornerDetectionResult>();
    mocks.runCornerAutoDetect.mockReturnValueOnce(detectDef.promise);

    const img1 = createSampleItem({ id: 'd1', maskBytes: createNonEmptyMask() });
    const img2 = createSampleItem({ id: 'd2' });
    const store = createAppStoreInstance({
      initialState: { images: [img1, img2], activeImageId: 'd1' },
    });

    const detectPromise = store.actions.autoDetectActive();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().isDetecting).toBe(true);

    // 检测进行中：单图修复与批量修复必须被互斥锁拦截
    expect(await store.actions.processActiveImage()).toBe(false);
    await store.actions.processBatchImages();
    expect(mocks.runFastInpaint).not.toHaveBeenCalled();

    // 用户在检测完成前切换到图 2
    store.actions.selectImage('d2');

    // 图 1 检测返回：不得覆盖当前激活图 2 的 lastDetectionResult
    detectDef.resolve({
      detected: true,
      corner: 'bottom-right',
      confidence: 0.96,
      mask: createNonEmptyMask(),
      message: '检出豆包水印',
    });
    await detectPromise;

    expect(store.getState().isDetecting).toBe(false);
    expect(store.getState().activeImageId).toBe('d2');
    expect(store.getState().lastDetectionResult).toBeNull();
    // 图 1 自身的选区仍被正确回写
    expect(store.getState().images.find((i) => i.id === 'd1')?.maskBytes).not.toBeNull();

    // 再次发起检测后立即清空队列，过期结果返回后不产生报错且不回写
    const detectDef2 = deferred<CornerDetectionResult>();
    mocks.runCornerAutoDetect.mockReturnValueOnce(detectDef2.promise);
    store.actions.selectImage('d1');
    const p2 = store.actions.autoDetectActive();
    await Promise.resolve();
    store.actions.clearImages();
    detectDef2.resolve({
      detected: true,
      corner: 'top-left',
      confidence: 0.9,
      mask: createNonEmptyMask(),
      message: '过期结果',
    });
    expect(await p2).toBeNull();
    expect(store.getState().images).toHaveLength(0);
    expect(store.getState().isDetecting).toBe(false);

    store.dispose();
  });

  it('copyActiveImage 应准确返回成功/失败布尔值，exportAllAsZip 应防重入并支持 onlyProcessed（P1-3 / P1-8）', async () => {
    const imgDone = createSampleItem({ id: 'e1', processed: true, status: 'done' });
    const imgIdle = createSampleItem({ id: 'e2', processed: false, status: 'idle' });
    const store = createAppStoreInstance({
      initialState: { images: [imgDone, imgIdle], activeImageId: 'e1' },
    });

    // 复制失败返回 false
    mocks.copyImageToClipboard.mockRejectedValueOnce(new Error('权限被拒绝'));
    expect(await store.actions.copyActiveImage()).toBe(false);

    // 复制成功返回 true
    mocks.copyImageToClipboard.mockResolvedValueOnce(undefined);
    expect(await store.actions.copyActiveImage()).toBe(true);

    // ZIP 导出防重入 + onlyProcessed 过滤
    const zipDef = deferred<{ filename: string; count: number }>();
    mocks.exportBatchAsZip.mockReturnValueOnce(zipDef.promise);

    const pZip1 = store.actions.exportAllAsZip(true);
    const pZip2 = store.actions.exportAllAsZip(false); // 重入调用应直接被忽略
    await pZip2;

    expect(mocks.exportBatchAsZip).toHaveBeenCalledTimes(1);
    const passedItems = mocks.exportBatchAsZip.mock.calls[0][0] as ImageItem[];
    expect(passedItems.map((i) => i.id)).toEqual(['e1']);

    zipDef.resolve({ filename: 'clearmark.zip', count: 1 });
    await pZip1;
    expect(store.getState().isExporting).toBe(false);

    store.dispose();
  });
});
