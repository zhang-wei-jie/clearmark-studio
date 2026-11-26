/**
 * LaMa IndexedDB 双仓模型缓存单元测试（modelCache.ts）
 *
 * 覆盖：双仓原子写入、轻量元信息探测不误读大权重、完整读写、删除清理、
 * 存储配额汇总、QuotaExceededError 中文错误提示与无 IndexedDB 环境降级。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDb, type FakeIndexedDbController } from '../../../test/fakeIndexedDb';
import {
  DEFAULT_LAMA_MODEL_ID,
  deleteModelFromCache,
  getCacheStorageInfo,
  getCachedModelMeta,
  isIndexedDbAvailable,
  loadModelFromCache,
  saveModelToCache,
} from '../modelCache';

describe('modelCache - IndexedDB 双仓模型缓存', () => {
  let idb: FakeIndexedDbController;

  beforeEach(() => {
    idb = installFakeIndexedDb();
  });

  afterEach(() => {
    idb.restore();
    vi.restoreAllMocks();
  });

  it('saveModelToCache 原子写入后，getCachedModelMeta 仅读取 model_meta 而不加载大体积 model_blobs', async () => {
    const payload = new Uint8Array([0x08, 0x08, 0x12, 0x04, 0x6c, 0x61, 0x6d, 0x61]);
    const saved = await saveModelToCache({
      buffer: payload.buffer,
      sourceLabel: '测试镜像源',
      sourceUrl: 'https://example.com/lama.onnx',
    });

    expect(saved.id).toBe(DEFAULT_LAMA_MODEL_ID);
    expect(saved.sizeBytes).toBe(payload.byteLength);
    expect(saved.sourceLabel).toBe('测试镜像源');

    const meta = await getCachedModelMeta();
    expect(meta).not.toBeNull();
    expect(meta?.sizeBytes).toBe(payload.byteLength);
    expect(idb.getReadCount('model_meta')).toBe(1);
    expect(idb.getReadCount('model_blobs')).toBe(0);

    const full = await loadModelFromCache();
    expect(full).not.toBeNull();
    expect(new Uint8Array(full!.buffer)).toEqual(payload);
    expect(idb.getReadCount('model_blobs')).toBe(1);
  });

  it('deleteModelFromCache 应同步清除元信息与二进制权重', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    await saveModelToCache({
      buffer: payload.buffer,
      sourceLabel: '本地导入',
      sourceUrl: 'local://lama.onnx',
    });

    await deleteModelFromCache();
    expect(await getCachedModelMeta()).toBeNull();
    expect(await loadModelFromCache()).toBeNull();
  });

  it('getCacheStorageInfo 应汇总已缓存字节数与浏览器配额信息', async () => {
    const payload = new Uint8Array(2048);
    await saveModelToCache({
      buffer: payload.buffer,
      sourceLabel: 'HF-Mirror',
      sourceUrl: 'https://hf-mirror.com/lama.onnx',
    });

    const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: vi.fn().mockResolvedValue({ quota: 1_000_000_000, usage: 2048 }),
      },
    });

    try {
      const info = await getCacheStorageInfo();
      expect(info.cachedBytes).toBe(2048);
      expect(info.quotaBytes).toBe(1_000_000_000);
      expect(info.usageBytes).toBe(2048);
    } finally {
      if (originalStorage) {
        Object.defineProperty(navigator, 'storage', originalStorage);
      } else {
        delete (navigator as unknown as Record<string, unknown>).storage;
      }
    }
  });

  it('写入遭遇 QuotaExceededError 时应返回清晰简体中文提示', async () => {
    idb.setNextPutError(new DOMException('Disk full', 'QuotaExceededError'));
    await expect(
      saveModelToCache({
        buffer: new ArrayBuffer(16),
        sourceLabel: '测试源',
        sourceUrl: 'https://example.com/lama.onnx',
      }),
    ).rejects.toThrow('浏览器本地存储空间不足');
  });

  it('数据库被其他标签页阻塞时应抛出明确提示', async () => {
    idb.setNextOpenBlocked(true);
    await expect(getCachedModelMeta()).rejects.toThrow('被其他标签页锁定');
  });

  it('无 IndexedDB 环境时查询与删除应安全降级，保存应返回明确错误', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    expect(isIndexedDbAvailable()).toBe(false);
    expect(await getCachedModelMeta()).toBeNull();
    expect(await loadModelFromCache()).toBeNull();
    await expect(deleteModelFromCache()).resolves.toBeUndefined();
    await expect(
      saveModelToCache({
        buffer: new ArrayBuffer(8),
        sourceLabel: '测试',
        sourceUrl: 'https://example.com/lama.onnx',
      }),
    ).rejects.toThrow('不支持 IndexedDB');
  });
});
