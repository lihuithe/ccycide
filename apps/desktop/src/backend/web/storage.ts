/**
 * 浏览器本地存储：设备身份、已记住的设备、设置。
 * 主存储是 IndexedDB（同一浏览器档案内共享）；IndexedDB 不可用时退回内存（本次页面有效，刷新即丢）。
 * 身份私钥只存在这个浏览器档案里，清除站点数据、换浏览器、无痕窗口都会得到一台新设备。
 */

const DB_NAME = 'rterm-web';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, unknown>();

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return memory.get(key) as T | undefined;
  return (await wrap(db.transaction(STORE).objectStore(STORE).get(key))) as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) {
    memory.set(key, value);
    return;
  }
  await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key));
}

export async function kvDelete(key: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    memory.delete(key);
    return;
  }
  await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key));
}

/** 是否真的持久化（IndexedDB 可用）。不可用时界面应提示“刷新后会变成新设备” */
export async function isPersistent(): Promise<boolean> {
  return (await openDb()) !== null;
}
