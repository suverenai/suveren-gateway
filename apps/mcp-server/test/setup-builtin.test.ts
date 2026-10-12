/**
 * `setup__set_agent_brief` / `setup__create_mandate` (simulation setup S7/S8;
 * DL1 — temp/briefs/dl-delegation-brief.md — took both outside simulation):
 * the AI proposes a new agent brief or a new mandate; a person approves; only
 * then does anything change. Governed by the review-only delegation profile
 * through the real tool-proxy and committed executor (stubbed AS + cache, as
 * in builtin-integration.test.ts).
 *
 * - in simulation mode: unchanged (any held Delegation mandate version works);
 * - outside simulation mode (DL1 decision 1): gated instead by decision 5 — an
 *   unscoped (pre-0.4) Delegation mandate is refused and recorded under
 *   Blocked, a 0.4+ one works;
 * - create_mandate's own scope (DL1 decision 3): a profile or mode outside the
 *   held Delegation mandate's `allowed_profiles`/`allowed_modes` is refused by
 *   the Gatekeeper and recorded under Blocked — no new gating code, just the
 *   manifest's executionMapping;
 * - "delegation" itself can never be proposed (DL1 decision 4), unconditionally;
 * - a full profile id is refused at input validation (DL1 Interface contract);
 * - too large or empty brief: refused before anything is requested (no
 *   proposal a person would approve in vain);
 * - a call becomes a proposal and nothing changes until approval;
 * - after approval the brief/mandate is created and visible accordingly;
 * - describe_mandate_proposal / describe_brief_proposal: the two internal
 *   AU3 preview tools these two declare (DL1 Interface contract).
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
const { computeSubmissionPreviewHash } = await import('../src/lib/preview');
const { testReceiptKeypair, makeSignedReceipt } = await import('./helpers/real-receipt');
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { SPProposal } from '../src/lib/sp-client';
import type { ReportSources } from '../src/lib/report';

// Grading run (and the brief's "Done when") sets SUVEREN_PROFILES_DIR to
// temp/profiles-dl04, which carries delegation 0.4 + sales 0.4 alongside
// every other current profile — that's the ONLY place delegation 0.4 exists
// pre-merge (hap-profiles PR #12), so these tests only run meaningfully there.
const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const DELEGATION = JSON.parse(readFileSync(join(profilesDir, 'delegation', '0.1.profile.json'), 'utf8'));
const DELEGATION_04 = JSON.parse(readFileSync(join(profilesDir, 'delegation', '0.4.profile.json'), 'utf8'));
const SALES_04 = JSON.parse(readFileSync(join(profilesDir, 'sales', '0.4.profile.json'), 'utf8'));
const BRIEF = join(dataDir, 'context.md');

beforeAll(() => {
  registerProfile(DELEGATION.id, DELEGATION);
  registerProfile(DELEGATION_04.id, DELEGATION_04);
  registerProfile(SALES_04.id, SALES_04);
  registerProfile('sales', SALES_04); // short-name lookup, as profile-loader.ts registers it
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
afterEach(() => { delete process.env.SUVEREN_SIMULATION; rmSync(BRIEF, { force: true }); });

/** delegation@0.1 — unscoped: outside simulation, DL1 decision 5 refuses it. */
const AUTH = {
  authorizationId: 'authz_d0000000-0000-4000-8000-000000000001',
  profileId: DELEGATION.id, path: 'p',
  frame: { read_access: 'unlimited', brief_daily_max: 2, mandate_daily_max: 2 },
  bounds: { read_access: 'unlimited', brief_daily_max: 2, mandate_daily_max: 2 },
  context: {}, attestations: [], requiredDomains: [], attestedDomains: [],
  deferredCommitmentDomains: ['owner'], signedCommitmentMode: 'review', complete: true, gateContent: null,
} as unknown as EnrichedAuthorization;

/** delegation@0.4 — scoped to propose "sales" in review/automatic mode: works outside simulation. */
const AUTH_04 = {
  authorizationId: 'authz_d0000000-0000-4000-8000-000000000004',
  profileId: DELEGATION_04.id, path: 'p',
  frame: { read_access: 'unlimited', brief_daily_max: 2, mandate_daily_max: 2 },
  bounds: { read_access: 'unlimited', brief_daily_max: 2, mandate_daily_max: 2 },
  context: { allowed_profiles: 'sales', allowed_modes: 'review,automatic' },
  attestations: [], requiredDomains: [], attestedDomains: [],
  deferredCommitmentDomains: ['owner'], signedCommitmentMode: 'review', complete: true, gateContent: null,
} as unknown as EnrichedAuthorization;

/**
 * Mirrors hap-core's own "subset" scope check (gatekeeper.ts's
 * checkScopeConstraints) ONLY for `allowed_profiles`/`allowed_modes` — just
 * enough to test THIS builtin's wiring (executionMapping → the Gatekeeper →
 * recordGatekeeperRefusal/Blocked) against the SAME held mandate's granted
 * `context`, without constructing a real signed mandate blob (every other
 * test file mocks `verifyExecution` wholesale; this one additionally mocks
 * the one check these tests are about). hap-core's own test suite owns
 * proving the algorithm itself is correct.
 */
function subsetCheck(field: string, ctx: Record<string, string | number>, execution: Record<string, string | number>) {
  const bound = ctx[field];
  const actual = execution[field];
  if (bound === undefined || bound === '' || actual === undefined || actual === '') return null;
  const allowed = String(bound).split(',').map((s) => s.trim().toLowerCase());
  const actuals = String(actual).split(',').map((s) => s.trim().toLowerCase());
  const disallowed = actuals.filter((v) => !allowed.includes(v));
  return disallowed.length > 0 ? { code: 'BOUND_EXCEEDED', field, bound, actual } : null;
}

function setup(auths: EnrichedAuthorization[] = [AUTH]) {
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
  const denialLog = { record: vi.fn() };
  const state = {
    getEnrichedAuthorizations: () => auths,
    spClient: { postReceipt, submitProposal, isUnlocked: () => true },
    cache: { invalidate: vi.fn(), getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer, getAllAuthorizations: () => auths },
    gatekeeper: {
      verifyExecution: vi.fn().mockImplementation(async (_path: string, execution: Record<string, string | number>, override?: { context?: Record<string, string | number> }) => {
        const ctx = override?.context ?? {};
        const errors = [subsetCheck('allowed_profiles', ctx, execution), subsetCheck('allowed_modes', ctx, execution)]
          .filter((e): e is NonNullable<typeof e> => e !== null);
        return { result: { approved: errors.length === 0, errors } };
      }),
    },
    denialLog,
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
  // BUILTIN_FACTORIES also registers `report` (independent built-in, its own
  // tests) — assert setup registered, not the full default list's exact shape.
  expect(registerBuiltins({ state, integrationManager: im, reportSources: {} as ReportSources })).toContain('setup');
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
  // DL1 decision 1: set_agent_brief now works OUTSIDE simulation too — gated
  // instead by decision 5 (the held Delegation mandate's own profile version).
  it('outside simulation mode with a 0.1 (unscoped) Delegation mandate: refused and recorded under Blocked', async () => {
    const { call, state, submitProposal, postReceipt } = setup([AUTH]);
    const r = await call({ content: '# Brief' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/delegation 0\.1.*does not declare/);
    expect(r.content[0].text).toMatch(/No ticket was requested/);
    expect(submitProposal).not.toHaveBeenCalled();
    expect(postReceipt).not.toHaveBeenCalled();
    expect(state.denialLog.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'not_authorized', code: 'NO_MATCHING_MANDATE', tool: 'set_agent_brief',
    }));
  });

  it('outside simulation mode with a 0.4 (scoped) Delegation mandate: becomes a proposal', async () => {
    const { call, submitProposal } = setup([AUTH_04]);
    const r = await call({ content: '# New brief' });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toMatch(/Awaiting commitment/);
    expect(submitProposal).toHaveBeenCalledOnce();
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

  // DL1 decision 1 removed set_agent_brief's `isSimulationMode()` re-check at
  // execution (it no longer depends on simulation mode at all) — the test
  // that exercised it ("simulation mode switched off after the proposal")
  // tested a mechanism that no longer exists, so it is removed rather than
  // replaced: `executeCommitted` cross-checks a committed proposal's
  // toolArgs/executionContext against what THIS gateway recorded at
  // submission (commitments.ts ~line 177), which already refuses a tampered
  // proposal before the handler's own `briefRefusal` would ever see one —
  // nothing analogous to decision 5's mandate-version check runs again at
  // approval time, same as it never did for the old simulation check either.
});

describe('setup__create_mandate', () => {
  /** A stand-in control plane: records each /internal/mandate request and answers per `answer`. */
  function stubControlPlane(answer: (dryRun: boolean, request: any) => { status: number; body: any }) {
    const seen: Array<{ dryRun: boolean; request: any; secret: string | null }> = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (!String(url).endsWith('/internal/mandate')) return realFetch(url, init);
      const { dryRun, request } = JSON.parse(String(init.body));
      seen.push({ dryRun, request, secret: (init.headers as Record<string, string>)['X-Internal-Secret'] ?? null });
      const a = answer(dryRun, request);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
    });
    return seen;
  }
  const ARGS = { profile: 'sales', limits: { value_max: 1000 }, scope: { currency: 'EUR' }, intent: 'Why — test.', mode: 'automatic', duration_hours: 24 };

  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SUVEREN_INTERNAL_SECRET; });

  function mandateTool(auths: EnrichedAuthorization[] = [AUTH]) {
    const s = setup(auths);
    const tool = s.im.getAllTools().find((t) => t.namespacedName === 'setup__create_mandate')!;
    return { ...s, call: (args: Record<string, unknown>) => createGatedToolHandler(tool, s.im, s.state)(args) };
  }

  it('a refused check (e.g. not an approver) comes back at once — no proposal', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    process.env.SUVEREN_INTERNAL_SECRET = 'sec';
    const seen = stubControlPlane(() => ({ status: 422, body: { error: 'mandate_refused', message: 'Only Sales\'s approvers in "Sales Vienna" can give this mandate.' } }));
    const { call, submitProposal } = mandateTool();
    const r = await call(ARGS);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Refused: Only Sales's approvers/);
    expect(r.content[0].text).toMatch(/No ticket was requested/);
    expect(submitProposal).not.toHaveBeenCalled();
    expect(seen).toEqual([expect.objectContaining({ dryRun: true, secret: 'sec' })]);
  });

  it('a valid request becomes a proposal; the mandate is created only after approval', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    process.env.SUVEREN_INTERNAL_SECRET = 'sec';
    const seen = stubControlPlane((dryRun) => dryRun
      ? { status: 200, body: { ok: true } }
      : { status: 200, body: { ok: true, authorizationId: 'authz_created', profileId: 'p/sales@0.3', groupName: 'Anna', mode: 'automatic', ttlSeconds: 86400 } });
    const { call, approve, submitProposal } = mandateTool();

    const r = await call(ARGS);
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toMatch(/Awaiting commitment/);
    expect(submitProposal).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'setup__create_mandate', executionContext: expect.objectContaining({ action_type: 'mandate' }),
    }));
    expect(seen.map((x) => x.dryRun)).toEqual([true]); // nothing created yet

    const done = await approve();
    expect(done.isError, done.text).toBeFalsy();
    expect(seen.map((x) => x.dryRun)).toEqual([true, false]);
    expect(seen[1].request).toMatchObject({ profile: 'sales', limits: { value_max: 1000 }, scope: { currency: 'EUR' }, mode: 'automatic', durationHours: 24 });
  });

  // DL1 decision 1: create_mandate now works OUTSIDE simulation too — gated
  // instead by decision 5 (mandate version) and decision 3 (its scope).
  it('outside simulation mode with a 0.1 (unscoped) Delegation mandate: refused and recorded under Blocked', async () => {
    process.env.SUVEREN_INTERNAL_SECRET = 'sec';
    const seen = stubControlPlane(() => ({ status: 200, body: { ok: true } }));
    const { call, state, submitProposal } = mandateTool([AUTH]);
    const r = await call(ARGS);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/delegation 0\.1.*does not declare/);
    expect(submitProposal).not.toHaveBeenCalled();
    expect(state.denialLog.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'not_authorized', code: 'NO_MATCHING_MANDATE', tool: 'create_mandate',
    }));
    void seen; // the dry run MAY still run (validate() precedes mandate selection) — irrelevant here
  });

  it('outside simulation mode with a 0.4 Delegation mandate scoped to "sales"/automatic: becomes a proposal', async () => {
    process.env.SUVEREN_INTERNAL_SECRET = 'sec';
    stubControlPlane(() => ({ status: 200, body: { ok: true } }));
    const { call, submitProposal } = mandateTool([AUTH_04]);
    const r = await call(ARGS); // profile: 'sales', mode: 'automatic' — both within AUTH_04's scope
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toMatch(/Awaiting commitment/);
    expect(submitProposal).toHaveBeenCalledOnce();
  });

  it('DL1 decision 3: a profile outside allowed_profiles is refused by the Gatekeeper and recorded under Blocked', async () => {
    process.env.SUVEREN_INTERNAL_SECRET = 'sec';
    stubControlPlane(() => ({ status: 200, body: { ok: true } }));
    const { call, state, submitProposal } = mandateTool([AUTH_04]); // allowed_profiles: "sales" only
    const r = await call({ ...ARGS, profile: 'customers' });
    expect(r.isError).toBe(true);
    expect(submitProposal).not.toHaveBeenCalled();
    expect(state.denialLog.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'scope', tool: 'create_mandate' }));
  });

  it('DL1 decision 3: a mode outside allowed_modes is refused by the Gatekeeper and recorded under Blocked', async () => {
    process.env.SUVEREN_INTERNAL_SECRET = 'sec';
    stubControlPlane(() => ({ status: 200, body: { ok: true } }));
    const REVIEW_ONLY = { ...AUTH_04, context: { allowed_profiles: 'sales', allowed_modes: 'review' } } as EnrichedAuthorization;
    const { call, state, submitProposal } = mandateTool([REVIEW_ONLY]);
    const r = await call({ ...ARGS, mode: 'automatic' }); // only "review" is allowed
    expect(r.isError).toBe(true);
    expect(submitProposal).not.toHaveBeenCalled();
    expect(state.denialLog.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'scope', tool: 'create_mandate' }));
  });

  // DL1 decision 4: fixed rule in the tool — independent of simulation mode and of scope.
  it('DL1 decision 4: proposing "delegation" itself is always refused, and recorded under Blocked', async () => {
    process.env.SUVEREN_INTERNAL_SECRET = 'sec';
    const seen = stubControlPlane(() => ({ status: 200, body: { ok: true } }));
    const { call, state, submitProposal } = mandateTool([AUTH_04]);
    const r = await call({ ...ARGS, profile: 'delegation' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Delegation can never be proposed/);
    expect(submitProposal).not.toHaveBeenCalled();
    expect(seen).toEqual([]); // the fixed rule refuses before any control-plane dry run
    expect(state.denialLog.record).toHaveBeenCalledWith(expect.objectContaining({
      code: 'DELEGATION_NOT_PROPOSABLE', tool: 'create_mandate',
    }));
  });

  // DL1 Interface contract: "create_mandate.profile must be a short profile name
  // (input schema pattern ...); a full id is refused at input validation."
  it('a full profile id is refused at input validation, before the tool ever runs', async () => {
    const { im } = mandateTool([AUTH_04]);
    const tool = im.getAllTools().find((t) => t.namespacedName === 'setup__create_mandate')!;
    const { jsonSchemaToZodShape } = await import('../src/lib/json-schema-to-zod');
    const { z } = await import('zod');
    const schema = z.object(jsonSchemaToZodShape(tool.inputSchema));
    expect(schema.safeParse({ ...ARGS, profile: 'github.com/humanagencyprotocol/hap-profiles/sales@0.4' }).success).toBe(false);
    expect(schema.safeParse({ ...ARGS, profile: 'sales' }).success).toBe(true);
  });

  // DL1 Interface contract: "previewHash is skipped for builtin previews."
  it('previewHash is never computed for a builtin preview (create_mandate)', async () => {
    const { im } = mandateTool([AUTH_04]);
    expect(im.isBuiltin('setup')).toBe(true);
    const hash = await computeSubmissionPreviewHash(im, 'setup', 'create_mandate', ARGS);
    expect(hash).toBeUndefined();
  });
});

describe('setup__describe_mandate_proposal (AU3 internal preview — DL1 Interface contract)', () => {
  // WS3 (work-plan "Added 2026-10-11 — an account is Personal OR in one
  // team"): no `team` argument any more — the preview's `workspace` field
  // now comes from the SAME dry-run control-plane check create_mandate's
  // own `validate` runs (controlPlaneMandate), never echoed from an arg.
  const MANDATE_ARGS = {
    profile: 'sales',
    limits: { value_max: 1000, discount_max: 5 },
    scope: { currency: 'EUR' },
    intent: 'Why — test.', mode: 'review', duration_hours: 720, title: 'Innendienst',
  };

  /** Mirrors setup__create_mandate's own stubControlPlane above — answers
   *  every /internal/mandate call (dry-run and real) the same way. */
  function stubControlPlane(answer: (dryRun: boolean, request: any) => { status: number; body: any }) {
    process.env.SUVEREN_INTERNAL_SECRET = 'sec';
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (!String(url).endsWith('/internal/mandate')) return realFetch(url, init);
      const { dryRun, request } = JSON.parse(String(init.body));
      const a = answer(dryRun, request);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
    });
  }

  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SUVEREN_INTERNAL_SECRET; });

  it('returns the contract shape, with labels/units from the TARGET profile (sales 0.4)', async () => {
    stubControlPlane(() => ({ status: 200, body: { ok: true, groupName: 'Sales Vienna' } }));
    const { im } = setup([AUTH_04]);
    const result = await im.callTool('setup', 'describe_mandate_proposal', MANDATE_ARGS);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      proposal: 'New mandate · Sales',
      profile_version: 'sales 0.4',
      workspace: 'Sales Vienna',
      mode: 'review',
      valid: '30 days',
      limits: { 'Max value per quote or order': 'EUR 1000', 'Max discount': '5%' },
      scope: { Currency: 'EUR' },
      title: 'Innendienst',
      intent: 'Why — test.',
    });
    const checks = result.structuredContent!.checks as string[];
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.join(' ')).toMatch(/Sales is allowed by your Delegation mandate/);
  });

  it('workspace reflects the account\'s OWN Personal workspace name, not a fixed "Personal"', async () => {
    stubControlPlane(() => ({ status: 200, body: { ok: true, groupName: "Anna's Workspace" } }));
    const { im } = setup([AUTH_04]);
    const result = await im.callTool('setup', 'describe_mandate_proposal', MANDATE_ARGS);
    expect(result.structuredContent!.workspace).toBe("Anna's Workspace");
  });

  it('workspace falls back to "Personal" when the control-plane check cannot be reached', async () => {
    // No stubControlPlane — the real fetch runs and fails (nothing is
    // listening), exactly like a genuinely unreachable control plane.
    const { im } = setup([AUTH_04]);
    const result = await im.callTool('setup', 'describe_mandate_proposal', MANDATE_ARGS);
    expect(result.structuredContent!.workspace).toBe('Personal');
  });

  it('title is null, not omitted, when no title is given', async () => {
    stubControlPlane(() => ({ status: 200, body: { ok: true, groupName: 'Sales Vienna' } }));
    const { im } = setup([AUTH_04]);
    const { title: _omit, ...rest } = MANDATE_ARGS;
    const result = await im.callTool('setup', 'describe_mandate_proposal', rest);
    expect(result.structuredContent!.title).toBeNull();
  });

  it('is internal: setup.ts declares it on BuiltinTool, propagated to DiscoveredTool', () => {
    const { im } = setup();
    const tool = im.getAllTools().find((t) => t.namespacedName === 'setup__describe_mandate_proposal')!;
    expect(tool.internal).toBe(true);
    expect(tool.outputSchema).toBeDefined();
  });
});

describe('setup__describe_brief_proposal (AU3 internal preview — DL1 Interface contract)', () => {
  it('returns a unified diff against the current brief, and a word count', async () => {
    writeContextFile('line one\nold line\nline three');
    const { im } = setup();
    const result = await im.callTool('setup', 'describe_brief_proposal', { content: 'line one\nnew line\nline three' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.change).toBe('line one\n-old line\n+new line\nline three');
    expect(result.structuredContent!.words).toBe(6);
  });

  it('diffs against an empty brief when none exists yet', async () => {
    const { im } = setup();
    const result = await im.callTool('setup', 'describe_brief_proposal', { content: 'hello' });
    expect(result.structuredContent!.change).toBe('-\n+hello');
    expect(result.structuredContent!.words).toBe(1);
  });

  it('is internal, with a text/x-diff outputSchema for the "change" field', () => {
    const { im } = setup();
    const tool = im.getAllTools().find((t) => t.namespacedName === 'setup__describe_brief_proposal')!;
    expect(tool.internal).toBe(true);
    const props = (tool.outputSchema as { properties: Record<string, { contentMediaType?: string }> }).properties;
    expect(props.change.contentMediaType).toBe('text/x-diff');
  });
});
