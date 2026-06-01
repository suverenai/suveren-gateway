/**
 * Session Restore Tests
 *
 * Verifies that persistent state survives restart by re-instantiating stores
 * from the same directory and confirming data is recovered correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GateStore, type GateEntry } from '../src/lib/gate-store';
import { ExecutionLog } from '../src/lib/execution-log';
import type { ExecutionLogEntry } from '@hap/core';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeVaultKey(): Buffer {
  return randomBytes(32);
}

function makeEntry(overrides: Partial<GateEntry> = {}): GateEntry {
  return {
    frameHash: 'sha256:abc123def456',
    boundsHash: 'sha256:bounds123',
    contextHash: 'sha256:ctx456',
    path: 'charge-routine',
    profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
    gateContent: {
      problem: 'Test purchasing authority for session restore.',
      objective: 'Enable automated payment processing within bounds.',
      tradeoffs: 'Accepts financial risk up to configured limits.',
    },
    context: {
      currency: 'USD',
      action_type: 'charge',
    },
    storedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeLogEntry(overrides: Partial<ExecutionLogEntry> = {}): ExecutionLogEntry {
  return {
    profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
    path: 'charge-routine',
    execution: { amount: 42, currency: 'USD', action_type: 'charge' },
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// ── Fixture management ────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'suveren-session-restore-test-'));
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── GateStore persistence ─────────────────────────────────────────────────────

describe('Session Restore', () => {
  describe('Gate Store persistence', () => {
    it('gate entries survive store re-instantiation from same directory', () => {
      const entry = makeEntry();

      // Write with first instance
      const store1 = new GateStore(testDir);
      store1.set('charge-routine', entry);

      // Re-instantiate from same directory
      const store2 = new GateStore(testDir);
      const retrieved = store2.get('charge-routine');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.frameHash).toBe(entry.frameHash);
      expect(retrieved!.path).toBe(entry.path);
      expect(retrieved!.profileId).toBe(entry.profileId);
      expect(retrieved!.gateContent.problem).toBe(entry.gateContent.problem);
      expect(retrieved!.gateContent.objective).toBe(entry.gateContent.objective);
      expect(retrieved!.gateContent.tradeoffs).toBe(entry.gateContent.tradeoffs);
    });

    it('gate entries with context survive re-instantiation', () => {
      const entry = makeEntry({ context: { currency: 'EUR', action_type: 'refund' } });

      const store1 = new GateStore(testDir);
      store1.set('charge-reviewed', entry);

      const store2 = new GateStore(testDir);
      const retrieved = store2.get('charge-reviewed');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.context).toEqual({ currency: 'EUR', action_type: 'refund' });
    });

    it('v0.4 fields (boundsHash, contextHash, context) round-trip through persistence', () => {
      const entry = makeEntry({
        boundsHash: 'sha256:boundsABC123',
        contextHash: 'sha256:ctxDEF456',
        context: { currency: 'GBP', action_type: 'subscribe' },
      });

      const store1 = new GateStore(testDir);
      store1.set('charge-routine', entry);

      const store2 = new GateStore(testDir);
      const retrieved = store2.get('charge-routine');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.boundsHash).toBe('sha256:boundsABC123');
      expect(retrieved!.contextHash).toBe('sha256:ctxDEF456');
      expect(retrieved!.context).toEqual({ currency: 'GBP', action_type: 'subscribe' });
    });

    it('multiple entries all survive re-instantiation', () => {
      const store1 = new GateStore(testDir);
      store1.set('charge-routine', makeEntry({ path: 'charge-routine' }));
      store1.set('charge-reviewed', makeEntry({ path: 'charge-reviewed', boundsHash: 'sha256:other' }));

      const store2 = new GateStore(testDir);
      expect(store2.get('charge-routine')).not.toBeNull();
      expect(store2.get('charge-reviewed')).not.toBeNull();
      expect(store2.getAll()).toHaveLength(2);
    });
  });

  // ── ExecutionLog persistence ─────────────────────────────────────────────────

  describe('Execution Log persistence', () => {
    it('execution log entries survive re-instantiation from same directory', () => {
      const entry = makeLogEntry();

      const log1 = new ExecutionLog(testDir);
      log1.record(entry);

      const log2 = new ExecutionLog(testDir);
      expect(log2.size).toBe(1);

      const all = log2.getAll();
      expect(all[0].profileId).toBe(entry.profileId);
      expect(all[0].path).toBe(entry.path);
      expect(all[0].execution.amount).toBe(42);
    });

    it('sumByWindow returns correct values after re-instantiation', () => {
      const profileId = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';
      const path = 'charge-routine';
      const now = Math.floor(Date.now() / 1000);

      const log1 = new ExecutionLog(testDir);
      log1.record(makeLogEntry({ execution: { amount: 30 }, timestamp: now - 100 }));
      log1.record(makeLogEntry({ execution: { amount: 50 }, timestamp: now - 200 }));

      // Re-instantiate and verify cumulative sum is intact
      const log2 = new ExecutionLog(testDir);
      const dailyTotal = log2.sumByWindow(profileId, path, 'amount', 'daily', now);
      expect(dailyTotal).toBe(80);

      const dailyCount = log2.sumByWindow(profileId, path, '_count', 'daily', now);
      expect(dailyCount).toBe(2);
    });

    it('multiple records across paths survive re-instantiation', () => {
      const profileId = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';
      const now = Math.floor(Date.now() / 1000);

      const log1 = new ExecutionLog(testDir);
      log1.record(makeLogEntry({ path: 'charge-routine', execution: { amount: 10 }, timestamp: now - 50 }));
      log1.record(makeLogEntry({ path: 'charge-reviewed', execution: { amount: 200 }, timestamp: now - 50 }));

      const log2 = new ExecutionLog(testDir);
      expect(log2.size).toBe(2);
      expect(log2.sumByWindow(profileId, 'charge-routine', 'amount', 'daily', now)).toBe(10);
      expect(log2.sumByWindow(profileId, 'charge-reviewed', 'amount', 'daily', now)).toBe(200);
    });
  });

  // ── Encrypted persistence ────────────────────────────────────────────────────

  describe('Encrypted persistence', () => {
    it('gate store with vault key persists encrypted, restores with same key', () => {
      const vaultKey = makeVaultKey();
      const entry = makeEntry();

      const store1 = new GateStore(testDir);
      store1.setVaultKey(vaultKey);
      store1.set('charge-routine', entry);

      // Verify encrypted file exists
      expect(existsSync(join(testDir, 'gates.enc.json'))).toBe(true);
      // Verify plaintext file does not exist
      expect(existsSync(join(testDir, 'gates.json'))).toBe(false);

      // Re-instantiate with the same vault key
      const store2 = new GateStore(testDir);
      store2.setVaultKey(vaultKey);

      const retrieved = store2.get('charge-routine');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.gateContent.problem).toBe(entry.gateContent.problem);
      expect(retrieved!.boundsHash).toBe(entry.boundsHash);
      expect(retrieved!.contextHash).toBe(entry.contextHash);
      expect(retrieved!.context).toEqual({ currency: 'USD', action_type: 'charge' });
    });

    it('execution log with vault key persists encrypted, restores with same key', () => {
      const vaultKey = makeVaultKey();
      const profileId = 'github.com/humanagencyprotocol/hap-profiles/charge@0.4';
      const path = 'charge-routine';
      const now = Math.floor(Date.now() / 1000);

      const log1 = new ExecutionLog(testDir);
      log1.setVaultKey(vaultKey);
      log1.record(makeLogEntry({ execution: { amount: 75 }, timestamp: now - 60 }));
      log1.record(makeLogEntry({ execution: { amount: 25 }, timestamp: now - 30 }));

      // Encrypted file exists, plaintext does not
      expect(existsSync(join(testDir, 'execution-log.enc.json'))).toBe(true);
      expect(existsSync(join(testDir, 'execution-log.json'))).toBe(false);

      // Re-instantiate with same key
      const log2 = new ExecutionLog(testDir);
      log2.setVaultKey(vaultKey);

      expect(log2.size).toBe(2);
      const dailyTotal = log2.sumByWindow(profileId, path, 'amount', 'daily', now);
      expect(dailyTotal).toBe(100);

      const dailyCount = log2.sumByWindow(profileId, path, '_count', 'daily', now);
      expect(dailyCount).toBe(2);
    });
  });
});
