/**
 * The usage an AI is shown counts each limit by its own action types — also after an approved
 * (review-mode) action, and a limit of 0 is not shown at all.
 *
 * Found 2026-11-11 on an Email mandate: list-authorizations showed "Usage: 0/5 daily, 0/0 daily" and
 * "Test-data loads per day: 1 / 0" after one approved send. v0.8 keeps `action_type` out of the
 * proposal's wire context (it travels as the proposal's own `actionType`); the review path recorded
 * that wire context as is, and the log counts an entry without an action type against every limit.
 *
 * Real ExecutionLog, the shipped email profile, the real executeCommitted; only the Authority Server
 * and the connector are stand-ins (a signed test ticket, a tool that answers "sent").
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile } from '@hap/core';
import { ExecutionLog } from '../src/lib/execution-log';
import { ExecutionJournal, hashToolArgs } from '../src/lib/execution-journal';
import { getConsumptionState, formatConsumptionCompact, formatConsumptionFull } from '../src/lib/consumption';
import { executeCommitted } from '../src/tools/commitments';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { SPProposal } from '../src/lib/sp-client';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const EMAIL = JSON.parse(readFileSync(join(profilesDir, 'email', '0.10.profile.json'), 'utf8')) as AgentProfile;

const PROPOSAL: SPProposal = {
  id: 'prop-send',
  authorizationId: 'authz_mail',
  profileId: EMAIL.id,
  path: 'mail',
  pendingDomains: [],
  committedBy: { owner: { userId: 'u', at: 0 } },
  rejectedBy: null,
  tool: 'mail__send_message',
  toolArgs: { to: 'a@example.com', body: 'hi' },
  // v0.8 wire context: no action_type in it.
  executionContext: { recipient_count: 1 },
  status: 'committed',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
};

const TOOL: DiscoveredTool = {
  originalName: 'send_message',
  namespacedName: 'mail__send_message',
  integrationId: 'mail',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  gating: { profile: 'email', executionMapping: {}, staticExecution: { action_type: 'send' } } as unknown as DiscoveredTool['gating'],
};

const AUTH = {
  profileId: EMAIL.id,
  path: 'mail',
  frame: { profile: EMAIL.id, read_access: 'unlimited', recipient_max: 1, send_daily_max: 5, setup_daily_max: 0 },
} as unknown as EnrichedAuthorization;

async function approveOneSend(log: ExecutionLog): Promise<void> {
  const kp = testReceiptKeypair();
  const receipt = makeSignedReceipt(kp, {
    id: 'rcpt-send', action: PROPOSAL.tool, actionType: 'send', executionContext: PROPOSAL.executionContext,
    authorizationId: PROPOSAL.authorizationId, profileId: PROPOSAL.profileId, proposalId: PROPOSAL.id,
  });
  const dir = mkdtempSync(join(tmpdir(), 'usage-review-'));
  const state = {
    spClient: { postReceipt: vi.fn().mockResolvedValue({ receipt, idempotent: false }), isUnlocked: () => true },
    cache: { getAllAuthorizations: () => [], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    // This gateway's own record of the submission: where v0.8 keeps the action type.
    proposalSubmissions: {
      get: () => ({
        proposalId: PROPOSAL.id, tool: PROPOSAL.tool, actionType: 'send',
        toolArgsHash: hashToolArgs(PROPOSAL.toolArgs), executionContextHash: hashToolArgs(PROPOSAL.executionContext),
        authorizationId: PROPOSAL.authorizationId, profileId: PROPOSAL.profileId, submittedAt: Math.floor(Date.now() / 1000),
      }),
      record: vi.fn(),
    },
    executionLog: log,
    executionJournal: new ExecutionJournal(dir),
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  const im = {
    getAllTools: () => [TOOL],
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'sent' }] }),
  } as unknown as IntegrationManager;
  const r = await executeCommitted(PROPOSAL, state, im);
  expect(r.isError, r.text).toBeFalsy();
}

describe('usage after an approved send (review mode, v0.8 wire)', () => {
  it('the log entry carries the action type, so the send counts against the send limit only', async () => {
    const log = new ExecutionLog(mkdtempSync(join(tmpdir(), 'usage-log-')));
    await approveOneSend(log);
    const usage = Object.fromEntries(getConsumptionState(AUTH, log, EMAIL).map(e => [e.field, e.current]));
    expect(usage.send_daily_max).toBe(1);
    expect(usage.setup_daily_max).toBe(0);
  });

  it('a limit of 0 (an action this mandate does not allow) is not shown as usage', async () => {
    const log = new ExecutionLog(mkdtempSync(join(tmpdir(), 'usage-log-')));
    await approveOneSend(log);
    const entries = getConsumptionState(AUTH, log, EMAIL);
    expect(formatConsumptionCompact(entries)).toBe('1/5 daily');
    const full = formatConsumptionFull(entries);
    expect(full).toMatch(/Daily send limit:\s+1 \/ 5/);
    expect(full).not.toContain('Test-data loads per day');
  });
});
