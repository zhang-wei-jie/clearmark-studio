/**
 * 内置 MI-GAN 与可选 LaMa ONNX 模型管理领域 Actions
 */

import {
  cancelLamaDownload,
  clearLamaModelCache,
  disposeLamaSession,
  downloadLamaModel,
  ensureLamaSessionLoaded,
  getLamaModelStatus,
  importLocalLamaModel,
} from '../../engines/lama';
import { disposeMiganSession, preloadMiganModel } from '../../engines/migan';
import { extractErrorMessage, isAbortError } from '../history';
import type { StoreActionContext } from '../types';

export interface ModelActions {
  preloadMiganAiModel: () => Promise<void>;
  unloadMiganAiSession: () => Promise<void>;
  downloadAiModel: (url: string, label?: string) => Promise<void>;
  cancelAiModelDownload: () => void;
  importAiModelFile: (file: File) => Promise<void>;
  clearAiModelCache: () => Promise<void>;
  loadAiModelSession: () => Promise<void>;
  unloadAiModelSession: () => Promise<void>;
}

export function createModelActions(ctx: StoreActionContext): ModelActions {
  const { refs, pushToast } = ctx;

  const preloadMiganAiModel = async () => {
    try {
      await preloadMiganModel();
      pushToast('success', '内置 MI-GAN 本地 AI 引擎已预加载就绪（WASM）');
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '预加载内置 MI-GAN 模型失败'), 5000);
    }
  };

  const unloadMiganAiSession = async () => {
    try {
      await disposeMiganSession();
      pushToast('info', '已释放内置 MI-GAN 推理线程内存');
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '释放 MI-GAN 会话失败'));
    }
  };

  const downloadAiModel = async (url: string, label?: string) => {
    const trimmed = url.trim();
    if (!trimmed) {
      pushToast('warning', '请输入有效的 ONNX 模型下载地址');
      return;
    }

    refs.modelDownloadAbort?.abort();
    const controller = new AbortController();
    refs.modelDownloadAbort = controller;

    try {
      await downloadLamaModel(trimmed, {
        label,
        signal: controller.signal,
      });
      pushToast('success', 'LaMa AI 模型已下载并缓存至本地浏览器');
    } catch (err) {
      if (isAbortError(err)) {
        pushToast('info', '已取消 AI 模型下载');
      } else {
        pushToast('error', extractErrorMessage(err, '模型下载失败，请切换镜像源或本地导入'), 5500);
      }
    } finally {
      if (refs.modelDownloadAbort === controller) {
        refs.modelDownloadAbort = null;
      }
    }
  };

  const cancelAiModelDownload = () => {
    refs.modelDownloadAbort?.abort();
    refs.modelDownloadAbort = null;
    cancelLamaDownload();
  };

  const importAiModelFile = async (file: File) => {
    try {
      await importLocalLamaModel(file);
      pushToast('success', `已导入本地模型「${file.name}」并缓存至浏览器`);
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '导入本地 ONNX 模型失败'), 5000);
    }
  };

  const clearAiModelCache = async () => {
    try {
      await clearLamaModelCache();
      pushToast('info', '已清除本地缓存的 LaMa AI 模型');
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '清除模型缓存失败'));
    }
  };

  const loadAiModelSession = async () => {
    try {
      await ensureLamaSessionLoaded();
      const backend = getLamaModelStatus().backend;
      pushToast(
        'success',
        `LaMa 推理引擎已就绪（后端：${backend === 'webgpu' ? 'WebGPU 加速' : 'WASM'}）`,
      );
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '初始化 LaMa 推理会话失败'), 5000);
    }
  };

  const unloadAiModelSession = async () => {
    try {
      await disposeLamaSession();
      pushToast('info', '已释放 LaMa 推理显存/内存会话');
    } catch (err) {
      pushToast('error', extractErrorMessage(err, '释放推理会话失败'));
    }
  };

  return {
    preloadMiganAiModel,
    unloadMiganAiSession,
    downloadAiModel,
    cancelAiModelDownload,
    importAiModelFile,
    clearAiModelCache,
    loadAiModelSession,
    unloadAiModelSession,
  };
}
