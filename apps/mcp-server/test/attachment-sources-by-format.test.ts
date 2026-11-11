/**
 * The attachment-source field is recognised by its declared format
 * (`format: "connector:kind"`), never by its name. A made-up profile declares
 * it as `may_include_documents` — nothing in the gateway knows that name — and
 * every place that reads the field must still work off the format: the policy
 * ("empty means nothing" too), the candidate narrowing, the change card's tag,
 * the AI's guidance, and the gated call itself (the execution-context field
 * the subset check reads, and the refusal recorded for the card).
 *
 * Written against email@0.9's shape: its scope and execution-context field
 * renamed, nothing else changed.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { computeMandateDiff, type ChangeProfile } from '@hap/core/mandate-change';
import { emptyScopeMeans } from '@hap/core/scope-rules';
import {
  attachmentSourcesField, attachmentSourcesFieldDeclared, attachmentSourcesValue,
  isAttachmentSourceAllowed, candidatesAllowingAttachments,
} from '../src/lib/attachment-policy';
import { attachmentNotAllowedText, connectorOverview, proposalFields, type OverviewInput } from '../src/lib/guidance';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { DenialLog } from '../src/lib/denial-log';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

const FIELD = 'may_include_documents';
const PROFILE_ID = 'example.org/test/hap-profiles/bulletin@0.1';
const OLD_PROFILE_ID = 'example.org/test/hap-profiles/bulletin@0.0';

const BULLETIN = {
  id: PROFILE_ID,
  version: '0.1',
  description: 'test — a made-up profile whose document-source field has its own name',
  boundsSchema: {
    actionTypes: ['send'],
    keyOrder: ['profile', 'send_daily_max'],
    fields: {
      profile: { type: 'string', required: true },
      send_daily_max: { type: 'number', required: false, boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['send'] },
    },
  },
  scopeSchema: {
    keyOrder: ['allowed_domains', FIELD],
    fields: {
      allowed_domains: { type: 'string', required: false, format: 'domain', constraint: { type: 'string', enforceable: ['subset'] } },
      [FIELD]: {
        type: 'string', required: false, displayName: 'Documents it may include', format: 'connector:kind',
        constraint: { type: 'string', enforceable: ['subset'] },
      },
    },
  },
  executionContextSchema: {
    fields: {
      [FIELD]: { source: 'declared', required: false, constraint: { type: 'string', enforceable: ['subset'] } },
    },
  },
  requiredGates: [],
  ttl: { default: 3600, max: 86400 },
  retention_minimum: 1,
};
/** The same area before it could carry documents: no `connector:kind` field. */
const BULLETIN_OLD = {
  ...BULLETIN, id: OLD_PROFILE_ID, version: '0.0',
  scopeSchema: { keyOrder: ['allowed_domains'], fields: { allowed_domains: BULLETIN.scopeSchema.fields.allowed_domains } },
  executionContextSchema: { fields: {} },
};

const profileOf = (id: string) => (id === PROFILE_ID ? BULLETIN : id === OLD_PROFILE_ID ? BULLETIN_OLD : undefined);
const FILE = { connector: 'files', kind: 'file' };

beforeAll(() => {
  registerProfile(PROFILE_ID, BULLETIN as never);
  registerProfile(OLD_PROFILE_ID, BULLETIN_OLD as never);
  registerProfile('bulletin', BULLETIN as never);
});

describe('the policy finds the field by its format', () => {
  it('names the declared field, whatever it is called; a profile without one has none', () => {
    expect(attachmentSourcesField(BULLETIN)).toBe(FIELD);
    expect(attachmentSourcesFieldDeclared(BULLETIN)).toBe(true);
    expect(attachmentSourcesField(BULLETIN_OLD)).toBeUndefined();
    expect(attachmentSourcesValue(BULLETIN, { [FIELD]: 'files:file' })).toBe('files:file');
  });

  it('allows a listed source and refuses an unlisted one, naming the declared field', () => {
    expect(isAttachmentSourceAllowed(PROFILE_ID, BULLETIN, 'erp:invoice-pdf,files:file', FILE).allowed).toBe(true);
    const refused = isAttachmentSourceAllowed(PROFILE_ID, BULLETIN, 'erp:invoice-pdf', FILE);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe(`"files:file" is not in this mandate's "${FIELD}" (erp:invoice-pdf).`);
  });

  it('empty means nothing: an empty or absent list refuses every attachment', () => {
    expect(emptyScopeMeans(BULLETIN.scopeSchema.fields[FIELD])).toBe('nothing');
    expect(emptyScopeMeans(BULLETIN.scopeSchema.fields.allowed_domains)).toBe('anything');
    expect(isAttachmentSourceAllowed(PROFILE_ID, BULLETIN, '', FILE).allowed).toBe(false);
    expect(isAttachmentSourceAllowed(PROFILE_ID, BULLETIN, undefined, FILE).allowed).toBe(false);
  });

  it('a profile with no such field refuses every attachment, as today', () => {
    expect(isAttachmentSourceAllowed(OLD_PROFILE_ID, BULLETIN_OLD, 'files:file', FILE).allowed).toBe(false);
  });

  it('candidate narrowing reads each mandate\'s value of its own declared field', () => {
    const old = { id: 'old', profileId: OLD_PROFILE_ID, context: { [FIELD]: 'files:file' } };
    const unticked = { id: 'unticked', profileId: PROFILE_ID, context: { [FIELD]: 'erp:invoice-pdf' } };
    const ticked = { id: 'ticked', profileId: PROFILE_ID, context: { [FIELD]: 'files:file' } };
    const r = candidatesAllowingAttachments([old, unticked, ticked], [FILE], profileOf);
    expect(r.allowed.map((c) => c.id)).toEqual(['ticked']);
  });
});

describe('the change card tags the list the way the gateway enforces it', () => {
  const side = (scope: Record<string, string>) => ({
    profile: BULLETIN as unknown as ChangeProfile, bounds: { send_daily_max: 5 }, scope, intent: 'Why.', mode: 'review', expiresAt: 1000,
  });
  it('adding a source to an empty list is More; emptying it is Less', () => {
    const add = computeMandateDiff({ before: side({}), after: side({ [FIELD]: 'files:file' }) }).rows.find((r) => r.field === FIELD);
    expect(add).toMatchObject({ tag: 'More', added: ['files:file'], emptyMeans: 'nothing', format: 'connector:kind' });
    const drop = computeMandateDiff({ before: side({ [FIELD]: 'files:file' }), after: side({}) }).rows.find((r) => r.field === FIELD);
    expect(drop).toMatchObject({ tag: 'Less', removed: ['files:file'], emptyMeans: 'nothing' });
  });
});

describe('the AI\'s guidance reads the declared field', () => {
  it('the field list for a proposal says what the field takes', () => {
    const sources = [{ key: 'files:file', connectorId: 'files', kind: 'file', title: 'Saved files' }];
    expect(proposalFields('setup__create_mandate', 'bulletin', BULLETIN as never, ['review'], sources)).toContain(
      `${FIELD} (Documents it may include) = comma-separated, from Saved files (files:file); when the work attaches files`,
    );
  });

  it('the refusal says to tick the source on the mandate that has the field', () => {
    const t = attachmentNotAllowedText({
      tool: 'post__send', area: 'Bulletin', refs: [FILE],
      candidates: [{ profileId: PROFILE_ID, context: { [FIELD]: 'erp:invoice-pdf' } }],
      profileOf, titleOf: () => 'Saved files',
    });
    expect(t).toContain('open the Bulletin mandate, press **Edit**, tick Saved files (files:file) under **What the AI may attach**');
  });

  it('the connector overview says which sources the sending mandate allows', () => {
    const input: OverviewInput = {
      manifests: [
        { id: 'post', name: 'Post', profile: 'bulletin', toolGating: { overrides: { send: { attachmentsArg: 'attachments' } } } } as never,
        { id: 'files', name: 'Files', profile: 'files', documents: { file: { title: 'Saved files', savedBy: 'save_file' } } } as never,
      ],
      auths: [{ profileId: PROFILE_ID, complete: true, context: { [FIELD]: 'files:file' } }],
      areaName: (a) => a,
      setup: { card: 'Setup', held: [], fields: { profile: 'allowed_profiles', mode: 'allowed_modes' } } as never,
      toolName: (c, t) => `${c}__${t}`,
      facts: () => ({ running: true, hasCredentials: true }),
      mandateProfileOf: profileOf,
    };
    expect(connectorOverview(input)).toContain('may attach: Saved files (save the file first with files__save_file) — allowed');
  });
});

describe('a gated call uses the declared field', () => {
  let dataDir: string;
  let denialLog: DenialLog;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'attach-by-format-')); denialLog = new DenialLog(dataDir); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const TOOL: DiscoveredTool = {
    originalName: 'send', namespacedName: 'post__send', integrationId: 'post', description: '',
    inputSchema: { type: 'object', properties: {} },
    gating: { profile: 'bulletin', executionMapping: {}, staticExecution: { action_type: 'send' }, attachmentsArg: 'attachments' } as unknown as DiscoveredTool['gating'],
  };
  const auth = (context: Record<string, string>) => ({
    authorizationId: 'authz_b0000000-0000-4000-8000-00000000b001', profileId: PROFILE_ID, path: 'p',
    frame: { send_daily_max: 5 }, bounds: { send_daily_max: 5 }, context,
    attestations: [], requiredDomains: [], attestedDomains: [], deferredCommitmentDomains: [], complete: true, gateContent: null,
  }) as unknown as EnrichedAuthorization;
  const im = { getAllTools: () => [TOOL], callTool: async () => ({ content: [] }), isSimulationSafe: () => false } as unknown as IntegrationManager;
  const state = (auths: EnrichedAuthorization[], seen: Array<Record<string, unknown>>) => ({
    getEnrichedAuthorizations: () => auths,
    spClient: { isUnlocked: () => true, postReceipt: async () => { throw new Error('unused'); } },
    denialLog,
    gatekeeper: { verifyExecution: async (_id: string, execution: Record<string, unknown>) => { seen.push({ ...execution }); return { result: { approved: true, errors: [] } }; } },
    cache: { invalidate: () => {}, markNeedsReapproval: () => {} },
    executionLog: { record: () => {} },
    executionJournal: { begin: () => ({ ok: true }), complete: () => {} },
    archiveReceipt: async () => {},
  }) as unknown as SharedState;

  it('the call\'s own sources reach the subset check under the declared field name', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await createGatedToolHandler(TOOL, im, state([auth({ [FIELD]: 'files:file' })], seen))({ text: 'x', attachments: [{ ...FILE, id: 'f1' }] });
    expect(seen[0]?.[FIELD]).toBe('files:file');
  });

  it('a source the mandate does not list is refused and recorded under the declared field', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await createGatedToolHandler(TOOL, im, state([auth({ [FIELD]: '' })], seen))({ text: 'x', attachments: [{ ...FILE, id: 'f1' }] });
    expect(result.isError).toBe(true);
    expect(denialLog.getRecent()[0]).toMatchObject({ kind: 'scope', who: 'gateway', field: FIELD, value: 'files:file' });
  });
});
