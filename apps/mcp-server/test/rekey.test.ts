/**
 * The move to an unlock password gives the vault a fresh key. The stores this
 * process holds are re-sealed by lib/rekey.ts; the real stores must open with
 * the new key, not with the old one, and lose nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GateStore, type GateEntry } from '../src/lib/gate-store';
import { rekeyDirectory } from '../src/lib/rekey';

const entry = (id: string): GateEntry => ({
  authorizationId: id, path: 'email@0.4', profileId: 'email@0.4',
  gateContent: { intent: 'secret intent' }, storedAt: new Date().toISOString(),
});
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'rekey-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('rekeyDirectory with the real gate store', () => {
  it('a store sealed with the old key opens with the new key, with nothing lost, and no longer with the old', () => {
    const dir = tmp();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const store = new GateStore(dir);
    store.setVaultKey(oldKey);
    store.set('a1', entry('a1'));
    store.set('a2', entry('a2'));

    const r = rekeyDirectory(dir, oldKey, newKey);
    expect(r.reSealed).toBe(2);

    const reopened = new GateStore(dir);
    reopened.setVaultKey(newKey);
    expect(reopened.getAll().map(e => e.authorizationId).sort()).toEqual(['a1', 'a2']);

    const stale = new GateStore(dir);
    stale.setVaultKey(oldKey); // the account-key-derived key: opens nothing now
    expect(stale.getAll()).toHaveLength(0);
    expect(readFileSync(join(dir, 'gates.enc.json'), 'utf-8')).not.toContain('secret intent');
  });

  it('running it again changes nothing (a crash or a second process is repaired by repeating)', () => {
    const dir = tmp();
    const oldKey = randomBytes(32), newKey = randomBytes(32);
    const store = new GateStore(dir);
    store.setVaultKey(oldKey);
    store.set('a1', entry('a1'));
    rekeyDirectory(dir, oldKey, newKey);
    const again = rekeyDirectory(dir, oldKey, newKey);
    expect(again.reSealed).toBe(0);
    expect(again.alreadyNew).toBe(1);
    const reopened = new GateStore(dir);
    reopened.setVaultKey(newKey);
    expect(reopened.getAll()).toHaveLength(1);
  });
});
