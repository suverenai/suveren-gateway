/**
 * `setup__set_agent_brief` (simulation setup S7): the AI proposes a new agent
 * brief; a person approves; only then is context.md replaced, and the next
 * session's brief carries it. Governed by the review-only delegation profile
 * through the real tool-proxy and committed executor (stubbed AS + cache, as in
 * builtin-integration.test.ts).
 *
 * - outside simulation mode: refused before anything is requested;
 * - too large or empty: refused before anything is requested (no proposal a
 *   person would approve in vain);
 * - the call becomes a proposal and the brief is unchanged until approval;
 * - after approval the brief is replaced and the next session brief shows it;
 * - the handler checks again at execution (mode switched off meanwhile).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'gw-setup-brief-'));
process.env.SUVEREN_DATA_DIR = dataDir; // context-loader reads it at import

const { registerProfile } = await import('@hap/core');
const { IntegrationManager } = await import('../src/lib/integration-manager');
const { registerBuiltins } = await import('../src/lib/builtins');
const { createGatedToolHandler } = await import('../src/lib/tool-proxy');
const { executeCommitted } = await import('../src/tools/commitments');
const { hashToolArgs } = await import('../src/lib/execution-journal');
const { buildMandateBrief } = await import('../src/lib/mandate-brief');
const { writeContextFile, CONTEXT_MAX_BYTES } = await import('../src/lib/context-loader');
const { testReceiptKeypair, makeSignedReceipt } = await import('./helpers/real-receipt');
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { SPProposal } from '../src/lib/sp-client';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const DELEGATION = JSON.parse(readFileSync(join(profilesDir, 'delegation', '0.1.profile.json'), 'utf8'));
const BRIEF = join(dataDir, 'context.md');

beforeAll(() => registerProfile(DELEGATION.id, DELEGATION));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
afterEach(() => { delete process.env.SUVEREN_SIMULATION; rmSync(BRIEF, { force: true }); });

const AUTH = {
  authorizationId: 'authz_d0000000-0000-4000-8000-000000000001',
  profileId: DELEGATION.id, path: 'p',
  frame: { read_access: 'unlimited', brief_daily_max: 2, mandate_daily_max: 0 },
  bounds: { read_access: 'unlimited', brief_daily_max: 2, mandate_daily_max: 0 },
  context: {}, attestations: [], requiredDomains: [], attestedDomains: [],
  deferredCommitmentDomains: ['owner'], signedCommitmentMode: 'review', complete: true, gateContent: null,
} as unknown as EnrichedAuthorization;

function setup() {
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: Record<string, any>) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'ticket-brief', action: req.action, executionContext: req.executionContext ?? {},
      authorizationId: req.authorizationId, profileId: DELEGATION.id, proposalId: req.proposalId,
      contentHash: req.contentHash, contentBinding: req.contentBinding,
    }),
  }));
  const submissions = new Map<string, any>();
  const submitProposal = vi.fn().mockImplementation(async (p: Record<string, any>) => ({ proposal: { id: 'prop-brief', ...p } }));
  const state = {
    getEnrichedAuthorizations: () => [AUTH],
    spClient: { postReceipt, submitProposal, isUnlocked: () => true },
    cache: { invalidate: vi.fn(), getPublicKey: async () => kp.publicKeyHex, getAllAuthorizations: () => [AUTH] },
    gatekeeper: { verifyExecution: vi.fn().mockResolvedValue({ result: { approved: true, errors: [] } }) },
    proposalSubmissions: {
      record: (r: Record<string, any>) => submissions.set(r.proposalId, {
        ...r, toolArgsHash: hashToolArgs(r.toolArgs), executionContextHash: hashToolArgs(r.executionContext),
        submittedAt: Math.floor(Date.now() / 1000),
      }),
      get: (id: string) => submissions.get(id),
    },
    executionLog: { record: vi.fn(), getAll: () => [], sumByWindow: () => 0, countByWindow: () => 0 },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  const im = new IntegrationManager();
  expect(registerBuiltins({ state, integrationManager: im })).toEqual(['setup']);
  const tool = im.getAllTools().find((t) => t.namespacedName === 'setup__set_agent_brief')!;
  const call = (args: Record<string, unknown>) => createGatedToolHandler(tool, im, state)(args);
  const approve = () => {
    const sent = submitProposal.mock.calls.at(-1)![0];
    return executeCommitted({
      id: 'prop-brief', authorizationId: sent.authorizationId, profileId: sent.profileId, path: sent.path,
      pendingDomains: [], committedBy: { owner: { userId: 'u', at: 0 } }, rejectedBy: null,
      tool: sent.tool, toolArgs: sent.toolArgs, executionContext: sent.executionContext,
      status: 'committed', executionResult: null, createdAt: 0, expiresAt: 0,
    } as SPProposal, state, im);
  };
  return { im, state, call, approve, postReceipt, submitProposal };
}

describe('setup__set_agent_brief', () => {
  it('outside simulation mode: refused before anything is requested', async () => {
    const { call, submitProposal, postReceipt } = setup();
    const r = await call({ content: '# Brief' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not available/);
    expect(submitProposal).not.toHaveBeenCalled();
    expect(postReceipt).not.toHaveBeenCalled();
  });

  it.each([
    ['too large', 'x'.repeat(CONTEXT_MAX_BYTES + 1), /limit is 16384/],
    ['empty', '   ', /complete new brief/],
  ])('%s: refused before anything is requested', async (_label, content, msg) => {
    process.env.SUVEREN_SIMULATION = '1';
    const { call, submitProposal } = setup();
    const r = await call({ content });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(msg);
    expect(submitProposal).not.toHaveBeenCalled();
  });

  it('becomes a proposal; the brief changes only after approval and the next session sees it', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    writeContextFile('# Old brief');
    const { im, state, call, approve, postReceipt } = setup();

    const r = await call({ content: '# New brief\n\nAnswer quote requests the same day.' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/Awaiting commitment/);
    expect(readFileSync(BRIEF, 'utf8')).toBe('# Old brief');
    expect(postReceipt).not.toHaveBeenCalled();

    const done = await approve();
    expect(done.isError, done.text).toBeFalsy();
    expect(postReceipt).toHaveBeenCalledWith(expect.objectContaining({ action: 'setup__set_agent_brief', actionType: 'brief' }));
    expect(readFileSync(BRIEF, 'utf8')).toBe('# New brief\n\nAnswer quote requests the same day.');

    const next = buildMandateBrief({ authorizations: [], executionLog: state.executionLog, integrationManager: im });
    expect(next).toContain('Answer quote requests the same day.');
  });

  it('checks again at execution: simulation mode switched off after the proposal → nothing written', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const { call, approve } = setup();
    await call({ content: '# New brief' });
    delete process.env.SUVEREN_SIMULATION;
    await approve();
    expect(existsSync(BRIEF)).toBe(false);
  });
});
