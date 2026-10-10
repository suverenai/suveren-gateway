/**
 * AU4 — the previewHash fallback inside executeCommitted, for a tool whose
 * declared preview carries no `version` (no connector-side revision
 * enforcement of its own). A proposal submission (tool-proxy.ts) snapshots a
 * hash of the preview read; right before the tool runs, executeCommitted
 * re-reads and compares — any mismatch refuses, never executes, and
 * journals outcome 'changed'.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCommitted } from '../src/tools/commitments';
import { loadManifests } from '../src/lib/manifest-loader';
import { hashPreviewBody } from '../src/lib/preview';
import type { SharedState } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { SPProposal } from '../src/lib/sp-client';
import { testReceiptKeypair, makeSignedReceipt } from './helpers/real-receipt';
import { hashToolArgs } from '../src/lib/execution-journal';

let manifestDir: string;

beforeAll(() => {
  manifestDir = mkdtempSync(join(tmpdir(), 'hap-preview-exec-manifests-'));
  mkdirSync(join(manifestDir, 'gmail'));
  writeFileSync(
    join(manifestDir, 'index.json'),
    JSON.stringify({ integrations: { gmail: 'gmail/manifest.json' } }),
  );
  writeFileSync(
    join(manifestDir, 'gmail/manifest.json'),
    JSON.stringify({
      id: 'gmail',
      name: 'Gmail',
      version: '1',
      profile: 'email',
      mcp: { command: 'node', args: [] },
      credentials: { fields: [], envMapping: {} },
      oauth: null,
      toolGating: {
        default: { executionMapping: {}, staticExecution: {} },
        overrides: {
          send_message: {
            executionMapping: {},
            staticExecution: { action_type: 'send' },
            // No `version` — the AU4 fallback path.
            preview: { tool: 'get_message', args: { id: 'to' } },
          },
        },
      },
    }),
  );
  loadManifests(manifestDir);
});

afterAll(() => rmSync(manifestDir, { recursive: true, force: true }));

const PROPOSAL: SPProposal = {
  id: 'prop-preview-1',
  authorizationId: 'authz_1',
  profileId: 'test-email@1',
  path: 'email@0.5',
  pendingDomains: [],
  committedBy: { owner: { userId: 'andreas', at: 0 } },
  rejectedBy: null,
  tool: 'gmail__send_message',
  toolArgs: { body: 'Hi there', to: 'x@y.com' },
  executionContext: { action_type: 'send' },
  status: 'committed',
  executionResult: null,
  createdAt: 0,
  expiresAt: 0,
};

const TOOL: DiscoveredTool = {
  originalName: 'send_message',
  namespacedName: 'gmail__send_message',
  integrationId: 'gmail',
  description: '',
  inputSchema: { type: 'object', properties: { body: { type: 'string' }, to: { type: 'string' } } },
  gating: { profile: 'email', executionMapping: {}, staticExecution: {} } as unknown as DiscoveredTool['gating'],
};

const PREVIEW_TOOL: DiscoveredTool = {
  originalName: 'get_message',
  namespacedName: 'gmail__get_message',
  integrationId: 'gmail',
  description: '',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  gating: null,
};

/** The read-tool's canned "current" answer — same for every call in these
 *  tests; what differs per test is the previewHash recorded at submission. */
const CURRENT_READ_BODY = { snippet: 'unchanged content' };

function buildState(opts: { previewHash?: string }) {
  const kp = testReceiptKeypair();
  const postReceipt = vi.fn().mockImplementation(async (req: {
    action: string;
    executionContext?: Record<string, unknown>;
    authorizationId?: string;
    profileId?: string;
    proposalId?: string;
  }) => ({
    receipt: makeSignedReceipt(kp, {
      id: 'rcpt-preview-1',
      action: req.action,
      executionContext: req.executionContext ?? {},
      authorizationId: req.authorizationId,
      profileId: req.profileId,
      proposalId: req.proposalId,
    }),
  }));
  const completeSpy = vi.fn();
  const state = {
    spClient: { postReceipt },
    proposalSubmissions: {
      get: () => ({
        proposalId: PROPOSAL.id,
        tool: PROPOSAL.tool,
        toolArgsHash: hashToolArgs(PROPOSAL.toolArgs),
        executionContextHash: hashToolArgs(PROPOSAL.executionContext),
        authorizationId: PROPOSAL.authorizationId,
        profileId: PROPOSAL.profileId,
        submittedAt: Math.floor(Date.now() / 1000),
        previewHash: opts.previewHash,
      }),
      record: vi.fn(),
    },
    cache: {
      getPublicKey: async () => kp.publicKeyHex,
      getTrustedIssuer: async () => kp.issuer,
      getAllAuthorizations: () => [
        {
          authorizationId: 'authz_1',
          profileId: 'email',
          path: 'email@0.5',
          frame: {},
          attestations: [],
          requiredDomains: [],
          attestedDomains: [],
          deferredCommitmentDomains: [],
          complete: true,
        },
      ],
    },
    executionLog: { record: vi.fn() },
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
    executionJournal: { begin: () => ({ ok: true }), complete: completeSpy },
  } as unknown as SharedState;
  return { state, completeSpy };
}

function buildIntegrationManager() {
  const callTool = vi.fn().mockImplementation(async (_integrationId: string, toolName: string) => {
    if (toolName === 'get_message') {
      return { content: [{ type: 'text', text: 'read' }], structuredContent: CURRENT_READ_BODY };
    }
    return { content: [{ type: 'text', text: 'sent' }] };
  });
  const integrationManager = {
    getAllTools: () => [TOOL, PREVIEW_TOOL],
    callTool,
  } as unknown as IntegrationManager;
  return { integrationManager, callTool };
}

describe('executeCommitted — AU4 previewHash fallback', () => {
  it('matches: executes normally and journals done', async () => {
    const matchingHash = hashPreviewBody({ structured: CURRENT_READ_BODY });
    const { state, completeSpy } = buildState({ previewHash: matchingHash });
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await executeCommitted(PROPOSAL, state, integrationManager);

    expect(result.isError).toBeFalsy();
    expect(callTool).toHaveBeenCalledWith('gmail', 'send_message', expect.anything());
    expect(completeSpy).toHaveBeenCalledWith('rcpt-preview-1', 'done');
  });

  it('mismatch: does NOT call the action tool, journals failed/changed, refuses', async () => {
    const { state, completeSpy } = buildState({ previewHash: 'sha256:stale-hash-from-submission' });
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await executeCommitted(PROPOSAL, state, integrationManager);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/record changed in gmail/);
    expect(result.text).toMatch(/nothing was done/);
    expect(result.text).toMatch(/new attempt needs a new request and approval/);
    // The action tool (send_message) must NEVER be called once a change is
    // detected — only the preview read (get_message) runs.
    expect(callTool).not.toHaveBeenCalledWith('gmail', 'send_message', expect.anything());
    expect(callTool).toHaveBeenCalledWith('gmail', 'get_message', expect.anything());
    expect(completeSpy).toHaveBeenCalledWith('rcpt-preview-1', 'failed', 'changed');
  });

  it('no previewHash on the submission record: runs exactly like before AU4', async () => {
    const { state, completeSpy } = buildState({});
    const { integrationManager, callTool } = buildIntegrationManager();

    const result = await executeCommitted(PROPOSAL, state, integrationManager);

    expect(result.isError).toBeFalsy();
    expect(callTool).toHaveBeenCalledWith('gmail', 'send_message', expect.anything());
    // No preview re-read happens when no hash was snapshotted at submission.
    expect(callTool).not.toHaveBeenCalledWith('gmail', 'get_message', expect.anything());
    expect(completeSpy).toHaveBeenCalledWith('rcpt-preview-1', 'done');
  });
});
