/**
 * 导出配置、单图导出、剪贴板复制与批量 ZIP 打包领域 Actions
 */

import type { ExportConfig } from '../../types';
import { copyImageToClipboard, downloadSingleImage, exportBatchAsZip } from '../../utils/export';
import { extractErrorMessage, isAbortError } from '../history';
import type { StoreActionContext } from '../types';

export interface ExportActions {
  setExportConfig: (patch: Partial<ExportConfig>) => void;
  exportActiveImage: () => Promise<void>;
  copyActiveImage: () => Promise<boolean>;
  exportAllAsZip: (onlyProcessed?: boolean) => Promise<void>;
}

export function createExportActions(ctx: StoreActionContext): ExportActions {
  const { getState, dispatch, getActiveImage, pushToast } = ctx;

  const setExportConfig = (patch: Partial<ExportConfig>) => {
    dispatch({ type: 'PATCH_EXPORT_CONFIG', patch });
  };

  const exportActiveImage = async () => {
    if (getState().isExporting) {
      return;
    }
    const active = getActiveImage();
    if (!active) {
      pushToast('warning', '当前没有可导出的图片');
      return;
    }
    dispatch({ type: 'SET_EXPORTING', isExporting: true });
    try {
      const filename = await downloadSingleImage(active, getState().exportConfig);
      pushToast('success', `已原分辨率导出：${filename}`);
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '图片导出失败'));
    } finally {
      dispatch({ type: 'SET_EXPORTING', isExporting: false });
    }
  };

  const copyActiveImage = async (): Promise<boolean> => {
    const active = getActiveImage();
    if (!active) {
      pushToast('warning', '当前没有可复制的图片');
      return false;
    }
    try {
      await copyImageToClipboard(active.currentDataUrl);
      pushToast('success', '已复制当前图片到剪贴板');
      return true;
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '复制到剪贴板失败'), 4500);
      return false;
    }
  };

  const exportAllAsZip = async (onlyProcessed = false) => {
    if (getState().isExporting) {
      return;
    }
    const { images, exportConfig } = getState();
    const candidates = onlyProcessed ? images.filter((item) => item.processed) : images;

    if (candidates.length === 0) {
      pushToast(
        'warning',
        onlyProcessed ? '暂无已完成去水印的图片可打包' : '当前队列没有可导出的图片',
      );
      return;
    }

    dispatch({
      type: 'SET_EXPORTING',
      isExporting: true,
      zipProgress: { completed: 0, total: candidates.length, currentName: candidates[0].name },
    });

    try {
      const result = await exportBatchAsZip(candidates, exportConfig, {
        onProgress: (completed, total, currentName) => {
          dispatch({
            type: 'SET_EXPORTING',
            isExporting: true,
            zipProgress: { completed, total, currentName },
          });
        },
      });
      pushToast('success', `已打包下载 ${result.count} 张图片（${result.filename}）`);
    } catch (err) {
      if (!isAbortError(err)) {
        pushToast('error', extractErrorMessage(err, '批量 ZIP 打包导出失败'));
      }
    } finally {
      dispatch({ type: 'SET_EXPORTING', isExporting: false, zipProgress: null });
    }
  };

  return {
    setExportConfig,
    exportActiveImage,
    copyActiveImage,
    exportAllAsZip,
  };
}
