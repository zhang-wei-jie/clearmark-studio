/**
 * LaMa AI 模型本地持久化缓存（基于原生 IndexedDB）
 *
 * 将下载或本地导入的 .onnx 模型权重拆分为两个对象仓库存储：
 * - model_meta：轻量级元信息（来源、URL、大小、更新时间），用于页面初始化时毫秒级检测缓存状态，避免把 200MB 权重读入内存。
 * - model_blobs：二进制模型权重（ArrayBuffer），仅在实际初始化 ONNX 推理会话时按需读取。
 */

export const LAMA_CACHE_DB_NAME = 'clearmark-ai-models';
export const LAMA_CACHE_DB_VERSION = 1;
export const DEFAULT_LAMA_MODEL_ID = 'lama-default';

const META_STORE_NAME = 'model_meta';
const BLOB_STORE_NAME = 'model_blobs';

/** 缓存在 IndexedDB 中的模型元信息 */
export interface CachedModelMeta {
  id: string;
  sourceLabel: string;
  sourceUrl: string;
  sizeBytes: number;
  updatedAt: number;
}

/** 完整缓存记录（元信息 + 模型二进制数据） */
export interface CachedModelRecord extends CachedModelMeta {
  buffer: ArrayBuffer;
}

/** 浏览器存储空间使用概览 */
export interface CacheStorageInfo {
  cachedBytes: number;
  quotaBytes?: number;
  usageBytes?: number;
}

interface StoredModelBlob {
  id: string;
  buffer: ArrayBuffer;
}

/** 检测当前运行环境是否支持 IndexedDB */
export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

/** 包装 IndexedDB 异常为清晰的简体中文错误提示 */
function formatIdbError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new Error(
      '浏览器本地存储空间不足，无法缓存 AI 模型（约 208 MB）。请清理浏览器站点缓存或释放磁盘空间后重试。',
    );
  }
  if (error instanceof Error && error.message) {
    return new Error(`${fallbackMessage}：${error.message}`);
  }
  return new Error(fallbackMessage);
}

/** 打开并初始化 clearmark-ai-models 数据库 */
function openCacheDatabase(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(
      new Error(
        '当前浏览器环境不支持 IndexedDB（可能处于隐私模式或受限环境），无法持久化模型缓存。',
      ),
    );
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(LAMA_CACHE_DB_NAME, LAMA_CACHE_DB_VERSION);
    } catch (error) {
      reject(formatIdbError(error, '无法打开本地模型缓存数据库'));
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE_NAME)) {
        db.createObjectStore(META_STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(BLOB_STORE_NAME)) {
        db.createObjectStore(BLOB_STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(formatIdbError(request.error, '打开本地模型缓存数据库失败'));
    };

    request.onblocked = () => {
      reject(new Error('本地模型缓存数据库被其他标签页锁定，请关闭冲突页面后重试。'));
    };
  });
}

/** 保存模型二进制权重与元信息（同一事务原子写入） */
export async function saveModelToCache(params: {
  buffer: ArrayBuffer;
  sourceLabel: string;
  sourceUrl: string;
  id?: string;
}): Promise<CachedModelMeta> {
  const id = params.id ?? DEFAULT_LAMA_MODEL_ID;
  const meta: CachedModelMeta = {
    id,
    sourceLabel: params.sourceLabel,
    sourceUrl: params.sourceUrl,
    sizeBytes: params.buffer.byteLength,
    updatedAt: Date.now(),
  };
  const blobRecord: StoredModelBlob = {
    id,
    buffer: params.buffer,
  };

  const db = await openCacheDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META_STORE_NAME, BLOB_STORE_NAME], 'readwrite');
      tx.objectStore(META_STORE_NAME).put(meta);
      tx.objectStore(BLOB_STORE_NAME).put(blobRecord);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(formatIdbError(tx.error, '写入本地模型缓存失败'));
      tx.onabort = () => reject(formatIdbError(tx.error, '写入本地模型缓存被中断'));
    });
    return meta;
  } finally {
    db.close();
  }
}

/** 仅查询缓存模型元信息，不加载大体积权重 */
export async function getCachedModelMeta(
  id: string = DEFAULT_LAMA_MODEL_ID,
): Promise<CachedModelMeta | null> {
  if (!isIndexedDbAvailable()) {
    return null;
  }

  const db = await openCacheDatabase();
  try {
    return await new Promise<CachedModelMeta | null>((resolve, reject) => {
      const tx = db.transaction(META_STORE_NAME, 'readonly');
      const request = tx.objectStore(META_STORE_NAME).get(id);
      request.onsuccess = () => {
        const result = request.result as CachedModelMeta | undefined;
        resolve(result ?? null);
      };
      request.onerror = () => reject(formatIdbError(request.error, '读取模型缓存元信息失败'));
    });
  } finally {
    db.close();
  }
}

/** 读取缓存模型的完整二进制权重与元信息 */
export async function loadModelFromCache(
  id: string = DEFAULT_LAMA_MODEL_ID,
): Promise<CachedModelRecord | null> {
  if (!isIndexedDbAvailable()) {
    return null;
  }

  const db = await openCacheDatabase();
  try {
    return await new Promise<CachedModelRecord | null>((resolve, reject) => {
      const tx = db.transaction([META_STORE_NAME, BLOB_STORE_NAME], 'readonly');
      const metaReq = tx.objectStore(META_STORE_NAME).get(id);
      const blobReq = tx.objectStore(BLOB_STORE_NAME).get(id);

      let meta: CachedModelMeta | undefined;
      let blob: StoredModelBlob | undefined;

      metaReq.onsuccess = () => {
        meta = metaReq.result as CachedModelMeta | undefined;
      };
      blobReq.onsuccess = () => {
        blob = blobReq.result as StoredModelBlob | undefined;
      };

      tx.oncomplete = () => {
        if (!meta || !blob || !(blob.buffer instanceof ArrayBuffer)) {
          resolve(null);
          return;
        }
        resolve({
          ...meta,
          buffer: blob.buffer,
        });
      };
      tx.onerror = () => reject(formatIdbError(tx.error, '读取本地缓存模型权重失败'));
      tx.onabort = () => reject(formatIdbError(tx.error, '读取本地缓存模型被中断'));
    });
  } finally {
    db.close();
  }
}

/** 删除指定缓存模型及其元信息 */
export async function deleteModelFromCache(id: string = DEFAULT_LAMA_MODEL_ID): Promise<void> {
  if (!isIndexedDbAvailable()) {
    return;
  }

  const db = await openCacheDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META_STORE_NAME, BLOB_STORE_NAME], 'readwrite');
      tx.objectStore(META_STORE_NAME).delete(id);
      tx.objectStore(BLOB_STORE_NAME).delete(id);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(formatIdbError(tx.error, '清除本地模型缓存失败'));
      tx.onabort = () => reject(formatIdbError(tx.error, '清除本地模型缓存被中断'));
    });
  } finally {
    db.close();
  }
}

/** 查询当前模型缓存占用及浏览器站点存储配额信息 */
export async function getCacheStorageInfo(
  id: string = DEFAULT_LAMA_MODEL_ID,
): Promise<CacheStorageInfo> {
  const meta = await getCachedModelMeta(id);
  const info: CacheStorageInfo = {
    cachedBytes: meta?.sizeBytes ?? 0,
  };

  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      if (typeof estimate.quota === 'number') {
        info.quotaBytes = estimate.quota;
      }
      if (typeof estimate.usage === 'number') {
        info.usageBytes = estimate.usage;
      }
    } catch {
      // 部分隐私模式下 storage.estimate 可能被拒绝，不影响已缓存字节数返回
    }
  }

  return info;
}
