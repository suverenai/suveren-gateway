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
import { ExecutionLog } from '../src/lib/execution-log';
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

  describe('monthly window', () => {
    it('sums amounts within the last 30 days', () => {
      const dayInSec = 86400;
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(dayInSec * 1),  { amount: 100 }));
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(dayInSec * 15), { amount: 200 }));
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(dayInSec * 29), { amount: 300 }));

      const total = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'monthly', NOW);
      expect(total).toBe(600);
    });

    it('excludes entries older than 30 days', () => {
      const dayInSec = 86400;
      // Entry inside monthly window (5 days ago)
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(dayInSec * 5),  { amount: 100 }));
      // Entries well outside the monthly window (31+ days ago)
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(dayInSec * 31), { amount: 999 }));
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(dayInSec * 60), { amount: 999 }));

      const total = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'monthly', NOW);
      expect(total).toBe(100);
    });

    it('monthly window is wider than daily window', () => {
      const dayInSec = 86400;
      // This entry is >24h but <30d — should appear in monthly but not daily
      log.record(makeEntry(PROFILE_A, PATH_A, secondsAgo(dayInSec * 3), { amount: 50 }));

      const daily = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'daily', NOW);
      const monthly = log.sumByWindow(PROFILE_A, PATH_A, 'amount', 'monthly', NOW);

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
