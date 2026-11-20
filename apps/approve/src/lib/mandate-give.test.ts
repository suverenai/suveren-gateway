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
    as.prepared = [{ mandate_id: MID, mandate_version: content.mandate_version, submitted_by_key_id: from, ciphertext: sealed.content.ciphertext, device_key: sealed.content.encrypted_keys[keys.keyId], stored_at: as.now(), expires_at: as.now() + 7 * 86400 }];
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

  it('a change without the version it continues is not shown', async () => {
    const w = await world();
    await w.prepare((c) => { c.give.op = 'change'; });
    expect(await refusedCode(w)).toBe('give_previous_mismatch');
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

describe('a change on the phone (mockup B1): the previous version is checked against its grant', () => {
  const AUTHZ2 = 'authz_00000000-0000-4000-8000-0000000000bb';
  const NEW_BOUNDS: Record<string, string | number> = { ...BOUNDS, value_max: 3000 };

  /** The phone gives v1 (a real grant at the Authority Server), then the computer prepares v2 with the previous values. */
  async function changeWorld(editPrevious: (pv: Record<string, any>) => void = () => {}, edit: (c: Record<string, any>) => void = () => {}) {
    const w = await world();
    await w.prepare();
    const d = new GiveDriver(w.deps);
    d.open(await onlyItem(w));
    await d.give();
    const v1 = w.as.postedGrants[0].grant as MandateGrant;
    await w.prepare((c) => {
      c.mandate_version = 2;
      c.give.op = 'change';
      c.give.bounds = { ...NEW_BOUNDS };
      c.give.payload.bounds_hash = computeBoundsHash(NEW_BOUNDS as never, SALES);
      c.give.place.authorization_id = AUTHZ2;
      c.give.place.replaces = AUTHZ;
      const previous: Record<string, any> = { profile: SALES, bounds: { ...BOUNDS }, scope: { ...SCOPE }, intent: INTENT, expires_at: (v1 as unknown as Record<string, unknown>).expires_at, mandate_version: 1 };
      editPrevious(previous);
      c.give.previous = previous;
      edit(c);
    });
    return { w, v1 };
  }

  it('shows the change with the old value crossed out, and grants version 2 with one touch', async () => {
    const { w } = await changeWorld();
    const item = await onlyItem(w);
    expect(item).toMatchObject({ op: 'change', version: 2 });
    const row = item.diff!.rows.find((r) => r.field === 'value_max');
    expect(row).toBeTruthy();
    expect(String(row!.before)).toContain('1');
    expect(String(row!.after)).toContain('3');
    const d = new GiveDriver(w.deps);
    d.open(item);
    await d.give();
    expect(['signed', 'not_received']).toContain(d.get().step);
    const posted = w.as.postedGrants.at(-1)!;
    expect(posted.op).toBe('change');
    await verifyGrant({ grant: posted.grant, sig: posted.sig, check: posted.check }, { chain: await w.as.state(), mandateFields: item.members, expect: { ops: ['change'], mandate_id: MID, mandate_version: 2 } });
  });

  // A computer (or a server) that shows other "old" values than the version that was signed: no card.
  const lies: Array<[string, (pv: Record<string, any>) => void]> = [
    ['other old limits', (pv) => { pv.bounds.value_max = 50; }],
    ['another old scope', (pv) => { pv.scope.currency = 'USD'; }],
    ['another old intent', (pv) => { pv.intent = 'Something else.'; }],
    ['another old end', (pv) => { pv.expires_at += 86400; }],
    ['the wrong previous version', (pv) => { pv.mandate_version = 0; }],
  ];
  for (const [name, editPrevious] of lies) {
    it(`refuses ${name}: no card, nothing to sign`, async () => {
      const { w } = await changeWorld(editPrevious);
      expect(await refusedCode(w)).toBe('give_previous_mismatch');
    });
  }

  it('refuses a previous grant that does not verify against the chain (forged at the server)', async () => {
    const { w } = await changeWorld();
    const rows = w.as.grants.get(MID)!;
    rows[0] = { ...rows[0], sig: rows[0].sig.slice(0, -4) + 'AAAA' };
    expect(await refusedCode(w)).toBe('give_previous_mismatch');
  });

  it('refuses a change that does not take over from the previous authorization', async () => {
    const { w } = await changeWorld(() => {}, (c) => { c.give.place.replaces = 'authz_00000000-0000-4000-8000-0000000000cc'; });
    expect(await refusedCode(w)).toBe('give_place_invalid');
  });

  it('refuses a change whose version does not follow the newest grant', async () => {
    const { w } = await changeWorld();
    w.as.prepared[0].mandate_version = 3;
    expect(await refusedCode(w)).toBeDefined();
  });
});

describe('a renewal on the phone (DEC-90): only the end date moves, checked against the previous grant', () => {
  /** The phone gives v1, then the computer prepares v2 as an extension: the same authorization, a later end, everything else equal. */
  async function renewWorld(edit: (c: Record<string, any>, v1: Record<string, unknown>) => void = () => {}) {
    const w = await world();
    await w.prepare();
    const d = new GiveDriver(w.deps);
    d.open(await onlyItem(w));
    await d.give();
    const v1 = w.as.postedGrants[0].grant as unknown as Record<string, unknown>;
    await w.prepare((c) => {
      c.mandate_version = 2;
      c.give.op = 'change';
      c.give.renewal = true;
      c.give.payload.expires_at = (v1.expires_at as number) + 7 * 86400;
      c.give.previous = { profile: SALES, bounds: { ...BOUNDS }, scope: { ...SCOPE }, intent: INTENT, expires_at: v1.expires_at, mandate_version: 1 };
      edit(c, v1);
    });
    return { w, v1 };
  }

  it('shows it as an extension (only "lasts until" changes) and grants version 2 under the same authorization with one touch', async () => {
    const { w } = await renewWorld();
    const item = await onlyItem(w);
    expect(item).toMatchObject({ op: 'change', version: 2, renewal: true });
    expect(item.diff!.rows.map((r) => r.field)).not.toContain('value_max');
    const d = new GiveDriver(w.deps);
    d.open(item);
    await d.give();
    expect(['signed', 'not_received']).toContain(d.get().step);
    const posted = w.as.postedGrants.at(-1)!;
    expect(posted.op).toBe('change');
    await verifyGrant({ grant: posted.grant, sig: posted.sig, check: posted.check }, { chain: await w.as.state(), mandateFields: item.members, expect: { ops: ['change'], mandate_id: MID, mandate_version: 2 } });
    expect((posted.grant as unknown as Record<string, unknown>).authorization_id).toBe(AUTHZ);
  });

  const changes: Array<[string, (c: Record<string, any>, v1: Record<string, unknown>) => void, string]> = [
    ['other limits under the name of an extension', (c) => { c.give.bounds = { ...BOUNDS, value_max: 9999 }; c.give.payload.bounds_hash = computeBoundsHash(c.give.bounds as never, SALES); }, 'give_renewal_is_a_change'],
    ['another intent', (c) => { c.intent = 'Something else.'; c.give.payload.gate_content_hashes = { intent: computeIntentHash('Something else.') }; }, 'give_renewal_is_a_change'],
    ['an end that is not later', (c, v1) => { c.give.payload.expires_at = v1.expires_at; }, 'give_renewal_is_a_change'],
    ['another authorization', (c) => { c.give.place.authorization_id = 'authz_00000000-0000-4000-8000-0000000000bb'; }, 'give_place_invalid'],
    ['other "old" values than were signed', (c) => { c.give.previous.bounds = { ...BOUNDS, value_max: 50 }; }, 'give_previous_mismatch'],
  ];
  for (const [name, edit, code] of changes) {
    it(`refuses ${name} (${code}): no card, nothing to sign`, async () => {
      const { w } = await renewWorld(edit);
      expect(await refusedCode(w)).toBe(code);
    });
  }
});
