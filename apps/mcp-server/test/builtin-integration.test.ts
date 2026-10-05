/**
 * Built-in integrations: tools the gateway implements itself, governed exactly
 * like a connector's (simulation setup S4). The subject is the real
 * IntegrationManager + the real tool-proxy and committed executor; only the
 * Authority Server and the local mandate cache are stubbed, as in
 * mandate-fallback.test.ts and commit-review-parity.test.ts.
 *
 * What must hold:
 * - a built-in tool without a matching mandate is refused — no ticket, the
 *   handler never runs — and is not listed to the agent;
 * - under a review-mode mandate (delegation@0.1 is review only) the call only
 *   becomes a proposal; the handler runs after approval, through the committed
 *   executor, with the ticket's id;
 * - under an automatic mandate (reporting@0.1) it runs with a ticket, like a
 *   connector tool — a second profile plugs in without code changes;
 * - simulation mode refuses a built-in unless it declares `simulation: true`;
 * - a built-in never appears in the connector status list, and cannot take an
 *   id a connector already uses.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { IntegrationManager } from '../src/lib/integration-manager';
import { builtinText, type BuiltinIntegration } from '../src/lib/builtin-integration';
import { createGatedToolHandler, toolIsAuthorizedForDisplay } from '../src/lib/tool-proxy';
import { executeCommitted } from '../src/tools/commitments';
import { hashToolArgs } from '../src/lib/execution-journal';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { SPProposal } from '../src/lib/sp-client';
import type { ReportSources } from '../src/lib/report';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const load = (rel: string) => JSON.parse(readFileSync(join(profilesDir, rel), 'utf8'));
const DELEGATION = load('delegation/0.1.profile.json');
const REPORTING = load('reporting/0.1.profile.json');

beforeAll(() => {
  registerProfile(DELEGATION.id, DELEGATION);
  registerProfile(REPORTING.id, REPORTING);
});

afterEach(() => {
  delete process.env.SUVEREN_SIMULATION;
});

/** A delegation built-in with one review-only write tool (like S7's brief tool). */
function delegationBuiltin(handler = vi.fn(async (args: Record<string, unknown>) => builtinText(`brief set (${String(args.receipt_id)})`)), simulation = true): {
  def: BuiltinIntegration; handler: typeof handler;
} {
  return {
    handler,
    def: {
      id: 'setup',
      name: 'Setup',
      profile: DELEGATION.id,
      simulation,
      toolGating: {
        overrides: {
          propose_brief: {
            executionMapping: {},
            staticExecution: { action_type: 'brief' },
            hideUnlessAuthorized: true,
          },
        },
      } as unknown as BuiltinIntegration['toolGating'],
      tools: [{
        name: 'propose_brief',
        description: 'Propose a new agent brief.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' }, receipt_id: { type: 'string' } },
          required: ['text'],
        },
        handler,
      }],
    },
  };
}

function auth(profileId: string, bounds: Record<string, unknown>, review: boolean): EnrichedAuthorization {
  return {
    authorizationId: `authz_${profileId.includes('delegation') ? 'd' : 'r'}0000000-0000-4000-8000-000000000001`,
    profileId,
    path: 'p',
    frame: bounds,
    bounds,
    context: {},
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    deferredCommitmentDomains: review ? ['owner'] : [],
    signedCommitmentMode: review ? 'review' : 'automatic',
    complete: true,
    gateContent: null,
  } as unknown as EnrichedAuthorization;
}

function buildState(enriched: EnrichedAuthorization[]) {
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: Record<string, any>) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'ticket-1',
      action: req.action,
      executionContext: req.executionContext ?? {},
      authorizationId: req.authorizationId,
      profileId: req.profileId ?? enriched[0]?.profileId,
      idempotencyKey: req.idempotencyKey,
      proposalId: req.proposalId,
      contentHash: req.contentHash,
      contentBinding: req.contentBinding,
    }),
  }));
  const submissions = new Map<string, any>();
  const submitProposal = vi.fn().mockImplementation(async (p: Record<string, any>) => ({
    proposal: { id: 'prop-1', ...p },
  }));
  const state = {
    getEnrichedAuthorizations: () => enriched,
    spClient: { postReceipt, submitProposal, isUnlocked: () => true },
    cache: {
      invalidate: vi.fn(),
      getPublicKey: async () => kp.publicKeyHex,
      getAllAuthorizations: () => enriched,
    },
    gatekeeper: { verifyExecution: vi.fn().mockResolvedValue({ result: { approved: true, errors: [] } }) },
    proposalSubmissions: {
      record: (r: Record<string, any>) => submissions.set(r.proposalId, {
        ...r,
        toolArgsHash: hashToolArgs(r.toolArgs),
        executionContextHash: hashToolArgs(r.executionContext),
        submittedAt: Math.floor(Date.now() / 1000),
      }),
      get: (id: string) => submissions.get(id),
    },
    executionLog: { record: vi.fn() },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  return { state, postReceipt, submitProposal };
}

const DELEGATION_SETUP_BOUNDS = { read_access: 'unlimited', brief_daily_max: 2, mandate_daily_max: 0 };

describe('registerBuiltin', () => {
  it('turns each tool into a gated <id>__<tool> tool', () => {
    const im = new IntegrationManager();
    im.registerBuiltin(delegationBuiltin().def);
    const tool = im.getAllTools().find((t) => t.namespacedName === 'setup__propose_brief')!;
    expect(tool.integrationId).toBe('setup');
    expect(tool.gating).toMatchObject({ profile: DELEGATION.id, staticExecution: { action_type: 'brief' }, hideUnlessAuthorized: true });
    expect(im.isBuiltin('setup')).toBe(true);
  });

  it('a tool the gating does not describe is refused at the gating layer', () => {
    const im = new IntegrationManager();
    const { def } = delegationBuiltin();
    def.tools.push({ name: 'undescribed', description: '', inputSchema: { type: 'object' }, handler: vi.fn() });
    im.registerBuiltin(def);
    expect(im.getAllTools().find((t) => t.originalName === 'undescribed')!.gating).toMatchObject({ category: 'disabled' });
  });

  it.each([
    ['an id with __', 'a__b'],
    ['an uppercase id', 'Setup'],
    ['an id already in use', 'erp'],
  ])('refuses %s', (_label, id) => {
    const im = new IntegrationManager();
    if (id === 'erp') {
      // A second registration under the same id is the in-process stand-in for a taken id.
      im.registerBuiltin({ ...delegationBuiltin().def, id: 'erp' });
    }
    expect(() => im.registerBuiltin({ ...delegationBuiltin().def, id })).toThrow(/must be lowercase|already in use/);
  });

  it('never appears in the connector status list', () => {
    const im = new IntegrationManager();
    im.registerBuiltin(delegationBuiltin().def);
    expect(im.getStatus([]).map((s) => s.id)).not.toContain('setup');
  });
});

describe('a built-in tool goes through the same gate as a connector tool', () => {
  it('no matching mandate: refused, no ticket, handler never runs — and not listed', async () => {
    const im = new IntegrationManager();
    const { def, handler } = delegationBuiltin();
    im.registerBuiltin(def);
    const tool = im.getAllTools()[0];
    const { state, postReceipt, submitProposal } = buildState([]);

    const r = await createGatedToolHandler(tool, im, state)({ text: 'new brief' });
    expect(r.isError).toBe(true);
    expect(postReceipt).not.toHaveBeenCalled();
    expect(submitProposal).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(toolIsAuthorizedForDisplay(tool, [])).toBe(false);
  });

  it('a mandate whose limit for this action is 0 does not list the tool', () => {
    const im = new IntegrationManager();
    im.registerBuiltin(delegationBuiltin().def);
    const tool = im.getAllTools()[0];
    expect(toolIsAuthorizedForDisplay(tool, [auth(DELEGATION.id, { ...DELEGATION_SETUP_BOUNDS, brief_daily_max: 0 }, true)])).toBe(false);
    expect(toolIsAuthorizedForDisplay(tool, [auth(DELEGATION.id, DELEGATION_SETUP_BOUNDS, true)])).toBe(true);
  });

  it('review mandate (delegation): the call only becomes a proposal; after approval the handler runs with the ticket', async () => {
    const im = new IntegrationManager();
    const { def, handler } = delegationBuiltin();
    im.registerBuiltin(def);
    const tool = im.getAllTools()[0];
    const { state, postReceipt, submitProposal } = buildState([auth(DELEGATION.id, DELEGATION_SETUP_BOUNDS, true)]);

    const r = await createGatedToolHandler(tool, im, state)({ text: 'new brief' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/Awaiting commitment/);
    expect(submitProposal).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'setup__propose_brief', executionContext: expect.objectContaining({ action_type: 'brief' }),
    }));
    expect(postReceipt).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();

    // A person approved it: the committed executor runs it (any trigger).
    const sent = submitProposal.mock.calls[0][0];
    const proposal = {
      id: 'prop-1', authorizationId: sent.authorizationId, profileId: sent.profileId, path: sent.path,
      pendingDomains: [], committedBy: { owner: { userId: 'u', at: 0 } }, rejectedBy: null,
      tool: sent.tool, toolArgs: sent.toolArgs, executionContext: sent.executionContext,
      status: 'committed', executionResult: null, createdAt: 0, expiresAt: 0,
    } as SPProposal;
    const done = await executeCommitted(proposal, state, im);
    expect(done.isError).toBeFalsy();
    expect(postReceipt).toHaveBeenCalledWith(expect.objectContaining({ proposalId: 'prop-1', action: 'setup__propose_brief' }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ text: expect.stringContaining('new brief'), receipt_id: 'ticket-1' });
  });

  it('automatic mandate (reporting): a second profile plugs in unchanged and runs with a ticket', async () => {
    const im = new IntegrationManager();
    const write = vi.fn(async () => builtinText('report stored'));
    im.registerBuiltin({
      id: 'report',
      name: 'Report',
      profile: REPORTING.id,
      simulation: true,
      toolGating: { overrides: { write_report: { executionMapping: {}, staticExecution: { action_type: 'report' } } } } as unknown as BuiltinIntegration['toolGating'],
      tools: [{
        name: 'write_report', description: 'Store the report.',
        inputSchema: { type: 'object', properties: { html: { type: 'string' }, receipt_id: { type: 'string' } } },
        handler: write,
      }],
    });
    const tool = im.getAllTools()[0];
    const { state, postReceipt } = buildState([auth(REPORTING.id, { read_access: 'unlimited', report_daily_max: 3 }, false)]);

    const r = await createGatedToolHandler(tool, im, state)({ html: '<p>x</p>' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(postReceipt).toHaveBeenCalledWith(expect.objectContaining({ action: 'report__write_report', actionType: 'report' }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({ receipt_id: 'ticket-1' });
  });

  it('a handler that throws is reported as a failed call', async () => {
    const im = new IntegrationManager();
    im.registerBuiltin(delegationBuiltin(vi.fn(async () => { throw new Error('disk full'); })).def);
    const r = await im.callTool('setup', 'propose_brief', { text: 'x' });
    expect(r).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('disk full') }] });
  });
});

describe('simulation mode', () => {
  it('refuses a built-in that does not declare simulation: true — neutral text, no ticket', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const im = new IntegrationManager();
    const { def, handler } = delegationBuiltin(undefined, false);
    im.registerBuiltin(def);
    const { state, postReceipt, submitProposal } = buildState([auth(DELEGATION.id, DELEGATION_SETUP_BOUNDS, true)]);
    const r = await createGatedToolHandler(im.getAllTools()[0], im, state)({ text: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not available/);
    expect(r.content[0].text).not.toMatch(/simulat/i);
    expect(postReceipt).not.toHaveBeenCalled();
    expect(submitProposal).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a built-in that declares simulation: true through to the normal gate', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const im = new IntegrationManager();
    im.registerBuiltin(delegationBuiltin().def);
    const { state, submitProposal } = buildState([auth(DELEGATION.id, DELEGATION_SETUP_BOUNDS, true)]);
    const r = await createGatedToolHandler(im.getAllTools()[0], im, state)({ text: 'x' });
    expect(r.isError).toBeFalsy();
    expect(submitProposal).toHaveBeenCalledTimes(1);
  });
});

describe('registerBuiltins (start-up registration)', () => {
  it('registers each factory; a failing one is left out and the rest still register', async () => {
    const { registerBuiltins } = await import('../src/lib/builtins');
    const im = new IntegrationManager();
    const ok = () => delegationBuiltin().def;
    const bad = () => ({ ...delegationBuiltin().def, id: 'Bad Id' });
    const ids = registerBuiltins(
      { state: {} as SharedState, integrationManager: im, reportSources: {} as ReportSources },
      [bad, ok],
    );
    expect(ids).toEqual(['setup']);
    expect(im.getAllTools().map((t) => t.namespacedName)).toEqual(['setup__propose_brief']);
  });
});
