import { describe, it, expect } from 'vitest';
import { MemoryKv, type Kv } from './kv';
import { loadAutoOpen, saveAutoOpen } from './panel-setting';

describe('"Open approvals automatically" on this phone (DEC-86)', () => {
  it('is on by default, as the gateway\'s', async () => {
    expect(await loadAutoOpen(new MemoryKv())).toBe(true);
  });

  it('keeps what the person chose, read back from the store', async () => {
    const kv = new MemoryKv();
    expect(await saveAutoOpen(kv, false)).toBe(false);
    expect(await loadAutoOpen(kv)).toBe(false);
    expect(await saveAutoOpen(kv, true)).toBe(true);
  });

  it('a store that cannot be read gives null: nothing opens by itself and the switch is left out', async () => {
    const broken: Kv = { get: async () => { throw new Error('no'); }, set: async () => {}, delete: async () => {} };
    expect(await loadAutoOpen(broken)).toBeNull();
  });

  it('a write that did not stick throws', async () => {
    const lost: Kv = { get: async () => undefined, set: async () => {}, delete: async () => {} };
    await expect(saveAutoOpen(lost, false)).rejects.toThrow();
  });
});
