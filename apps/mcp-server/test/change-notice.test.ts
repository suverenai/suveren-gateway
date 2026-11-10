/**
 * Change notice (src/lib/change-notice.ts): a running chat is told, once, when the brief or
 * the mandates changed. Through the real MCP server wiring for the part that must reach a real
 * client (src/index.ts + the SDK's in-memory transport).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// The real context loader reads the data dir when imported: point it at a scratch folder first.
const { dataDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const dir = mkdtempSync(j(tmpdir(), 'change-notice-'));
  process.env.SUVEREN_DATA_DIR = dir;
  return { dataDir: dir };
});

const { ChangeLedger, SessionChangeNotice, changeNote, sameTold } = await import('../src/lib/change-notice');
const { createMcpServer } = await import('../src/index');
type Told = import('../src/lib/change-notice').Told;
type MandateSeen = import('../src/lib/change-notice').MandateSeen;

const mandate = (id: string, title: string, over: Partial<MandateSeen> = {}): MandateSeen => ({
  id, title, area: 'github.com/x/email', fingerprint: 'fp', expiresAt: Math.floor(Date.now() / 1000) + 3600, ...over,
});
const told = (brief: string, mandates: MandateSeen[] = []): Told => ({ brief, mandates });

function session(state: { now: Told; brief: string | null }, app = 'app-1', ledger?: InstanceType<typeof ChangeLedger>) {
  const notice = new SessionChangeNotice({
    now: () => state.now,
    currentBrief: () => state.brief,
    ledger,
    appName: () => app,
  });
  const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'real answer' }] }));
  const call = notice.wrap(handler);
  return { call: async () => (await call()) as { content: Array<{ type: string; text?: string }> } };
}
const noteOf = (r: { content: Array<{ text?: string }> }) => r.content.map(c => c.text).join('\n').replace('real answer', '').trim();

describe('the note for one chat', () => {
  it('nothing changed: the first answer and every later one stay untouched', async () => {
    const state = { now: told('h1', [mandate('a', 'Email')]), brief: 'Do the work.' };
    const s = session(state);
    expect((await s.call()).content).toEqual([{ type: 'text', text: 'real answer' }]);
    expect((await s.call()).content).toHaveLength(1);
  });

  it('brief edited: the next answer quotes the current brief, once', async () => {
    const state = { now: told('h1'), brief: 'Old brief.' };
    const s = session(state);
    await s.call();
    state.now = told('h2'); state.brief = 'New brief: only quotes.';
    const r = await s.call();
    expect(noteOf(r)).toBe('[Suveren gateway] The agent brief changed since this chat started. This is the current one:\n\nNew brief: only quotes.');
    expect(noteOf(await s.call())).toBe('');
  });

  it('the first answer already carries a change made before it', async () => {
    const state = { now: told('h1'), brief: 'Old.' };
    const s = session(state);
    state.now = told('h2'); state.brief = 'New.';
    expect(noteOf(await s.call())).toContain('This is the current one:\n\nNew.');
  });

  it('a second edit gives a second note', async () => {
    const state = { now: told('h1'), brief: 'a' };
    const s = session(state);
    state.now = told('h2'); state.brief = 'b'; await s.call();
    state.now = told('h3'); state.brief = 'c';
    expect(noteOf(await s.call())).toContain('\n\nc');
  });

  it('names mandates by the title the person gave: added, revoked, expired', () => {
    const now = 1000;
    const note = changeNote(
      told('', [mandate('r', 'Old invoices', { expiresAt: 2000 }), mandate('e', 'Spent', { expiresAt: 500 })]),
      told('', [mandate('n', 'Friday report')]),
      'chat', null, now,
    );
    expect(note).toBe('[Suveren gateway] Mandates changed since this chat started: added "Friday report"; revoked "Old invoices"; expired "Spent". For the details call list-authorizations.');
  });

  it('an edit that keeps the id but changes the limits says edited', () => {
    expect(changeNote(told('', [mandate('m', 'Sales', { fingerprint: 'a' })]), told('', [mandate('m', 'Sales', { fingerprint: 'b' })]), 'chat', null))
      .toBe('[Suveren gateway] Mandates changed since this chat started: edited "Sales". For the details call list-authorizations.');
  });

  it('an edit that signs a replacement under the same title is one edit, not added plus revoked', () => {
    expect(changeNote(told('', [mandate('old', 'Sales')]), told('', [mandate('new', 'Sales')]), 'chat', null))
      .toBe('[Suveren gateway] Mandates changed since this chat started: edited "Sales". For the details call list-authorizations.');
  });

  it('counts only what the AI was told: a used-up counter or a clock tick is not a change', () => {
    const a = told('h', [mandate('x', 'A', { expiresAt: 1000 })]);
    const b = told('h', [mandate('x', 'A', { expiresAt: 2000 })]);
    expect(sameTold(a, b)).toBe(true);
  });

  it('a removed brief is said plainly, with no stale text', () => {
    expect(changeNote(told('h1'), told(''), 'chat', null))
      .toBe('[Suveren gateway] The agent brief was removed since this chat started. There is none now.');
  });

  it('a refused call gets the note too, and stays refused', async () => {
    const state = { now: told('h1'), brief: 'a' };
    const notice = new SessionChangeNotice({ now: () => state.now, currentBrief: () => state.brief, appName: () => 'app' });
    const call = notice.wrap(async () => ({ content: [{ type: 'text', text: 'Refused: no mandate covers it.' }], isError: true }));
    await call();
    state.now = told('h2'); state.brief = 'Now b.';
    const r = await call() as { content: Array<{ text?: string }>; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Refused: no mandate covers it.');
    expect(r.content[1].text).toContain('Now b.');
  });

  it('two calls racing get one note between them', async () => {
    const state = { now: told('h1'), brief: 'a' };
    const s = session(state);
    await s.call();
    state.now = told('h2'); state.brief = 'b';
    const [x, y] = await Promise.all([s.call(), s.call()]);
    expect([noteOf(x), noteOf(y)].filter(Boolean)).toHaveLength(1);
  });

  it('an answer that cannot carry text leaves the change for the next one', async () => {
    const state = { now: told('h1'), brief: 'a' };
    const notice = new SessionChangeNotice({ now: () => state.now, currentBrief: () => state.brief, appName: () => 'app' });
    let bad = true;
    const call = notice.wrap(async () => (bad ? undefined : { content: [{ type: 'text', text: 'ok' }] }));
    state.now = told('h2'); state.brief = 'b';
    expect(await call()).toBeUndefined();
    bad = false;
    const r = await call() as { content: Array<{ text?: string }> };
    expect(r.content[1].text).toContain('\n\nb');
  });
});

describe('an app that keeps its old instructions across a new session (reconnect or resume)', () => {
  const key = Buffer.alloc(32, 7);
  beforeEach(() => {
    for (const f of ['change-ledger.json', 'change-ledger.enc.json']) rmSync(join(dataDir, f), { force: true });
  });

  it('a new session from an app that last heard something else starts from that', async () => {
    const ledger = new ChangeLedger(dataDir);
    const state = { now: told('h1'), brief: 'Old.' };
    await session(state, 'codex', ledger).call(); // the chat before the reconnect
    state.now = told('h2'); state.brief = 'New.';
    const reconnected = session(state, 'codex', ledger); // session opens after the edit; its own start already says h2
    const r = await reconnected.call();
    expect(noteOf(r)).toBe('[Suveren gateway] The agent brief changed since this app last connected. This is the current one:\n\nNew.');
    expect(noteOf(await reconnected.call())).toBe('');
  });

  it('survives a gateway restart: the ledger is on disk, encrypted once the vault is open', async () => {
    const a = new ChangeLedger(dataDir);
    a.setVaultKey(key);
    const state = { now: told('h1', [mandate('m', 'Personal title')]), brief: 'x' };
    await session(state, 'codex', a).call();
    expect(existsSync(join(dataDir, 'change-ledger.enc.json'))).toBe(true);
    expect(readFileSync(join(dataDir, 'change-ledger.enc.json'), 'utf8')).not.toContain('Personal title');
    const b = new ChangeLedger(dataDir);
    b.setVaultKey(key);
    state.now = told('h1', []);
    expect(noteOf(await session(state, 'codex', b).call())).toContain('Mandates changed since this app last connected: revoked "Personal title"');
  });

  it('no note for a new session when the app already knew this state', async () => {
    const ledger = new ChangeLedger(dataDir);
    const state = { now: told('h1'), brief: 'x' };
    await session(state, 'codex', ledger).call();
    expect((await session(state, 'codex', ledger).call()).content).toHaveLength(1);
  });

  it('another app is told separately', async () => {
    const ledger = new ChangeLedger(dataDir);
    const state = { now: told('h1'), brief: 'x' };
    await session(state, 'claude', ledger).call();
    state.now = told('h2'); state.brief = 'y';
    expect(noteOf(await session(state, 'codex', ledger).call())).toBe(''); // codex has no record yet
    expect(noteOf(await session(state, 'claude', ledger).call())).toContain('\n\ny');
  });

  it('a live session never needs the ledger', async () => {
    const ledger = new ChangeLedger(dataDir);
    const state = { now: told('h1'), brief: 'x' };
    const live = session(state, 'claude', ledger);
    await live.call();
    state.now = told('h2'); state.brief = 'y';
    await session(state, 'claude', ledger).call(); // another chat is told first
    expect(noteOf(await live.call())).toContain('\n\ny'); // the live one is still told
  });
});

describe('through the real MCP server wiring', () => {
  const profileId = 'github.com/x/customers@0.9';
  const auth = (id: string, title: string) => ({
    authorizationId: id, title, profileId, path: 'p', frame: {}, attestations: [{ domain: 'owner', blob: 'b', expiresAt: Math.floor(Date.now() / 1000) + 3600 }],
    requiredDomains: ['owner'], attestedDomains: ['owner'], deferredCommitmentDomains: [], complete: true, gateContent: { intent: 'x' },
  });

  async function connect(auths: unknown[]) {
    const state = {
      getEnrichedAuthorizations: () => auths,
      executionLog: { record: () => {}, sumByWindow: () => 0, getAll: () => [], size: 0 },
      spClient: { isUnlocked: () => true, getAuthorizationSummary: async () => null },
      denialLog: { record: () => {} },
      cache: { getAllAuthorizations: () => auths },
      outcomeOutbox: { getUndelivered: () => [], markDelivered: () => {} },
    };
    const { server } = createMcpServer(state as never, { getAllTools: () => [], isBuiltin: () => false } as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: `wire-${Math.random()}`, version: '1' });
    await client.connect(b);
    return client;
  }
  const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map(c => c.text).join('\n');

  it('list-authorizations carries the note, once', async () => {
    writeFileSync(join(dataDir, 'context.md'), 'Brief version one.');
    const auths = [auth('authz_1', 'Customer records')];
    const client = await connect(auths);
    const first = await client.callTool({ name: 'list-authorizations', arguments: {} });
    expect(text(first)).not.toContain('[Suveren gateway]');
    writeFileSync(join(dataDir, 'context.md'), 'Brief version two.');
    auths.pop();
    const second = await client.callTool({ name: 'list-authorizations', arguments: {} });
    expect(text(second)).toContain('The agent brief changed since this chat started. This is the current one:\n\nBrief version two.');
    expect(text(second)).toContain('revoked "Customer records"');
    const third = await client.callTool({ name: 'list-authorizations', arguments: {} });
    expect(text(third)).not.toContain('[Suveren gateway]');
  });
});
