/**
 * "From your gateway" on the change card: the refusals this gateway itself recorded
 * that the proposed change would have allowed. Only the gateway's denial log and the
 * sealed differences are read; the AI adds nothing. Real email@0.9 profile, real
 * DenialLog and ExecutionLog on a temp folder.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { computeMandateDiff, type ChangeProfile, type MandateDiff } from '@hap/core/mandate-change';
import { changeFacts } from '../src/lib/mandate-change';
import { DenialLog, type DenialRecord } from '../src/lib/denial-log';
import { ExecutionLog } from '../src/lib/execution-log';
import type { SharedState } from '../src/lib/shared-state';

const profilesDir = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const EMAIL = JSON.parse(readFileSync(join(profilesDir, 'email', '0.9.profile.json'), 'utf8'));
const ID = 'authz_change-facts-1';
const OTHER = 'authz_change-facts-other';

let dir: string;
let denials: DenialLog;
let state: SharedState;

beforeAll(() => { registerProfile(EMAIL.id, EMAIL); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'change-facts-'));
  denials = new DenialLog(dir);
  state = {
    getEnrichedAuthorizations: () => [{ authorizationId: ID, profileId: EMAIL.id, path: 'email', attestations: [], frame: BOUNDS, bounds: BOUNDS, context: {}, complete: true }],
    denialLog: denials,
    executionLog: new ExecutionLog(join(dir, 'execution-log.json')),
    proposalSubmissions: { list: () => [] },
    spClient: { getProposal: async () => null },
  } as unknown as SharedState;
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const BOUNDS = { profile: EMAIL.id, read_access: 'unlimited', recipient_max: 3, send_daily_max: 50, read_max_age_days: 30, setup_daily_max: 0 };
const side = (scope: Record<string, string>, bounds: Record<string, string | number> = BOUNDS) =>
  ({ profile: EMAIL as ChangeProfile, bounds, scope, intent: 'Why.', mode: 'review', expiresAt: 1000 });
const diff = (before: Record<string, string>, after: Record<string, string>): MandateDiff => computeMandateDiff({ before: side(before), after: side(after) });

function refusal(over: Partial<DenialRecord>): void {
  denials.record({
    ts: Date.now(), tool: 'send_message', integrationId: 'mail', profile: 'email', kind: 'scope', detail: 'x',
    field: 'allowed_attachment_sources', value: 'files:file', mandateId: ID, who: 'gateway', code: 'BOUND_EXCEEDED', ...over,
  });
}

describe('refusals the change would have allowed', () => {
  it('a saved file refused under this mandate shows when the change adds Saved files', async () => {
    const ts = Date.now() - 60_000;
    refusal({ ts });
    const f = await changeFacts(state, ID, diff({}, { allowed_attachment_sources: 'files:file' }));
    expect(f.refused).toEqual([{ field: 'allowed_attachment_sources', ts, values: ['files:file'] }]);
  });

  it('only refusals this change would have allowed: not another source, not a removal', async () => {
    refusal({ value: 'erp:invoice-pdf' });
    expect((await changeFacts(state, ID, diff({}, { allowed_attachment_sources: 'files:file' }))).refused).toEqual([]);
    refusal({ value: 'files:file' });
    expect((await changeFacts(state, ID, diff({ allowed_attachment_sources: 'files:file,erp:invoice-pdf' }, { allowed_attachment_sources: 'erp:invoice-pdf' }))).refused).toEqual([]);
  });

  it('another mandate\'s refusal does not count; one that names no mandate counts by its area', async () => {
    refusal({ mandateId: OTHER });
    expect((await changeFacts(state, ID, diff({}, { allowed_attachment_sources: 'files:file' }))).refused).toEqual([]);
    refusal({ mandateId: undefined, profile: 'email' });
    expect((await changeFacts(state, ID, diff({}, { allowed_attachment_sources: 'files:file' }))).refused).toHaveLength(1);
  });

  it('at most two, newest first; older than a week is left out', async () => {
    const now = Date.now();
    refusal({ ts: now - 8 * 86_400_000 });
    refusal({ ts: now - 3000 });
    refusal({ ts: now - 1000 });
    refusal({ ts: now - 2000 });
    const f = await changeFacts(state, ID, diff({}, { allowed_attachment_sources: 'files:file' }));
    expect(f.refused.map((r) => r.ts)).toEqual([now - 1000, now - 2000]);
  });

  it('a recipient the change adds, and an amount the new limit covers, count too', async () => {
    refusal({ field: 'allowed_recipients', value: 'Bob@Partner.example' });
    const r = await changeFacts(state, ID, diff({ allowed_recipients: 'anna@partner.example' }, { allowed_recipients: 'anna@partner.example,bob@partner.example' }));
    expect(r.refused).toEqual([expect.objectContaining({ field: 'allowed_recipients', values: ['bob@partner.example'] })]);

    // recipient_max is checked on the execution field recipient_count.
    refusal({ kind: 'bound', field: 'recipient_count', value: 6 });
    refusal({ kind: 'bound', field: 'recipient_count', value: 5 });
    const raised = computeMandateDiff({ before: side({}), after: side({}, { ...BOUNDS, recipient_max: 5 }) });
    const n = await changeFacts(state, ID, raised);
    expect(n.refused).toEqual([expect.objectContaining({ field: 'recipient_max', value: 5 })]);
  });

  it('nothing recorded, nothing shown', async () => {
    expect((await changeFacts(state, ID, diff({}, { allowed_attachment_sources: 'files:file' }))).refused).toEqual([]);
  });
});
