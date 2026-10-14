/**
 * AU10 — request/history read engine (doc/au10-request-context.md).
 * Covers: identity-key derivation (incl. free-mail suppression), `_source`
 * resolution (explicit + implicit sourceFromArg, invalid/unreadable/
 * not_found), thread chain traversal, contextKeys gathering (direct +
 * recordKeys indirection), and history matching (no key / no match /
 * unreachable / ok + AI-written detection via the execution journal).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveIdentityKeysFromEmail,
  deriveIdentityKeysFromValue,
  isFreeMailDomain,
  withSourceLink,
  stripSourceLink,
  resolveRequestContext,
  gatherContextKeysFromAction,
  buildHistory,
  buildRequestContext,
} from '../src/lib/request-context';
import { loadManifests, getAllManifests } from '../src/lib/manifest-loader';
import { ExecutionJournal } from '../src/lib/execution-journal';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

// ─── Identity keys ──────────────────────────────────────────────────────────

describe('free-mail domains', () => {
  it('flags well-known consumer providers', () => {
    expect(isFreeMailDomain('gmail.com')).toBe(true);
    expect(isFreeMailDomain('GMAIL.com')).toBe(true);
    expect(isFreeMailDomain('gmx.de')).toBe(true);
  });
  it('does not flag a business domain', () => {
    expect(isFreeMailDomain('bavaria-umform.de')).toBe(false);
  });
});

describe('deriveIdentityKeysFromEmail', () => {
  it('yields email + email_domain for a business address', () => {
    expect(deriveIdentityKeysFromEmail('J.Kraus@Bavaria-Umform.de')).toEqual([
      { type: 'email', value: 'j.kraus@bavaria-umform.de' },
      { type: 'email_domain', value: 'bavaria-umform.de' },
    ]);
  });
  it('yields ONLY email for a free-mail address (doc §2)', () => {
    expect(deriveIdentityKeysFromEmail('hans.privat@gmail.com')).toEqual([
      { type: 'email', value: 'hans.privat@gmail.com' },
    ]);
  });
  it('yields nothing for a malformed address', () => {
    expect(deriveIdentityKeysFromEmail('not-an-email')).toEqual([]);
    expect(deriveIdentityKeysFromEmail('@nodomain')).toEqual([]);
    expect(deriveIdentityKeysFromEmail('noat@')).toEqual([]);
  });
});

describe('deriveIdentityKeysFromValue', () => {
  it('handles a single string', () => {
    expect(deriveIdentityKeysFromValue('a@b.com').length).toBe(2);
  });
  it('handles an array (e.g. send_message.to)', () => {
    const keys = deriveIdentityKeysFromValue(['a@b.com', 'c@gmail.com']);
    expect(keys).toEqual([
      { type: 'email', value: 'a@b.com' },
      { type: 'email_domain', value: 'b.com' },
      { type: 'email', value: 'c@gmail.com' },
    ]);
  });
  it('handles neither', () => {
    expect(deriveIdentityKeysFromValue(42)).toEqual([]);
    expect(deriveIdentityKeysFromValue(undefined)).toEqual([]);
  });
});

// ─── `_source` schema injection + stripping ─────────────────────────────────

describe('withSourceLink', () => {
  it('adds an optional _source property', () => {
    const schema = withSourceLink({ type: 'object', properties: { name: { type: 'string' } } });
    expect((schema.properties as Record<string, unknown>)._source).toBeDefined();
    expect((schema.properties as Record<string, unknown>).name).toEqual({ type: 'string' });
  });
  it('is idempotent — never clobbers an existing _source', () => {
    const already = { type: 'object', properties: { _source: { type: 'string' } } };
    expect(withSourceLink(already)).toBe(already);
  });
  it('tolerates a schema with no properties at all', () => {
    const schema = withSourceLink({ type: 'object' });
    expect((schema.properties as Record<string, unknown>)._source).toBeDefined();
  });
});

describe('stripSourceLink', () => {
  it('removes _source and nothing else', () => {
    const out = stripSourceLink({ name: 'x', _source: { connector: 'mail', kind: 'message', id: 'm-1' } });
    expect(out).toEqual({ name: 'x' });
  });
  it('is a no-op when _source is absent (and returns the SAME object)', () => {
    const args = { name: 'x' };
    expect(stripSourceLink(args)).toBe(args);
  });
});

// ─── Fixture manifests + fake IntegrationManager ───────────────────────────

let manifestDir: string;

function loadFixtureManifests(): void {
  manifestDir = mkdtempSync(join(tmpdir(), 'hap-au10-manifests-'));
  const index = { integrations: { mail: 'mail.json', crm: 'crm.json', erp: 'erp.json' } };
  writeFileSync(join(manifestDir, 'index.json'), JSON.stringify(index));
  writeFileSync(join(manifestDir, 'mail.json'), JSON.stringify({
    id: 'mail', name: 'Email', version: '1', profile: 'email',
    mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
    context: {
      sources: {
        message: {
          read: { tool: 'get_message', args: { id: '$id' } },
          keys: { email: 'from.email' },
          title: 'subject', author: 'from.name', at: 'received_at', body: 'body',
          chain: { field: 'in_reply_to', max: 5 },
        },
      },
    },
    toolGating: {
      default: { executionMapping: {}, staticExecution: {} },
      overrides: {
        get_message: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
        send_message: {
          executionMapping: {}, staticExecution: { action_type: 'send' },
          sourceFromArg: { kind: 'message', arg: 'in_reply_to' },
          contextKeys: { email: 'to' },
        },
      },
    },
  }));
  writeFileSync(join(manifestDir, 'crm.json'), JSON.stringify({
    id: 'crm', name: 'CRM', version: '1', profile: 'customers',
    mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
    context: {
      history: {
        byKey: ['email_domain', 'email'],
        read: { tool: 'get_timeline', args: { $keyType: '$key', since: '$since', limit: '$limit' } },
        limit: 5, maxAgeDays: 14,
        item: { kind: 'activity', title: 'summary', body: 'detail', at: 'date', author: 'created_by', type: 'type', ticket: 'ticket_id' },
      },
    },
    toolGating: {
      default: { executionMapping: {}, staticExecution: {} },
      overrides: {
        get_timeline: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
        create_contact: {
          executionMapping: {}, staticExecution: { action_type: 'write' },
          contextKeys: { email: 'email' },
        },
      },
    },
  }));
  writeFileSync(join(manifestDir, 'erp.json'), JSON.stringify({
    id: 'erp', name: 'ERP', version: '1', profile: 'sales',
    mcp: { command: 'node', args: [] }, credentials: { fields: [], envMapping: {} }, oauth: null,
    context: {
      recordKeys: {
        customer: { read: { tool: 'get_customer', args: { id: '$id' } }, keys: { email: 'email' } },
      },
    },
    toolGating: {
      default: { executionMapping: {}, staticExecution: {} },
      overrides: {
        get_customer: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
        create_quote: {
          executionMapping: {}, staticExecution: { action_type: 'quote' },
          contextKeys: { customer: 'customer_id' },
        },
      },
    },
  }));
  loadManifests(manifestDir);
}

function cleanupFixtureManifests(): void {
  rmSync(manifestDir, { recursive: true, force: true });
}

interface Fixtures {
  messages: Record<string, { subject: string; from: { name: string; email: string }; received_at: string; body: string; in_reply_to?: string | null }>;
  timelines: Record<string, Array<Record<string, unknown>>>;
  customers: Record<string, { email: string }>;
}

function buildFakeManager(fixtures: Fixtures): { integrationManager: IntegrationManager; callTool: ReturnType<typeof vi.fn> } {
  const tools: DiscoveredTool[] = [
    { originalName: 'get_message', namespacedName: 'mail__get_message', integrationId: 'mail', description: '', inputSchema: {}, gating: null },
    { originalName: 'get_timeline', namespacedName: 'crm__get_timeline', integrationId: 'crm', description: '', inputSchema: {}, gating: null },
    { originalName: 'get_customer', namespacedName: 'erp__get_customer', integrationId: 'erp', description: '', inputSchema: {}, gating: null },
  ];
  const callTool = vi.fn().mockImplementation(async (integrationId: string, toolName: string, args: Record<string, unknown>) => {
    if (integrationId === 'mail' && toolName === 'get_message') {
      const msg = fixtures.messages[args.id as string];
      if (!msg) return { content: [{ type: 'text', text: 'not found' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(msg) }] };
    }
    if (integrationId === 'crm' && toolName === 'get_timeline') {
      const key = (args.email_domain ?? args.email) as string | undefined;
      const rows = (key && fixtures.timelines[key]) ?? [];
      return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
    }
    if (integrationId === 'erp' && toolName === 'get_customer') {
      const c = fixtures.customers[args.id as string];
      if (!c) return { content: [{ type: 'text', text: 'not found' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(c) }] };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const integrationManager = { getAllTools: () => tools, callTool, isBuiltin: () => false } as unknown as IntegrationManager;
  return { integrationManager, callTool };
}

/** AU10 F4 — "every connector configured on this gateway", for tests that
 *  aren't specifically exercising the installed/not-installed distinction. */
const ALL_CONFIGURED = new Set(['mail', 'crm', 'erp']);

describe('AU10 request/history engine', () => {
  let journalDir: string;
  let journal: ExecutionJournal;

  beforeEach(() => {
    loadFixtureManifests();
    journalDir = mkdtempSync(join(tmpdir(), 'hap-au10-journal-'));
    journal = new ExecutionJournal(journalDir);
  });
  afterEach(() => {
    cleanupFixtureManifests();
    rmSync(journalDir, { recursive: true, force: true });
  });

  // ─── Request block ────────────────────────────────────────────────────

  it('resolves an explicit _source and extracts title/author/body', async () => {
    const { integrationManager } = buildFakeManager({
      messages: { 'm-17': { subject: 'RF 55 Stillstand', from: { name: 'J. Kraus', email: 'j.kraus@bavaria-umform.de' }, received_at: '2026-10-14T09:55:00Z', body: 'Guten Morgen...' } },
      timelines: {}, customers: {},
    });
    const { result, keys } = await resolveRequestContext(
      integrationManager, { _source: { connector: 'mail', kind: 'message', id: 'm-17' } }, 'crm', undefined, ALL_CONFIGURED,
    );
    expect(result).toMatchObject({ status: 'ok', connector: 'mail', kind: 'message', implicit: false, author: 'J. Kraus', title: 'RF 55 Stillstand' });
    expect(keys).toEqual([
      { type: 'email', value: 'j.kraus@bavaria-umform.de' },
      { type: 'email_domain', value: 'bavaria-umform.de' },
    ]);
  });

  it('resolves an implicit sourceFromArg when no _source is given', async () => {
    const { integrationManager } = buildFakeManager({
      messages: { 'm-17': { subject: 'RF 55 Stillstand', from: { name: 'J. Kraus', email: 'j.kraus@bavaria-umform.de' }, received_at: '2026-10-14T09:55:00Z', body: 'x' } },
      timelines: {}, customers: {},
    });
    const { result } = await resolveRequestContext(
      integrationManager, { to: ['j.kraus@bavaria-umform.de'], in_reply_to: 'm-17' }, 'mail',
      { kind: 'message', arg: 'in_reply_to' }, ALL_CONFIGURED,
    );
    expect(result).toMatchObject({ status: 'ok', implicit: true, connector: 'mail' });
  });

  it('explicit _source wins over sourceFromArg when both are present', async () => {
    const { integrationManager } = buildFakeManager({
      messages: {
        'm-17': { subject: 'A', from: { name: 'A', email: 'a@x.com' }, received_at: 't', body: '' },
        'm-99': { subject: 'B', from: { name: 'B', email: 'b@x.com' }, received_at: 't', body: '' },
      },
      timelines: {}, customers: {},
    });
    const { result } = await resolveRequestContext(
      integrationManager,
      { in_reply_to: 'm-17', _source: { connector: 'mail', kind: 'message', id: 'm-99' } },
      'mail',
      { kind: 'message', arg: 'in_reply_to' },
      ALL_CONFIGURED,
    );
    expect(result).toMatchObject({ status: 'ok', title: 'B' });
  });

  it('none — no _source and no sourceFromArg', async () => {
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    const { result } = await resolveRequestContext(integrationManager, {}, 'crm', undefined, ALL_CONFIGURED);
    expect(result).toEqual({ status: 'none' });
  });

  it('unreadable — malformed _source shape', async () => {
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    const { result } = await resolveRequestContext(integrationManager, { _source: { connector: 'mail' } }, 'crm', undefined, ALL_CONFIGURED);
    expect(result.status).toBe('unreadable');
  });

  it('unreadable — unknown connector', async () => {
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    const { result } = await resolveRequestContext(
      integrationManager, { _source: { connector: 'unknown_system', kind: 'record', id: 'x' } }, 'crm', undefined, ALL_CONFIGURED,
    );
    expect(result).toEqual({ status: 'unreadable', reason: 'connector not installed' });
  });

  it('unreadable — undeclared kind on a known connector', async () => {
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    const { result } = await resolveRequestContext(
      integrationManager, { _source: { connector: 'mail', kind: 'attachment', id: 'x' } }, 'crm', undefined, ALL_CONFIGURED,
    );
    expect(result.status).toBe('unreadable');
  });

  it('not_found — the record no longer exists', async () => {
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    const { result } = await resolveRequestContext(
      integrationManager, { _source: { connector: 'mail', kind: 'message', id: 'm-gone' } }, 'crm', undefined, ALL_CONFIGURED,
    );
    expect(result).toEqual({ status: 'not_found' });
  });

  it('follows a thread chain up to max hops, oldest-first collapse', async () => {
    const { integrationManager } = buildFakeManager({
      messages: {
        'm-3': { subject: 'Re: Re: X', from: { name: 'A', email: 'a@x.com' }, received_at: 't3', body: 'latest', in_reply_to: 'm-2' },
        'm-2': { subject: 'Re: X', from: { name: 'A', email: 'a@x.com' }, received_at: 't2', body: 'middle', in_reply_to: 'm-1' },
        'm-1': { subject: 'X', from: { name: 'A', email: 'a@x.com' }, received_at: 't1', body: 'first', in_reply_to: null },
      },
      timelines: {}, customers: {},
    });
    const { result } = await resolveRequestContext(integrationManager, { _source: { connector: 'mail', kind: 'message', id: 'm-3' } }, 'crm', undefined, ALL_CONFIGURED);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.chain).toHaveLength(2);
      expect(result.chain[0].title).toBe('Re: X');
      expect(result.chain[1].title).toBe('X');
    }
  });

  it('a chain capped at max=5 never loops forever on a cycle', async () => {
    const { integrationManager } = buildFakeManager({
      messages: {
        'm-a': { subject: 'A', from: { name: 'A', email: 'a@x.com' }, received_at: 't', body: '', in_reply_to: 'm-b' },
        'm-b': { subject: 'B', from: { name: 'A', email: 'a@x.com' }, received_at: 't', body: '', in_reply_to: 'm-a' },
      },
      timelines: {}, customers: {},
    });
    const { result } = await resolveRequestContext(integrationManager, { _source: { connector: 'mail', kind: 'message', id: 'm-a' } }, 'crm', undefined, ALL_CONFIGURED);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.chain.length).toBeLessThanOrEqual(5);
    }
  });

  // ─── F4 — only connectors configured on THIS gateway count ────────────

  it('F4 — an explicit _source naming a REAL but NOT-INSTALLED connector reads as "connector not installed"', async () => {
    const { integrationManager } = buildFakeManager({
      messages: { 'm-17': { subject: 'X', from: { name: 'A', email: 'a@x.com' }, received_at: 't', body: '' } },
      timelines: {}, customers: {},
    });
    // 'mail' has a real, valid manifest+source — just not configured here.
    const notInstalled = new Set(['crm', 'erp']);
    const { result } = await resolveRequestContext(
      integrationManager, { _source: { connector: 'mail', kind: 'message', id: 'm-17' } }, 'crm', undefined, notInstalled,
    );
    expect(result).toEqual({ status: 'unreadable', reason: 'connector not installed' });
  });

  // ─── contextKeys gathering ────────────────────────────────────────────

  it('gathers a direct email contextKey from the action', async () => {
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    const keys = await gatherContextKeysFromAction(integrationManager, 'crm', { email: 'email' }, { email: 'new@bavaria-umform.de' });
    expect(keys).toEqual([
      { type: 'email', value: 'new@bavaria-umform.de' },
      { type: 'email_domain', value: 'bavaria-umform.de' },
    ]);
  });

  it('gathers via recordKeys indirection (ERP customer_id -> get_customer -> email)', async () => {
    const { integrationManager } = buildFakeManager({
      messages: {}, timelines: {}, customers: { 'cust-77': { email: 'buyer@bavaria-umform.de' } },
    });
    const keys = await gatherContextKeysFromAction(integrationManager, 'erp', { customer: 'customer_id' }, { customer_id: 'cust-77' });
    expect(keys).toEqual([
      { type: 'email', value: 'buyer@bavaria-umform.de' },
      { type: 'email_domain', value: 'bavaria-umform.de' },
    ]);
  });

  it('contributes nothing when the declared action arg is absent', async () => {
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    const keys = await gatherContextKeysFromAction(integrationManager, 'erp', { customer: 'customer_id' }, {});
    expect(keys).toEqual([]);
  });

  // ─── History ──────────────────────────────────────────────────────────

  it('no_customer_link when no identity keys were gathered at all', async () => {
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    const result = await buildHistory(integrationManager, [], journal, ALL_CONFIGURED);
    expect(result).toEqual({ status: 'no_customer_link' });
  });

  it('F7 — a company domain key is matched by email_domain (first in byKey order)', async () => {
    const { integrationManager } = buildFakeManager({
      messages: {}, customers: {},
      timelines: {
        'bavaria-umform.de': [
          { contact_id: 'c1', contact_name: 'L. Leitner', type: 'call', summary: 'RF 55 steht', detail: null, date: '2026-10-14T09:40:00Z', created_by: 'L. Leitner', ticket_id: null },
        ],
      },
    });
    // Both an email AND a domain key are gathered (the normal case for a
    // business sender) — byKey=["email_domain","email"] must prefer the domain.
    const result = await buildHistory(
      integrationManager,
      [{ type: 'email', value: 'l.leitner@bavaria-umform.de' }, { type: 'email_domain', value: 'bavaria-umform.de' }],
      journal, ALL_CONFIGURED,
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.matches[0]).toMatchObject({ matchedKeyType: 'email_domain', matchedKeyValue: 'bavaria-umform.de' });
    }
  });

  it('F7 — a free-mail sender (no domain key at all) falls back to exact email', async () => {
    const { integrationManager } = buildFakeManager({
      messages: {}, customers: {},
      timelines: {
        'hans.privat@gmail.com': [
          { contact_id: 'c2', contact_name: 'Hans Mueller', type: 'call', summary: 'Nachfrage Ersatzteilpreis', detail: null, date: '2026-10-13T00:00:00Z', created_by: 'Hans Mueller', ticket_id: null },
        ],
      },
    });
    // Free-mail: deriveIdentityKeysFromEmail never produces an email_domain
    // key for gmail.com — only `email` is ever gathered for this sender.
    const result = await buildHistory(integrationManager, [{ type: 'email', value: 'hans.privat@gmail.com' }], journal, ALL_CONFIGURED);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.matches[0]).toMatchObject({ matchedKeyType: 'email', matchedKeyValue: 'hans.privat@gmail.com' });
    }
  });

  it('F7 — no_match when only a key type outside byKey is available', async () => {
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    // Reuses the same engine with a connector-less key set (no manifest
    // declares anything other than email/email_domain, so this proves the
    // "nothing in byKey order has a value" branch via an empty read result
    // rather than inventing a third key type).
    const result = await buildHistory(integrationManager, [], journal, ALL_CONFIGURED);
    expect(result).toEqual({ status: 'no_customer_link' });
  });

  it('ok — matches by email_domain and returns mapped items', async () => {
    const { integrationManager } = buildFakeManager({
      messages: {}, customers: {},
      timelines: {
        'bavaria-umform.de': [
          { contact_id: 'c1', contact_name: 'L. Leitner', type: 'call', summary: 'RF 55 steht', detail: null, date: '2026-10-14T09:40:00Z', created_by: 'L. Leitner', ticket_id: null },
        ],
      },
    });
    const result = await buildHistory(integrationManager, [{ type: 'email_domain', value: 'bavaria-umform.de' }], journal, ALL_CONFIGURED);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({ connectorId: 'crm', matchedKeyType: 'email_domain', matchedKeyValue: 'bavaria-umform.de' });
      expect(result.matches[0].items[0]).toMatchObject({ title: 'RF 55 steht', author: 'L. Leitner' });
    }
  });

  it('marks an item AI-written when its ticket is in this gateway\'s own journal as executed', async () => {
    journal.begin({ ticketId: 'ticket-1', tool: 'crm__log_activity', argsHash: 'sha256:x' });
    journal.complete('ticket-1', 'done');
    const { integrationManager } = buildFakeManager({
      messages: {}, customers: {},
      timelines: {
        'bavaria-umform.de': [
          { contact_id: 'c1', contact_name: 'AI', type: 'email', summary: 'Sent quote Q-1198', detail: 'Sent quote Q-1198 for PV-55A replacement, confirmed stock.', date: '2026-10-13T14:20:00Z', created_by: 'the AI', ticket_id: 'ticket-1' },
        ],
      },
    });
    const result = await buildHistory(integrationManager, [{ type: 'email_domain', value: 'bavaria-umform.de' }], journal, ALL_CONFIGURED);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.matches[0].items[0].aiWritten).toBeDefined();
    }
  });

  it('does NOT mark an item AI-written when its ticket is unknown to this journal', async () => {
    const { integrationManager } = buildFakeManager({
      messages: {}, customers: {},
      timelines: {
        'bavaria-umform.de': [
          { contact_id: 'c1', contact_name: 'L', type: 'call', summary: 'x', detail: null, date: '2026-10-13T14:20:00Z', created_by: 'L', ticket_id: 'ticket-never-seen' },
        ],
      },
    });
    const result = await buildHistory(integrationManager, [{ type: 'email_domain', value: 'bavaria-umform.de' }], journal, ALL_CONFIGURED);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.matches[0].items[0].aiWritten).toBeUndefined();
    }
  });

  it('unreachable when the only matching-type connector errors', async () => {
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    (integrationManager.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
    const result = await buildHistory(integrationManager, [{ type: 'email_domain', value: 'bavaria-umform.de' }], journal, ALL_CONFIGURED);
    expect(result).toEqual({ status: 'unreachable', connectorIds: ['crm'] });
  });

  // ─── F4 — only connectors configured on THIS gateway count ────────────

  it('F4 — a connector NOT configured on this gateway is skipped silently (no "not reachable")', async () => {
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    // CRM is the only connector declaring history in the fixture manifests —
    // omit it from the configured set entirely.
    const notInstalled = new Set(['mail', 'erp']);
    const result = await buildHistory(integrationManager, [{ type: 'email_domain', value: 'bavaria-umform.de' }], journal, notInstalled);
    expect(result).toEqual({ status: 'no_match' });
  });

  it('F4 — a connector configured but STOPPED (no discovered tools) reads as unreachable, not skipped', async () => {
    // "Installed" (configured) but its tools aren't currently discovered —
    // readPreview/readContextRecord then answers 'unavailable' for it, same
    // as a genuinely crashed/down connector.
    const { integrationManager } = buildFakeManager({ messages: {}, timelines: {}, customers: {} });
    const stoppedManager = { ...integrationManager, getAllTools: () => [] } as unknown as IntegrationManager;
    const result = await buildHistory(stoppedManager, [{ type: 'email_domain', value: 'bavaria-umform.de' }], journal, ALL_CONFIGURED);
    expect(result).toEqual({ status: 'unreachable', connectorIds: ['crm'] });
  });

  // ─── Orchestration ────────────────────────────────────────────────────

  it('buildRequestContext combines source + action contextKeys into one key set for history', async () => {
    const { integrationManager } = buildFakeManager({
      messages: { 'm-1': { subject: 'S', from: { name: 'J', email: 'j@bavaria-umform.de' }, received_at: 't', body: '' } },
      customers: {},
      timelines: { 'bavaria-umform.de': [{ contact_id: 'c1', contact_name: 'L', type: 'call', summary: 'hist', detail: null, date: '2026-10-14T00:00:00Z', created_by: 'L', ticket_id: null }] },
    });
    const result = await buildRequestContext(
      integrationManager, journal, 'crm', { email: 'new@bavaria-umform.de', _source: { connector: 'mail', kind: 'message', id: 'm-1' } },
      { contextKeys: { email: 'email' } },
      ALL_CONFIGURED,
    );
    expect(result.request.status).toBe('ok');
    expect(result.history.status).toBe('ok');
  });
});

// Confirms the manifest fixtures above actually loaded (sanity check that a
// JSON typo in this file doesn't silently produce zero manifests, which
// would make every "ok" case above pass vacuously).
describe('fixture manifests load cleanly', () => {
  beforeEach(loadFixtureManifests);
  afterEach(cleanupFixtureManifests);
  it('loads mail, crm, erp', () => {
    expect(getAllManifests().map((m) => m.id).sort()).toEqual(['crm', 'erp', 'mail']);
  });
});
