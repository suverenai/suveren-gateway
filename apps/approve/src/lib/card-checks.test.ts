import { describe, it, expect } from 'vitest';
import { checkCard, routeFor, toolDisplayOf, type CardReason } from './card-checks';
import { argRows } from '@suveren/approval-card/lib/approval-view';
import { cardWorld, signGrant, AUTHZ, PROFILE, PROPOSAL_ID, MANDATE_ID, MAPPING, ARGS } from './card-world';
import { didKeyOf } from './mandate-check';
import { BLOCKED_REASONS, blockedText } from '../texts';

type World = Awaited<ReturnType<typeof cardWorld>>;
const check = (w: World) => checkCard(w.rt.checks, w.as.byId.get(PROPOSAL_ID) as never);
const reason = async (w: World): Promise<CardReason | 'ok'> => { const c = await check(w); return c.ok ? 'ok' : c.reason; };

// Each case builds one or more full card worlds (a registered phone, a fake Authority Server, signed mandate,
// grant and sealed content). Locally a world takes ~15-50 ms; on the windows-latest runner the file took
// 20-34 s for 30 cases (bundle-smoke runs 45090277313, 45094813561), so the 4-world case at line ~73
// crossed vitest's 5 s default. The checks themselves are unchanged; only the time allowed per case is.
describe('the checks before a decision is offered (plan 8; step 12)', { timeout: 30_000 }, () => {
  it('passes for a request whose every part is what it claims, and says what a decision will name', async () => {
    const w = await cardWorld();
    const c = await check(w);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.ready.facts).toEqual({ mandateId: MANDATE_ID, actionType: 'send' });
    expect(c.ready.contentHash).toBe(w.proposal.contentHash);
    expect(c.ready.args).toEqual(w.args);
    expect(c.ready.route).toEqual({ kind: 'domain', domain: 'owner' });
    // the card gets the gateway's own labels, order and money, and the mapping
    expect(c.ready.display.approvalView?.amount).toEqual({ label: 'Amount', kind: 'money', currencyArg: 'currency' });
    expect(Object.keys(c.ready.display.approvalView ?? {})).toEqual(['to', 'amount']);
    expect(c.ready.display.aiTextArg).toBe('body');
  });

  it('a request whose fingerprint was changed in the database shows the reason and offers nothing', async () => {
    const w = await cardWorld();
    // the server's row now says another fingerprint than the content hashes to
    (w.as.byId.get(PROPOSAL_ID) as { contentHash: string }).contentHash = 'sha256:' + '1'.repeat(64);
    expect(await reason(w)).toBe('content_mismatch');
  });

  it('content that does not hash to the fingerprint NAMED INSIDE it is refused too (rule 8)', async () => {
    const w = await cardWorld();
    const row = w.as.byId.get(PROPOSAL_ID) as { content: { proposalContentHash: string } };
    row.content.proposalContentHash = 'sha256:' + '2'.repeat(64);
    expect(await reason(w)).toBe('content_mismatch');
  });

  it('a request this phone holds no key for says so, in its own words', async () => {
    const w = await cardWorld();
    (w.as.byId.get(PROPOSAL_ID) as { content: { device_keys: object } }).content.device_keys = {};
    expect(await reason(w)).toBe('content_not_here');
  });

  it('no card context: no buttons (the context is checked before they show)', async () => {
    expect(await reason(await cardWorld({ noContext: true }))).toBe('context_missing');
  });

  it('a card context moved from another request cannot be opened: no buttons', async () => {
    const a = await cardWorld();
    const b = await cardWorld({ args: { ...a.args, amount: '99.00' } });
    // b's context, sealed for b's content, laid onto a's request: its associated data names another fingerprint
    // (a different phone too, so the key differs; the point is that it never opens)
    (a.as.byId.get(PROPOSAL_ID) as { content: { context: string } }).content.context = (b.proposal.content as { context: string }).context;
    expect(await reason(a)).toBe('context_unreadable');
  });

  it('a context that is not a mapping is refused, never run', async () => {
    expect(await reason(await cardWorld({ mapping: { amount: 5 } }))).toBe('context_unreadable');
    expect(await reason(await cardWorld({ mapping: [] as never }))).toBe('context_unreadable');
  });

  it('the execution context the server holds must equal what the arguments produce under the sealed mapping', async () => {
    expect(await reason(await cardWorld({ executionContext: { amount: 125 } }))).toBe('context_mismatch');
    // a missing field is a mismatch too
    expect(await reason(await cardWorld({ executionContext: {} }))).toBe('context_mismatch');
    expect(await reason(await cardWorld({ executionContext: { amount: 12.5 } }))).toBe('ok');
  });

  it('numbers: the arguments are parsed the way the gateway parses them (a plain decimal string of a declared numeric field), and the compare is exact', async () => {
    // the gateway sends 12.5 for the argument "12.50": that is what must be carried
    expect(await reason(await cardWorld({ executionContext: { amount: '12.50' } }))).toBe('context_mismatch'); // a string is not the number
    // "1e1" is not a plain decimal: the gateway leaves it a string, so a carried 10 is NOT the same amount
    expect(await reason(await cardWorld({ args: { ...ARGS, amount: '1e1' }, executionContext: { amount: 10 } }))).toBe('context_mismatch');
    expect(await reason(await cardWorld({ args: { ...ARGS, amount: '1e1' }, executionContext: { amount: '1e1' } }))).toBe('ok');
    expect(await reason(await cardWorld({ args: { ...ARGS, amount: ' 5' }, executionContext: { amount: 5 } }))).toBe('context_mismatch');
  });

  it('the SAME fields: a bound-read field the server carries and the arguments do not produce is a mismatch, and the card draws the rebuilt values', async () => {
    const profile = { ...(PROFILE as object), boundsSchema: { ...(PROFILE as { boundsSchema: object }).boundsSchema, fields: { amount_max: { boundType: { kind: 'per_transaction', of: 'amount' } }, spend_daily: { boundType: { kind: 'cumulative_sum', of: 'spend' } } } } };
    expect(await reason(await cardWorld({ profile, executionContext: { amount: 12.5, spend: 5 } }))).toBe('context_mismatch');
    const w = await cardWorld({ profile, executionContext: { amount: 12.5 } });
    const c = await check(w);
    expect(c.ok && c.ready.executionContext).toEqual({ amount: 12.5 });
    // a field the server carries that no bound reads is dropped from both sides, never drawn
    const x = await check(await cardWorld({ executionContext: { amount: 12.5, recipients: 99, _hint: 1 } }));
    expect(x.ok && x.ready.executionContext).toEqual({ amount: 12.5 });
  });

  it('a mapping that produces a field no bound reads asks nothing of the server\'s copy', async () => {
    // `recipients` (a count) is not read by any bound of the test profile: only `amount` is compared
    const w = await cardWorld({ executionContext: { amount: 12.5, recipients: 99 } });
    expect(await reason(w)).toBe('ok');
  });

  it('a mandate signed by another key than the one this phone pinned is refused', async () => {
    const w = await cardWorld();
    const rogue = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    w.as.mandates.set(AUTHZ, { blobs: [await w.as.mandateBlob(w.payload, { signWith: rogue.privateKey })] });
    expect(await reason(w)).toBe('mandate_signature');
  });

  it('a mandate under another issuer name is refused even when the server signed it', async () => {
    const w = await cardWorld();
    w.as.mandates.set(AUTHZ, { blobs: [await w.as.mandateBlob({ ...w.payload, issuer: didKeyOf(new Uint8Array(32).fill(7)) })] });
    expect(await reason(w)).toBe('mandate_signature');
  });

  it('a revoked, expired or missing mandate offers nothing', async () => {
    const w = await cardWorld();
    w.as.mandates.set(AUTHZ, { blobs: w.as.mandates.get(AUTHZ)!.blobs, revoked: true });
    expect(await reason(w)).toBe('mandate_ended');
    const e = await cardWorld({ mandate: { expires_at: 1_700_000_000 } });
    expect(await reason(e)).toBe('mandate_expired');
    const m = await cardWorld();
    m.as.mandates.delete(AUTHZ);
    expect(await reason(m)).toBe('mandate_unavailable');
  });

  it('the profile bytes must hash to the mandate\'s profile_hash', async () => {
    const w = await cardWorld();
    w.as.profiles.set(w.payload.profile_id, { ...(PROFILE as object), extra: 'changed rules' });
    expect(await reason(w)).toBe('profile_mismatch');
    const gone = await cardWorld();
    gone.as.profiles.delete(gone.payload.profile_id);
    expect(await reason(gone)).toBe('profile_unavailable');
  });

  it('a mandate of another owner is not decided on this phone (it needs the owner\'s chain)', async () => {
    expect(await reason(await cardWorld({ ownerDid: 'did:key:z6Mkcolleague' }))).toBe('owner_not_you');
  });

  it('the owner\'s grant (plan 4.4): without one that verifies for exactly this mandate, nothing is offered', async () => {
    // none at all: the server signed a mandate its owner never confirmed
    expect(await reason(await cardWorld({ grant: { none: true } }))).toBe('mandate_not_granted');
    // signed by this phone's key but without the check over it
    expect(await reason(await cardWorld({ grant: { noCheck: true } }))).toBe('mandate_not_granted');
    // signed by another key that is not a device of this chain
    expect(await reason(await cardWorld({ grant: { signWith: 'other' } }))).toBe('mandate_not_granted');
    // a member differs from the signed mandate (the grant was for other bounds)
    expect(await reason(await cardWorld({ grant: { over: { bounds_hash: 'sha256:' + 'd'.repeat(64) } } }))).toBe('mandate_not_granted');
    // a grant of another authorization
    expect(await reason(await cardWorld({ grant: { authorizationId: 'authz_00000000-0000-4000-8000-000000000999' } }))).toBe('mandate_not_granted');
  });

  it('the grant follows the mandate: a mandate changed after the grant (the server serves new bounds) is not granted', async () => {
    const w = await cardWorld();
    // the server re-signs the mandate with other bounds; the owner's grant is still the one for the old bounds
    w.as.mandates.set(AUTHZ, { blobs: [await w.as.mandateBlob({ ...w.payload, bounds_hash: 'sha256:' + 'e'.repeat(64) })] });
    expect(await reason(w)).toBe('mandate_not_granted');
  });

  it('a revoke the owner\'s device signed ends the mandate; one that does not verify is ignored', async () => {
    const w = await cardWorld();
    w.as.grants.get(MANDATE_ID)!.push(await signGrant(w.rt, w.payload as never, { revoke: true, signWith: 'other' }));
    expect(await reason(w)).toBe('ok');
    w.as.grants.get(MANDATE_ID)!.push(await signGrant(w.rt, w.payload as never, { revoke: true }));
    expect(await reason(w)).toBe('mandate_ended');
  });

  it('a newer grant that does not verify does not hide an older one that does', async () => {
    const w = await cardWorld();
    w.as.grants.get(MANDATE_ID)!.push(await signGrant(w.rt, w.payload as never, { op: 'change', noCheck: true }, 2));
    expect(await reason(w)).toBe('ok');
  });

  it('grants that cannot be read are a failed read, not a pass', async () => {
    const w = await cardWorld();
    const orig = w.as.grants;
    w.as.grants = { get: () => 'not a list' } as never;
    expect(await reason(w)).toBe('reads_failed');
    w.as.grants = orig;
  });

  it('without WebCrypto the card says it cannot check here, before any check could call a genuine request forged', async () => {
    const w = await cardWorld();
    const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    let r: CardReason | 'ok';
    try { r = await reason(w); } finally { Object.defineProperty(globalThis, 'crypto', real); }
    expect(r).toBe('crypto_unavailable');
    expect(blockedText('crypto_unavailable')).toMatch(/cannot check mandates here/);
    expect(await reason(w)).toBe('ok');
  });

  it('a request without an action type, or one the profile does not know, offers nothing', async () => {
    expect(await reason(await cardWorld({ actionType: null }))).toBe('action_type_missing');
    expect(await reason(await cardWorld({ actionType: 'wire_everything' }))).toBe('action_type_unknown');
  });

  it('a request that no longer waits offers nothing', async () => {
    const w = await cardWorld();
    (w.as.byId.get(PROPOSAL_ID) as { status: string }).status = 'rejected';
    expect(await reason(w)).toBe('not_pending');
  });

  it('with the session over, it says so and asks the server nothing more', async () => {
    const w = await cardWorld();
    w.as.sessions.clear();
    w.rt.session.lost();
    await Promise.resolve();
    w.as.calls.length = 0;
    expect(await reason(w)).toBe('session_ended');
    expect(w.as.calls.length).toBe(0);
  });

  it('a server that cannot be reached is "could not check", never a pass', async () => {
    const w = await cardWorld();
    w.as.down = true;
    expect(await reason(w)).toBe('reads_failed');
  });

  it('every reason has a sentence of its own, with no code and no gendered pronoun', () => {
    for (const r of BLOCKED_REASONS) {
      const t = blockedText(r);
      expect(t, r).not.toBe(r);
      expect(t, r).not.toMatch(/\b(he|she|his|hers?|him)\b/i);
      expect(t, r).not.toMatch(/authority server|fingerprint|mandate_/i);
    }
    expect(blockedText('something_new')).toBe(blockedText('reads_failed'));
  });
});

describe('which route decides a request, and how the card is laid out', () => {
  const p = (x: object) => x as never;
  it('an above-cap approver uses approve/reject; the person\'s own queue uses resolve with a domain', () => {
    expect(routeFor(p({ pendingApprovers: ['u1'], pendingDomains: ['owner'] }), 'u1')).toEqual({ kind: 'approver' });
    expect(routeFor(p({ pendingDomains: ['owner'] }), 'u1')).toEqual({ kind: 'domain', domain: 'owner' });
    expect(routeFor(p({ pendingDomains: ['u1', 'owner'] }), 'u1')).toEqual({ kind: 'domain', domain: 'u1' });
    expect(routeFor(p({ pendingDomains: [] }), 'u1')).toBeNull();
  });

  it('display hints become labels, order and money of top-level arguments only; nothing is hidden', () => {
    const d = toolDisplayOf({ labels: { 'a.b': 'x', subject: 'Subject' }, order: ['subject', 'lines[].qty'], hidden: ['body'], percent: ['p'] }, MAPPING, { subject: 's', body: 'b' });
    expect(d.approvalView).toEqual({ subject: { label: 'Subject' } });
    expect(toolDisplayOf(null, MAPPING).approvalView).toBeUndefined();
    // hints that name no argument of this request are dropped (nothing invented), and an aiText that is not a string argument is dropped
    const args = { subject: 'Hi', body: 'Hello', n: 3 };
    const e = toolDisplayOf({ labels: { subject: 'Subject', ghost: 'Ghost' }, order: ['ghost', 'subject'], money: ['ghost'], aiText: 'ghost' }, MAPPING, args);
    expect(e.approvalView).toEqual({ subject: { label: 'Subject' } });
    expect(e.aiTextArg).toBeUndefined();
    expect(toolDisplayOf({ aiText: 'n' }, MAPPING, args).aiTextArg).toBeUndefined(); // not a string
    expect(toolDisplayOf({ aiText: 'body' }, MAPPING, { body: '' }).aiTextArg).toBeUndefined(); // empty
    expect(toolDisplayOf({ aiText: 'body' }, MAPPING, args).aiTextArg).toBe('body');
    expect(toolDisplayOf('nonsense', MAPPING).executionMapping).toEqual(MAPPING);
  });
});

describe('every bound argument is visible', () => {
  it('whatever hints the sealed context carries, every argument of the request is a row or the AI-text box', async () => {
    const hostile = [
      { hidden: ['to', 'amount', 'currency', 'body'], aiText: 'to' },
      { aiText: 'ghost', labels: { ghost: 'x' }, order: ['ghost'], money: ['ghost'] },
      { aiText: 'amount' },
      {},
    ];
    for (const display of hostile) {
      const w = await cardWorld({ display });
      const c = await check(w);
      expect(c.ok).toBe(true);
      if (!c.ok) continue;
      const rows = argRows(c.ready.args, c.ready.display).map((r) => r.key);
      for (const k of Object.keys(ARGS)) expect(rows.includes(k) || c.ready.display.aiTextArg === k, k).toBe(true);
    }
  });
});
