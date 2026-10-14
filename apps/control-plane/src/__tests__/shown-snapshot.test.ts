/**
 * AU10 §8.4 — ShownSnapshotStore (apps/control-plane/src/lib/shown-snapshot.ts).
 * JCS -> sha256 hashing, per-proposal encrypted storage, and age-based
 * pruning. Uses a real Vault (not a stub) so the AES-256-GCM round trip is
 * the actual production code, not a test double of it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, ApiKeyUnsealProvider } from '../lib/vault';
import { ShownSnapshotStore, computeShownHash, SHOWN_SNAPSHOT_MAX_AGE_SECONDS } from '../lib/shown-snapshot';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

async function unlockedVault(d: string): Promise<Vault> {
  const vault = new Vault(d);
  await vault.unseal(new ApiKeyUnsealProvider('test-api-key'));
  return vault;
}

describe('computeShownHash', () => {
  it('is deterministic under key reordering (JCS)', () => {
    expect(computeShownHash({ b: 1, a: 2 })).toBe(computeShownHash({ a: 2, b: 1 }));
  });
  it('differs for different content', () => {
    expect(computeShownHash({ a: 1 })).not.toBe(computeShownHash({ a: 2 }));
  });
  it('is prefixed sha256:<hex>', () => {
    expect(computeShownHash({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('ShownSnapshotStore', () => {
  it('save then get round-trips the exact snapshot and hash', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-shown-snapshot-'));
    const vault = await unlockedVault(dir);
    const store = new ShownSnapshotStore(dir);
    const snapshot = { readAt: 123, preview: { status: 'none' }, requestContext: { request: { status: 'none' }, history: { status: 'no_customer_link' } } };

    const hash = store.save('prop-1', snapshot, vault);
    expect(hash).toBe(computeShownHash(snapshot));

    const entry = store.get('prop-1', vault);
    expect(entry).not.toBeNull();
    expect(entry!.shownHash).toBe(hash);
    expect(entry!.snapshot).toEqual(snapshot);
  });

  it('is stored encrypted at rest — the raw file contains no plaintext snapshot content', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-shown-snapshot-'));
    const vault = await unlockedVault(dir);
    const store = new ShownSnapshotStore(dir);
    store.save('prop-2', { readAt: 1, preview: { status: 'none' }, requestContext: { request: { status: 'none' }, history: { status: 'no_customer_link' } }, secretMarker: 'CUSTOMER_EMAIL_ba@varia-umform.de' }, vault);

    const filePath = join(dir, 'shown-snapshots.enc.json');
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('CUSTOMER_EMAIL');
    expect(raw).not.toContain('ba@varia-umform.de');
  });

  it('get returns null for a proposal with no stored snapshot', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-shown-snapshot-'));
    const vault = await unlockedVault(dir);
    const store = new ShownSnapshotStore(dir);
    expect(store.get('never-saved', vault)).toBeNull();
  });

  it('remove deletes the entry', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-shown-snapshot-'));
    const vault = await unlockedVault(dir);
    const store = new ShownSnapshotStore(dir);
    store.save('prop-3', { readAt: 1, preview: { status: 'none' }, requestContext: { request: { status: 'none' }, history: { status: 'no_customer_link' } } }, vault);
    store.remove('prop-3');
    expect(store.get('prop-3', vault)).toBeNull();
  });

  it('pruneWithVault drops entries older than SHOWN_SNAPSHOT_MAX_AGE_SECONDS', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-shown-snapshot-'));
    const vault = await unlockedVault(dir);
    const store = new ShownSnapshotStore(dir);
    const now = Math.floor(Date.now() / 1000);
    store.save('old', { readAt: 1, preview: { status: 'none' }, requestContext: { request: { status: 'none' }, history: { status: 'no_customer_link' } } }, vault);
    // save() itself prunes against "now" — directly exercise pruneWithVault
    // with a FUTURE "now" to simulate the entry aging out.
    // +60 s margin: save() stamps its own clock, which can tick past `now` on
    // a slow runner (seen on Windows CI), and an entry exactly at the cutoff
    // is kept.
    store.pruneWithVault(vault, now + SHOWN_SNAPSHOT_MAX_AGE_SECONDS + 60);
    expect(store.get('old', vault)).toBeNull();
  });

  it('a fresh entry survives pruning at the current time', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hap-shown-snapshot-'));
    const vault = await unlockedVault(dir);
    const store = new ShownSnapshotStore(dir);
    store.save('fresh', { readAt: 1, preview: { status: 'none' }, requestContext: { request: { status: 'none' }, history: { status: 'no_customer_link' } } }, vault);
    store.pruneWithVault(vault);
    expect(store.get('fresh', vault)).not.toBeNull();
  });
});
