/**
 * ReportStore — the one current evidence-backed report (work-plan
 * "evidence-backed reports", R5 gateway frame half). Verifies:
 *  - plaintext until a vault key is set, then AES-256-GCM encrypted (mirrors
 *    GateStore/ReceiptArchive's own tested pattern)
 *  - saveReport() replaces the previous report (never accumulates a history)
 *  - saveReport() runs verifyReport EXACTLY ONCE per call and stores the result
 *  - recheck() re-verifies the STORED html and updates checkedAt without
 *    touching savedAt or needing a new html argument
 *  - getReport()/isLocked() never claim "no report" over unreadable evidence
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ReportStore } from '../../src/lib/report/report-store';
import { buildScenario } from './fixtures/scenario';
import { buildEmailExport } from './fixtures/exports';
import type { ReportSources, RunConnectorExport } from '../../src/lib/report/types';

function makeVaultKey(): Buffer {
  return randomBytes(32);
}

function makeSources(runExport: RunConnectorExport, archive: ReportSources['archive']): ReportSources {
  return { archive, runExport };
}

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'suveren-report-store-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('ReportStore', () => {
  it('starts with no report and is not locked when no file exists', () => {
    const store = new ReportStore(testDir);
    expect(store.isLocked()).toBe(false);
    expect(store.getReport()).toBeNull();
  });

  it('saveReport verifies once and stores the result, readable immediately', async () => {
    const { archive } = buildScenario();
    const runExport = vi.fn(async () => buildEmailExport());
    const store = new ReportStore(testDir);

    const stored = await store.saveReport('<p>hello</p>', makeSources(runExport, archive), 1_000);

    expect(stored.html).toContain('hello');
    expect(stored.savedAt).toBe(1_000);
    expect(stored.checkedAt).toBe(1_000);
    expect(stored.result.elements).toEqual([]);
    expect(store.getReport()).toEqual(stored);
    // Coverage always checks loaded cases against the email export, even
    // when the report places no sv-case/sv-record — exactly once per save.
    expect(runExport).toHaveBeenCalledTimes(1);
    expect(runExport).toHaveBeenCalledWith('email');
  });

  it('saveReport REPLACES the previous report — never accumulates a history', async () => {
    const { archive } = buildScenario();
    const runExport = async () => buildEmailExport();
    const store = new ReportStore(testDir);

    await store.saveReport('<p>first</p>', makeSources(runExport, archive), 1_000);
    const second = await store.saveReport('<p>second</p>', makeSources(runExport, archive), 2_000);

    expect(second.html).toContain('second');
    expect(second.savedAt).toBe(2_000);
    const reopened = new ReportStore(testDir);
    expect(reopened.getReport()?.html).toContain('second');
    expect(reopened.getReport()?.html).not.toContain('first');
  });

  it('recheck() re-verifies the stored html and moves checkedAt without changing savedAt', async () => {
    const { archive, addTicket } = buildScenario();
    const runExport = async () => buildEmailExport();
    const store = new ReportStore(testDir);

    await store.saveReport('<sv-ticket ref="ghost"></sv-ticket>', makeSources(runExport, archive), 1_000);
    expect(store.getReport()?.result.elements[0].status).toBe('unverifiable');

    // The ticket now exists in the archive — a recheck must pick that up
    // without the AI rewriting the report.
    addTicket({ id: 'ghost', action: 'erp__create_quote', authorizationId: 'authz-1' });
    const rechecked = await store.recheck(makeSources(runExport, archive), 2_000);

    expect(rechecked?.savedAt).toBe(1_000); // unchanged — the AI did not rewrite
    expect(rechecked?.checkedAt).toBe(2_000);
    expect(rechecked?.result.elements[0].status).toBe('verified');
  });

  it('recheck() returns null when there is no report to recheck', async () => {
    const { archive } = buildScenario();
    const store = new ReportStore(testDir);
    const result = await store.recheck(makeSources(async () => buildEmailExport(), archive));
    expect(result).toBeNull();
  });

  it('persists plaintext until a vault key is set, then migrates to encrypted', async () => {
    const { archive } = buildScenario();
    const store = new ReportStore(testDir);
    await store.saveReport('<p>secret-ish</p>', makeSources(async () => buildEmailExport(), archive), 1_000);

    expect(existsSync(join(testDir, 'report.json'))).toBe(true);
    expect(existsSync(join(testDir, 'report.enc.json'))).toBe(false);
    const plaintext = readFileSync(join(testDir, 'report.json'), 'utf-8');
    expect(plaintext).toContain('secret-ish');

    store.setVaultKey(makeVaultKey());

    expect(existsSync(join(testDir, 'report.enc.json'))).toBe(true);
    expect(existsSync(join(testDir, 'report.json'))).toBe(false); // plaintext removed after migration
    const encrypted = readFileSync(join(testDir, 'report.enc.json'), 'utf-8');
    expect(encrypted).not.toContain('secret-ish');
  });

  it('isLocked() is true when an encrypted file exists but no vault key has been set yet', async () => {
    const { archive } = buildScenario();
    const key = makeVaultKey();
    const writer = new ReportStore(testDir);
    writer.setVaultKey(key); // no report yet — nothing to encrypt
    await writer.saveReport('<p>x</p>', makeSources(async () => buildEmailExport(), archive), 1_000);

    const reopened = new ReportStore(testDir);
    expect(reopened.isLocked()).toBe(true);
    // MUST NOT claim "no report" over unreadable evidence.
    expect(reopened.getReport()).toBeNull();

    reopened.setVaultKey(key);
    expect(reopened.isLocked()).toBe(false);
    expect(reopened.getReport()?.html).toContain('x');
  });

  it('a corrupt plaintext file is preserved aside, never overwritten silently', () => {
    const path = join(testDir, 'report.json');
    writeFileSync(path, '{not json', 'utf-8');
    const store = new ReportStore(testDir);
    expect(store.getReport()).toBeNull();
    const siblings = readdirSync(testDir);
    expect(siblings.some((f: string) => f.startsWith('report.json.corrupt-'))).toBe(true);
  });
});
