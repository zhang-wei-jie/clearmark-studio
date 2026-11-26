/**
 * 图片队列管理与单图历史栈（撤销 / 重做 / 重置）领域 Actions
 */

import { DEMO_SAMPLES, loadAllDemoSamples, loadDemoSample } from '../../data/demoSamples';
import type { ImageItem } from '../../types';
import { loadImageElement } from '../../utils/export';
import {
  ACCEPTED_IMAGE_EXT,
  createId,
  extractErrorMessage,
  revokeIfBlobUrl,
  revokeItemBlobUrls,
} from '../history';
import type { StoreActionContext } from '../types';

export interface ImageQueueActions {
  addImages: (
    files: FileList | File[],
    activateFirst?: boolean,
    options?: { silentToast?: boolean },
  ) => Promise<number>;
  loadDemoSampleById: (id: string) => Promise<void>;
  loadAllDemos: () => Promise<void>;
  selectImage: (id: string) => void;
  removeImage: (id: string) => void;
  clearImages: () => void;
  jumpToHistory: (index: number) => void;
  undoActive: () => void;
  redoActive: () => void;
  resetActiveToOriginal: () => void;
}

export function createImageQueueActions(ctx: StoreActionContext): ImageQueueActions {
  const { getState, dispatch, refs, getActiveImage, pushToast } = ctx;

  const addImages = async (
    fileInput: FileList | File[],
    activateFirst = false,
    options?: { silentToast?: boolean },
  ): Promise<number> => {
    const rawFiles = Array.from(fileInput);
    if (rawFiles.length === 0) {
      return 0;
    }

    const validFiles = rawFiles.filter(
      (file) => file.type.startsWith('image/') || ACCEPTED_IMAGE_EXT.test(file.name),
    );
    const skippedCount = rawFiles.length - validFiles.length;
    if (validFiles.length === 0) {
      pushToast('warning', '未识别到有效图片文件，请选择 PNG、JPG、WebP、BMP、GIF 或 AVIF 格式');
      return 0;
    }

    const createdItems: ImageItem[] = [];
    let failedDecode = 0;

    for (const file of validFiles) {
      const objectUrl = URL.createObjectURL(file);
      try {
        const img = await loadImageElement(objectUrl);
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        if (width <= 0 || height <= 0) {
          throw new Error('图片尺寸无效');
        }

        const now = Date.now();
        const item: ImageItem = {
          id: createId('img'),
          name: file.name || `粘贴图片_${now}.png`,
          originalUrl: objectUrl,
          width,
          height,
          mimeType: file.type || 'image/png',
          currentDataUrl: objectUrl,
          processed: false,
          status: 'idle',
          maskBytes: null,
          activePresetBox: null,
          history: [
            {
              id: createId('hist'),
              dataUrl: objectUrl,
              label: '原图',
              timestamp: now,
            },
          ],
          historyIndex: 0,
        };
        createdItems.push(item);
      } catch {
        revokeIfBlobUrl(objectUrl);
        failedDecode++;
      }
    }

    if (createdItems.length > 0) {
      const shouldActivate = activateFirst || !getState().activeImageId;
      dispatch({
        type: 'ADD_IMAGES',
        items: createdItems,
        activateId: shouldActivate ? createdItems[0].id : undefined,
      });

      if (!options?.silentToast) {
        const suffixParts: string[] = [];
        if (skippedCount > 0) suffixParts.push(`跳过 ${skippedCount} 个非图片文件`);
        if (failedDecode > 0) suffixParts.push(`${failedDecode} 张解码失败`);
        const extra = suffixParts.length > 0 ? `（${suffixParts.join('，')}）` : '';
        pushToast('success', `已导入 ${createdItems.length} 张图片${extra}`);
      }
    } else {
      pushToast('error', '所选图片均无法解码，请检查文件是否损坏');
    }

    return createdItems.length;
  };

  const loadDemoSampleById = async (id: string) => {
    try {
      const file = await loadDemoSample(id);
      const added = await addImages([file], true, { silentToast: true });
      if (added > 0) {
        const meta = DEMO_SAMPLES.find((s) => s.id === id);
        pushToast(
          'success',
          meta ? `已载入「${meta.title}」，可套用平台预设或一键检测` : '已载入内置演示样图',
        );
      }
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '加载演示样图失败'));
    }
  };

  const loadAllDemos = async () => {
    try {
      const files = await loadAllDemoSamples();
      const added = await addImages(files, true, { silentToast: true });
      if (added > 0) {
        pushToast('success', '已载入全部 3 张演示样图，可体验批量检测与批量去水印');
      }
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '批量加载演示样图失败'));
    }
  };

  const selectImage = (id: string) => {
    dispatch({ type: 'SELECT_IMAGE', id });
  };

  const removeImage = (id: string) => {
    const target = getState().images.find((item) => item.id === id);
    if (target) {
      revokeItemBlobUrls(target);
    }
    dispatch({ type: 'REMOVE_IMAGE', id });
  };

  const clearImages = () => {
    // 清空队列时递增代际令牌并中止在途去水印，防止异步任务回写脏数据
    refs.detectTaskGen += 1;
    refs.refineTaskGen += 1;
    refs.processingAbort?.abort();
    refs.processingAbort = null;
    for (const item of getState().images) {
      revokeItemBlobUrls(item);
    }
    dispatch({ type: 'CLEAR_IMAGES' });
    dispatch({ type: 'SET_IS_DETECTING', value: false });
    dispatch({ type: 'SET_IS_REFINING_MASK', value: false });
    dispatch({ type: 'SET_PROCESSING', isProcessing: false, progress: null });
    pushToast('info', '已清空图片队列');
  };

  const jumpToHistory = (index: number) => {
    const active = getActiveImage();
    if (!active) return;
    if (index < 0 || index >= active.history.length || index === active.historyIndex) {
      return;
    }

    const entry = active.history[index];
    dispatch({
      type: 'UPDATE_IMAGE',
      id: active.id,
      updater: (item) => ({
        ...item,
        currentDataUrl: entry.dataUrl,
        historyIndex: index,
        processed: index > 0,
        status: index > 0 ? 'done' : 'idle',
        error: undefined,
        lastDurationMs: entry.durationMs,
        lastBackend: entry.backend,
      }),
    });
    if (index === 0) {
      dispatch({ type: 'SET_COMPARE_MODE', mode: 'off' });
    }
  };

  const undoActive = () => {
    const active = getActiveImage();
    if (!active || active.historyIndex <= 0) return;
    jumpToHistory(active.historyIndex - 1);
  };

  const redoActive = () => {
    const active = getActiveImage();
    if (!active || active.historyIndex >= active.history.length - 1) return;
    jumpToHistory(active.historyIndex + 1);
  };

  const resetActiveToOriginal = () => {
    const active = getActiveImage();
    if (!active || active.historyIndex === 0) return;
    jumpToHistory(0);
    pushToast('info', '已恢复为原始图片');
  };

  return {
    addImages,
    loadDemoSampleById,
    loadAllDemos,
    selectImage,
    removeImage,
    clearImages,
    jumpToHistory,
    undoActive,
    redoActive,
    resetActiveToOriginal,
  };
}
