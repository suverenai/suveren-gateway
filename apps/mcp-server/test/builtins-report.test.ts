/**
 * The `report` built-in (src/lib/builtins/report.ts) — real IntegrationManager
 * + real tool-proxy + real ReceiptArchive + real ReportStore, governed by the
 * `reporting` profile, the same harness style as builtin-integration.test.ts
 * (which this file deliberately does not depend on, so it is unaffected by
 * whatever profile the sibling `hap-profiles` checkout currently has loaded
 * for OTHER profiles' tests — only `reporting/0.1.profile.json` is read here).
 *
 * What must hold:
 * - under an automatic `reporting` mandate, write_report goes through the
 *   real tool-proxy, gets a ticket, the handler receives receipt_id, the
 *   report is stored + verified, and the AI gets a verification summary;
 * - read tools work with read_access: unlimited, and are refused with
 *   read_access: none — no data leaves either way;
 * - without ANY reporting mandate, every tool call is refused and nothing
 *   (ticket, proposal, stored report, exported data) is produced;
 * - the simulator's `reference_replies` table is never returned by
 *   list_cases or get_records, even when the raw export carries it;
 * - an oversize write_report is refused before verification ever runs;
 * - write_report's description IS the report brief.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { IntegrationManager } from '../src/lib/integration-manager';
import { createMcpServer } from '../src/index';
import { registerBuiltins } from '../src/lib/builtins';
import { createGatedToolHandler, toolIsAuthorizedForDisplay } from '../src/lib/tool-proxy';
import { ReportStore } from '../src/lib/report/report-store';
import { REPORT_BRIEF } from '../src/lib/report-brief';
import { MAX_REPORT_HTML_BYTES, reportBuiltin } from '../src/lib/builtins/report';
import { buildScenario } from './report/fixtures/scenario';
import { buildEmailExport, buildErpExport, buildCrmExport } from './report/fixtures/exports';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { ReportSources, ExportSystem } from '../src/lib/report/types';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const REPORTING = JSON.parse(readFileSync(join(profilesDir, 'reporting/0.1.profile.json'), 'utf8'));

beforeAll(() => {
  registerProfile(REPORTING.id, REPORTING);
  registerProfile('reporting', REPORTING);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function authWithProfile(profileId: string, bounds: Record<string, unknown>): EnrichedAuthorization {
  return {
    authorizationId: 'authz_r0000000-0000-4000-8000-000000000001',
    profileId,
    path: 'p',
    frame: bounds,
    bounds,
    context: {},
    attestations: [],
    requiredDomains: [],
    attestedDomains: [],
    deferredCommitmentDomains: [],
    signedCommitmentMode: 'automatic',
    complete: true,
    gateContent: null,
  } as unknown as EnrichedAuthorization;
}

function auth(bounds: Record<string, unknown>): EnrichedAuthorization {
  return authWithProfile(REPORTING.id, bounds);
}

const REPORTING_BOUNDS = { read_access: 'unlimited', report_daily_max: 5 };

/**
 * One SharedState-shaped object serving BOTH roles it plays in production
 * (bin/http.ts): the gatekeeper state `createGatedToolHandler` checks
 * authorizations/issues tickets against, AND `BuiltinDeps.state`, whose
 * `.reportStore` the write_report handler saves into directly.
 */
function buildState(enriched: EnrichedAuthorization[], reportStore: ReportStore) {
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
  const submitProposal = vi.fn();
  const state = {
    reportStore,
    getEnrichedAuthorizations: () => enriched,
    spClient: { postReceipt, submitProposal, isUnlocked: () => true },
    cache: {
      invalidate: vi.fn(),
      getPublicKey: async () => kp.publicKeyHex,
      getAllAuthorizations: () => enriched,
    },
    gatekeeper: { verifyExecution: vi.fn().mockResolvedValue({ result: { approved: true, errors: [] } }) },
    proposalSubmissions: { record: vi.fn(), get: vi.fn() },
    executionLog: { record: vi.fn() },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  return { state, postReceipt, submitProposal };
}

/** Fresh archive + report store + runExport stub, and the registered tools. */
function setup(enriched: EnrichedAuthorization[], runExport?: ReportSources['runExport']) {
  const scenario = buildScenario();
  const reportDir = mkdtempSync(join(tmpdir(), 'suveren-report-builtin-test-'));
  const reportStore = new ReportStore(reportDir);
  const defaultRunExport = vi.fn(async (system: ExportSystem) => {
    if (system === 'email') return buildEmailExport();
    if (system === 'erp') return buildErpExport();
    return buildCrmExport();
  });
  const reportSources: ReportSources = { archive: scenario.archive, runExport: runExport ?? defaultRunExport };
  const { state, postReceipt, submitProposal } = buildState(enriched, reportStore);
  const im = new IntegrationManager();
  // Only this built-in — isolated from `setup` and any other group BUILTIN_FACTORIES carries.
  const ids = registerBuiltins({ state, integrationManager: im, reportSources }, [reportBuiltin]);
  expect(ids).toEqual(['report']);
  const tools = Object.fromEntries(
    im.getAllTools().filter((t) => t.integrationId === 'report').map((t) => [t.originalName, t]),
  );
  const cleanup = () => rmSync(reportDir, { recursive: true, force: true });
  return { im, tools, state, scenario, reportStore, postReceipt, submitProposal, cleanup };
}

describe('report built-in registration', () => {
  it('registers all five tools under the reporting profile', () => {
    const { tools } = setup([]);
    expect(Object.keys(tools).sort()).toEqual(
      ['get_records', 'get_ticket', 'list_cases', 'list_tickets', 'write_report'].sort(),
    );
    // None declares hideUnlessAuthorized, so this PURE predicate is vacuously
    // true for all of them — this is NOT the same claim as "listed in
    // tools/list without a mandate": that is decided by refreshTools() in
    // src/index.ts (`matchingAuths.length > 0 && toolIsAuthorizedForDisplay`),
    // which ALSO requires a complete authorization on this exact profile. See
    // the "tools/list visibility" describe block below for the real check,
    // through the real MCP server wiring.
    for (const name of Object.keys(tools)) {
      expect(toolIsAuthorizedForDisplay(tools[name], [])).toBe(true);
    }
  });

  it("write_report's description IS the report brief (R3/R4: the brief reaches the AI via the tool description)", () => {
    const { tools } = setup([]);
    expect(tools.write_report.description).toBe(REPORT_BRIEF);
  });
});

/**
 * The REAL `tools/list` visibility check: `src/index.ts#refreshTools` is what
 * actually decides whether the working agent ever sees `report__*` — it calls
 * `registered.enable()`/`.disable()` on the MCP SDK's own RegisteredTool based
 * on `matchingAuths.length > 0 && toolIsAuthorizedForDisplay(...)`, where
 * `matchingAuths` is already filtered to authorizations matching THIS tool's
 * profile. Since none of the five tools sets `hideUnlessAuthorized`,
 * `toolIsAuthorizedForDisplay` alone is vacuously true (see above) — the
 * `matchingAuths.length > 0` half is what actually gates listing, and that is
 * NOT exercised by testing the predicate in isolation. Mirrors
 * hide-unless-authorized.test.ts's end-to-end section ("C"), reading the SDK's
 * own `enabled` flag — the thing `tools/list` actually filters on.
 */
describe('tools/list visibility (real MCP server wiring: src/index.ts refreshTools)', () => {
  const REPORT_TOOL_NAMES = [
    'report__list_tickets', 'report__get_ticket', 'report__list_cases',
    'report__get_records', 'report__write_report',
  ];

  function mockExecutionLog() {
    return { record: () => {}, sumByWindow: () => 0, getAll: () => [], size: 0 };
  }

  function mockState(auths: EnrichedAuthorization[]): SharedState {
    return {
      getEnrichedAuthorizations: () => auths,
      executionLog: mockExecutionLog(),
      spClient: { isUnlocked: () => true },
    } as unknown as SharedState;
  }

  /** The real MCP SDK's own `enabled` flag per registered tool name. */
  function registeredTools(auths: EnrichedAuthorization[]): Record<string, { enabled: boolean }> {
    const im = new IntegrationManager();
    im.registerBuiltin(reportBuiltin({ state: {} as SharedState, integrationManager: im, reportSources: {} as ReportSources }));
    const { server, refreshTools } = createMcpServer(mockState(auths), im);
    refreshTools();
    return (server as unknown as { _registeredTools: Record<string, { enabled: boolean }> })._registeredTools;
  }

  it('(a) no reporting mandate at all: report__* tools are NOT listed', () => {
    const tools = registeredTools([]);
    for (const name of REPORT_TOOL_NAMES) expect(tools[name].enabled, name).toBe(false);
  });

  it("(b) only a sales mandate (the working agent's, a DIFFERENT profile): report__* tools are NOT listed", () => {
    const salesAuth = authWithProfile('github.com/humanagencyprotocol/hap-profiles/sales@0.2', { foo: 'bar' });
    const tools = registeredTools([salesAuth]);
    for (const name of REPORT_TOOL_NAMES) expect(tools[name].enabled, name).toBe(false);
  });

  it('(c) a reporting mandate: report__* tools ARE listed', () => {
    const tools = registeredTools([auth(REPORTING_BOUNDS)]);
    for (const name of REPORT_TOOL_NAMES) expect(tools[name].enabled, name).toBe(true);
  });
});

describe('without a reporting mandate', () => {
  it('every tool is refused and produces no ticket, no proposal, no stored report, no exported data', async () => {
    const runExportSpy = vi.fn(async () => buildEmailExport());
    const { tools, im, state, postReceipt, submitProposal, reportStore, cleanup } = setup([], runExportSpy);

    for (const name of ['list_tickets', 'get_ticket', 'list_cases', 'get_records', 'write_report']) {
      const tool = tools[name];
      const r = await createGatedToolHandler(tool, im, state)({ id: 'x', html: '<p>x</p>', system: 'email' });
      expect(r.isError, `${name} should be refused without a mandate`).toBe(true);
    }
    expect(postReceipt).not.toHaveBeenCalled();
    expect(submitProposal).not.toHaveBeenCalled();
    expect(runExportSpy).not.toHaveBeenCalled();
    expect(reportStore.getReport()).toBeNull();
    cleanup();
  });
});

describe('read tools', () => {
  it('read_access: unlimited — list_tickets returns tickets from the archive, no signatures/raw blobs', async () => {
    const { tools, im, state, scenario, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    scenario.addTicket({ id: 'tk-1', action: 'erp__create_quote', authorizationId: 'authz-x', timestamp: 1000 });
    scenario.addTicket({ id: 'tk-2', action: 'erp__create_quote', authorizationId: 'authz-x', timestamp: 2000 });

    const r = await createGatedToolHandler(tools.list_tickets, im, state)({});
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.tickets.map((t: any) => t.id)).toEqual(['tk-1', 'tk-2']);
    expect(body.tickets[0]).not.toHaveProperty('signature');
    expect(r.content[0].text).not.toMatch(/signature/i);
    cleanup();
  });

  it('list_tickets filters by since/until', async () => {
    const { tools, im, state, scenario, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    scenario.addTicket({ id: 'early', action: 'a', authorizationId: 'x', timestamp: 100 });
    scenario.addTicket({ id: 'late', action: 'a', authorizationId: 'x', timestamp: 9000 });

    const r = await createGatedToolHandler(tools.list_tickets, im, state)({ since: 500 });
    const body = JSON.parse(r.content[0].text);
    expect(body.tickets.map((t: any) => t.id)).toEqual(['late']);
    cleanup();
  });

  it('get_ticket returns ticket + approval + mandate, reusing the same resolvers verify-report.ts uses', async () => {
    const { tools, im, state, scenario, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    scenario.addTicket({
      id: 'tk-1', action: 'erp__create_quote', authorizationId: 'authz-x', timestamp: 1000,
      authorization: { authorizationId: 'authz-x', profileId: 'test-profile', bounds: { cap: 10 }, intent: 'do the thing' },
      proposal: { committedBy: { owner: { userId: 'u1', at: 1050 } }, createdAt: 1000, status: 'committed' },
    });

    const r = await createGatedToolHandler(tools.get_ticket, im, state)({ id: 'tk-1' });
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.ticket.ticketId).toBe('tk-1');
    expect(body.approval).toMatchObject({ verified: true, who: ['u1'] });
    expect(body.mandate).toMatchObject({ verified: true, intent: 'do the thing' });
    cleanup();
  });

  it('get_ticket on an unknown id is refused, not a crash', async () => {
    const { tools, im, state, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    const r = await createGatedToolHandler(tools.get_ticket, im, state)({ id: 'ghost' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/ghost/);
    cleanup();
  });

  it('list_cases returns cases and sent mail, and NEVER reference_replies even when the raw export carries it', async () => {
    const runExport = vi.fn(async (system: ExportSystem) => {
      if (system !== 'email') return buildEmailExport();
      return {
        ...buildEmailExport({
          simulation_load: { name: 'pkg', package_sha256: 'sha', cases_loaded: 1, loaded_at: '2026-10-01T00:00:00.000Z' },
          inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'Hi', body: 'b', received_at: '2026-10-01T01:00:00.000Z', case_id: 'C1' }],
          sent: [{ id: 's1', from_name: 'Us', from_email: 'us@example.com', to_json: '["a@example.com"]', subject: 'Re: Hi', body: 'b', received_at: '2026-10-01T02:00:00.000Z', in_reply_to: 'm1', receipt_id: 'tk-1' }],
        }),
        // The real email-mcp export always includes this table (cli.ts) —
        // injected here even though the narrowed EmailExport type doesn't
        // declare it, to prove the handler can't forward it even if present.
        reference_replies: [{ case_id: 'C1', reply_body: 'THE PEOPLE\'S SECRET ANSWER' }],
      } as unknown as ReturnType<typeof buildEmailExport>;
    });
    const { tools, im, state, cleanup } = setup([auth(REPORTING_BOUNDS)], runExport);

    const r = await createGatedToolHandler(tools.list_cases, im, state)({});
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).not.toMatch(/reference_replies/);
    expect(r.content[0].text).not.toMatch(/SECRET ANSWER/);
    const body = JSON.parse(r.content[0].text);
    expect(body.cases).toEqual([{ caseId: 'C1', startMessageId: 'm1', from: 'a@example.com', subject: 'Hi', receivedAt: '2026-10-01T01:00:00.000Z' }]);
    expect(body.sent[0]).toMatchObject({ id: 's1', inReplyTo: 'm1', receiptId: 'tk-1' });
    expect(body.testDataLoadedAt).toBe('2026-10-01T00:00:00.000Z');
    cleanup();
  });

  it('get_records returns rows for a system/kind and NEVER returns reference_replies, even asked for by name', async () => {
    const runExport = vi.fn(async (system: ExportSystem) => {
      if (system !== 'email') return buildEmailExport();
      return {
        ...buildEmailExport({ inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@x.com', to_json: '[]', subject: 's', body: 'b', received_at: 't' }] }),
        reference_replies: [{ case_id: 'C1', reply_body: 'secret' }],
      } as unknown as ReturnType<typeof buildEmailExport>;
    });
    const { tools, im, state, cleanup } = setup([auth(REPORTING_BOUNDS)], runExport);

    const ok = await createGatedToolHandler(tools.get_records, im, state)({ system: 'email', kind: 'inbox' });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0].text).records.inbox).toHaveLength(1);

    // Asking directly for the forbidden table by name is refused, not served.
    const denied = await createGatedToolHandler(tools.get_records, im, state)({ system: 'email', kind: 'reference_replies' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).not.toMatch(/secret/);

    // Asking for "every table" (no kind) still never includes it.
    const all = await createGatedToolHandler(tools.get_records, im, state)({ system: 'email' });
    expect(Object.keys(JSON.parse(all.content[0].text).records)).not.toContain('reference_replies');
    expect(all.content[0].text).not.toMatch(/secret/);
    cleanup();
  });

  it('read_access: none — read calls are refused, no data leaves', async () => {
    const runExport = vi.fn(async () => buildEmailExport());
    const { tools, im, state, scenario, cleanup } = setup([auth({ read_access: 'none', report_daily_max: 5 })], runExport);
    scenario.addTicket({ id: 'tk-1', action: 'a', authorizationId: 'x' });

    for (const [name, args] of [
      ['list_tickets', {}], ['get_ticket', { id: 'tk-1' }], ['list_cases', {}], ['get_records', { system: 'email' }],
    ] as const) {
      const r = await createGatedToolHandler(tools[name], im, state)(args);
      expect(r.isError, `${name} should be refused with read_access: none`).toBe(true);
    }
    expect(runExport).not.toHaveBeenCalled();
    cleanup();
  });
});

describe('write_report', () => {
  it('automatic mandate: goes through the real tool-proxy, gets a ticket, the handler stores + verifies, AI gets a summary', async () => {
    const { tools, im, state, postReceipt, reportStore, cleanup } = setup([auth(REPORTING_BOUNDS)]);

    const r = await createGatedToolHandler(tools.write_report, im, state)({ html: '<p>hello</p>' });
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    expect(postReceipt).toHaveBeenCalledWith(expect.objectContaining({ action: 'report__write_report', actionType: 'report' }));
    // content-binding.ts injects receipt_id because the input schema declares it.
    expect(reportStore.getReport()?.html).toContain('hello');
    expect(r.content[0].text).toMatch(/stored/i);
    expect(r.content[0].text).toMatch(/0 element\(s\) verified, 0 warning\(s\), 0 not verifiable/);
    cleanup();
  });

  it('a ticket id reaches the handler via receipt_id, and the stored report is the actually-verified result', async () => {
    const { tools, im, state, scenario, reportStore, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    scenario.addTicket({ id: 'tk-real', action: 'erp__create_quote', authorizationId: 'authz-x', timestamp: 1000 });

    const r = await createGatedToolHandler(tools.write_report, im, state)({ html: '<sv-ticket ref="tk-real"></sv-ticket>' });
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    expect(r.content[0].text).toMatch(/1 element\(s\) verified/);
    expect(reportStore.getReport()?.result.elements[0]).toMatchObject({ kind: 'sv-ticket', status: 'verified' });
    cleanup();
  });

  it('an unverifiable reference is reported back to the AI by reason, so it can fix it', async () => {
    const { tools, im, state, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    const r = await createGatedToolHandler(tools.write_report, im, state)({ html: '<sv-ticket ref="ghost"></sv-ticket>' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/not verifiable/);
    expect(r.content[0].text).toMatch(/ghost/);
    cleanup();
  });

  it('oversize html is refused by `validate` BEFORE the gate — no ticket requested, no report_daily_max consumed, nothing stored', async () => {
    const { tools, im, state, postReceipt, reportStore, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    const huge = '<p>' + 'x'.repeat(MAX_REPORT_HTML_BYTES + 1) + '</p>';

    const r = await createGatedToolHandler(tools.write_report, im, state)({ html: huge });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/bytes/);
    expect(postReceipt).not.toHaveBeenCalled();
    expect(reportStore.getReport()).toBeNull();
    cleanup();
  });

  it('empty html is refused BEFORE the gate — no ticket requested', async () => {
    const { tools, im, state, postReceipt, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    const r = await createGatedToolHandler(tools.write_report, im, state)({ html: '   ' });
    expect(postReceipt).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    cleanup();
  });
});

describe('control check — breaking a gate must break its test', () => {
  // This is not a real control check runner, just a documented, deliberately
  // inverted assertion: if the `reporting` read gate ever stops being
  // enforced (e.g. `boundField`/`requiredValue` dropped from the override),
  // the "read_access: none" test above starts asserting isError === true
  // against a FALSE value and fails loudly — there is no path by which a
  // broken gate also keeps that test green.
  it('read_access: none genuinely denies (sanity: unlimited on the same tool does not)', async () => {
    const denied = setup([auth({ read_access: 'none', report_daily_max: 5 })]);
    const allowed = setup([auth(REPORTING_BOUNDS)]);
    const rDenied = await createGatedToolHandler(denied.tools.list_tickets, denied.im, denied.state)({});
    const rAllowed = await createGatedToolHandler(allowed.tools.list_tickets, allowed.im, allowed.state)({});
    expect(rDenied.isError).toBe(true);
    expect(rAllowed.isError).toBeFalsy();
    denied.cleanup();
    allowed.cleanup();
  });
});

/**
 * Andreas's rule: in simulation mode the WORKING agent must never be able to
 * tell it is a simulation. report__* tool names/descriptions/output use
 * neutral wording ("connected systems", "test data") instead — this is an
 * executable spec for that rule, not a one-off check: a future edit that
 * reintroduces "simulation"/"simulated" anywhere agent-facing fails this.
 */
describe('no report__* tool name/description/output says "simulation"/"simulated"', () => {
  const FORBIDDEN = /simulat/i;

  it('no tool name or description mentions it', () => {
    const { tools, cleanup } = setup([]);
    for (const [name, tool] of Object.entries(tools)) {
      expect(name, name).not.toMatch(FORBIDDEN);
      expect(tool.description, `${name} description`).not.toMatch(FORBIDDEN);
    }
    cleanup();
  });

  it('list_cases output and its "no data" error never mention it', async () => {
    const { tools, im, state, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    const ok = await createGatedToolHandler(tools.list_cases, im, state)({});
    expect(ok.content[0].text).not.toMatch(FORBIDDEN);

    const { tools: tools2, im: im2, state: state2, cleanup: cleanup2 } = setup(
      [auth(REPORTING_BOUNDS)],
      vi.fn(async () => { throw new Error('boom'); }),
    );
    const failed = await createGatedToolHandler(tools2.list_cases, im2, state2)({});
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).not.toMatch(FORBIDDEN);
    cleanup();
    cleanup2();
  });

  it('get_records output and its "unexpected shape" error never mention it', async () => {
    const { tools, im, state, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    const ok = await createGatedToolHandler(tools.get_records, im, state)({ system: 'erp' });
    expect(ok.content[0].text).not.toMatch(FORBIDDEN);

    const badShape = vi.fn(async () => ({ not: 'the expected shape' }));
    const { tools: tools2, im: im2, state: state2, cleanup: cleanup2 } = setup([auth(REPORTING_BOUNDS)], badShape);
    const failed = await createGatedToolHandler(tools2.get_records, im2, state2)({ system: 'erp' });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).not.toMatch(FORBIDDEN);
    cleanup();
    cleanup2();
  });
});

describe("write_report's validate hook (precheckBuiltin) — refused before the gate", () => {
  // `validate` lives on the BuiltinTool, not the DiscoveredTool tool-proxy.ts
  // sees — precheckBuiltin (IntegrationManager) is the real, documented way to
  // reach it, so this exercises exactly what createGatedToolHandler calls.
  it('precheckBuiltin flags empty and oversize html with NO ticket side effects, and lets good html through', () => {
    const { tools, im, cleanup } = setup([]);
    expect(im.precheckBuiltin(tools.write_report, { html: '   ' })).toMatch(/non-empty/);
    expect(im.precheckBuiltin(tools.write_report, { html: 'x'.repeat(MAX_REPORT_HTML_BYTES + 1) })).toMatch(/bytes/);
    expect(im.precheckBuiltin(tools.write_report, { html: '<p>ok</p>' })).toBeNull();
    cleanup();
  });
});
