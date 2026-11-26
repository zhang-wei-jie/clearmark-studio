/**
 * 零依赖轻量内存 IndexedDB 测试替身（供 Vitest/jsdom 覆盖 modelCache.ts 全链路）
 *
 * 完整支持：open、onupgradeneeded、createObjectStore、objectStoreNames.contains、
 * 单仓/多仓 readonly/readwrite 事务、put/get/delete、以及故障注入（QuotaExceededError / onblocked）。
 */

export interface FakeIndexedDbController {
  /** 清空所有内存数据库与故障注入状态 */
  reset: () => void;
  /** 注入下一次 put 操作抛出指定错误（如 QuotaExceededError） */
  setNextPutError: (error: Error | DOMException | null) => void;
  /** 注入下一次 open 触发 onblocked */
  setNextOpenBlocked: (blocked: boolean) => void;
  /** 统计指定对象仓库被 get 调用的次数（可用于断言不误读 model_blobs） */
  getReadCount: (storeName: string) => number;
  /** 还原全局 indexedDB */
  restore: () => void;
}

interface FakeDatabaseRecord {
  version: number;
  stores: Map<string, { keyPath: string; rows: Map<string, unknown> }>;
}

function scheduleMicrotask(fn: () => void): void {
  queueMicrotask(fn);
}

/** 安装内存 IndexedDB 到 globalThis.indexedDB 并返回控制句柄 */
export function installFakeIndexedDb(): FakeIndexedDbController {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const databases = new Map<string, FakeDatabaseRecord>();
  const readCounts = new Map<string, number>();

  let nextPutError: Error | DOMException | null = null;
  let nextOpenBlocked = false;

  const fakeFactory = {
    open(name: string, version = 1) {
      const request: Record<string, unknown> = {
        result: undefined,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };

      scheduleMicrotask(() => {
        if (nextOpenBlocked) {
          nextOpenBlocked = false;
          const onblocked = request.onblocked as (() => void) | null;
          onblocked?.();
          return;
        }

        let dbRecord = databases.get(name);
        const needsUpgrade = !dbRecord || dbRecord.version < version;
        if (!dbRecord) {
          dbRecord = { version, stores: new Map() };
          databases.set(name, dbRecord);
        } else if (needsUpgrade) {
          dbRecord.version = version;
        }

        const currentDb = dbRecord;

        const dbHandle = {
          objectStoreNames: {
            contains(storeName: string): boolean {
              return currentDb.stores.has(storeName);
            },
          },
          createObjectStore(storeName: string, options?: { keyPath?: string }) {
            if (!currentDb.stores.has(storeName)) {
              currentDb.stores.set(storeName, {
                keyPath: options?.keyPath ?? 'id',
                rows: new Map(),
              });
            }
            return {};
          },
          transaction(storeNames: string | string[], _mode?: IDBTransactionMode) {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames];
            const tx: Record<string, unknown> = {
              error: null,
              oncomplete: null,
              onerror: null,
              onabort: null,
            };

            let failed = false;
            const pendingOps: Array<() => void> = [];

            const scheduleFinalize = () => {
              scheduleMicrotask(() => {
                for (const op of pendingOps.splice(0, pendingOps.length)) {
                  if (failed) break;
                  op();
                }
                if (failed) {
                  const onerror = tx.onerror as (() => void) | null;
                  onerror?.();
                } else {
                  const oncomplete = tx.oncomplete as (() => void) | null;
                  oncomplete?.();
                }
              });
            };

            let scheduled = false;
            const ensureScheduled = () => {
              if (!scheduled) {
                scheduled = true;
                scheduleFinalize();
              }
            };

            tx.objectStore = (storeName: string) => {
              if (!names.includes(storeName)) {
                throw new Error(`对象仓库 ${storeName} 未包含在当前事务中`);
              }
              const store = currentDb.stores.get(storeName);
              if (!store) {
                throw new Error(`对象仓库 ${storeName} 不存在`);
              }

              return {
                put(value: Record<string, unknown>) {
                  const opReq: Record<string, unknown> = {
                    result: undefined,
                    error: null,
                    onsuccess: null,
                    onerror: null,
                  };
                  pendingOps.push(() => {
                    if (nextPutError) {
                      const err = nextPutError;
                      nextPutError = null;
                      failed = true;
                      opReq.error = err;
                      tx.error = err;
                      const onerror = opReq.onerror as (() => void) | null;
                      onerror?.();
                      return;
                    }
                    const key = String(value[store.keyPath]);
                    store.rows.set(key, value);
                    opReq.result = key;
                    const onsuccess = opReq.onsuccess as (() => void) | null;
                    onsuccess?.();
                  });
                  ensureScheduled();
                  return opReq;
                },
                get(key: string) {
                  const opReq: Record<string, unknown> = {
                    result: undefined,
                    error: null,
                    onsuccess: null,
                    onerror: null,
                  };
                  pendingOps.push(() => {
                    readCounts.set(storeName, (readCounts.get(storeName) ?? 0) + 1);
                    opReq.result = store.rows.get(String(key));
                    const onsuccess = opReq.onsuccess as (() => void) | null;
                    onsuccess?.();
                  });
                  ensureScheduled();
                  return opReq;
                },
                delete(key: string) {
                  const opReq: Record<string, unknown> = {
                    result: undefined,
                    error: null,
                    onsuccess: null,
                    onerror: null,
                  };
                  pendingOps.push(() => {
                    store.rows.delete(String(key));
                    const onsuccess = opReq.onsuccess as (() => void) | null;
                    onsuccess?.();
                  });
                  ensureScheduled();
                  return opReq;
                },
              };
            };

            return tx;
          },
          close() {
            // 内存替身无需关闭物理连接
          },
        };

        request.result = dbHandle;
        if (needsUpgrade) {
          const onupgradeneeded = request.onupgradeneeded as (() => void) | null;
          onupgradeneeded?.();
        }
        const onsuccess = request.onsuccess as (() => void) | null;
        onsuccess?.();
      });

      return request;
    },
  };

  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: fakeFactory,
  });

  return {
    reset() {
      databases.clear();
      readCounts.clear();
      nextPutError = null;
      nextOpenBlocked = false;
    },
    setNextPutError(error) {
      nextPutError = error;
    },
    setNextOpenBlocked(blocked) {
      nextOpenBlocked = blocked;
    },
    getReadCount(storeName) {
      return readCounts.get(storeName) ?? 0;
    },
    restore() {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'indexedDB', originalDescriptor);
      } else {
        delete (globalThis as Record<string, unknown>).indexedDB;
      }
    },
  };
}
