/**
 * ExecutionResultStore — the content half of the execution journal's
 * done/failed row (see execution-result-store.ts's doc comment). Pins: one
 * entry per proposal (latest wins), the 16 KB cap, encryption at rest once a
 * vault key is set, and the 90-day retention window — mirrors
 * outcome-outbox.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ExecutionResultStore, capResult } from '../src/lib/execution-result-store';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'exec-results-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

describe('ExecutionResultStore — record / get', () => {
  it('a fresh store has nothing for any proposal', () => {
    expect(new ExecutionResultStore(tmp()).get('p1')).toBeUndefined();
  });

  it('records a success and returns it', () => {
    const store = new ExecutionResultStore(tmp());
    store.record({ proposalId: 'p1', ticketId: 't1', ok: true, text: 'Sent message msg-1' });
    const got = store.get('p1');
    expect(got?.ok).toBe(true);
    expect(got?.text).toBe('Sent message msg-1');
    expect(got?.ticketId).toBe('t1');
  });

  it('records a failure and returns it', () => {
    const store = new ExecutionResultStore(tmp());
    store.record({ proposalId: 'p1', ticketId: 't1', ok: false, text: 'invalid profileId' });
    const got = store.get('p1');
    expect(got?.ok).toBe(false);
    expect(got?.text).toBe('invalid profileId');
  });

  it('a second record() for the same proposal replaces the first (latest wins)', () => {
    const store = new ExecutionResultStore(tmp());
    store.record({ proposalId: 'p1', ticketId: 't1', ok: false, text: 'first attempt failed' });
    store.record({ proposalId: 'p1', ticketId: 't2', ok: true, text: 'second attempt ok' });
    expect(store.size).toBe(1);
    expect(store.get('p1')).toMatchObject({ ok: true, text: 'second attempt ok', ticketId: 't2' });
  });

  it('keeps structuredContent alongside text when it fits', () => {
    const store = new ExecutionResultStore(tmp());
    store.record({ proposalId: 'p1', ticketId: 't1', ok: true, text: 'ok', structuredContent: { id: 'msg-1' } });
    expect(store.get('p1')?.structuredContent).toEqual({ id: 'msg-1' });
  });
});

describe('capResult — 16 KB cap', () => {
  it('leaves a small result untouched', () => {
    const r = capResult('short result');
    expect(r).toEqual({ text: 'short result', truncated: false });
  });

  it('drops structuredContent first when it alone pushes the entry over the cap', () => {
    const bigStruct = { blob: 'x'.repeat(17 * 1024) };
    const r = capResult('short text', bigStruct);
    expect(r.text).toBe('short text');
    expect(r.structuredContent).toBeUndefined();
    expect(r.truncated).toBe(true);
  });

  it('truncates text itself when text alone exceeds the cap', () => {
    const bigText = 'y'.repeat(20 * 1024);
    const r = capResult(bigText);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(r.truncated).toBe(true);
  });
});

describe('ExecutionResultStore — the cap is enforced on record()', () => {
  it('a result over 16 KB is capped and flagged truncated', () => {
    const store = new ExecutionResultStore(tmp());
    store.record({ proposalId: 'p1', ticketId: 't1', ok: true, text: 'z'.repeat(20 * 1024) });
    const got = store.get('p1');
    expect(got?.truncated).toBe(true);
    expect(Buffer.byteLength(got!.text, 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });

  it('a result well under 16 KB is not flagged truncated', () => {
    const store = new ExecutionResultStore(tmp());
    store.record({ proposalId: 'p1', ticketId: 't1', ok: true, text: 'fine' });
    expect(store.get('p1')?.truncated).toBeUndefined();
  });
});

describe('ExecutionResultStore — persistence survives a restart', () => {
  it('a recorded entry is still there for a fresh instance on the same dir', () => {
    const dir = tmp();
    new ExecutionResultStore(dir).record({ proposalId: 'p1', ticketId: 't1', ok: true, text: 'ok' });
    const restarted = new ExecutionResultStore(dir);
    expect(restarted.get('p1')?.text).toBe('ok');
  });
});

describe('ExecutionResultStore — encryption at rest', () => {
  it('persists plaintext without a key and reloads', () => {
    const dir = tmp();
    new ExecutionResultStore(dir).record({ proposalId: 'p1', ticketId: 't1', ok: true, text: 'ok' });
    expect(existsSync(join(dir, 'execution-results.json'))).toBe(true);
    expect(new ExecutionResultStore(dir).size).toBe(1);
  });

  it('encrypts at rest once a vault key is set (no plaintext content on disk)', () => {
    const dir = tmp();
    const store = new ExecutionResultStore(dir);
    store.setVaultKey(randomBytes(32));
    store.record({ proposalId: 'p1', ticketId: 't1', ok: false, text: 'SECRET-SENTINEL-ERROR-TEXT' });
    expect(existsSync(join(dir, 'execution-results.enc.json'))).toBe(true);
    const onDisk = readFileSync(join(dir, 'execution-results.enc.json'), 'utf-8');
    expect(onDisk).not.toContain('SECRET-SENTINEL-ERROR-TEXT');
  });

  it('round-trips through encryption', () => {
    const dir = tmp();
    const key = randomBytes(32);
    const a = new ExecutionResultStore(dir); a.setVaultKey(key);
    a.record({ proposalId: 'p1', ticketId: 't1', ok: true, text: 'kept' });
    const b = new ExecutionResultStore(dir); b.setVaultKey(key);
    expect(b.get('p1')?.text).toBe('kept');
  });

  it('migrates plaintext -> encrypted when a key arrives, deleting the plaintext file', () => {
    const dir = tmp();
    const store = new ExecutionResultStore(dir);
    store.record({ proposalId: 'p1', ticketId: 't1', ok: true, text: 'ok' });
    expect(existsSync(join(dir, 'execution-results.json'))).toBe(true);
    store.setVaultKey(randomBytes(32));
    expect(existsSync(join(dir, 'execution-results.enc.json'))).toBe(true);
    expect(existsSync(join(dir, 'execution-results.json'))).toBe(false);
  });

  it('isLocked is true when encrypted evidence exists but no key has arrived yet', () => {
    const dir = tmp();
    const a = new ExecutionResultStore(dir);
    a.setVaultKey(randomBytes(32));
    a.record({ proposalId: 'p1', ticketId: 't1', ok: true, text: 'ok' });

    const b = new ExecutionResultStore(dir); // fresh process, no key yet
    expect(b.isLocked()).toBe(true);
  });
});

describe('ExecutionResultStore — 90-day retention', () => {
  it('drops an entry older than 90 days on the next write', () => {
    const store = new ExecutionResultStore(tmp());
    const now = Math.floor(Date.now() / 1000);
    store.record({ proposalId: 'old', ticketId: 't-old', ok: true, text: 'old' }, now - 91 * 24 * 60 * 60);
    store.record({ proposalId: 'new', ticketId: 't-new', ok: true, text: 'new' }, now);
    expect(store.get('old')).toBeUndefined();
    expect(store.get('new')?.text).toBe('new');
  });
});
