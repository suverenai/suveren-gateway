import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, type McpRekeyClient } from '../lib/vault';
import { RekeyRetrier, RETRY_FIRST_MS, RETRY_MAX_MS } from '../lib/rekey-retry';

const FAST = { scrypt: { N: 1024, r: 8, p: 1 } };

async function pendingVault(client: McpRekeyClient) {
  const v = new Vault(mkdtempSync(join(tmpdir(), 'retry-')), FAST);
  await v.deriveAndSetKey('hap_k');
  v.setCredential('x', { a: 'b' });
  const moved = await v.setPassword('correct horse battery', 'u1', client);
  expect(moved.outcome).toBe('pending');
  return v;
}

describe('the background retry of an unfinished re-key', () => {
  it('tries again on its own, with growing waits, never locks the vault, and stops once it is done', async () => {
    let up = false, state: 'old' | 'new' = 'old', tries = 0;
    const client: McpRekeyClient = {
      state: async () => { if (!up) throw new Error('down'); return { sealedWith: state }; },
      rekey: async () => { tries++; state = 'new'; },
    };
    const v = await pendingVault(client);
    let t = 1_000_000;
    const r = new RekeyRetrier(v, client, () => t);

    expect(await r.tick()).toBe(true);                       // first background try: fails
    expect(await r.tick()).toBe(false);                      // too soon
    t += RETRY_FIRST_MS - 1;
    expect(await r.tick()).toBe(false);
    t += 2;
    expect(await r.tick()).toBe(true);                       // after 30 s: fails again
    t += RETRY_FIRST_MS + 1;
    expect(await r.tick()).toBe(false);                      // the wait doubled
    for (let i = 0; i < 10; i++) { t += RETRY_MAX_MS + 1; await r.tick(); }
    expect(v.isUnlocked()).toBe(true);                       // many failures: still not locked
    expect(v.hasPendingRekey()).toBe(true);

    up = true;
    t += RETRY_MAX_MS + 1;
    expect(await r.tick()).toBe(true);
    expect(v.hasPendingRekey()).toBe(false);
    expect(tries).toBe(1);
    expect(await r.tick()).toBe(false);                      // nothing pending: nothing to do
  });
});
