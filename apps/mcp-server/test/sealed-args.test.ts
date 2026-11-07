/**
 * Sealed-args rule (sealed-args.ts): where a tool's content is sealed, every
 * argument must be bound and shown, a declared reference, or declared
 * `nonContentArgs`; anything else is refused before any proposal or ticket.
 * Generic — the fixtures below use made-up connector, tool and field names on
 * purpose, and one profile-free binding per kind.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { classifySealedArgs, unclassifiedArgs, sealedArgsRefusalText } from '../src/lib/sealed-args';
import { invalidNonContentArgsReason, invalidManifestNonContentArgsReason } from '../src/lib/manifest-loader';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import { DenialLog } from '../src/lib/denial-log';
import type { SharedState } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

const FIELDS = { version: '2', kind: 'jcs', fields: ['to', 'subject', 'body'], required_fields: ['body'], appliesTo: ['send'] } as never;
const TEXT = { version: '1', kind: 'text' } as never;
const JCS = { version: '1', kind: 'jcs' } as never;

const GATING = {
  staticExecution: { action_type: 'send' },
  executionMapping: { to: 'recipients' },
  message: { text: 'body', to: 'to', subject: 'subject', verb: 'Sent' },
  attachmentsArg: 'files',
  insertFields: ['body'],
  sourceFromArg: { kind: 'message', arg: 'reply_to' },
};

describe('classifySealedArgs / unclassifiedArgs', () => {
  it('passes bound fields, references and gateway-owned arguments', () => {
    const args = { to: ['a@x'], subject: 's', body: 'b', files: [], insert: [], reply_to: {}, _source: {}, ticket_id: 'x' };
    expect(unclassifiedArgs(GATING, FIELDS, args)).toEqual([]);
  });

  it('refuses an argument that is none of the three — whatever it is called', () => {
    expect(unclassifiedArgs(GATING, FIELDS, { body: 'b', conversation: 'abc', also_html: true })).toEqual(['conversation', 'also_html']);
  });

  it('accepts an argument once the manifest declares it nonContentArgs', () => {
    const g = { ...GATING, nonContentArgs: ['page'] };
    expect(unclassifiedArgs(g, FIELDS, { body: 'b', page: 2 })).toEqual([]);
    expect(unclassifiedArgs(GATING, FIELDS, { body: 'b', page: 2 })).toEqual(['page']);
  });

  it('only the sealed fields count as bound: a v1 text binding seals the content field alone', () => {
    // `subject` is bound under the field binding, not under the text binding.
    expect(unclassifiedArgs(GATING, FIELDS, { body: 'b', subject: 's' })).toEqual([]);
    expect(unclassifiedArgs(GATING, TEXT, { body: 'b', subject: 's' })).toEqual(['subject']);
  });

  it('a declared contentField is the text binding\'s bound argument', () => {
    const g = { staticExecution: {}, contentField: 'sha', executionMapping: {} };
    expect(unclassifiedArgs(g, TEXT, { sha: 'abc', url: 'u' })).toEqual(['url']);
  });

  it('does not apply where nothing is sealed', () => {
    const odd = { conversation: 'abc' };
    expect(classifySealedArgs(GATING, undefined).exempt).toBe('no-binding');
    expect(unclassifiedArgs(GATING, undefined, odd)).toEqual([]);
    expect(unclassifiedArgs({ ...GATING, category: 'read' }, FIELDS, odd)).toEqual([]);
    // the binding does not apply to this action type (a delete carries an id only)
    expect(unclassifiedArgs({ ...GATING, staticExecution: { action_type: 'delete' } }, FIELDS, odd)).toEqual([]);
    // a text binding with no content field on the tool seals nothing
    expect(unclassifiedArgs({ staticExecution: {}, executionMapping: {} }, TEXT, odd)).toEqual([]);
    // a whole-payload binding binds every argument
    expect(classifySealedArgs(GATING, JCS).exempt).toBe('whole-payload');
    expect(unclassifiedArgs(GATING, JCS, odd)).toEqual([]);
  });

  it('refusal text names the argument and says why, never the value', () => {
    const t = sealedArgsRefusalText('x__send', ['conversation']);
    expect(t).toContain('"conversation"');
    expect(t).toMatch(/change what is sent/);
    expect(t).toMatch(/shown to the approver or sealed/);
    expect(t).toMatch(/No ticket was requested/);
  });
});

describe('nonContentArgs — manifest validation', () => {
  const ok = { executionMapping: { to: 'r' }, message: { text: 'body', verb: 'Sent' }, nonContentArgs: ['page'] };

  it('accepts a clean declaration and absence', () => {
    expect(invalidNonContentArgsReason('t', ok)).toBeNull();
    expect(invalidNonContentArgsReason('t', { executionMapping: {} })).toBeNull();
    expect(invalidNonContentArgsReason('t', null)).toBeNull();
  });

  it.each([
    ['not a list', { nonContentArgs: 'page' }],
    ['empty', { nonContentArgs: [] }],
    ['non-string', { nonContentArgs: [3] }],
    ['empty name', { nonContentArgs: [''] }],
    ['duplicate', { nonContentArgs: ['a', 'a'] }],
    ['on a read tool', { category: 'read', nonContentArgs: ['a'] }],
    ['on a disabled tool', { category: 'disabled', nonContentArgs: ['a'] }],
    ['also blocked', { blockedArgs: ['raw'], nonContentArgs: ['raw'] }],
    ['the message text', { message: { text: 'body', verb: 'Sent' }, nonContentArgs: ['body'] }],
    ['the message subject', { message: { text: 'body', subject: 'subj', verb: 'Sent' }, nonContentArgs: ['subj'] }],
    ['the content field', { contentField: 'sha', nonContentArgs: ['sha'] }],
    ['the attachments argument', { attachmentsArg: 'files', nonContentArgs: ['files'] }],
    ['the source link', { sourceFromArg: { kind: 'm', arg: 'rt' }, nonContentArgs: ['rt'] }],
    ['insert', { insertFields: ['body'], nonContentArgs: ['insert'] }],
    ['a mapped bound', { executionMapping: { to: 'r' }, nonContentArgs: ['to'] }],
    ['gateway-owned', { nonContentArgs: ['_source'] }],
  ])('refuses the manifest: %s', (_name, entry) => {
    const reason = invalidNonContentArgsReason('t', entry);
    expect(reason).toMatch(/nonContentArgs/);
    expect(invalidManifestNonContentArgsReason({ toolGating: { overrides: { t: entry } } } as never)).toBe(reason);
  });
});

describe('the refusal happens before any proposal or ticket', () => {
  const PROFILE = {
    id: 'github.com/example/sealed-demo@0.1', version: '0.1', description: 't',
    executionContextSchema: { fields: {} }, requiredGates: [], ttl: { default: 1, max: 1 }, retention_minimum: 1,
    content_binding: FIELDS,
  };
  let dataDir: string;
  let denialLog: DenialLog;
  beforeAll(() => { registerProfile(PROFILE.id, PROFILE as never); });
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'sealed-args-')); denialLog = new DenialLog(dataDir); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  const tool = {
    originalName: 'send', namespacedName: 'demo__send', integrationId: 'demo', description: '',
    inputSchema: { type: 'object', properties: {} },
    gating: { profile: 'sealed-demo', ...GATING, nonContentArgs: ['page'] },
  } as unknown as DiscoveredTool;

  /** Any use of the Authority Server, the gatekeeper or the connector fails the test. */
  const forbidden = () => new Proxy({}, { get() { throw new Error('reached past the guard'); } });
  const state = () => ({
    getEnrichedAuthorizations: () => [{ authorizationId: 'a1', profileId: PROFILE.id, complete: true, bounds: {}, context: {}, frame: {} }],
    spClient: { isUnlocked: () => true, postReceipt: () => { throw new Error('reached past the guard (ticket)'); } }, gatekeeper: forbidden(), cache: forbidden(), executionLog: forbidden(), executionJournal: forbidden(),
    denialLog,
  }) as unknown as SharedState;
  const manager = { isSimulationSafe: () => false, getAllTools: () => [tool], callTool: forbidden() } as unknown as IntegrationManager;

  it('refuses, names the argument, records a blocked action without content', async () => {
    const handler = createGatedToolHandler(tool, manager, state());
    const res = await handler({ to: ['a@x.example'], body: 'SECRET-BODY', conversation: 'thread-9' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('"conversation"');
    expect(res.content[0].text).toMatch(/No ticket was requested/);
    const records = denialLog.getRecent();
    const rec = JSON.stringify(records);
    expect(rec).toContain('unsealed_arg');
    expect(rec).toContain('UNSEALED_ARG');
    expect(rec).not.toContain('SECRET-BODY');
    expect(rec).not.toContain('thread-9');
  });

  it('lets a fully classified call go on to the normal path (it reaches the gatekeeper)', async () => {
    const handler = createGatedToolHandler(tool, manager, state());
    await expect(handler({ to: ['a@x.example'], body: 'b', page: 1 })).rejects.toThrow(/reached past the guard/);
  });
});
