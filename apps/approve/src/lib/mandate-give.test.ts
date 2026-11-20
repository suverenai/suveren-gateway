/**
 * Giving a mandate on the phone (mandate-give.ts). Real: hap-core's chain, grant, hash and sealing code, the phone's key store, the
 * session, the passkey assertion (FakePasskeys makes the same assertion a real one does). Stood in: the Authority Server (FakeAs, which
 * checks a posted grant with hap-core `verifyGrant` against the chain like the real one) and the computer that prepared the give.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMandateProjection, computeBoundsHash, computeExecutionContextHash, computeIntentHash, computeProfileHash, computeScopeHash, encryptProposalContent,
  type AgentProfile, type MandatePayload,
} from '@hap/core';
import { createGrantMembers } from '@hap/core/mandate-grant';
import { b64uEncode, buildReceipt, grantHash, rootKeyFromRecoveryCode, signObject, verifyGrant, type MandateGrant } from '@hap/core/device-keys';
import { FakeAs, PeerComputer, addWithRoot, registerPhone, testRuntime } from './test-kit';
import { checkGive, readGives, GiveDriver, type GiveItem } from './mandate-give';

const profilesDir = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', '..', 'hap-profiles');
const SALES = JSON.parse(readFileSync(join(profilesDir, 'sales', '0.4.profile.json'), 'utf8')) as AgentProfile;
const BOUNDS_LIMITS = { read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 0, setup_daily_max: 0 };
const BOUNDS: Record<string, string | number> = { profile: SALES.id, ...BOUNDS_LIMITS };
const SCOPE = { currency: 'EUR' };
const INTENT = 'Why: quotes wait two days.';
const AUTHZ = 'authz_00000000-0000-4000-8000-0000000000aa';
const MID = 'mandate-give-0001';
const { grantMembersOf } = createGrantMembers(buildMandateProjection);

async function world() {
  const as = await FakeAs.create();
  const rt = testRuntime(as);
  const { recoveryCode } = await registerPhone(rt, as);
  const root = await rootKeyFromRecoveryCode(recoveryCode);
  const computer = await PeerComputer.create('Office Mac', false);
  await addWithRoot(as, root, computer);
  const opened = await rt.session.open();
  if (!opened.ok) throw new Error('session');
  const account = (await rt.accounts.read())!;
  const keys = (await rt.keys.publicKeys())!;

  /** What the computer seals: a give for the person's devices (the gateway's `sendToPhone` shape). `edit` changes it like a liar would. */
  const prepare = async (edit: (c: Record<string, any>) => void = () => {}, from = computer.keyId) => {
    const payload: Record<string, unknown> = {
      mandate_id: MID, version: '0.8', profile_id: SALES.id, bounds_hash: computeBoundsHash(BOUNDS as never, SALES), scope_hash: computeScopeHash(SCOPE as never, SALES),
      execution_context_hash: computeExecutionContextHash(SALES), profile_hash: computeProfileHash(SALES), issuer: 'did:key:z',
      mandate_owners: [{ did: account.root_did }], gate_content_hashes: { intent: computeIntentHash(INTENT) }, commitment_mode: 'review',
      issued_at: as.now(), expires_at: as.now() + 3600,
    };
    const content: Record<string, any> = {
      v: 2, mandate_id: MID, mandate_version: 1, scope: { ...SCOPE }, intent: INTENT,
      give: { op: 'grant', profile: SALES, bounds: { ...BOUNDS }, payload, place: { authorization_id: AUTHZ, group_id: 'g_personal', replaces: null, chain_dids: [account.root_did] }, title: 'Quotes', prepared_at: as.now() },
    };
    edit(content);
    const sealed = await encryptProposalContent(content, [{ did: keys.keyId, publicKey: keys.readPub }]);
    as.prepared = [{ mandate_id: MID, mandate_version: 1, submitted_by_key_id: from, ciphertext: sealed.content.ciphertext, device_key: sealed.content.encrypted_keys[keys.keyId], stored_at: as.now(), expires_at: as.now() + 7 * 86400 }];
    return { content, payload };
  };

  /** The computer received the grant and answers it with its signed receipt. */
  const receipt = async (grant: MandateGrant) => {
    const state = await as.state();
    const r = buildReceipt({ mandate_id: grant.mandate_id, mandate_version: grant.mandate_version, grant_hash: await grantHash(grant), key_id: computer.keyId, chain_seq: state.head.seq, chain_head: state.head.hash, received_at: as.now() });
    as.receipts.set(grant.mandate_id, [{ receipt: r, sig: await signObject(r, computer.seed) }]);
  };
  const deps = { keys: rt.keys, check: rt.check, api: rt.api, accounts: rt.accounts, session: rt.session, now: as.now, receiptPoll: { tries: 1, everyMs: 0 } };
  return { as, rt, account, keys, computer, prepare, receipt, deps };
}
type W = Awaited<ReturnType<typeof world>>;

async function onlyItem(w: W): Promise<GiveItem> {
  const r = await readGives(w.deps);
  if (!r.ok) throw new Error(r.code);
  expect(r.refused).toEqual([]);
  expect(r.items).toHaveLength(1);
  return r.items[0];
}

async function refusedCode(w: W): Promise<string | undefined> {
  const r = await readGives(w.deps);
  if (!r.ok) throw new Error(r.code);
  expect(r.items).toHaveLength(0);
  return r.refused[0] && !r.refused[0].ok ? r.refused[0].code : undefined;
}

describe('reading a give on the phone', () => {
  it('opens it with the phone\'s own key and shows it with who prepared it', async () => {
    const w = await world();
    await w.prepare();
    const item = await onlyItem(w);
    expect(item).toMatchObject({ mandateId: MID, version: 1, op: 'grant', preparedBy: 'Office Mac', title: 'Quotes', intent: INTENT, scope: SCOPE });
    expect(item.bounds).toEqual(BOUNDS);
  });

  it('the members it will sign are rebuilt here from the mandate (the gateway\'s rule)', async () => {
    const w = await world();
    const { payload } = await w.prepare();
    const item = await onlyItem(w);
    expect(item.members).toEqual(grantMembersOf(payload as unknown as MandatePayload, { authorizationId: AUTHZ, groupId: 'g_personal', replaces: null, chainDids: [w.account.root_did] }));
  });

  // Each of these is a computer (or a server) that shows one thing and asks to sign another.
  const lies: Array<[string, (c: Record<string, any>) => void, string]> = [
    ['other limits than the hash names', (c) => { c.give.bounds.value_max = 99999; }, 'give_hash_mismatch'],
    ['another scope than the hash names', (c) => { c.scope.currency = 'USD'; }, 'give_hash_mismatch'],
    ['another intent than the hash names', (c) => { c.intent = 'Something nicer.'; }, 'give_hash_mismatch'],
    ['a profile other than the one hashed', (c) => { c.give.profile = { ...c.give.profile, name: 'Renamed' }; }, 'give_hash_mismatch'],
    ['another owner', (c) => { c.give.payload.mandate_owners = [{ did: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK' }]; }, 'give_not_own'],
    ['another mandate id inside', (c) => { c.give.payload.mandate_id = 'mandate-other-01'; }, 'give_not_own'],
    ['an approver missing from chain_dids', (c) => { c.give.payload.above_cap_approvers = ['did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK']; }, 'give_place_invalid'],
    ['a stranger in chain_dids', (c) => { c.give.place.chain_dids.push('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'); }, 'give_place_invalid'],
    ['a bad authorization id', (c) => { c.give.place.authorization_id = 'nope'; }, 'give_place_invalid'],
    ['a mandate that ran out', (c) => { c.give.payload.expires_at = 1; }, 'give_expired'],
    ['a first give that is not version 1', (c) => { c.mandate_version = 2; }, 'give_version_invalid'],
  ];
  for (const [name, edit, code] of lies) {
    it(`refuses ${name} (${code}): no button is offered`, async () => {
      const w = await world();
      await w.prepare(edit);
      if (name === 'a first give that is not version 1') w.as.prepared[0].mandate_version = 2;
      expect(await refusedCode(w)).toBe(code);
    });
  }

  it('refuses a give that a device outside this phone\'s chain says it prepared', async () => {
    const w = await world();
    const stranger = await PeerComputer.create('Not mine');
    await w.prepare(() => {}, stranger.keyId);
    expect(await refusedCode(w)).toBe('give_from_unknown_device');
  });

  it('refuses a give "prepared" by this phone itself', async () => {
    const w = await world();
    await w.prepare(() => {}, w.account.key_id);
    expect(await refusedCode(w)).toBe('give_from_unknown_device');
  });

  it('refuses a first give under a mandate id that already holds a grant', async () => {
    const w = await world();
    await w.prepare();
    w.as.grants.set(MID, [{ mandate_version: 1, op: 'grant', grant: {}, sig: '', check: null }]);
    expect(await refusedCode(w)).toBe('give_version_invalid');
  });

  it('does not offer a change yet (it needs the previous version to show what changes)', async () => {
    const w = await world();
    await w.prepare((c) => { c.give.op = 'change'; });
    expect(await refusedCode(w)).toBe('give_change_unsupported');
  });

  it('skips a plain body (v1): a mandate granted on a computer is not a give', async () => {
    const w = await world();
    const { content } = await w.prepare();
    const sealed = await encryptProposalContent({ v: 1, mandate_id: MID, mandate_version: 1, scope: content.scope, intent: content.intent }, [{ did: w.keys.keyId, publicKey: w.keys.readPub }]);
    w.as.prepared[0] = { ...w.as.prepared[0], ciphertext: sealed.content.ciphertext, device_key: sealed.content.encrypted_keys[w.keys.keyId] };
    const r = await readGives(w.deps);
    expect(r).toMatchObject({ ok: true, items: [], refused: [] });
  });

  it('checkGive is the same check without the network', async () => {
    const w = await world();
    const { content } = await w.prepare();
    const s = w.rt.session.current()!;
    const c = await checkGive(content, w.as.prepared[0] as never, { chain: s.chain, ownKeyId: w.account.key_id, now: w.as.now(), grants: [] });
    expect(c.ok).toBe(true);
  });
});

describe('giving it', () => {
  it('one touch over exactly the grant; the grant verifies against the chain with the members shown; "Signed" once the computer received it', async () => {
    const w = await world();
    await w.prepare();
    const item = await onlyItem(w);
    const d = new GiveDriver(w.deps);
    d.open(item);
    // the computer answers with its receipt as soon as the grant is stored
    const orig = w.as.call.bind(w.as);
    w.as.call = async (m, p, o) => { const r = await orig(m, p, o); if (m === 'POST' && p.endsWith('/grants') && r.status === 201) await w.receipt(w.as.postedGrants.at(-1)!.grant as MandateGrant); return r; };
    await d.give();
    expect(d.get()).toMatchObject({ step: 'signed', receivedBy: 'Office Mac' });
    expect(w.as.postedGrants).toHaveLength(1);
    const posted = w.as.postedGrants[0];
    expect(posted.op).toBe('grant');
    expect(posted.check).toBeTruthy();
    // what the phone touched for is the grant's object hash, and the grant names this phone
    expect((posted.grant as MandateGrant).key_id).toBe(w.account.key_id);
    await verifyGrant({ grant: posted.grant, sig: posted.sig, check: posted.check }, { chain: await w.as.state(), mandateFields: item.members, expect: { ops: ['grant'], mandate_id: MID, mandate_version: 1 } });
  });

  it('without a receipt: the one not-received state; Check again finds it later', async () => {
    const w = await world();
    await w.prepare();
    const d = new GiveDriver(w.deps);
    d.open(await onlyItem(w));
    await d.give();
    expect(d.get()).toMatchObject({ step: 'not_received', checking: false, checkedOnce: false });
    await d.checkAgain();
    expect(d.get()).toMatchObject({ step: 'not_received', checkedOnce: true });
    await w.receipt(w.as.postedGrants[0].grant as MandateGrant);
    await d.checkAgain();
    expect(d.get()).toMatchObject({ step: 'signed', receivedBy: 'Office Mac' });
  });

  it('a receipt from a device outside the chain counts for nothing', async () => {
    const w = await world();
    await w.prepare();
    const d = new GiveDriver(w.deps);
    d.open(await onlyItem(w));
    await d.give();
    const g = w.as.postedGrants[0].grant as MandateGrant;
    const stranger = await PeerComputer.create('Not mine');
    const state = await w.as.state();
    const r = buildReceipt({ mandate_id: MID, mandate_version: 1, grant_hash: await grantHash(g), key_id: stranger.keyId, chain_seq: state.head.seq, chain_head: state.head.hash, received_at: w.as.now() });
    w.as.receipts.set(MID, [{ receipt: r, sig: await signObject(r, stranger.seed) }]);
    await d.checkAgain();
    expect(d.get()).toMatchObject({ step: 'not_received' });
  });

  it('Cancel while the touch is asked: nothing is sent, the review is back', async () => {
    const w = await world();
    await w.prepare();
    const d = new GiveDriver(w.deps);
    d.open(await onlyItem(w));
    let release!: () => void;
    w.rt.check.gate = new Promise<void>((r) => { release = r; });
    const p = d.give();
    await new Promise((r) => setTimeout(r, 10));
    expect(d.get().step).toBe('checking');
    d.cancelTouch();
    release();
    await p;
    expect(d.get().step).toBe('review');
    expect(w.as.postedGrants).toHaveLength(0);
  });

  it('a touch that was cancelled in the system window says so with Try again; nothing is sent', async () => {
    const w = await world();
    await w.prepare();
    const d = new GiveDriver(w.deps);
    d.open(await onlyItem(w));
    w.rt.check.cancelNext = true;
    await d.give();
    expect(d.get()).toMatchObject({ step: 'checking', error: expect.any(String) });
    expect(w.as.postedGrants).toHaveLength(0);
    await d.give();
    expect(['signed', 'not_received']).toContain(d.get().step);
    expect(w.as.postedGrants).toHaveLength(1);
  });

  it('a give that ran out while it was open is not signed', async () => {
    const w = await world();
    await w.prepare();
    const d = new GiveDriver(w.deps);
    d.open(await onlyItem(w));
    w.as.clock += 7200;
    await d.give();
    expect(d.get()).toMatchObject({ step: 'failed' });
    expect(w.as.postedGrants).toHaveLength(0);
  });

  it('the Authority Server\'s refusal is said and nothing is "Signed"', async () => {
    const w = await world();
    await w.prepare();
    const d = new GiveDriver(w.deps);
    d.open(await onlyItem(w));
    const orig = w.as.call.bind(w.as);
    w.as.call = async (m, p, o) => (m === 'POST' && p.endsWith('/grants') ? { status: 409, body: { approved: false, errors: [{ code: 'GRANT_VERSION_REFUSED', message: 'x' }] } } : orig(m, p, o));
    await d.give();
    expect(d.get()).toMatchObject({ step: 'failed' });
  });
});

void b64uEncode;
