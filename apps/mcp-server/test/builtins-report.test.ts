/**
 * The `report` built-in (src/lib/builtins/report.ts) — real IntegrationManager
 * + real tool-proxy + real ReceiptArchive + real ReportStore, governed by the
 * `reporting` profile, the same harness style as builtin-integration.test.ts
 * (which this file deliberately does not depend on, so it is unaffected by
 * whatever profile the sibling `hap-profiles` checkout currently has loaded
 * for OTHER profiles' tests — only the `reporting` profiles are read here:
 * 0.2, which sets the reporting window, and 0.1, which does not and is refused).
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
import { buildScenario, AS_URL } from './report/fixtures/scenario';
import { buildExportBundle, buildExportDocument } from '../src/lib/report/export-report';
import { renderReportHtml } from '../src/lib/report/render-report';
import { scopeReportSources } from '../src/lib/report/window';
import { FORBIDDEN_AGENT_KEYS } from '../src/lib/report/agent-view';
import { buildEmailExport, buildErpExport, buildCrmExport } from './report/fixtures/exports';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { ReportSources, ExportSystem } from '../src/lib/report/types';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

const profilesDir =
  process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const REPORTING = JSON.parse(readFileSync(join(profilesDir, 'reporting/0.2.profile.json'), 'utf8'));
const REPORTING_01 = JSON.parse(readFileSync(join(profilesDir, 'reporting/0.1.profile.json'), 'utf8'));

beforeAll(() => {
  registerProfile(REPORTING_01.id, REPORTING_01);
  registerProfile(REPORTING.id, REPORTING);
  registerProfile('reporting', REPORTING);
});

/** Unix seconds, relative to the real clock — the reporting window is
 *  [now − read_max_age_days, now], so fixed timestamps would age out. */
const nowS = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;
const isoAgo = (seconds: number) => new Date((nowS() - seconds) * 1000).toISOString();

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

const REPORTING_BOUNDS = { read_access: 'unlimited', read_max_age_days: 30, report_daily_max: 5 };

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
      const r = await createGatedToolHandler(tool, im, state)({ id: 'x', html: '<sv-ai><p>x</p></sv-ai>', system: 'email' });
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
    scenario.addTicket({ id: 'tk-1', action: 'erp__create_quote', authorizationId: 'authz-x', timestamp: nowS() - 2000 });
    scenario.addTicket({ id: 'tk-2', action: 'erp__create_quote', authorizationId: 'authz-x', timestamp: nowS() - 1000 });

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
    scenario.addTicket({ id: 'early', action: 'a', authorizationId: 'x', timestamp: nowS() - 9000 });
    scenario.addTicket({ id: 'late', action: 'a', authorizationId: 'x', timestamp: nowS() - 100 });

    const r = await createGatedToolHandler(tools.list_tickets, im, state)({ since: nowS() - 500 });
    const body = JSON.parse(r.content[0].text);
    expect(body.tickets.map((t: any) => t.id)).toEqual(['late']);
    cleanup();
  });

  it('get_ticket returns ticket + approval + mandate, reusing the same resolvers verify-report.ts uses', async () => {
    const { tools, im, state, scenario, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    scenario.addTicket({
      id: 'tk-1', action: 'erp__create_quote', authorizationId: 'authz-x', timestamp: nowS() - 1000,
      authorization: { authorizationId: 'authz-x', profileId: 'test-profile', bounds: { cap: 10 }, intent: 'do the thing' },
      proposal: { committedBy: { owner: { userId: 'u1', at: nowS() - 1050 } }, createdAt: nowS() - 1100, status: 'committed' },
    });

    const r = await createGatedToolHandler(tools.get_ticket, im, state)({ id: 'tk-1' });
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.ticket.ticketId).toBe('tk-1');
    expect(body.approval).toMatchObject({ verified: true, approved: true, approvedBy: 'a person (name not disclosed)', waitSeconds: 50 });
    expect(body.approval).not.toHaveProperty('who'); // raw account ids never reach the AI (RR3)
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
    const LOADED = isoAgo(5000);
    const RECEIVED = isoAgo(4000);
    const runExport = vi.fn(async (system: ExportSystem) => {
      if (system !== 'email') return buildEmailExport();
      return {
        ...buildEmailExport({
          simulation_load: { name: 'pkg', package_sha256: 'sha', cases_loaded: 1, loaded_at: LOADED },
          inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'Hi', body: 'b', received_at: RECEIVED, case_id: 'C1' }],
          sent: [{ id: 's1', from_name: 'Us', from_email: 'us@example.com', to_json: '["a@example.com"]', subject: 'Re: Hi', body: 'b', received_at: isoAgo(3000), in_reply_to: 'm1', receipt_id: 'tk-1' }],
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
    expect(body.cases).toEqual([{ caseId: 'C1', startMessageId: 'm1', from: 'a@example.com', subject: 'Hi', receivedAt: RECEIVED }]);
    expect(body.sent[0]).toMatchObject({ id: 's1', inReplyTo: 'm1', receiptId: 'tk-1' });
    expect(body.testDataLoadedAt).toBe(LOADED);
    cleanup();
  });

  it('get_records returns rows for a system/kind and NEVER returns reference_replies, even asked for by name', async () => {
    const runExport = vi.fn(async (system: ExportSystem) => {
      if (system !== 'email') return buildEmailExport();
      return {
        ...buildEmailExport({ inbox: [{ id: 'm1', from_name: 'A', from_email: 'a@x.com', to_json: '[]', subject: 's', body: 'b', received_at: isoAgo(60) }] }),
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

    const r = await createGatedToolHandler(tools.write_report, im, state)({ html: '<sv-ai><p>hello</p></sv-ai>' });
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    expect(postReceipt).toHaveBeenCalledWith(expect.objectContaining({ action: 'report__write_report', actionType: 'report' }));
    // content-binding.ts injects receipt_id because the input schema declares it.
    expect(reportStore.getReport()?.html).toContain('hello');
    expect(r.content[0].text).toMatch(/stored/i);
    expect(r.content[0].text).toMatch(/0 element\(s\) verified, 0 warning\(s\), 0 not verifiable/);
    cleanup();
  });

  it('two-tag rule: tells the AI what was dropped and which glossary terms were refused (RR6)', async () => {
    const { tools, im, state, scenario, reportStore, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    scenario.addTicket({ id: 'tk-real', action: 'erp__create_quote', authorizationId: 'authz-x', timestamp: nowS() - 1000 });
    const html =
      '<h1>Loose</h1><p>loose</p>' +
      '<sv-ai><style>*{color:red}</style><p>mine</p><sv-ticket ref="tk-real"></sv-ticket></sv-ai>' +
      '<sv-ticket ref="tk-real"></sv-ticket>' +
      '<sv-glossary lang="de"><sv-term key="erp__create_quote">Angebot erstellt</sv-term><sv-term key="tk-real">Beleg</sv-term></sv-glossary>';
    const r = await createGatedToolHandler(tools.write_report, im, state)({ html });
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    const text = r.content[0].text;
    expect(text).toMatch(/dropped: 2 block\(s\) outside sv-ai/);
    expect(text).toMatch(/dropped: 1 sv-\* element\(s\) inside sv-ai/);
    expect(text).toMatch(/dropped: 1 <style> block\(s\)/);
    expect(text).toMatch(/Glossary: 1 term\(s\) shown/);
    expect(text).toMatch(/ignored "tk-real": not a field name or fixed word/);
    expect(text).toMatch(/Reporting window: since /);
    // Stored is the sanitized report: the loose content is gone.
    expect(reportStore.getReport()?.html).not.toContain('Loose');
    expect(reportStore.getReport()?.result.elements).toHaveLength(1);
    cleanup();
  });

  it('a ticket id reaches the handler via receipt_id, and the stored report is the actually-verified result', async () => {
    const { tools, im, state, scenario, reportStore, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    scenario.addTicket({ id: 'tk-real', action: 'erp__create_quote', authorizationId: 'authz-x', timestamp: nowS() - 1000 });

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
  it('precheckBuiltin flags empty and oversize html with NO ticket side effects, and lets good html through', async () => {
    const { tools, im, cleanup } = setup([auth(REPORTING_BOUNDS)]);
    expect(await im.precheckBuiltin(tools.write_report, { html: '   ' })).toMatch(/non-empty/);
    expect(await im.precheckBuiltin(tools.write_report, { html: 'x'.repeat(MAX_REPORT_HTML_BYTES + 1) })).toMatch(/bytes/);
    expect(await im.precheckBuiltin(tools.write_report, { html: '<p>ok</p>' })).toBeNull();
    cleanup();
  });
});


// ─── RR2 — the reporting window ─────────────────────────────────────────────

/**
 * An archive that holds a REAL ticket from long before the window — real work
 * from the gateway's normal use, with a private intent — next to tickets from
 * inside the window. The old one must be absent from every tool output and
 * from the export file; a reference to it must say why it is not verifiable.
 */
describe('reporting window (RR2) — an old real ticket never reaches the report AI or the export', () => {
  const OLD_INTENT = 'Family calendar — PRIVATE, never in a business context';
  const NEW_INTENT = 'Quote known customers only.';

  function seed(scenario: ReturnType<typeof buildScenario>) {
    scenario.addTicket({
      id: 'tk-old-real', action: 'calendar__create_event', authorizationId: 'authz-old',
      timestamp: nowS() - 40 * DAY,
      authorization: { authorizationId: 'authz-old', profileId: 'github.com/humanagencyprotocol/hap-profiles/calendar@0.5', intent: OLD_INTENT, bounds: { booking_daily_max: 3 } },
    });
    scenario.addTicket({
      id: 'tk-old-unreferenced', action: 'email__send_message', authorizationId: 'authz-old',
      timestamp: nowS() - 31 * DAY,
    });
    scenario.addTicket({
      id: 'tk-new-1', action: 'erp__create_quote', authorizationId: 'authz-new',
      timestamp: nowS() - 2 * DAY,
      authorization: { authorizationId: 'authz-new', profileId: 'github.com/humanagencyprotocol/hap-profiles/sales@0.3', intent: NEW_INTENT, bounds: { value_max: 1000 } },
    });
    scenario.addTicket({ id: 'tk-new-2', action: 'erp__send_quote', authorizationId: 'authz-new', timestamp: nowS() - 3600 });
  }

  it('list_tickets lists only tickets inside the window, and says which window', async () => {
    const t = setup([auth(REPORTING_BOUNDS)]);
    seed(t.scenario);
    const r = await createGatedToolHandler(t.tools.list_tickets, t.im, t.state)({});
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.tickets.map((x: any) => x.id)).toEqual(['tk-new-1', 'tk-new-2']);
    expect(body.window.since).toMatch(/last 30 days/);
    // An explicit `since` cannot reach back past the window either.
    const wide = await createGatedToolHandler(t.tools.list_tickets, t.im, t.state)({ since: 0 });
    expect(JSON.parse(wide.content[0].text).tickets.map((x: any) => x.id)).toEqual(['tk-new-1', 'tk-new-2']);
    expect(wide.content[0].text).not.toContain('tk-old');
    t.cleanup();
  });

  it('get_ticket refuses a ticket outside the window, naming the window, and reveals nothing of it', async () => {
    const t = setup([auth(REPORTING_BOUNDS)]);
    seed(t.scenario);
    const r = await createGatedToolHandler(t.tools.get_ticket, t.im, t.state)({ id: 'tk-old-real' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/outside the reporting window/);
    expect(r.content[0].text).toMatch(/last 30 days/);
    expect(r.content[0].text).not.toContain(OLD_INTENT);
    expect(r.content[0].text).not.toContain('calendar');
    t.cleanup();
  });

  it('a report reference to it renders "not verifiable — outside the reporting window", and the export file carries none of it', async () => {
    const t = setup([auth(REPORTING_BOUNDS)]);
    seed(t.scenario);
    const html =
      '<h1>Week</h1><sv-ticket ref="tk-old-real"></sv-ticket><sv-mandate ticket="tk-old-real"></sv-mandate>' +
      '<sv-approval ticket="tk-old-real"></sv-approval><sv-ticket ref="tk-new-1"></sv-ticket>';
    const w = await createGatedToolHandler(t.tools.write_report, t.im, t.state)({ html });
    expect(w.isError, w.content[0]?.text).toBeFalsy();
    expect(w.content[0].text).toMatch(/tk-old-real.*not verifiable — outside the reporting window/);
    expect(w.content[0].text).not.toContain(OLD_INTENT);

    const stored = t.reportStore.getReport()!;
    for (const e of stored.result.elements.filter(e => e.attrs.ref === 'tk-old-real' || e.attrs.ticket === 'tk-old-real')) {
      expect(e.status).toBe('unverifiable');
      expect(e.reason).toMatch(/not verifiable — outside the reporting window/);
      expect(e.data).toBeUndefined();
    }
    expect(stored.result.coverage.ticketsInPeriod).toEqual(['tk-new-1', 'tk-new-2']);

    // The export, built the way http.ts builds it: scoped sources, recheck, bundle, document.
    const scoped = await scopeReportSources(
      { archive: t.scenario.archive, runExport: async () => buildEmailExport() },
      { authorizations: [auth(REPORTING_BOUNDS)], simulation: false },
    );
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    const rechecked = (await t.reportStore.recheck(scoped.sources))!;
    const bundle = buildExportBundle({
      stored: rechecked, archive: scoped.sources.archive, gatewayVersion: 'test',
      authorityServer: { url: AS_URL, publicKeyHex: t.scenario.kp.publicKeyHex },
    });
    const doc = buildExportDocument({ bundle, renderedHtml: renderReportHtml(rechecked.result.html, rechecked.result.elements) });

    expect(bundle.tickets.map(x => (x as { id: string }).id).sort()).toEqual(['tk-new-1', 'tk-new-2']);
    expect(Object.keys(bundle.authorizations)).toEqual([]);
    const oldReceipt = t.scenario.archive.getReceipts().find(r => r.receipt.id === 'tk-old-real')!.receipt;
    expect(doc).not.toContain(OLD_INTENT);
    expect(doc).not.toContain('authz-old');
    expect(doc).not.toContain(String(oldReceipt.signature));
    expect(doc).not.toContain('tk-old-unreferenced'); // not referenced, outside the window: nowhere in the file
    expect(doc).toContain('not verifiable — outside the reporting window');
    t.cleanup();
  });

  it('get_records and list_cases show only rows inside the window', async () => {
    const runExport = vi.fn(async (system: ExportSystem) => {
      if (system === 'erp') {
        return buildErpExport({
          quotes: [
            { id: 'q-old', number: 'Q-1', customer_id: 'c', status: 'sent', currency: 'EUR', net_total: 1, created_at: isoAgo(45 * DAY) },
            { id: 'q-new', number: 'Q-2', customer_id: 'c', status: 'sent', currency: 'EUR', net_total: 2, created_at: isoAgo(DAY) },
          ],
        });
      }
      return buildEmailExport({
        inbox: [
          { id: 'm-old', from_name: 'A', from_email: 'a@x', to_json: '[]', subject: 'old', body: 'b', received_at: isoAgo(60 * DAY), case_id: 'C0' },
          { id: 'm-new', from_name: 'A', from_email: 'a@x', to_json: '[]', subject: 'new', body: 'b', received_at: isoAgo(DAY), case_id: 'C1' },
        ],
      });
    });
    const t = setup([auth(REPORTING_BOUNDS)], runExport);
    const recs = JSON.parse((await createGatedToolHandler(t.tools.get_records, t.im, t.state)({ system: 'erp', kind: 'quotes' })).content[0].text);
    expect(recs.records.quotes.map((q: any) => q.id)).toEqual(['q-new']);
    const cases = JSON.parse((await createGatedToolHandler(t.tools.list_cases, t.im, t.state)({})).content[0].text);
    expect(cases.cases.map((c: any) => c.caseId)).toEqual(['C1']);
    t.cleanup();
  });
});

describe('reporting window (RR2) — simulation mode, and reporting@0.1 refused', () => {
  const prev = process.env.SUVEREN_SIMULATION;
  afterEach(() => {
    if (prev === undefined) delete process.env.SUVEREN_SIMULATION; else process.env.SUVEREN_SIMULATION = prev;
  });

  function loadExport(loadedAgo: number) {
    return vi.fn(async (system: ExportSystem) => (system === 'email'
      ? buildEmailExport({ simulation_load: { name: 'pkg', package_sha256: 's', cases_loaded: 0, loaded_at: isoAgo(loadedAgo) } })
      : system === 'erp' ? buildErpExport() : buildCrmExport()));
  }

  it('simulation mode: a ticket from before the test data was loaded is hidden, even inside the lookback', async () => {
    process.env.SUVEREN_SIMULATION = '1';
    const t = setup([auth(REPORTING_BOUNDS)], loadExport(3600));
    t.scenario.addTicket({ id: 'tk-before-load', action: 'a', authorizationId: 'x', timestamp: nowS() - 3601 });
    t.scenario.addTicket({ id: 'tk-after-load', action: 'a', authorizationId: 'x', timestamp: nowS() - 3599 });
    const r = await createGatedToolHandler(t.tools.list_tickets, t.im, t.state)({});
    const body = JSON.parse(r.content[0].text);
    expect(body.tickets.map((x: any) => x.id)).toEqual(['tk-after-load']);
    expect(body.window.since).toMatch(/test data was loaded/);
    const g = await createGatedToolHandler(t.tools.get_ticket, t.im, t.state)({ id: 'tk-before-load' });
    expect(g.isError).toBe(true);
    expect(g.content[0].text).toMatch(/outside the reporting window/);
    t.cleanup();
  });

  for (const simulation of [false, true]) {
    it(`REFUSAL: a reporting@0.1 mandate is refused ${simulation ? 'in' : 'outside'} simulation mode — every tool, and write_report before any ticket`, async () => {
      if (simulation) process.env.SUVEREN_SIMULATION = '1'; else delete process.env.SUVEREN_SIMULATION;
      const runExport = loadExport(600);
      const t = setup([authWithProfile(REPORTING_01.id, { read_access: 'unlimited', report_daily_max: 5 })], runExport);
      t.scenario.addTicket({ id: 'tk-1', action: 'a', authorizationId: 'x', timestamp: nowS() - 60 });
      for (const [name, args] of [['list_tickets', {}], ['get_ticket', { id: 'tk-1' }], ['list_cases', {}], ['get_records', { system: 'email' }]] as const) {
        const r = await createGatedToolHandler(t.tools[name], t.im, t.state)(args);
        expect(r.isError, name).toBe(true);
        expect(r.content[0].text, name).toMatch(/older profile version — create a new reporting mandate \(reporting@0\.2\)/);
        expect(r.content[0].text, name).not.toContain('tk-1');
      }
      const w = await createGatedToolHandler(t.tools.write_report, t.im, t.state)({ html: '<sv-ai><p>x</p></sv-ai>' });
      expect(w.isError).toBe(true);
      expect(w.content[0].text).toMatch(/older profile version/);
      expect(t.postReceipt).not.toHaveBeenCalled(); // refused before a ticket was requested
      if (!simulation) expect(runExport).not.toHaveBeenCalled();
      t.cleanup();
    });
  }
});

// ─── RR3 — what the report AI may read ──────────────────────────────────────

describe('report AI read scope (RR3) — no internal ids, signatures, blobs or account ids in any tool output', () => {
  const USER = 'c7246947-0f1e-4c2b-9a77-3d1f00a1b2c3';
  const GROUP = 'grp_5a1f0c2e-team';
  const DID = 'did:key:z6MkOwnerKeyMaterial246947';

  function seedSensitive(scenario: ReturnType<typeof buildScenario>) {
    return scenario.addTicket({
      id: 'tk-s', action: 'erp__send_quote', authorizationId: 'authz_9d3b7c11-secret',
      timestamp: nowS() - 600,
      extra: {
        userId: USER, groupId: GROUP, approvalSignature: 'APPROVALSIG-xyz', proposalId: 'prop_77',
        executionContext: { action_type: 'send', net_total: 840, userId: USER },
      },
      authorization: {
        authorizationId: 'authz_9d3b7c11-secret', profileId: 'github.com/humanagencyprotocol/hap-profiles/sales@0.3',
        bounds: { value_max: 1000 }, intent: 'Quote known customers only.', commitmentMode: 'review', owners: [DID],
      },
      proposal: { status: 'executed', createdAt: nowS() - 900, committedBy: { [USER]: { userId: USER, at: nowS() - 700 } } },
    });
  }

  it('every read tool and write_report: no forbidden key, no user/group/mandate id, no DID, no signature, no blob', async () => {
    const t = setup([auth(REPORTING_BOUNDS)]);
    const receipt = seedSensitive(t.scenario);
    const blob = t.scenario.archive.getAuthorizations()[0].attestations[0].blob;
    const outputs: Record<string, string> = {};
    for (const [name, args] of [
      ['list_tickets', {}], ['get_ticket', { id: 'tk-s' }], ['list_cases', {}],
      ['get_records', { system: 'erp' }], ['write_report', { html: '<sv-ticket ref="tk-s"></sv-ticket><sv-approval ticket="tk-s"></sv-approval><sv-mandate ticket="tk-s"></sv-mandate>' }],
    ] as const) {
      const r = await createGatedToolHandler(t.tools[name], t.im, t.state)(args);
      expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy();
      outputs[name] = r.content.map(c => c.text).join('\n');
    }
    for (const [name, text] of Object.entries(outputs)) {
      for (const key of FORBIDDEN_AGENT_KEYS) expect(text, `${name} carries "${key}"`).not.toContain(`"${key}"`);
      for (const value of [USER, GROUP, DID, 'authz_9d3b7c11-secret', String(receipt.signature), blob, 'APPROVALSIG-xyz', 'prop_77', '246947']) {
        expect(text, `${name} leaks ${value.slice(0, 24)}`).not.toContain(value);
      }
    }
    t.cleanup();
  });

  it('get_ticket is an allow-list: exactly these fields, with the facts a working agent sees plus approval facts', async () => {
    const t = setup([auth(REPORTING_BOUNDS)]);
    seedSensitive(t.scenario);
    const r = await createGatedToolHandler(t.tools.get_ticket, t.im, t.state)({ id: 'tk-s' });
    const body = JSON.parse(r.content[0].text);
    expect(Object.keys(body).sort()).toEqual(['approval', 'mandate', 'ticket']);
    expect(Object.keys(body.ticket).sort()).toEqual(
      ['action', 'actionLabel', 'checkUrl', 'limitsUsed', 'profile', 'profileLabel', 'ticketId', 'time', 'timeLabel'],
    );
    expect(Object.keys(body.approval).sort()).toEqual(
      ['approved', 'approvedBy', 'askedAt', 'askedAtLabel', 'decidedAt', 'decidedAtLabel', 'verified', 'waitLabel', 'waitSeconds'],
    );
    expect(Object.keys(body.mandate).sort()).toEqual(
      ['intent', 'limits', 'mode', 'owners', 'profile', 'profileLabel', 'rawLimits', 'verified'],
    );
    expect(body.ticket.ticketId).toBe('tk-s');
    expect(body.ticket.checkUrl).toBe(`${AS_URL}/r/tk-s`);
    expect(body.ticket.limitsUsed).toEqual({ action_type: 'send', net_total: 840 }); // nested userId scrubbed
    expect(body.approval).toMatchObject({ verified: true, approved: true, approvedBy: 'a person (name not disclosed)', waitSeconds: 200 });
    expect(body.mandate).toMatchObject({ verified: true, intent: 'Quote known customers only.', mode: 'review', owners: ['Owner (name not disclosed)'] });
    t.cleanup();
  });

  it('list_tickets rows are an allow-list too', async () => {
    const t = setup([auth(REPORTING_BOUNDS)]);
    seedSensitive(t.scenario);
    const body = JSON.parse((await createGatedToolHandler(t.tools.list_tickets, t.im, t.state)({})).content[0].text);
    expect(Object.keys(body.tickets[0]).sort()).toEqual(
      ['action', 'actionType', 'hasApproval', 'id', 'limitsUsed', 'profile', 'profileLabel', 'time'],
    );
    t.cleanup();
  });
});
