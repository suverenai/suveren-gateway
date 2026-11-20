import type { Kv } from './kv';

/**
 * IndexedDB as a {@link Kv}. The pattern is the one the device test proved on an iPhone XS (iOS 18.7): one database, one
 * object store, one transaction per call. A write is only trusted after it was read back (key-store.ts does that for keys).
 */
const DB_NAME = 'suveren-approve';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IdbKv implements Kv {
  private db: Promise<IDBDatabase> | null = null;
  private conn(): Promise<IDBDatabase> {
    this.db ??= open();
    return this.db;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const db = await this.conn();
    return new Promise((resolve, reject) => {
      const q = db.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => resolve(q.result as T | undefined);
      q.onerror = () => reject(q.error);
    });
  }

  async set(key: string, value: unknown): Promise<void> {
    const db = await this.conn();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.conn();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
