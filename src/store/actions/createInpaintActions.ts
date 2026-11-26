/**
 * 引擎选择、单图/批量去水印执行与取消控制领域 Actions
 */

import { runFastInpaint } from '../../engines/fast';
import { runLamaInpaint } from '../../engines/lama';
import { runMiganInpaint } from '../../engines/migan';
import type {
  EngineType,
  FastQuality,
  HistoryEntry,
  ImageItem,
  InpaintOutput,
  InpaintProgress,
} from '../../types';
import { imageDataToBlobUrl, imageSourceToImageData } from '../../utils/export';
import {
  appendHistoryEntry,
  computeNextHistory,
  createId,
  extractErrorMessage,
  isAbortError,
  resolveEffectiveMask,
  revokeIfBlobUrl,
  scheduleRevokeUrls,
} from '../history';
import type { StoreActionContext } from '../types';

export interface InpaintActions {
  setEngine: (engine: EngineType) => void;
  setFastQuality: (quality: FastQuality) => void;
  setAiModelModalOpen: (open: boolean) => void;
  processActiveImage: () => Promise<boolean>;
  processBatchImages: (targetIds?: string[]) => Promise<void>;
  cancelProcessing: () => void;
}

export function createInpaintActions(ctx: StoreActionContext): InpaintActions {
  const { getState, dispatch, refs, getActiveImage, pushToast } = ctx;

  const setEngine = (engine: EngineType) => {
    dispatch({ type: 'SET_ENGINE', engine });
  };

  const setFastQuality = (quality: FastQuality) => {
    dispatch({ type: 'SET_FAST_QUALITY', quality });
  };

  const setAiModelModalOpen = (open: boolean) => {
    dispatch({ type: 'SET_AI_MODEL_MODAL_OPEN', open });
  };

  /** 内部统一调用锁定引擎执行单图修补 */
  const executeInpaintForItem = async (
    item: ImageItem,
    mask: Uint8Array,
    engine: EngineType,
    signal: AbortSignal,
    onProgress: (progress: InpaintProgress) => void,
  ): Promise<InpaintOutput> => {
    const { fastQuality, featherPx } = getState();
    const imageData = await imageSourceToImageData(item.currentDataUrl);

    if (engine === 'migan') {
      return runMiganInpaint(
        { imageData, mask, featherPx, matchedMarks: item.matchedMarks },
        { onProgress, signal },
      );
    }

    if (engine === 'lama') {
      return runLamaInpaint(
        { imageData, mask, featherPx, matchedMarks: item.matchedMarks },
        { onProgress, signal },
      );
    }

    return runFastInpaint(
      { imageData, mask, quality: fastQuality, featherPx, matchedMarks: item.matchedMarks },
      { onProgress, signal },
    );
  };

  /** 在启动 LaMa 引擎前验证模型是否已缓存或加载，避免静默回退 */
  const ensureLamaReadyBeforeRun = (): boolean => {
    const { engine, lamaStatus } = getState();
    if (engine !== 'lama') {
      return true;
    }
    if (lamaStatus.state === 'ready' || lamaStatus.state === 'cached') {
      return true;
    }
    if (lamaStatus.state === 'downloading' || lamaStatus.state === 'loading') {
      pushToast('info', 'AI 模型正在下载或加载中，请稍候完成');
      dispatch({ type: 'SET_AI_MODEL_MODAL_OPEN', open: true });
      return false;
    }
    pushToast('warning', '请先在 AI 模型管理中下载或导入 LaMa ONNX 模型后再使用高阶 AI（LaMa）');
    dispatch({ type: 'SET_AI_MODEL_MODAL_OPEN', open: true });
    return false;
  };

  const cancelProcessing = () => {
    if (!refs.processingAbort) {
      return;
    }
    refs.processingAbort.abort();
    refs.processingAbort = null;
    dispatch({
      type: 'UPDATE_ALL_IMAGES',
      updater: (item) =>
        item.status === 'processing' ? { ...item, status: item.processed ? 'done' : 'idle' } : item,
    });
    dispatch({ type: 'SET_PROCESSING', isProcessing: false, progress: null });
    dispatch({
      type: 'SET_BATCH_PROGRESS',
      progress: { ...getState().batchProgress, running: false },
    });
    pushToast('info', '已取消当前去水印任务');
  };

  const processActiveImage = async (): Promise<boolean> => {
    const cur = getState();
    if (cur.isProcessing || cur.isDetecting || cur.isRefiningMask) {
      return false;
    }
    const active = getActiveImage();
    if (!active) {
      pushToast('warning', '请先导入需要处理的图片');
      return false;
    }

    const effectiveMask = resolveEffectiveMask(active);
    if (!effectiveMask) {
      pushToast('warning', '请先涂抹水印区域、套用平台预设或点击一键自动检测');
      return false;
    }

    if (!ensureLamaReadyBeforeRun()) {
      return false;
    }

    const controller = new AbortController();
    refs.processingAbort = controller;

    dispatch({
      type: 'SET_PROCESSING',
      isProcessing: true,
      progress: { stage: '正在准备图像数据...', percent: 2 },
    });
    dispatch({
      type: 'UPDATE_IMAGE',
      id: active.id,
      updater: (item) => ({ ...item, status: 'processing', error: undefined }),
    });

    try {
      const usedEngine = getState().engine;
      const output = await executeInpaintForItem(
        active,
        effectiveMask,
        usedEngine,
        controller.signal,
        (progress) => {
          if (refs.processingAbort === controller) {
            dispatch({ type: 'SET_PROCESSING', isProcessing: true, progress });
          }
        },
      );

      if (controller.signal.aborted) {
        dispatch({
          type: 'UPDATE_IMAGE',
          id: active.id,
          updater: (item) => ({ ...item, status: item.processed ? 'done' : 'idle' }),
        });
        return false;
      }

      const nextDataUrl = await imageDataToBlobUrl(output.imageData, 'image/png');
      const latestItem = getState().images.find((img) => img.id === active.id);
      if (controller.signal.aborted || !latestItem) {
        revokeIfBlobUrl(nextDataUrl);
        if (latestItem) {
          dispatch({
            type: 'UPDATE_IMAGE',
            id: active.id,
            updater: (item) => ({ ...item, status: item.processed ? 'done' : 'idle' }),
          });
        }
        return false;
      }

      const entry: HistoryEntry = {
        id: createId('hist'),
        dataUrl: nextDataUrl,
        label:
          usedEngine === 'migan'
            ? 'AI 精修 (MI-GAN)'
            : usedEngine === 'lama'
              ? '高阶 AI 修复 (LaMa)'
              : '快速无痕修复',
        timestamp: Date.now(),
        engine: usedEngine,
        durationMs: output.durationMs,
        backend: output.backend,
      };

      const { evictedUrls } = computeNextHistory(latestItem, entry);
      dispatch({
        type: 'UPDATE_IMAGE',
        id: active.id,
        updater: (item) => appendHistoryEntry(item, entry),
      });
      scheduleRevokeUrls(evictedUrls);

      const ms = Math.max(1, Math.round(output.durationMs));
      pushToast('success', `去水印完成（耗时 ${ms} ms · ${output.backend}）`);
      return true;
    } catch (err) {
      if (isAbortError(err)) {
        dispatch({
          type: 'UPDATE_IMAGE',
          id: active.id,
          updater: (item) => ({
            ...item,
            status: item.processed ? 'done' : 'idle',
          }),
        });
        return false;
      }

      const msg = extractErrorMessage(err, '去水印处理失败');
      dispatch({
        type: 'UPDATE_IMAGE',
        id: active.id,
        updater: (item) => ({ ...item, status: 'error', error: msg }),
      });
      pushToast('error', msg, 5000);
      return false;
    } finally {
      // 仅当当前任务仍为活跃控制器时才关闭处理态，避免旧任务取消后误关新任务的进度与锁
      if (refs.processingAbort === controller) {
        refs.processingAbort = null;
        dispatch({ type: 'SET_PROCESSING', isProcessing: false, progress: null });
      }
    }
  };

  const processBatchImages = async (targetIds?: string[]) => {
    const cur = getState();
    if (cur.isProcessing || cur.isDetecting || cur.isRefiningMask) {
      return;
    }
    const pool = targetIds ? cur.images.filter((img) => targetIds.includes(img.id)) : cur.images;

    if (pool.length === 0) {
      pushToast('warning', '当前图片队列为空');
      return;
    }

    const runnable = pool
      .map((item) => ({ item, mask: resolveEffectiveMask(item) }))
      .filter((entry): entry is { item: ImageItem; mask: Uint8Array } => entry.mask !== null);

    if (runnable.length === 0) {
      pushToast('warning', '队列中暂无已标记水印区域的图片，请先批量套用预设或运行全部自动检测');
      return;
    }

    if (!ensureLamaReadyBeforeRun()) {
      return;
    }

    const controller = new AbortController();
    refs.processingAbort = controller;
    const usedEngine = getState().engine;

    let completed = 0;
    let failed = 0;
    const total = runnable.length;
    const skipped = pool.length - runnable.length;

    dispatch({
      type: 'SET_PROCESSING',
      isProcessing: true,
      progress: { stage: `准备批量处理 ${total} 张图片...`, percent: 0 },
    });
    dispatch({
      type: 'SET_BATCH_PROGRESS',
      progress: {
        running: true,
        total,
        completed: 0,
        failed: 0,
        currentImageId: runnable[0].item.id,
        currentPercent: 0,
      },
    });

    try {
      for (let i = 0; i < runnable.length; i++) {
        if (controller.signal.aborted) {
          break;
        }

        const { item, mask } = runnable[i];
        const latestItem = getState().images.find((img) => img.id === item.id);
        if (!latestItem) {
          continue;
        }

        dispatch({
          type: 'UPDATE_IMAGE',
          id: latestItem.id,
          updater: (prev) => ({ ...prev, status: 'processing', error: undefined }),
        });
        dispatch({
          type: 'SET_BATCH_PROGRESS',
          progress: {
            running: true,
            total,
            completed,
            failed,
            currentImageId: latestItem.id,
            currentPercent: 0,
          },
        });

        try {
          const output = await executeInpaintForItem(
            latestItem,
            mask,
            usedEngine,
            controller.signal,
            (progress) => {
              if (refs.processingAbort !== controller) return;
              dispatch({
                type: 'SET_PROCESSING',
                isProcessing: true,
                progress: {
                  stage: `[${i + 1}/${total}] ${latestItem.name} · ${progress.stage}`,
                  percent: progress.percent,
                },
              });
              dispatch({
                type: 'SET_BATCH_PROGRESS',
                progress: {
                  running: true,
                  total,
                  completed,
                  failed,
                  currentImageId: latestItem.id,
                  currentPercent: progress.percent,
                },
              });
            },
          );

          if (controller.signal.aborted) {
            dispatch({
              type: 'UPDATE_IMAGE',
              id: latestItem.id,
              updater: (prev) => ({ ...prev, status: prev.processed ? 'done' : 'idle' }),
            });
            break;
          }

          const nextDataUrl = await imageDataToBlobUrl(output.imageData, 'image/png');
          const freshItem = getState().images.find((img) => img.id === latestItem.id);
          if (controller.signal.aborted || !freshItem) {
            revokeIfBlobUrl(nextDataUrl);
            if (freshItem) {
              dispatch({
                type: 'UPDATE_IMAGE',
                id: latestItem.id,
                updater: (prev) => ({ ...prev, status: prev.processed ? 'done' : 'idle' }),
              });
            }
            if (controller.signal.aborted) break;
            continue;
          }

          const entry: HistoryEntry = {
            id: createId('hist'),
            dataUrl: nextDataUrl,
            label:
              usedEngine === 'migan'
                ? '批量 AI 精修 (MI-GAN)'
                : usedEngine === 'lama'
                  ? '批量高阶 AI 修复 (LaMa)'
                  : '批量快速修复',
            timestamp: Date.now(),
            engine: usedEngine,
            durationMs: output.durationMs,
            backend: output.backend,
          };

          const { evictedUrls } = computeNextHistory(freshItem, entry);
          dispatch({
            type: 'UPDATE_IMAGE',
            id: latestItem.id,
            updater: (prev) => appendHistoryEntry(prev, entry),
          });
          scheduleRevokeUrls(evictedUrls);
          completed++;
        } catch (err) {
          if (isAbortError(err)) {
            dispatch({
              type: 'UPDATE_IMAGE',
              id: latestItem.id,
              updater: (prev) => ({
                ...prev,
                status: prev.processed ? 'done' : 'idle',
              }),
            });
            break;
          }

          failed++;
          const msg = extractErrorMessage(err, '处理失败');
          dispatch({
            type: 'UPDATE_IMAGE',
            id: latestItem.id,
            updater: (prev) => ({ ...prev, status: 'error', error: msg }),
          });
        }

        if (refs.processingAbort === controller) {
          dispatch({
            type: 'SET_BATCH_PROGRESS',
            progress: {
              running: true,
              total,
              completed,
              failed,
              currentImageId: latestItem.id,
              currentPercent: 100,
            },
          });
        }
      }

      if (!controller.signal.aborted) {
        const skippedText = skipped > 0 ? `，跳过 ${skipped} 张无选区图` : '';
        if (failed === 0) {
          pushToast('success', `批量去水印完成：成功 ${completed} 张${skippedText}`);
        } else {
          pushToast(
            'warning',
            `批量处理结束：成功 ${completed} 张，失败 ${failed} 张${skippedText}`,
            5000,
          );
        }
      }
    } finally {
      if (refs.processingAbort === controller) {
        refs.processingAbort = null;
        dispatch({ type: 'SET_PROCESSING', isProcessing: false, progress: null });
        dispatch({
          type: 'SET_BATCH_PROGRESS',
          progress: {
            running: false,
            total,
            completed,
            failed,
            currentImageId: undefined,
            currentPercent: 100,
          },
        });
      }
    }
  };

  return {
    setEngine,
    setFastQuality,
    setAiModelModalOpen,
    processActiveImage,
    processBatchImages,
    cancelProcessing,
  };
}
