/**
 * GateStore.clearAll() — used when the Authority Server URL changes
 * (re-pairing, see bin/http.ts's boot-time check + as-pairing.ts).
 *
 * The specific bug this guards against: clearing only the FILE the store
 * happens to be using right now (plaintext, pre-login) would leave a stale
 * `gates.enc.json` on disk, and the very next `setVaultKey()` call (the next
 * sign-in) would load THAT — silently resurrecting cached mandates from the
 * abandoned AS. clearAll() must remove both files.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GateStore, type GateEntry } from '../src/lib/gate-store';

const entry = (id: string): GateEntry => ({
  authorizationId: id,
  path: 'email@0.4',
  profileId: 'email@0.4',
  gateContent: { intent: 'test intent' },
  storedAt: new Date().toISOString(),
});

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gate-clear-')); dirs.push(d); return d; };

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('GateStore.clearAll', () => {
  it('empties the in-memory entries', () => {
    const dir = tmp();
    const store = new GateStore(dir);
    store.set('authz_1', entry('authz_1'));
    expect(store.getAll()).toHaveLength(1);

    store.clearAll();
    expect(store.getAll()).toHaveLength(0);
  });

  it('removes the plaintext file', () => {
    const dir = tmp();
    const store = new GateStore(dir);
    store.set('authz_1', entry('authz_1'));
    expect(existsSync(join(dir, 'gates.json'))).toBe(true);

    store.clearAll();
    expect(existsSync(join(dir, 'gates.json'))).toBe(false);
  });

  it("removes a stale ENCRYPTED file too, so a later sign-in can't resurrect it", () => {
    const dir = tmp();
    const key = randomBytes(32);

    // Simulate: signed in under the OLD AS, gate content encrypted to disk.
    const store = new GateStore(dir);
    store.setVaultKey(key);
    store.set('authz_old', entry('authz_old'));
    expect(existsSync(join(dir, 'gates.enc.json'))).toBe(true);

    // Boot-time AS-URL-change detection clears everything (runs BEFORE any
    // sign-in, so no vault key is set on the store yet in the real flow —
    // exercise that exact ordering here).
    const freshStore = new GateStore(dir);
    freshStore.clearAll();
    expect(existsSync(join(dir, 'gates.enc.json'))).toBe(false);
    expect(existsSync(join(dir, 'gates.json'))).toBe(false);

    // The next sign-in (new AS) sets a vault key again — must NOT resurrect
    // the old entry from a file that clearAll() already removed.
    freshStore.setVaultKey(randomBytes(32));
    expect(freshStore.getAll()).toHaveLength(0);
  });
});
