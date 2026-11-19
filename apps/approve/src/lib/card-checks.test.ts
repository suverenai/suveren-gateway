import { describe, it, expect } from 'vitest';
import { checkCard, routeFor, toolDisplayOf, type CardReason } from './card-checks';
import { cardWorld, AUTHZ, PROFILE, PROPOSAL_ID, MANDATE_ID, MAPPING } from './card-world';
import { didKeyOf } from './mandate-check';
import { BLOCKED_REASONS, blockedText } from '../texts';

type World = Awaited<ReturnType<typeof cardWorld>>;
const check = (w: World) => checkCard(w.rt.checks, w.as.byId.get(PROPOSAL_ID) as never);
const reason = async (w: World): Promise<CardReason | 'ok'> => { const c = await check(w); return c.ok ? 'ok' : c.reason; };

describe('the checks before a decision is offered (plan 8; step 12)', () => {
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
    // "12.50" and 12.5 are the same amount
    expect(await reason(await cardWorld({ executionContext: { amount: 12.5 } }))).toBe('ok');
    expect(await reason(await cardWorld({ executionContext: { amount: '12.50' } }))).toBe('ok');
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
    const d = toolDisplayOf({ labels: { 'a.b': 'x', subject: 'Subject' }, order: ['subject', 'lines[].qty'], hidden: ['body'], percent: ['p'] }, MAPPING);
    expect(d.approvalView).toEqual({ subject: { label: 'Subject' } });
    expect(toolDisplayOf(null, MAPPING).approvalView).toBeUndefined();
    expect(toolDisplayOf('nonsense', MAPPING).executionMapping).toEqual(MAPPING);
  });
});

