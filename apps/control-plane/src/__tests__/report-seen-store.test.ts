/**
 * report-seen-store — the local "last seen Report at" display flag. Pins:
 * never-seen defaults to 0 (counts everything as new, the safe direction),
 * marking seen persists and returns the given ts, and a corrupt/missing
 * file never breaks the read.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLastSeenReportAt, markReportSeen } from '../lib/report-seen-store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'report-seen-'));
});

describe('report-seen-store', () => {
  it('defaults to 0 (never seen) when no file exists', () => {
    expect(readLastSeenReportAt(dir)).toBe(0);
  });

  it('marks seen and persists the given timestamp', () => {
    expect(markReportSeen(1_700_000_000_000, dir)).toBe(1_700_000_000_000);
    expect(readLastSeenReportAt(dir)).toBe(1_700_000_000_000);
    const onDisk = JSON.parse(readFileSync(join(dir, 'report-seen.json'), 'utf8'));
    expect(onDisk.lastSeenReportAt).toBe(1_700_000_000_000);
  });

  it('marking again overwrites the previous cutoff', () => {
    markReportSeen(100, dir);
    markReportSeen(200, dir);
    expect(readLastSeenReportAt(dir)).toBe(200);
  });

  it('falls back to now for invalid input', () => {
    const before = Date.now();
    const ts = markReportSeen(NaN, dir);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(readLastSeenReportAt(dir)).toBe(ts);
  });

  it('treats a corrupt or malformed file as never-seen (0), not a crash', () => {
    writeFileSync(join(dir, 'report-seen.json'), '{not json');
    expect(readLastSeenReportAt(dir)).toBe(0);
    writeFileSync(join(dir, 'report-seen.json'), JSON.stringify({ lastSeenReportAt: 'not a number' }));
    expect(readLastSeenReportAt(dir)).toBe(0);
  });
});
