/**
 * Review-mode end to end for "emails carry documents by reference" (item 3):
 * a committed proposal whose toolArgs already carry `_attachmentsSealed`
 * (set by tool-proxy.ts's "resolve for display" step at proposal time) goes
 * through executeCommitted — which must re-resolve every sealed reference,
 * build the transport payload, and send it — OR refuse (nothing sent) when
 * a document changed since it was sealed. Same harness as
 * committed-executor.test.ts (real Ed25519-signed receipts via
 * ticket-verify.ts, a real ExecutionJournal).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerProfile, clearProfiles } from '@hap/core';
import { loadManifests } from '../src/lib/manifest-loader';
import { ExecutionJournal } from '../src/lib/execution-journal';
import { executeCommitted } from '../src/tools/commitments';
import { ATTACHMENTS_SEALED_META_KEY } from '../src/lib/attachment-resolution';
import { hashToolArgs } from '../src/lib/execution-journal';
import type { SharedState } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { SPProposal } from '../src/lib/sp-client';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';

const PROFILE = 'mail-attachments-review-test';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const PDF_BYTES = Buffer.from('%PDF-1.4 the real invoice as sealed');
const PDF_BASE64 = PDF_BYTES.toString('base64');
const PDF_SHA256 = sha256(PDF_BYTES);

let manifestDir: string;

beforeAll(() => {
  registerProfile(PROFILE, {
    id: PROFILE,
    version: '0.9',
    description: 'test',
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 1, max: 1 },
    retention_minimum: 1,
    // No content_binding declared — this file is about the attachment
    // transport/refusal mechanics, not content binding (covered separately
    // in content-binding-attachments.test.ts).
  });

  manifestDir = mkdtempSync(join(tmpdir(), 'hap-commitments-attachments-manifests-'));
  mkdirSync(join(manifestDir, 'erp'));
  mkdirSync(join(manifestDir, 'mail'));
  writeFileSync(join(manifestDir, 'index.json'), JSON.stringify({ integrations: { erp: 'erp/manifest.json', mail: 'mail/manifest.json' } }));
  writeFileSync(
    join(manifestDir, 'erp/manifest.json'),
    JSON.stringify({
      id: 'erp', name: 'ERP', version: '1', profile: 'invoicing',
      mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
      documents: { 'invoice-pdf': { tool: 'get_document', args: { kind: 'invoice-pdf', id: '$id' } } },
      toolGating: { default: { executionMapping: {} }, overrides: { get_document: { category: 'read', internal: true } } },
    }),
  );
  writeFileSync(
    join(manifestDir, 'mail/manifest.json'),
    JSON.stringify({
      id: 'mail', name: 'Mail', version: '1', profile: PROFILE,
      mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
      attachments: { transport: 'field', arg: 'attachments' },
      toolGating: {
        default: { executionMapping: {} },
        overrides: { send_message: { executionMapping: {}, staticExecution: { action_type: 'send' }, attachmentsArg: 'attachments', insertFields: ['body'] } },
      },
    }),
  );
  mkdirSync(join(manifestDir, 'gmail'));
  writeFileSync(
    join(manifestDir, 'gmail/manifest.json'),
    JSON.stringify({
      id: 'gmail', name: 'Gmail', version: '1', profile: PROFILE,
      mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
      attachments: { transport: 'mime-raw', arg: 'raw' },
      toolGating: {
        default: { executionMapping: {} },
        overrides: { send_message: { executionMapping: {}, staticExecution: { action_type: 'send' }, attachmentsArg: 'attachments', message: GMAIL_MESSAGE } },
      },
    }),
  );
  writeFileSync(join(manifestDir, 'index.json'), JSON.stringify({ integrations: { erp: 'erp/manifest.json', mail: 'mail/manifest.json', gmail: 'gmail/manifest.json' } }));
  loadManifests(manifestDir);
});

afterAll(() => {
  clearProfiles();
  rmSync(manifestDir, { recursive: true, force: true });
});

const kp = testReceiptKeypair();

const GMAIL_MESSAGE = { text: 'body', to: 'to', cc: 'cc', subject: 'subject', verb: 'Sent' as const };

const GMAIL_TOOL: DiscoveredTool = {
  originalName: 'send_message',
  namespacedName: 'gmail__send_message',
  integrationId: 'gmail',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  gating: { profile: PROFILE, executionMapping: {}, staticExecution: { action_type: 'send' }, attachmentsArg: 'attachments', message: GMAIL_MESSAGE } as unknown as DiscoveredTool['gating'],
};

const MAIL_TOOL: DiscoveredTool = {
  originalName: 'send_message',
  namespacedName: 'mail__send_message',
  integrationId: 'mail',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  gating: { profile: PROFILE, executionMapping: {}, staticExecution: { action_type: 'send' }, attachmentsArg: 'attachments', insertFields: ['body'] } as unknown as DiscoveredTool['gating'],
};

const ERP_TOOL: DiscoveredTool = {
  originalName: 'get_document',
  namespacedName: 'erp__get_document',
  integrationId: 'erp',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  gating: { profile: 'invoicing', executionMapping: {}, category: 'read', internal: true } as unknown as DiscoveredTool['gating'],
  internal: true,
};

/** A sealed proposal — exactly what tool-proxy.ts's "resolve for display"
 *  step would have stored: fingerprint only, no bytes, body already final. */
function buildProposal(sealedSha256: string, tool: DiscoveredTool = MAIL_TOOL): SPProposal {
  const toolArgs = {
    to: ['buchhaltung@drautal.at'],
    subject: 'Rechnung 2026-0003',
    body: 'Anbei die Rechnung.',
    [ATTACHMENTS_SEALED_META_KEY]: {
      attachments: [{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1', filename: 'Rechnung-2026-0003.pdf', contentType: 'application/pdf', sha256: sealedSha256, bytes: PDF_BYTES.byteLength }],
      inserts: [],
    },
  };
  return {
    id: 'prop-att-1',
    authorizationId: 'authz_1',
    profileId: PROFILE,
    path: `${PROFILE}@0.9`,
    pendingDomains: [],
    committedBy: { owner: { userId: 'andreas', at: 0 } },
    rejectedBy: null,
    tool: tool.namespacedName,
    toolArgs,
    executionContext: { action_type: 'send' },
    status: 'committed',
    executionResult: null,
    createdAt: 0,
    expiresAt: 0,
  };
}

function receiptFor(proposal: SPProposal, id: string): Record<string, unknown> {
  return makeSignedReceipt(kp, {
    id,
    action: proposal.tool,
    executionContext: proposal.executionContext,
    authorizationId: proposal.authorizationId,
    profileId: proposal.profileId,
    proposalId: proposal.id,
  });
}

function buildState(dir: string, proposal: SPProposal, postReceipt: ReturnType<typeof vi.fn>) {
  const state = {
    spClient: {
      postReceipt,
      isUnlocked: () => true,
      getProposalById: vi.fn().mockResolvedValue({ ...proposal, status: 'executed' }),
    },
    cache: { getAllAuthorizations: () => [], getPublicKey: async () => kp.publicKeyHex, getTrustedIssuer: async () => kp.issuer },
    proposalSubmissions: {
      get: () => ({
        proposalId: proposal.id,
        tool: proposal.tool,
        toolArgsHash: hashToolArgs(proposal.toolArgs),
        executionContextHash: hashToolArgs(proposal.executionContext),
        authorizationId: proposal.authorizationId,
        profileId: proposal.profileId,
        submittedAt: Math.floor(Date.now() / 1000),
      }),
      record: vi.fn(),
    },
    executionLog: { record: vi.fn() },
    executionJournal: new ExecutionJournal(dir),
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;
  return state;
}

function buildIntegrationManager(erpDoc: { filename: string; contentType: string; contentBase64: string; sha256: string }) {
  const callTool = vi.fn(async (integrationId: string, toolName: string, args: Record<string, unknown>) => {
    if (integrationId === 'erp' && toolName === 'get_document') {
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: erpDoc };
    }
    if ((integrationId === 'mail' || integrationId === 'gmail') && toolName === 'send_message') {
      return { content: [{ type: 'text', text: 'sent' }], structuredContent: { id: 'msg-1', sentArgs: args } };
    }
    throw new Error(`unexpected callTool(${integrationId}, ${toolName})`);
  });
  const im = { getAllTools: () => [MAIL_TOOL, GMAIL_TOOL, ERP_TOOL], callTool } as unknown as IntegrationManager;
  return { im, callTool };
}

describe('executeCommitted — attachment finalize at execution time', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hap-commitments-attachments-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('unchanged document: re-resolves, builds the field-transport payload, and the downstream call receives real bytes', async () => {
    const proposal = buildProposal(PDF_SHA256);
    const postReceipt = vi.fn().mockResolvedValue({ receipt: receiptFor(proposal, 'rcpt-att-1'), idempotent: false });
    const state = buildState(dir, proposal, postReceipt);
    const { im, callTool } = buildIntegrationManager({ filename: 'Rechnung-2026-0003.pdf', contentType: 'application/pdf', contentBase64: PDF_BASE64, sha256: PDF_SHA256 });

    const result = await executeCommitted(proposal, state, im);

    expect(result.isError).toBeUndefined();
    expect(callTool).toHaveBeenCalledWith('mail', 'send_message', expect.objectContaining({
      attachments: [{ filename: 'Rechnung-2026-0003.pdf', contentType: 'application/pdf', contentBase64: PDF_BASE64 }],
    }));
    // The sealed meta never reaches the downstream connector.
    const sentArgs = callTool.mock.calls[0][2] as Record<string, unknown>;
    expect(sentArgs[ATTACHMENTS_SEALED_META_KEY]).toBeUndefined();
  });

  it('mime-raw (Gmail) approved send: the ticket link is INSIDE the sent message, with the PDF', async () => {
    // 2026-10-18: approved emails with an attachment arrived without the
    // ticket link — the message was built before the link was added to the text.
    const proposal = buildProposal(PDF_SHA256, GMAIL_TOOL);
    const postReceipt = vi.fn().mockResolvedValue({ receipt: receiptFor(proposal, 'rcpt-att-gmail'), idempotent: false });
    const state = buildState(dir, proposal, postReceipt);
    const { im, callTool } = buildIntegrationManager({ filename: 'Rechnung-2026-0003.pdf', contentType: 'application/pdf', contentBase64: PDF_BASE64, sha256: PDF_SHA256 });

    const result = await executeCommitted(proposal, state, im);

    expect(result.isError).toBeUndefined();
    const sent = callTool.mock.calls.find(c => c[0] === 'gmail' && c[1] === 'send_message')![2] as Record<string, unknown>;
    const mime = Buffer.from((sent.raw as string).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const textPart = mime.split('\r\n\r\n')[2].split('\r\n--')[0].replace(/\r\n/g, '');
    const text = Buffer.from(textPart, 'base64').toString('utf8');
    expect(text).toContain('Anbei die Rechnung.');
    expect(text).toContain('/t/rcpt-att-gmail');
    expect(mime).toContain('Rechnung-2026-0003.pdf');
  });

  it('the document changed since it was sealed: refuses, nothing sent, journal outcome is "changed"', async () => {
    const proposal = buildProposal(PDF_SHA256); // sealed against the ORIGINAL bytes
    const postReceipt = vi.fn().mockResolvedValue({ receipt: receiptFor(proposal, 'rcpt-att-2'), idempotent: false });
    const state = buildState(dir, proposal, postReceipt);
    const CHANGED_BYTES = Buffer.from('%PDF-1.4 a DIFFERENT invoice entirely');
    const { im, callTool } = buildIntegrationManager({ filename: 'Rechnung-2026-0003.pdf', contentType: 'application/pdf', contentBase64: CHANGED_BYTES.toString('base64'), sha256: sha256(CHANGED_BYTES) });

    const result = await executeCommitted(proposal, state, im);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/changed since this was approved/);
    expect(result.text).toMatch(/Nothing was sent/);
    expect(callTool).not.toHaveBeenCalledWith('mail', 'send_message', expect.anything());
    const row = state.executionJournal.get('rcpt-att-2');
    expect(row?.state).toBe('failed');
    expect(row?.outcome).toBe('changed');
  });
});
