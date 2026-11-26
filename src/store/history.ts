/**
 * Store 历史栈纯函数、有效遮罩合成与 Blob ObjectURL 资源回收工具
 */

import type { HistoryEntry, ImageItem } from '../types';
import {
  applyNormalizedRectToMask,
  cloneMask,
  createEmptyMask,
  hasMaskPixels,
} from '../utils/maskUtils';

export const MAX_HISTORY_ENTRIES = 20;
export const ACCEPTED_IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|avif)$/i;

export function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const maybeError = err as { name?: string; code?: string };
  return maybeError.name === 'AbortError' || maybeError.code === 'ABORTED';
}

export function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  if (typeof err === 'string' && err.trim()) {
    return err;
  }
  return fallback;
}

export function revokeIfBlobUrl(url: string): void {
  if (url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // 忽略已释放 URL 的重复回收
    }
  }
}

/** 回收单张图片自身原图及全部历史节点占用的临时 Blob ObjectURL */
export function revokeItemBlobUrls(item: ImageItem): void {
  const urls = new Set<string>();
  urls.add(item.originalUrl);
  urls.add(item.currentDataUrl);
  for (const entry of item.history) {
    urls.add(entry.dataUrl);
  }
  urls.forEach(revokeIfBlobUrl);
}

/** 计算追加历史节点后的新历史栈与需要延迟回收的淘汰 Blob URL 列表（纯函数，无副作用） */
export function computeNextHistory(
  item: ImageItem,
  entry: HistoryEntry,
): { nextHistory: HistoryEntry[]; evictedUrls: string[] } {
  const truncated = item.history.slice(0, item.historyIndex + 1);
  truncated.push(entry);

  let nextHistory = truncated;
  if (nextHistory.length > MAX_HISTORY_ENTRIES) {
    // 始终保留 index 0 原图，淘汰最早的中间历史节点
    nextHistory = [nextHistory[0], ...nextHistory.slice(-(MAX_HISTORY_ENTRIES - 1))];
  }

  const keptUrls = new Set<string>([item.originalUrl]);
  for (const kept of nextHistory) {
    keptUrls.add(kept.dataUrl);
  }

  const evictedUrls: string[] = [];
  for (const old of item.history) {
    if (!keptUrls.has(old.dataUrl) && old.dataUrl.startsWith('blob:')) {
      evictedUrls.push(old.dataUrl);
    }
  }

  return { nextHistory, evictedUrls };
}

/** 延迟释放不再被引用的历史 Blob URL，确保 React 完成当前帧渲染后再回收 */
export function scheduleRevokeUrls(urls: readonly string[]): void {
  if (urls.length === 0) return;
  if (typeof window !== 'undefined') {
    window.setTimeout(() => {
      urls.forEach(revokeIfBlobUrl);
    }, 1000);
  } else {
    urls.forEach(revokeIfBlobUrl);
  }
}

/** 合并图片当前有效选区：同时兼容画笔/框选遮罩与未提交的交互预设框 */
export function resolveEffectiveMask(item: ImageItem): Uint8Array | null {
  let mask = hasMaskPixels(item.maskBytes) ? cloneMask(item.maskBytes!) : null;
  if (item.activePresetBox) {
    if (!mask) {
      mask = createEmptyMask(item.width, item.height);
    }
    applyNormalizedRectToMask(mask, item.width, item.height, item.activePresetBox, 255);
  }
  return hasMaskPixels(mask) ? mask : null;
}

/** 追加单图历史记录并保持索引 0 恒为原图（纯函数，严格兼容 React StrictMode） */
export function appendHistoryEntry(item: ImageItem, entry: HistoryEntry): ImageItem {
  const { nextHistory } = computeNextHistory(item, entry);

  return {
    ...item,
    currentDataUrl: entry.dataUrl,
    processed: true,
    status: 'done',
    error: undefined,
    maskBytes: null,
    matchedMarks: undefined,
    activePresetBox: null,
    history: nextHistory,
    historyIndex: nextHistory.length - 1,
    lastDurationMs: entry.durationMs,
    lastBackend: entry.backend,
  };
}
