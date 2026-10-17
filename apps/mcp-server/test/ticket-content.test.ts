/**
 * UI spec §14 — automatic tickets show what was sent. Pins, through the
 * REAL automatic path (tool-proxy.ts createGatedToolHandler) and the REAL
 * SharedState#archiveReceipt / ReceiptArchive / ExecutionJournal /
 * ExecutionResultStore on a temp dir:
 *
 *  1. the archive entry carries `sentArgs` — exactly the object the journal's
 *     argsHash is computed from — written before the tool runs;
 *  2. the archive write stays fail-closed: a failed write blocks the call;
 *  3. the tool's answer is kept for automatic executions, keyed by ticket;
 *  4. the args check: match / mismatch (local copy changed) / unchecked;
 *  5. the review path does not store args twice (proposal.toolArgs is it).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfile, clearProfiles } from '@hap/core';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { SharedState, type EnrichedAuthorization } from '../src/lib/shared-state';
import { ReceiptArchive, SENT_ARGS_MAX_BYTES } from '../src/lib/receipt-archive';
import { ExecutionJournal, hashToolArgs } from '../src/lib/execution-journal';
import { ExecutionResultStore } from '../src/lib/execution-result-store';
import { checkSentArgs, archivedArgs, headlineArgs, resultView, trimForHeadline } from '../src/lib/ticket-content';
import type { CachedAuthorization } from '../src/lib/attestation-cache';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

vi.mock('../src/lib/cp-notify', () => ({ notifyControlPlane: vi.fn().mockResolvedValue(undefined) }));

const PROFILE_ID = 'github.com/humanagencyprotocol/hap-profiles/ticket-content-test@0.5';
const SHORT = 'ticket-content-test';
const ARGS = { name: 'Anna Auto', company: 'Drautal Maschinenbau GmbH', type: 'customer', _source: { connector: 'mail', kind: 'message', id: 'm-1' } };

beforeAll(() => {
  registerProfile(PROFILE_ID, {
    id: PROFILE_ID, version: '0.5', description: 'test',
    executionContextSchema: { fields: {} }, requiredGates: [], ttl: { default: 1, max: 1 }, retention_minimum: 1,
  } as never);
});
afterAll(() => clearProfiles());

const TOOL: DiscoveredTool = {
  originalName: 'create_contact',
  namespacedName: 'crm__create_contact',
  integrationId: 'crm',
  description: '',
  inputSchema: { type: 'object', properties: { name: {}, company: {}, type: {}, _source: { type: 'object' } } },
  gating: { profile: SHORT, executionMapping: {}, staticExecution: { action_type: 'write' } } as unknown as DiscoveredTool['gating'],
};

const AUTH = {
  authorizationId: 'authz_00000000-0000-4000-8000-0000000000c1',
  profileId: PROFILE_ID,
  path: 'crm-routine',
  frame: { profile: PROFILE_ID, path: 'crm-routine' },
  attestations: [],
  requiredDomains: [],
  attestedDomains: [],
  complete: true,
} as unknown as CachedAuthorization;

const TICKET_ID = 'rcpt-tc-1';

function buildState(dir: string, archive = new ReceiptArchive(dir)) {
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: Record<string, unknown>) => ({
    receipt: makeSignedReceipt(kp, {
      id: TICKET_ID,
      action: req.action as string,
      executionContext: (req.executionContext as Record<string, unknown>) ?? {},
      authorizationId: req.authorizationId as string,
      profileId: req.profileId as string,
      idempotencyKey: req.idempotencyKey as string,
    }),
  }));
  const state = {
    getEnrichedAuthorizations: () => [{ ...AUTH, gateContent: null } as EnrichedAuthorization],
    spClient: { postReceipt, isUnlocked: () => true, url: 'https://as.test' },
    cache: { getAllAuthorizations: () => [AUTH], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    gateStore: { get: () => undefined },
    gatekeeper: { verifyExecution: vi.fn().mockResolvedValue({ result: { approved: true, errors: [] }, authorization: AUTH }) },
    executionLog: { record: vi.fn() },
    executionJournal: new ExecutionJournal(dir),
    executionResults: new ExecutionResultStore(dir),
    receiptArchive: archive,
  } as unknown as SharedState;
  // The REAL write-ahead, fail-closed archive method, on this partial state.
  (state as unknown as { archiveReceipt: SharedState['archiveReceipt'] }).archiveReceipt =
    SharedState.prototype.archiveReceipt.bind(state);
  return state;
}

function im(callTool: ReturnType<typeof vi.fn>) {
  return { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager;
}

describe('automatic path — the archive keeps what was sent', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ticket-content-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes sentArgs = exactly the object the journal hashed, BEFORE the tool runs', async () => {
    const state = buildState(dir);
    let archivedAtCall: unknown;
    const callTool = vi.fn().mockImplementation(async () => {
      // Write-ahead: the entry (with sentArgs) exists when the tool is called.
      archivedAtCall = state.receiptArchive.getReceipts()[0]?.sentArgs;
      return { content: [{ type: 'text', text: '{"id":"c-1042"}' }], structuredContent: { id: 'c-1042' } };
    });
    const result = await createGatedToolHandler(TOOL, im(callTool), state)({ ...ARGS });
    expect((result as { isError?: boolean }).isError).not.toBe(true);

    const entry = state.receiptArchive.getReceipts()[0];
    expect(entry.sentArgs).toEqual(ARGS); // _source included: it is part of the hashed object
    expect(archivedAtCall).toEqual(ARGS);
    const row = state.executionJournal.get(TICKET_ID);
    expect(row?.argsHash).toBe(hashToolArgs(entry.sentArgs));
    expect(checkSentArgs(entry, row)).toBe('match');
    // The downstream still never sees _source (AU10) — only the record keeps it.
    expect('_source' in (callTool.mock.calls[0][2] as Record<string, unknown>)).toBe(false);
  });

  it('sentArgs survives a restart, encrypted with the rest of the archive', async () => {
    const key = Buffer.alloc(32, 7);
    const archive = new ReceiptArchive(dir);
    archive.setVaultKey(key);
    const state = buildState(dir, archive);
    await createGatedToolHandler(TOOL, im(vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })), state)({ ...ARGS });

    const reopened = new ReceiptArchive(dir);
    expect(reopened.isLocked()).toBe(true);
    reopened.setVaultKey(key);
    expect(reopened.getReceipts()[0].sentArgs).toEqual(ARGS);
  });

  it('stays FAIL-CLOSED: a failed archive write blocks the call, nothing runs, nothing is journaled', async () => {
    const archive = new ReceiptArchive(dir);
    vi.spyOn(archive, 'record').mockImplementation(() => { throw new Error('disk full'); });
    const state = buildState(dir, archive);
    const callTool = vi.fn();
    const result = await createGatedToolHandler(TOOL, im(callTool), state)({ ...ARGS });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result as { content: Array<{ text: string }> }).content[0].text).toMatch(/could not be archived locally/);
    expect(callTool).not.toHaveBeenCalled();
    expect(state.executionJournal.get(TICKET_ID)).toBeUndefined();
    expect(state.executionResults.getByTicket(TICKET_ID)).toBeUndefined();
  });

  it('args too large to keep: the ticket is still archived (and the call runs), marked too_large', async () => {
    const state = buildState(dir);
    const big = { ...ARGS, notes: 'x'.repeat(SENT_ARGS_MAX_BYTES + 10) };
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await createGatedToolHandler(TOOL, im(callTool), state)(big);
    const entry = state.receiptArchive.getReceipts()[0];
    expect(callTool).toHaveBeenCalledOnce();
    expect(entry.sentArgs).toBeUndefined();
    expect(entry.sentArgsOmitted).toBe('too_large');
    expect(checkSentArgs(entry, state.executionJournal.get(TICKET_ID))).toBe('unchecked');
  });
});

describe('automatic path — the result is kept, keyed by ticket', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ticket-result-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('success: text and structuredContent', async () => {
    const state = buildState(dir);
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Contact c-1042 created' }], structuredContent: { id: 'c-1042' } });
    await createGatedToolHandler(TOOL, im(callTool), state)({ ...ARGS });
    const kept = state.executionResults.getByTicket(TICKET_ID);
    expect(kept).toMatchObject({ ticketId: TICKET_ID, ok: true, text: 'Contact c-1042 created', structuredContent: { id: 'c-1042' } });
    expect(kept?.proposalId).toBeUndefined();
    expect(resultView(kept)).toEqual({ ok: true, text: 'Contact c-1042 created', structuredContent: { id: 'c-1042' } });
  });

  it('the connector answered with an error: kept as not ok, with its text', async () => {
    const state = buildState(dir);
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Duplicate contact' }], isError: true });
    await createGatedToolHandler(TOOL, im(callTool), state)({ ...ARGS });
    expect(state.executionResults.getByTicket(TICKET_ID)).toMatchObject({ ok: false, text: 'Duplicate contact' });
  });

  it('the call threw: kept as not ok, the error rethrown as before', async () => {
    const state = buildState(dir);
    const callTool = vi.fn().mockRejectedValue(new Error('connection reset'));
    await expect(createGatedToolHandler(TOOL, im(callTool), state)({ ...ARGS })).rejects.toThrow('connection reset');
    expect(state.executionResults.getByTicket(TICKET_ID)).toMatchObject({ ok: false, text: 'The tool call threw: connection reset' });
    expect(state.executionJournal.get(TICKET_ID)?.state).toBe('failed');
  });

  it('a result-store failure never turns a completed action into an error', async () => {
    const state = buildState(dir);
    vi.spyOn(state.executionResults, 'record').mockImplementation(() => { throw new Error('disk full'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const result = await createGatedToolHandler(TOOL, im(callTool), state)({ ...ARGS });
    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(state.executionJournal.get(TICKET_ID)?.state).toBe('done');
    errSpy.mockRestore();
  });

  it('automatic and review entries do not replace each other', () => {
    const store = new ExecutionResultStore(dir);
    store.record({ proposalId: 'p1', ticketId: 't-review', ok: true, text: 'review' });
    store.record({ ticketId: 't-auto', ok: true, text: 'auto' });
    store.record({ ticketId: 't-auto', ok: true, text: 'auto again' });
    expect(store.get('p1')?.text).toBe('review');
    expect(store.getByTicket('t-review')?.text).toBe('review');
    expect(store.getByTicket('t-auto')?.text).toBe('auto again');
    expect(store.size).toBe(2);
  });
});

describe('checkSentArgs — match / mismatch / unchecked', () => {
  const args = { amount: '0.10', description: 'Suveren test charge' };
  const row = { argsHash: hashToolArgs(args) };

  it('match: the archived copy hashes to the journal row', () => {
    expect(checkSentArgs({ sentArgs: { ...args } }, row)).toBe('match');
  });

  it('match regardless of key order', () => {
    expect(checkSentArgs({ sentArgs: { description: 'Suveren test charge', amount: '0.10' } }, row)).toBe('match');
  });

  it('mismatch: the local copy was changed', () => {
    expect(checkSentArgs({ sentArgs: { ...args, amount: '10.00' } }, row)).toBe('mismatch');
  });

  it('unchecked: no args kept, or no journal row (pruned after 90 days / never written)', () => {
    expect(checkSentArgs({}, row)).toBe('unchecked');
    expect(checkSentArgs({ sentArgs: args }, undefined)).toBe('unchecked');
  });

  it('review path: the archived proposal.toolArgs is the checked object (not stored twice)', () => {
    expect(archivedArgs({ proposal: { toolArgs: args } })).toEqual({ args, source: 'proposal' });
    expect(checkSentArgs({ proposal: { toolArgs: args } }, row)).toBe('match');
    expect(checkSentArgs({ proposal: { toolArgs: { ...args, amount: '9' } } }, row)).toBe('mismatch');
  });

  it('review path with an image: the archive stripped _imagePreview the journal hashed — unchecked, never a false alarm', () => {
    const withImage = { text: 'post', imagePath: '/tmp/a.png', _imagePreview: 'data:image/png;base64,AAA' };
    const { _imagePreview: _drop, ...stripped } = withImage;
    expect(checkSentArgs({ proposal: { toolArgs: stripped } }, { argsHash: hashToolArgs(withImage) })).toBe('unchecked');
  });
});

describe('headlineArgs — automatic tickets only, trimmed', () => {
  it('uses sentArgs, else object boundContent; skips approved tickets and text-only bound content', () => {
    const base = { archivedAt: 0, authorizationId: 'a', asUrl: '', asPublicKey: '' };
    const out = headlineArgs([
      { ...base, receipt: { id: 't1' }, sentArgs: { name: 'Anna' } },
      { ...base, receipt: { id: 't2' }, boundContent: { name: 'Bert' } },
      { ...base, receipt: { id: 't3' }, boundContent: 'just text' },
      { ...base, receipt: { id: 't4' }, proposal: { toolArgs: { name: 'Approved' } } },
      { ...base, receipt: { id: 't5' } },
    ]);
    expect(out).toEqual({ t1: { name: 'Anna' }, t2: { name: 'Bert' } });
  });

  it('trims long strings but keeps array lengths (a list headline counts "+N")', () => {
    expect(trimForHeadline({ body: 'y'.repeat(500), to: ['a', 'b', 'c', 'd', 'e', 'f'] })).toEqual({
      body: 'y'.repeat(200),
      to: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
  });
});
