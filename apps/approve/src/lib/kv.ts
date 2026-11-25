/**
 * The app's one small key-value store. IndexedDB in the phone (idb.ts); a Map in tests (the same interface).
 *
 * What goes in it: the device's key material as the platform keeps it (key-store.ts), the public facts of the account
 * (device-store.ts) and nothing else. Never a decrypted proposal, never a recovery code, never a session token
 * (plan 8: "The app never writes decrypted content to IndexedDB or the service-worker cache"; section 6.2: "the token is
 * kept in memory only").
 */
export interface Kv {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** For tests. A value is stored as it is, so a CryptoKey stays a CryptoKey (as it does in IndexedDB). */
export class MemoryKv implements Kv {
  private readonly m = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> { return this.m.get(key) as T | undefined; }
  async set(key: string, value: unknown): Promise<void> { this.m.set(key, value); }
  async delete(key: string): Promise<void> { this.m.delete(key); }
  keys(): string[] { return [...this.m.keys()]; }
}
