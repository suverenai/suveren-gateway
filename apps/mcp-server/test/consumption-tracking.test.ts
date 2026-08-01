/**
 * Consumption Tracking Tests — ExecutionLog cumulative state
 *
 * Tests the execution log's cumulative window tracking:
 * - sumByWindow('daily') / sumByWindow('monthly') time boundaries
 * - _count field counts entries, not sums values
 * - Multiple profiles/paths tracked independently
 * - After record(), subsequent sumByWindow() includes the new entry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionLog, windowCutoff } from '../src/lib/execution-log';
import type { ExecutionLogEntry } from '@hap/core';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROFILE_A = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';
const PROFILE_B = 'github.com/humanagencyprotocol/hap-profiles/ship@0.4';
const PATH_A = 'charge-routine';
const PATH_B = 'charge-reviewed';

const NOW = Math.floor(Date.now() / 1000);

/** Seconds ago helper */
function secondsAgo(s: number): number {
  return NOW - s;
}

function makeEntry(
  profileId: string,
  path: string,
  timestamp: number,
  execution: Record<string, number | string>,
): ExecutionLogEntry {
  return { profileId, path, timestamp, execution };
}

// ── Fixture management ────────────────────────────────────────────────────────

let testDir: string;
let log: ExecutionLog;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'suveren-log-test-'));
  log = new ExecutionLog(testDir);
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ExecutionLog — sumByWindow', () => {
  describe('daily window', () => {
    it('sums amounts within the last 24 hours', () => {
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(3600),  { amount: 10 }));  // 1h ago
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(7200),  { amount: 20 }));  // 2h ago
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(23000), { amount: 30 }));  // ~6h ago

      const total = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'daily', NOW);
      expect(total).toBe(60);
    });

    it('excludes entries older than 24 hours', () => {
      // Entry inside daily window (1 hour ago)
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(3600),  { amount: 10 }));
      // Entry well outside the daily window (25 hours ago)
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(90000), { amount: 500 }));

      const total = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'daily', NOW);
      // Only the 10-unit entry (within 24h) should be counted
      expect(total).toBe(10);
    });

    it('returns 0 when no entries exist in window', () => {
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(90000), { amount: 999 }));

      const total = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'daily', NOW);
      expect(total).toBe(0);
    });
  });

  describe('monthly window (CALENDAR month — matches the Authority Server)', () => {
    // Boundary semantics are pinned deterministically in
    // execution-log-windows.test.ts; record() prunes against the real clock, so
    // fixed historical dates cannot be used here. These anchor to the current
    // month instead, and stay inside the 31-day retention by construction.
    const monthStart = () => windowCutoff('monthly', NOW);
    /** Latest timestamp guaranteed to be inside BOTH the month and retention. */
    const insideMonth = (offset = 60) => Math.max(NOW - offset, monthStart() + 1);

    it('sums entries since the 1st of the month', () => {
      log.record(makeEntry(PROFILE_A, PATH_A, insideMonth(60),  { amount: 100 }));
      log.record(makeEntry(PROFILE_A, PATH_A, insideMonth(120), { amount: 200 }));

      const total = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'monthly', NOW);
      expect(total).toBe(300);
    });

    it('excludes entries from before the 1st, even if only hours earlier', () => {
      // The behaviour that changed: a rolling 30-day window counted these.
      const beforeMonth = monthStart() - 3600;
      const RETENTION = 31 * 86400;
      if (NOW - beforeMonth < RETENTION) {
        // Skipped only on the final day of a long month, when the previous
        // month has already aged out of retention and record() would drop it.
        log.record(makeEntry(PROFILE_A, PATH_A, beforeMonth, { amount: 999 }));
      }
      log.record(makeEntry(PROFILE_A, PATH_A, insideMonth(), { amount: 100 }));

      const total = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'monthly', NOW);
      expect(total).toBe(100);
    });

    it('monthly window is wider than daily window', () => {
      const dayInSec = 86400;
      // The month window is a CALENDAR month, so "three days ago" is only
      // inside it from the 4th onwards. Against the real clock this test failed
      // on the 1st, 2nd and 3rd of every month — and on the 1st its premise is
      // impossible, because no time older than 24h is in the current month yet.
      // Pin a mid-month "now" so the relationship under test (monthly ⊃ daily)
      // is what decides the result, not today's date.
      // Two constraints, both real: the reference point needs several days of
      // its OWN calendar month behind it, and the entry must stay inside the
      // log's 31-day retention or record() prunes it on the way in. So derive
      // from the real clock rather than hardcoding a date that ages out.
      const real = new Date(NOW * 1000);
      const monthStart = Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), 1, 12);
      const pinnedNow = real.getUTCDate() >= 5
        ? NOW                                              // safely mid-month already
        : Math.floor(monthStart / 1000) - dayInSec * 3;    // step back into the previous month
      // >24h old, and inside the same calendar month as pinnedNow.
      log.record(makeEntry(PROFILE_A, PATH_A, pinnedNow - dayInSec * 3, { amount: 50 }));

      const daily = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'daily', pinnedNow);
      const monthly = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'monthly', pinnedNow);

      expect(daily).toBe(0);
      expect(monthly).toBe(50);
    });
  });

  describe('_count field', () => {
    it('_count counts entries, not sum of values', () => {
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(100),  { amount: 1000 }));
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(200),  { amount: 2000 }));
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(300),  { amount: 500 }));

      const count = log.sumByWindow(PROFILE_A, PATH_A, '_count', 'daily', NOW);
      // 3 entries, not the sum 3500
      expect(count).toBe(3);
    });

    it('_count returns 0 when no entries in window', () => {
      const count = log.sumByWindow(PROFILE_A, PATH_A, '_count', 'daily', NOW);
      expect(count).toBe(0);
    });

    it('_count excludes out-of-window entries', () => {
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(3600),  { amount: 10 }));
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(90000), { amount: 20 })); // >24h

      const count = log.sumByWindow(PROFILE_A, PATH_A, '_count', 'daily', NOW);
      expect(count).toBe(1);
    });

    it('_count counts entries regardless of execution field values', () => {
      // Even entries with no amount field should be counted
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(100), {}));
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(200), { foo: 'bar' }));

      const count = log.sumByWindow(PROFILE_A, PATH_A, '_count', 'daily', NOW);
      expect(count).toBe(2);
    });
  });

  describe('multiple profiles and paths tracked independently', () => {
    it('different profileId entries do not affect each other', () => {
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(100), { amount: 50 }));
      log.record(makeEntry(PROFILE_B, PATH_A, secondsAgo(100), { amount: 200 }));

      const sumA = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'daily', NOW);
      const sumB = log.sumByWindow(PROFILE_B, PATH_A, 'amount', 'daily', NOW);

      expect(sumA).toBe(50);
      expect(sumB).toBe(200);
    });

    it('different path entries do not affect each other', () => {
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(100), { amount: 75 }));
      log.record(makeEntry(PROFILE_A, PATH_B, secondsAgo(100), { amount: 300 }));

      const sumA = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'daily', NOW);
      const sumB = log.sumByWindow(PROFILE_A, PATH_B, 'amount', 'daily', NOW);

      expect(sumA).toBe(75);
      expect(sumB).toBe(300);
    });

    it('profile A and profile B _count tracked independently', () => {
      for (let i = 0; i < 3; i++) {
        log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(100 + i), { amount: 10 }));
      }
      for (let i = 0; i < 7; i++) {
        log.record(makeEntry(PROFILE_B, PATH_A, secondsAgo(100 + i), { amount: 10 }));
      }

      expect(log.sumByWindow(PROFILE_A, PATH_A, '_count', 'daily', NOW)).toBe(3);
      expect(log.sumByWindow(PROFILE_B, PATH_A, '_count', 'daily', NOW)).toBe(7);
    });
  });

  describe('after record(), subsequent sumByWindow() includes the new entry', () => {
    it('sum increases after recording a new entry', () => {
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(100), { amount: 50 }));

      const before = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'daily', NOW);
      expect(before).toBe(50);

      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(50), { amount: 30 }));

      const after = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'daily', NOW);
      expect(after).toBe(80);
    });

    it('_count increases after recording a new entry', () => {
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(100), { amount: 50 }));
      expect(log.sumByWindow(PROFILE_A, PATH_A, '_count', 'daily', NOW)).toBe(1);

      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(50), { amount: 30 }));
      expect(log.sumByWindow(PROFILE_A, PATH_A, '_count', 'daily', NOW)).toBe(2);

      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(10), { amount: 20 }));
      expect(log.sumByWindow(PROFILE_A, PATH_A, '_count', 'daily', NOW)).toBe(3);
    });

    it('persists across log re-instantiation', () => {
      // Record entries to the file
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(100), { amount: 40 }));
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(200), { amount: 60 }));

      // Create a new ExecutionLog pointing at the same directory
      const reloadedLog = new ExecutionLog(testDir);
      const total = reloadedLog.sumByWindow(PROFILE_A, PATH_A, 'amount', 'daily', NOW);
      expect(total).toBe(100);
    });
  });
});
