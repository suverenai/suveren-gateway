/**
 * blocked-seen-store — the local "last seen Blocked at" display flag. Pins:
 * never-seen defaults to 0 (counts everything as new, the safe direction),
 * marking seen persists and returns the given ts, and a corrupt/missing
 * file never breaks the read.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLastSeenBlockedAt, markBlockedSeen } from '../lib/blocked-seen-store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blocked-seen-'));
});

describe('blocked-seen-store', () => {
  it('defaults to 0 (never seen) when no file exists', () => {
    expect(readLastSeenBlockedAt(dir)).toBe(0);
  });

  it('marks seen and persists the given timestamp', () => {
    expect(markBlockedSeen(1_700_000_000_000, dir)).toBe(1_700_000_000_000);
    expect(readLastSeenBlockedAt(dir)).toBe(1_700_000_000_000);
    const onDisk = JSON.parse(readFileSync(join(dir, 'blocked-seen.json'), 'utf8'));
    expect(onDisk.lastSeenBlockedAt).toBe(1_700_000_000_000);
  });

  it('marking again overwrites the previous cutoff', () => {
    markBlockedSeen(100, dir);
    markBlockedSeen(200, dir);
    expect(readLastSeenBlockedAt(dir)).toBe(200);
  });

  it('falls back to now for invalid input', () => {
    const before = Date.now();
    const ts = markBlockedSeen(NaN, dir);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(readLastSeenBlockedAt(dir)).toBe(ts);
  });

  it('treats a corrupt or malformed file as never-seen (0), not a crash', () => {
    writeFileSync(join(dir, 'blocked-seen.json'), '{not json');
    expect(readLastSeenBlockedAt(dir)).toBe(0);
    writeFileSync(join(dir, 'blocked-seen.json'), JSON.stringify({ lastSeenBlockedAt: 'not a number' }));
    expect(readLastSeenBlockedAt(dir)).toBe(0);
  });
});
