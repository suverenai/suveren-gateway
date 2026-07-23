import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DenialLog, type DenialRecord } from '../src/lib/denial-log';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'denial-log-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const rec = (over: Partial<DenialRecord> = {}): DenialRecord => ({
  ts: Date.now(), tool: 'get_message', integrationId: 'gmail', profile: 'email',
  reason: 'age', detail: 'older than the 90-day window', ...over,
});

describe('DenialLog', () => {
  it('records and returns newest-first', () => {
    const log = new DenialLog(tmp());
    log.record(rec({ ts: 1000, reason: 'age' }));
    log.record(rec({ ts: 3000, reason: 'resource' }));
    log.record(rec({ ts: 2000, reason: 'spam' }));
    expect(log.getRecent().map(r => r.reason)).toEqual(['resource', 'spam', 'age']);
  });

  it('persists plaintext without a key and reloads', () => {
    const dir = tmp();
    new DenialLog(dir).record(rec({ detail: 'blocked' }));
    expect(existsSync(join(dir, 'denials.json'))).toBe(true);
    expect(new DenialLog(dir).getRecent()).toHaveLength(1);
  });

  it('encrypts at rest once a vault key is set (no plaintext content on disk)', () => {
    const dir = tmp();
    const log = new DenialLog(dir);
    log.setVaultKey(randomBytes(32));
    log.record(rec({ detail: 'SECRET-SENTINEL-DETAIL' }));
    expect(existsSync(join(dir, 'denials.enc.json'))).toBe(true);
    const onDisk = readFileSync(join(dir, 'denials.enc.json'), 'utf-8');
    expect(onDisk).not.toContain('SECRET-SENTINEL-DETAIL');
    expect(onDisk).not.toContain('get_message');
  });

  it('round-trips through encryption', () => {
    const dir = tmp();
    const key = randomBytes(32);
    const a = new DenialLog(dir); a.setVaultKey(key); a.record(rec({ detail: 'kept', reason: 'resource', target: 'Family' }));
    const b = new DenialLog(dir); b.setVaultKey(key);
    const got = b.getRecent();
    expect(got).toHaveLength(1);
    expect(got[0].target).toBe('Family');
  });

  it('migrates plaintext → encrypted when a key arrives, deleting the plaintext file', () => {
    const dir = tmp();
    const log = new DenialLog(dir);
    log.record(rec());
    expect(existsSync(join(dir, 'denials.json'))).toBe(true);
    log.setVaultKey(randomBytes(32));
    expect(existsSync(join(dir, 'denials.enc.json'))).toBe(true);
    expect(existsSync(join(dir, 'denials.json'))).toBe(false);
  });

  it('caps at 200 records (ring buffer)', () => {
    const log = new DenialLog(tmp());
    for (let i = 0; i < 250; i++) log.record(rec({ ts: 10_000 + i }));
    expect(log.size).toBe(200);
    // Oldest dropped: the newest 200 (ts 10050..10249) remain.
    expect(log.getRecent()[log.size - 1].ts).toBe(10_050);
  });

  it('drops records older than 30 days', () => {
    const log = new DenialLog(tmp());
    const now = Date.now();
    log.record(rec({ ts: now - 40 * 24 * 60 * 60 * 1000 })); // 40d old
    log.record(rec({ ts: now }));                            // fresh — its ts drives the prune
    expect(log.size).toBe(1);
    expect(log.getRecent()[0].ts).toBe(now);
  });

  it('getRecent honours sinceMs and limit', () => {
    const log = new DenialLog(tmp());
    for (const ts of [1000, 2000, 3000]) log.record(rec({ ts }));
    expect(log.getRecent(2000).map(r => r.ts)).toEqual([3000, 2000]);
    expect(log.getRecent(undefined, 1).map(r => r.ts)).toEqual([3000]);
  });
});
