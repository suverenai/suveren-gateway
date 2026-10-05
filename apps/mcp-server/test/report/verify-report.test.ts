/**
 * Report Verifier — orchestrator tests (work-plan "evidence-backed reports",
 * step R5). Exercises the REAL resolvers end to end (real signed tickets,
 * real signed attestations, a real `ReceiptArchive`) against fixture
 * simulator exports shaped like the real connectors' `export` CLI output.
 *
 * Per engineering.md: "test refusals harder than successes" — for every
 * verification rule here there is a companion test that BREAKS it and checks
 * the report says so, not just a happy path that never exercises the check.
 */
import { describe, it, expect } from 'vitest';
import { verifyReport } from '../../src/lib/report/verify-report';
import type { RunConnectorExport, ExportSystem, VerifiedElement } from '../../src/lib/report/types';
import { buildScenario, AS_URL } from './fixtures/scenario';
import { buildEmailExport, buildErpExport, buildCrmExport } from './fixtures/exports';
import { testReceiptKeypair } from '../helpers/real-receipt';

function el(elements: VerifiedElement[], id: string): VerifiedElement {
  const found = elements.find(e => e.id === id);
  if (!found) throw new Error(`test setup: no element "${id}" (got: ${elements.map(e => e.id).join(', ')})`);
  return found;
}

function makeRunExport(
  exports: Partial<Record<ExportSystem, unknown>>,
  errors: Partial<Record<ExportSystem, string>> = {},
): RunConnectorExport {
  return async system => {
    if (errors[system]) throw new Error(errors[system]);
    return exports[system] ?? {};
  };
}

describe('verifyReport — sv-ticket', () => {
  it('verifies a real archived ticket against its archived Authority Server key', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000, extra: { limits: { value_max: 1000 } } });

    const result = await verifyReport('<sv-ticket ref="t1"></sv-ticket>', { archive, runExport: makeRunExport({}) });

    const e = el(result.elements, 'sv-ticket-0');
    expect(e.status).toBe('verified');
    expect(e.data).toMatchObject({
      ticketId: 't1',
      action: 'erp__create_quote',
      time: 1_800_000_000,
      authorizationId: 'authz-1',
      limitsUsed: { value_max: 1000 },
      checkUrl: `${AS_URL}/r/t1`,
    });
    expect(result.proof.signaturesValid).toBe(1);
    expect(result.proof.unverifiableCount).toBe(0);
  });

  it('REFUSAL: a ticket id not in the local archive is unverifiable', async () => {
    const { archive } = buildScenario();
    const result = await verifyReport('<sv-ticket ref="ghost"></sv-ticket>', { archive, runExport: makeRunExport({}) });
    const e = el(result.elements, 'sv-ticket-0');
    expect(e.status).toBe('unverifiable');
    expect(e.reason).toMatch(/no ticket/i);
    expect(result.proof.signaturesValid).toBe(0);
    expect(result.proof.unverifiableCount).toBe(1);
  });

  it('REFUSAL: a ticket signed with a different key than the one archived does not verify', async () => {
    const { archive, addTicket } = buildScenario();
    const impostorKeypair = testReceiptKeypair();
    // Signed with a DIFFERENT private key than the one whose public key was
    // archived alongside it — simulates a tampered/forged ticket.
    addTicket({ id: 't-bad', action: 'erp__create_quote', authorizationId: 'authz-1', signWithKeypair: impostorKeypair });

    const result = await verifyReport('<sv-ticket ref="t-bad"></sv-ticket>', { archive, runExport: makeRunExport({}) });
    const e = el(result.elements, 'sv-ticket-0');
    expect(e.status).toBe('unverifiable');
    expect(e.reason).toMatch(/signature does not verify/i);
  });

  it('REFUSAL: a ticket with no archived Authority Server key cannot be verified', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 't-nokey', action: 'erp__create_quote', authorizationId: 'authz-1', omitAsPublicKey: true });
    const result = await verifyReport('<sv-ticket ref="t-nokey"></sv-ticket>', { archive, runExport: makeRunExport({}) });
    expect(el(result.elements, 'sv-ticket-0').status).toBe('unverifiable');
  });
});

describe('verifyReport — sv-approval', () => {
  it('verifies the archived approval (who, created -> decided, wait)', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({
      id: 't2', action: 'erp__send_quote', authorizationId: 'authz-1',
      proposal: { id: 'prop-1', status: 'executed', createdAt: 1000, committedBy: { finance: { userId: 'alice', at: 1090 } } },
    });

    const result = await verifyReport('<sv-approval ticket="t2"></sv-approval>', { archive, runExport: makeRunExport({}) });
    const e = el(result.elements, 'sv-approval-0');
    expect(e.status).toBe('verified');
    expect(e.data).toMatchObject({ who: ['alice'], createdAt: 1000, decidedAt: 1090, waitSeconds: 90 });
  });

  it('REFUSAL: a ticket with no archived proposal (automatic mode) is not an approval', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 't3', action: 'erp__send_quote', authorizationId: 'authz-1' }); // no proposal
    const result = await verifyReport('<sv-approval ticket="t3"></sv-approval>', { archive, runExport: makeRunExport({}) });
    expect(el(result.elements, 'sv-approval-0').status).toBe('unverifiable');
  });
});

describe('verifyReport — sv-mandate', () => {
  it('verifies the archived mandate matching the ticket', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({
      id: 't4', action: 'erp__create_quote', authorizationId: 'authz-mandate-1',
      authorization: {
        authorizationId: 'authz-mandate-1', profileId: 'sales@0.3', bounds: { value_max: 1000 },
        intent: 'Quote known customers only.', commitmentMode: 'review', owners: ['did:key:zOwner9'],
      },
    });

    const result = await verifyReport('<sv-mandate ticket="t4"></sv-mandate>', { archive, runExport: makeRunExport({}) });
    const e = el(result.elements, 'sv-mandate-0');
    expect(e.status).toBe('verified');
    expect(e.data).toMatchObject({
      authorizationId: 'authz-mandate-1', profile: 'sales@0.3', limits: { value_max: 1000 },
      intent: 'Quote known customers only.', mode: 'review', owners: ['did:key:zOwner9'],
    });
  });

  it('REFUSAL: boundsHash mismatch between ticket and archived mandate is unverifiable', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({
      id: 't5', action: 'erp__create_quote', authorizationId: 'authz-mismatch',
      extra: { boundsHash: 'sha256:ticket-says-this' },
      authorization: { authorizationId: 'authz-mismatch', profileId: 'sales@0.3', boundsHash: 'sha256:mandate-says-that' },
    });
    const result = await verifyReport('<sv-mandate ticket="t5"></sv-mandate>', { archive, runExport: makeRunExport({}) });
    expect(el(result.elements, 'sv-mandate-0').status).toBe('unverifiable');
  });
});

describe('verifyReport — sv-record', () => {
  it('resolves a record from the simulator export, and a change carries its causing ticket', async () => {
    const { archive } = buildScenario();
    const erp = buildErpExport({
      quotes: [{ id: 'q1', number: 'Q-1', customer_id: 'c1', status: 'sent', currency: 'EUR', net_total: 500, created_at: '2026-10-05T09:00:00.000Z' }],
      changes: [{ id: 'chg-1', at: '2026-10-05T09:00:00.000Z', tool: 'create_quote', receipt_id: 't1', document_id: 'q1' }],
    });

    const result = await verifyReport(
      '<sv-record system="erp" ref="q1"></sv-record><sv-record system="erp" ref="chg-1"></sv-record>',
      { archive, runExport: makeRunExport({ erp }) },
    );
    expect(el(result.elements, 'sv-record-0').status).toBe('verified');
    expect(el(result.elements, 'sv-record-0').data).toMatchObject({ kind: 'quote', id: 'q1' });
    expect(el(result.elements, 'sv-record-1').data).toMatchObject({ kind: 'change', causingReceiptId: 't1' });
    expect(result.proof.recordsChecked).toBe(2);
  });

  it('REFUSAL: an unknown record ref is unverifiable', async () => {
    const { archive } = buildScenario();
    const result = await verifyReport('<sv-record system="crm" ref="nope"></sv-record>', { archive, runExport: makeRunExport({ crm: buildCrmExport() }) });
    expect(el(result.elements, 'sv-record-0').status).toBe('unverifiable');
  });

  it('REFUSAL: when the connector export cannot be read, the record is unverifiable (not silently empty)', async () => {
    const { archive } = buildScenario();
    const result = await verifyReport('<sv-record system="crm" ref="x"></sv-record>', {
      archive, runExport: makeRunExport({}, { crm: 'crm-mcp not installed' }),
    });
    const e = el(result.elements, 'sv-record-0');
    expect(e.status).toBe('unverifiable');
    expect(e.reason).toMatch(/crm-mcp not installed/);
  });
});

const START_TIME = 1_800_000_000; // fixed, arbitrary — 2027-01-15T06:40:00Z
const START_ISO = new Date(START_TIME * 1000).toISOString();

describe('verifyReport — sv-case', () => {
  it('verifies start, goal and steps, and builds the timeline', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'step-1', action: 'crm__log_activity', authorizationId: 'authz-1', timestamp: START_TIME + 120 });
    addTicket({
      id: 'goal-1', action: 'email__send_message', authorizationId: 'authz-1', timestamp: START_TIME + 600,
      proposal: { id: 'p1', status: 'executed', createdAt: START_TIME + 500, committedBy: { finance: { userId: 'alice', at: START_TIME + 580 } } },
    });
    const email = buildEmailExport({
      inbox: [{ id: 'm1', from_name: 'Cust', from_email: 'cust@example.com', to_json: '["us@example.com"]', subject: 'Quote please', body: 'hi', received_at: START_ISO, case_id: 'C1' }],
      sent: [{ id: 's1', from_name: 'Us', from_email: 'us@example.com', to_json: '["cust@example.com"]', subject: 'Re: Quote please', body: 'here', received_at: new Date((START_TIME + 600) * 1000).toISOString(), in_reply_to: 'm1', receipt_id: 'goal-1' }],
    });

    const html = '<sv-case start="email:m1" goal="ticket:goal-1" steps="step-1"></sv-case>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });
    const e = el(result.elements, 'sv-case-0');
    expect(e.status).toBe('verified');
    expect(e.data).toMatchObject({ caseId: 'C1', totalDurationSeconds: 600 });
    expect((e.data!.steps as unknown[]).length).toBe(1);
    expect((e.data!.approvals as unknown[]).length).toBe(1);
    const timeline = e.data!.timeline as Array<{ type: string }>;
    expect(timeline[0].type).toBe('start');
    expect(timeline[timeline.length - 1].type).toBe('goal');
  });

  it('REFUSAL: goal before start is unverifiable', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'goal-early', action: 'email__send_message', authorizationId: 'authz-1', timestamp: START_TIME - 10 });
    const email = buildEmailExport({
      inbox: [{ id: 'm2', from_name: 'Cust', from_email: 'cust@example.com', to_json: '[]', subject: 'x', body: 'x', received_at: START_ISO, case_id: 'C2' }],
    });
    const result = await verifyReport('<sv-case start="email:m2" goal="ticket:goal-early" steps=""></sv-case>', { archive, runExport: makeRunExport({ email }) });
    const e = el(result.elements, 'sv-case-0');
    expect(e.status).toBe('unverifiable');
    expect(e.reason).toMatch(/before start/i);
    // Coverage still credits the case as addressed — start itself was real.
    expect(result.coverage.coveredCases).toContain('C2');
  });

  it('WARNING: an email goal that is neither a reply nor addressed to the sender is "goal link not confirmed"', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'goal-noreply', action: 'email__send_message', authorizationId: 'authz-1', timestamp: START_TIME + 60 });
    const email = buildEmailExport({
      inbox: [{ id: 'm3', from_name: 'Cust', from_email: 'cust@example.com', to_json: '[]', subject: 'x', body: 'x', received_at: START_ISO, case_id: 'C3' }],
      sent: [{ id: 's3', from_name: 'Us', from_email: 'us@example.com', to_json: '["someone-else@example.com"]', subject: 'unrelated', body: 'x', received_at: new Date((START_TIME + 60) * 1000).toISOString(), in_reply_to: null, receipt_id: 'goal-noreply' }],
    });
    const result = await verifyReport('<sv-case start="email:m3" goal="ticket:goal-noreply" steps=""></sv-case>', { archive, runExport: makeRunExport({ email }) });
    const e = el(result.elements, 'sv-case-0');
    expect(e.status).toBe('warning');
    expect(e.reason).toMatch(/goal link not confirmed/);
    expect(e.data).toBeDefined(); // a warning still carries real, checked data
  });

  it('REFUSAL: a step ticket outside the [start, goal] window is unverifiable', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'goal-4', action: 'email__send_message', authorizationId: 'authz-1', timestamp: START_TIME + 300 });
    addTicket({ id: 'step-late', action: 'crm__log_activity', authorizationId: 'authz-1', timestamp: START_TIME + 900 }); // AFTER the goal
    const email = buildEmailExport({
      inbox: [{ id: 'm4', from_name: 'Cust', from_email: 'cust@example.com', to_json: '[]', subject: 'x', body: 'x', received_at: START_ISO, case_id: 'C4' }],
    });
    const result = await verifyReport('<sv-case start="email:m4" goal="ticket:goal-4" steps="step-late"></sv-case>', { archive, runExport: makeRunExport({ email }) });
    const e = el(result.elements, 'sv-case-0');
    expect(e.status).toBe('unverifiable');
    expect(e.reason).toMatch(/outside the case window/);
  });

  it('REFUSAL: start must be a loaded, case-tagged inbox message', async () => {
    const { archive } = buildScenario();
    const email = buildEmailExport({ inbox: [] });
    const result = await verifyReport('<sv-case start="email:ghost" goal="ticket:x" steps=""></sv-case>', { archive, runExport: makeRunExport({ email }) });
    expect(el(result.elements, 'sv-case-0').status).toBe('unverifiable');
  });
});

describe('verifyReport — sv-metric', () => {
  async function oneCaseScenario() {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'm-step', action: 'crm__log_activity', authorizationId: 'authz-1', timestamp: START_TIME + 100 });
    addTicket({
      id: 'm-goal', action: 'email__send_message', authorizationId: 'authz-1', timestamp: START_TIME + 400,
      proposal: { id: 'p-m', status: 'executed', createdAt: START_TIME + 350, committedBy: { finance: { userId: 'bob', at: START_TIME + 390 } } },
    });
    const email = buildEmailExport({
      inbox: [{ id: 'mm1', from_name: 'Cust', from_email: 'cust@example.com', to_json: '["us@example.com"]', subject: 'x', body: 'x', received_at: START_ISO, case_id: 'CM1' }],
      sent: [{ id: 'ss1', from_name: 'Us', from_email: 'us@example.com', to_json: '["cust@example.com"]', subject: 'x', body: 'x', received_at: new Date((START_TIME + 400) * 1000).toISOString(), in_reply_to: 'mm1', receipt_id: 'm-goal' }],
    });
    return { archive, addTicket, email };
  }

  it('computes real numbers matching hand-computed values', async () => {
    const { archive, email } = await oneCaseScenario();
    const html =
      '<sv-case start="email:mm1" goal="ticket:m-goal" steps="m-step"></sv-case>' +
      '<sv-metric kind="completed" cases="all"></sv-metric>' +
      '<sv-metric kind="median-time" cases="all"></sv-metric>' +
      '<sv-metric kind="approvals" cases="all"></sv-metric>' +
      '<sv-metric kind="without-approval" cases="all"></sv-metric>' +
      '<sv-metric kind="tickets" cases="all"></sv-metric>' +
      '<sv-metric kind="median-approval-wait" cases="all"></sv-metric>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email, erp: buildErpExport(), crm: buildCrmExport() }) });

    expect(el(result.elements, 'sv-metric-0').data!.value).toBe(1); // completed
    expect(el(result.elements, 'sv-metric-1').data!.value).toBe(400); // median-time: goal(start+400) - start(start+0)
    expect(el(result.elements, 'sv-metric-2').data!.value).toBe(1); // approvals
    expect(el(result.elements, 'sv-metric-3').data!.value).toBe(0); // without-approval share
    expect(el(result.elements, 'sv-metric-4').data!.value).toBe(2); // tickets: goal + 1 step
    expect(el(result.elements, 'sv-metric-5').data!.value).toBe(40); // median-approval-wait: 390-350
  });

  it('REFUSAL: refusals metric fails closed when a connector export cannot be read', async () => {
    const { archive, email } = await oneCaseScenario();
    const html = '<sv-case start="email:mm1" goal="ticket:m-goal" steps="m-step"></sv-case><sv-metric kind="refusals" cases="all"></sv-metric>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }, { erp: 'erp-mcp not installed' }) });
    const metric = el(result.elements, 'sv-metric-0');
    expect(metric.status).toBe('unverifiable');
    expect(metric.reason).toMatch(/erp-mcp not installed/);
  });

  it('counts simulator refusals within the case window, across systems', async () => {
    const { archive, email } = await oneCaseScenario();
    const erp = buildErpExport({ refusals: [{ id: 'r1', at: new Date((START_TIME + 150) * 1000).toISOString(), tool: 'create_quote', message: 'over cap' }] });
    const html = '<sv-case start="email:mm1" goal="ticket:m-goal" steps="m-step"></sv-case><sv-metric kind="refusals" cases="all"></sv-metric>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email, erp, crm: buildCrmExport() }) });
    expect(el(result.elements, 'sv-metric-0').data!.value).toBe(1);
  });

  it('REFUSAL: an unknown metric kind is unverifiable', async () => {
    const { archive, email } = await oneCaseScenario();
    const html = '<sv-case start="email:mm1" goal="ticket:m-goal" steps="m-step"></sv-case><sv-metric kind="made-up-kind" cases="all"></sv-metric>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });
    expect(el(result.elements, 'sv-metric-0').status).toBe('unverifiable');
  });
});

describe('verifyReport — unknown elements and coverage', () => {
  it('REFUSAL: an unrecognised sv-* element is unverifiable', async () => {
    const { archive } = buildScenario();
    const result = await verifyReport('<sv-bogus foo="x"></sv-bogus>', { archive, runExport: makeRunExport({}) });
    const e = el(result.elements, 'sv-bogus-0');
    expect(e.status).toBe('unverifiable');
    expect(e.reason).toMatch(/unknown element/i);
  });

  it('coverage lists a loaded case the report never addressed', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'cov-goal', action: 'email__send_message', authorizationId: 'authz-1', timestamp: START_TIME + 200 });
    const email = buildEmailExport({
      inbox: [
        { id: 'cov-1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'x', body: 'x', received_at: START_ISO, case_id: 'COVERED' },
        { id: 'cov-2', from_name: 'B', from_email: 'b@example.com', to_json: '[]', subject: 'x', body: 'x', received_at: START_ISO, case_id: 'MISSING' },
      ],
    });
    const html = '<sv-case start="email:cov-1" goal="ticket:cov-goal" steps=""></sv-case>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });

    expect(result.coverage.loadedCases.sort()).toEqual(['COVERED', 'MISSING']);
    expect(result.coverage.coveredCases).toEqual(['COVERED']);
    expect(result.coverage.missingCases).toEqual(['MISSING']);
  });
});

describe('verifyReport — ticket coverage (the AI cannot leave a ticket out unnoticed)', () => {
  it('lists every ticket since the simulation load that the report does not reference', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'before-load', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: START_TIME - 600 });
    addTicket({ id: 't-step', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: START_TIME + 100 });
    addTicket({ id: 't-hidden', action: 'erp__update_quote', authorizationId: 'authz-1', timestamp: START_TIME + 150 });
    addTicket({ id: 't-goal', action: 'email__send_message', authorizationId: 'authz-1', timestamp: START_TIME + 200 });
    const email = buildEmailExport({
      simulation_load: { name: 'pkg', package_sha256: 'x', cases_loaded: 1, loaded_at: START_ISO },
      inbox: [{ id: 'm-1', from_name: 'A', from_email: 'a@example.com', to_json: '[]', subject: 'x', body: 'x', received_at: START_ISO, case_id: 'C1' }],
    });
    const html = '<sv-case start="email:m-1" goal="ticket:t-goal" steps="t-step"></sv-case>';
    const result = await verifyReport(html, { archive, runExport: makeRunExport({ email }) });

    expect(result.coverage.periodStart).toBe(START_TIME);
    expect(result.coverage.ticketsInPeriod).toEqual(['t-step', 't-hidden', 't-goal']);
    expect(result.coverage.ticketsReferenced).toEqual(['t-step', 't-goal']);
    expect(result.coverage.ticketsNotReferenced).toEqual(['t-hidden']);
  });

  it('without a known load time every archived ticket counts', async () => {
    const { archive, addTicket } = buildScenario();
    addTicket({ id: 'old', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: START_TIME - 600 });
    const result = await verifyReport('<p>nothing</p>', { archive, runExport: makeRunExport({ email: buildEmailExport({}) }) });
    expect(result.coverage.periodStart).toBeNull();
    expect(result.coverage.ticketsNotReferenced).toEqual(['old']);
  });
});

describe('verifyReport — control check (a broken rule must fail its own test)', () => {
  it('a tampered ticket signature is caught — proving the signature check is not a no-op', async () => {
    const { archive, addTicket, kp } = buildScenario();
    const receipt = addTicket({ id: 'tamper-1', action: 'erp__create_quote', authorizationId: 'authz-1' });

    // Flip one character of the real signature — as if bytes were corrupted
    // in transit or an attacker modified the stored evidence — and archive
    // THAT tampered receipt under a fresh id, still against the correct
    // (real) Authority Server key, so only the signature itself is wrong.
    const sig = String(receipt.signature);
    const tampered = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    archive.record({
      receipt: { ...receipt, id: 'tamper-1-recorded', signature: tampered },
      authorizationId: 'authz-1',
      asUrl: AS_URL,
      asPublicKey: kp.publicKeyHex,
    });

    const result = await verifyReport('<sv-ticket ref="tamper-1-recorded"></sv-ticket>', { archive, runExport: makeRunExport({}) });
    expect(el(result.elements, 'sv-ticket-0').status).toBe('unverifiable');
    expect(el(result.elements, 'sv-ticket-0').reason).toMatch(/signature does not verify/i);
  });
});
