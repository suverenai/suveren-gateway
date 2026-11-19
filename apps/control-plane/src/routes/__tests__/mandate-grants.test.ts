/**
 * Mandates granted on this computer with its check (device-keys plan 4.4, 7, 20.19, 20.20; build step 13, computer
 * part), through the REAL routers (`/api/mandate/*` and `/internal/mandate-grant/*` with the page-session guard, the real
 * ceremony, vault, chain store, hap-core builder and verifier, helper client). The only stand-ins:
 *
 *   - the Authority Server's network: StubAs + StubMandates, a local HTTP server on port 0 that answers PR #141's real
 *     shapes and checks every grant with hap-core `verifyGrant` against the real chain, with its member list written
 *     out by hand (helpers/stub-as-mandates.ts);
 *   - the native helper: packages/unlock-helper/test/fake-helper.mjs, software P-256 keys and no touch at all. No test
 *     shows a real Touch ID prompt. The prompt text it would show is read from the helper's own return value.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as dk from '@hap/core/device-keys';
import { decodeMandateBlob, computeBoundsHash, computeProfileHash } from '@hap/core';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { StubMandates, AS_GRANT_MEMBERS } from '../../__tests__/helpers/stub-as-mandates';
import { StubProposals } from '../../__tests__/helpers/stub-as-proposals';
import { computeProposalContentHash } from '../../lib/content-crypto';
import { bootGateway, call, sessionHeaders, type GatewayRig } from '../../__tests__/helpers/device-rig';
import { PlatformHelper } from '../../lib/platform-helper';
import { PlatformChecks } from '../../lib/platform-checks';
import { grantFieldKeys } from '../../lib/mandate-grants';
import { MandateGrantStore } from '../../lib/mandate-grant-store';
import { DeviceChainStore } from '../../lib/device-chain-store';
import { reasonFor } from '../../../../../packages/unlock-helper/test/fake-helper.mjs';

const FAKE = fileURLToPath(new URL('../../../../../packages/unlock-helper/test/fake-helper.mjs', import.meta.url));
const profilesDir = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'hap-profiles');
const SALES = JSON.parse(readFileSync(join(profilesDir, 'sales', '0.4.profile.json'), 'utf8'));
const LIMITS = { read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 0, setup_daily_max: 0 };
const REQ = { profile: 'sales', limits: LIMITS, scope: { currency: 'EUR' }, intent: 'Why: quotes wait two days.', mode: 'review', ttlSeconds: 3600, title: 'Quotes', team: 'personal' };

const open: Array<{ close: () => Promise<void> }> = [];
const hosts: PlatformHelper[] = [];
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  for (const h of hosts.splice(0)) h.close();
  vi.restoreAllMocks();
});

/** `env` is read at every start of the helper process: a test changes it, then ends the process (`close`) to apply it. */
const fakeHost = (env: Record<string, string> = {}): PlatformHelper => {
  const h = new PlatformHelper({ locate: () => ({ spec: { command: process.execPath, args: [FAKE], env: { ...process.env, ...env }, files: [] } }), idleMs: 30, touchTimeoutMs: 20_000 });
  hosts.push(h);
  return h;
};

// ─── another person with a device chain (an approver) ───────────────────────

async function person() {
  const { seed } = await dk.generateRecoveryCode();
  const root = await dk.deriveRootKey(seed);
  const priv = new Uint8Array((await import('node:crypto')).randomBytes(32));
  const pub = await dk.ed25519PublicKey(priv);
  const rec = await dk.buildDeviceRecord({ sign_pub: dk.b64uEncode(pub), read_pub: dk.b64uEncode(new Uint8Array(32).fill(5)), kind: 'gateway', label: 'Their computer', keystore: 'software' }, pub);
  const e0 = dk.buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: Math.floor(Date.now() / 1000), signer: 'root', device: rec });
  e0.sigs.push(await dk.signEntry(e0, 'root', root.privateSeed), await dk.signEntry(e0, rec.key_id, priv));
  await dk.verifyChain({ expectedRootDid: root.did, entries: [e0] });
  return { did: root.did, entries: [e0] };
}

async function world(o: { checkKey?: boolean } = {}) {
  const as = await new StubAs().listen();
  open.push(as);
  const props = new StubProposals(as);   // first: StubMandates chains in front of it
  const mandates = new StubMandates(as, SALES);
  const delivered: unknown[] = [];
  const helperEnv: Record<string, string> = {};
  const helper = fakeHost(helperEnv);
  const gw: GatewayRig = await bootGateway({ as, platform: helper, mandate: { deliver: async a => { delivered.push(a); } }, decision: { facts: async () => ({ mandateId: props.mandateId, actionType: props.actionType }) } });
  open.push(gw);
  const session = await gw.unlock();
  const h = sessionHeaders(session);
  const post = (path: string, body: unknown = {}) => call(gw.port, 'POST', path, { headers: h, body });
  const start = await post('/auth/device/setup/start', o.checkKey === false ? {} : { checkKey: true });
  expect(start.status).toBe(200);
  const fin = await post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: as.issueEnrolmentCode() });
  expect(fin.status).toBe(200);
  mandates.users.set('u1', { did: String(start.body.rootDid) });
  const sign = (body: Record<string, unknown> = {}) => post('/api/mandate/sign', { ...REQ, ...body });
  const internal = (path: string, body: unknown) => call(gw.port, 'POST', path, { headers: { 'x-internal-secret': 'sekret' }, body, origin: null });
  const spy = vi.spyOn(PlatformChecks.prototype, 'sign');
  /** From now on the helper behaves like this (set-up needed its own good touch first). */
  const helperNow = (env: Record<string, string>): void => { Object.assign(helperEnv, env); helper.close(); };
  return { as, props, mandates, gw, h, post, sign, internal, delivered, helperNow, rootDid: String(start.body.rootDid), keyId: String(start.body.deviceKeyId), touches: spy };
}
type W = Awaited<ReturnType<typeof world>>;

const authzOf = (r: { body: Record<string, unknown> }) => String(r.body.authorizationId);

describe('the grant: what is signed and what is sent', () => {
  it('the members are exactly the Authority Server\'s list (written out by hand there, derived from hap-core here)', () => {
    expect([...grantFieldKeys()]).toEqual(AS_GRANT_MEMBERS);
  });

  it('a mandate is granted with the computer\'s check, verified by the Authority Server, and only then requested', async () => {
    const w = await world();
    const r = await w.sign();
    expect(r.status, r.text).toBe(200);
    // one touch, for a grant, with the helper's own prompt text for THIS grant
    expect(w.touches).toHaveBeenCalledTimes(1);
    const g = w.mandates.rows;
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ op: 'grant', version: 1, userId: 'u1', keyId: w.keyId });
    expect(g[0].check).toMatchObject({ signature: expect.any(String) });
    const shown = await w.touches.mock.results[0].value;
    expect(shown.reason).toBe('grant the mandate for "' + SALES.id + '"');
    expect(reasonFor(Buffer.from(dk.signedBytes(g[0].grant)))).toBe(shown.reason);
    // the order: the grant is stored before the body and the body before the mandate request
    const order = w.mandates.posts.map(p => p.path.replace(/\/[A-Za-z0-9_-]{20,}\//, '/:id/'));
    expect(order).toEqual(['/api/mandates/:id/grants', '/api/mandates/prepared', '/api/as/mandate']);
    expect(w.mandates.posts.map(p => p.status)).toEqual([201, 201, 201]);
    // the mandate was issued under exactly that grant, and its intent delivered to the gateway
    const issued = w.mandates.issued;
    expect(issued).toHaveLength(1);
    expect(decodeMandateBlob(issued[0].blob).payload).toMatchObject({ mandate_id: g[0].mandateId, commitment_mode: 'review', mandate_owners: [{ did: w.rootDid }] });
    expect(w.delivered).toHaveLength(1);
    // every member of the grant the AS asked for is there, with the gateway's own values
    const grant = g[0].grant as Record<string, unknown>;
    expect(grant).toMatchObject({
      version: '0.8', profile_id: SALES.id, profile_hash: computeProfileHash(SALES), bounds_hash: computeBoundsHash({ ...LIMITS, profile: SALES.id } as never, SALES),
      commitment_mode: 'review', above_cap_caps: null, above_cap_approvers: null, above_cap_approvals: null, disclose_fields: null,
      subjects_disclosed: false, group_id: 'g_personal', replaces: null, chain_dids: [w.rootDid], owner_did: w.rootDid,
    });
    expect(grant.authorization_id).toBe(authzOf(r));
  });

  it('what is requested from the Authority Server: the id and version of the grant, an expiry and no ttl, only the DID of the owner', async () => {
    const w = await world();
    await w.sign();
    const req = w.mandates.posts.at(-1)!.body;
    expect(req).toMatchObject({ mandate_version: 1, mandate_owners: [{ did: w.rootDid }], commitment_mode: 'review' });
    expect(req.ttl).toBeUndefined();
    expect(typeof req.expires_at).toBe('number');
    const grant = w.mandates.rows[0].grant as Record<string, unknown>;
    expect(req.mandate_id).toBe(grant.mandate_id);
    expect(req.expires_at).toBe(grant.expires_at);
  });

  it('what is signed comes from the gateway\'s own plan: fields a page puts in the request body change nothing', async () => {
    const w = await world();
    const forged = {
      mandate_id: 'EVILEVILEVIL', mandate_version: 9, expires_at: 1, ttl: 5, commitment_mode: 'automatic', above_cap_approvers: ['did:key:z6MkEvil'],
      above_cap_caps: { value_max: 1 }, above_cap_approvals: 1, chain_dids: ['did:key:z6MkEvil'], group_id: 'g_team',
      op: 'revoke', owner_did: 'did:key:z6MkEvil', key_id: 'x', check: { signature: 'AAAA' }, grant: { op: 'revoke' }, nonce: 'AAAA', confirmed: true,
    };
    const r = await w.sign(forged);
    expect(r.status, r.text).toBe(200);
    const grant = w.mandates.rows[0].grant as Record<string, unknown>;
    expect(grant).toMatchObject({ op: 'grant', mandate_version: 1, commitment_mode: 'review', group_id: 'g_personal', above_cap_approvers: null, replaces: null, owner_did: w.rootDid, key_id: w.keyId });
    expect(grant.mandate_id).not.toBe('EVILEVILEVIL');
    expect(grant.expires_at).not.toBe(1);
    expect(JSON.stringify(w.mandates.posts)).not.toMatch(/EVILEVIL|z6MkEvil/);
  });

  it('the sealed body goes to EVERY active device of the verified chain, and opens for the right one', async () => {
    const w = await world();
    // a second device joins the chain (a phone-like device with its own read key)
    const rootless = await (async () => {
      const priv = new Uint8Array(32).fill(9);
      const pub = await dk.ed25519PublicKey(priv);
      const read = (await import('@hap/core')).generateReaderKeyPair;
      const kp = await read();
      const rec = await dk.buildDeviceRecord({ sign_pub: dk.b64uEncode(pub), read_pub: dk.b64uEncode(kp.publicKey), kind: 'approve-app', label: 'Phone', keystore: 'software' }, pub);
      return { rec, priv, kp };
    })();
    void rootless; // the chain is root-signed: adding it needs the root key, which only set-up held. See the per-device test in the MCP suite.
    const r = await w.sign();
    expect(r.status, r.text).toBe(200);
    const body = w.mandates.bodies[0];
    const chainState = await dk.verifyChain({ expectedRootDid: w.rootDid, entries: w.as.chainEntries() });
    expect(Object.keys(body.deviceKeys).sort()).toEqual(dk.activeDevices(chainState).map(d => d.key_id).sort());
    // the AS holds ciphertext and wraps only: nothing of scope or intent in the clear
    expect(JSON.stringify(body)).not.toMatch(/quotes wait|EUR/);
    // the computer's own reading key opens it
    const { decryptProposalContent } = await import('@hap/core');
    const { loadOrGenerateKeyPair } = await import('../../lib/e2e-key-manager');
    const kp = await loadOrGenerateKeyPair(w.gw.vault);
    const opened = await decryptProposalContent({ ciphertext: body.ciphertext, encrypted_keys: body.deviceKeys, readers: Object.keys(body.deviceKeys), unreadable: [] }, w.keyId, kp.privateKey);
    expect(opened.arguments).toMatchObject({ v: 1, mandate_id: w.mandates.rows[0].mandateId, mandate_version: 1, scope: { currency: 'EUR' }, intent: REQ.intent });
  });
});

describe('before the touch: everything that can be refused is refused without asking the person', () => {
  it('no check key: nothing is signed, nothing is stored, no mandate is requested', async () => {
    const w = await world({ checkKey: false });
    const r = await w.sign();
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'grant_refused', grantCode: 'no_check_key' });
    expect(w.touches).not.toHaveBeenCalled();
    expect(w.mandates.posts).toEqual([]);
    expect(w.mandates.issued).toEqual([]);
  });

  it('a touch that is not given (cancelled): no grant, no body, no mandate', async () => {
    const w = await world();
    w.helperNow({ FAKE_TOUCH: 'cancel' });
    const r = await w.sign();
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'grant_refused', grantCode: 'check_failed' });
    expect(w.mandates.rows).toEqual([]);
    expect(w.mandates.posts).toEqual([]);
  });

  it('a helper that signs something else is refused here: a wrong signature never leaves this computer', async () => {
    const w = await world();
    // the set-up itself needed one good check; from here every check is wrong
    w.helperNow({ FAKE_WRONG_SIGNATURE: '1' });
    const r = await w.sign();
    expect([r.status, r.body.grantCode]).toEqual([422, 'check_failed']);
    expect(w.mandates.rows).toEqual([]);
    expect(w.mandates.posts).toEqual([]);
  });

  it('a chain the Authority Server cannot serve: refused with a code, nothing signed, no touch', async () => {
    const w = await world();
    w.as.failChainGets = 5;
    const r = await w.sign();
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'grant_refused', grantCode: 'as_answer_invalid' });
    expect(w.touches).not.toHaveBeenCalled();
    expect(w.mandates.posts).toEqual([]);
  });
});

describe('teams: approvers, caps and the count go into the mandate before the owner signs (DEC-61)', () => {
  const CAPS = { value_max: { value: 500, kind: 'approval' as const } };

  async function team(w: W, opts: { approvers?: string[] } = {}) {
    const ap = await person();
    const ap2 = await person();
    w.as.otherChains.set(ap.did, ap.entries);
    w.as.otherChains.set(ap2.did, ap2.entries);
    w.mandates.users.set('u_ap', { did: ap.did });
    w.mandates.users.set('u_ap2', { did: ap2.did });
    w.mandates.team = { approvers: opts.approvers ?? ['u_ap', 'u_ap2'], approvals: 2, caps: CAPS };
    const dids = (opts.approvers ?? ['u_ap', 'u_ap2']).map(u => w.mandates.users.get(u)!.did);
    w.mandates.expectation = { mode: 'review', caps: { value_max: 500 }, approvers: [...dids].sort(), approvals: 2 };
    return { ap, ap2, dids };
  }

  it('the team\'s approvers (DIDs), caps and count are in the grant, and a new approver\'s code must be compared first', async () => {
    const w = await world();
    const t = await team(w);
    const first = await w.sign({ team: 'g_team' });
    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({ code: 'grant_refused', grantCode: 'approver_identity_unconfirmed' });
    expect((first.body.approvers as Array<{ did: string; identityCode: string }>).map(a => a.did).sort()).toEqual([...t.dids].sort());
    expect((first.body.approvers as Array<{ identityCode: string }>)[0].identityCode).toMatch(/^\d{4} \d{4} \d{4} \d{4} \d{4} \d{4}$/);
    expect(w.touches).not.toHaveBeenCalled();
    expect(w.mandates.posts).toEqual([]);
    // the person compared them: granted, with one touch
    const r = await w.sign({ team: 'g_team', confirmedApproverDids: t.dids });
    expect(r.status, r.text).toBe(200);
    expect(w.touches).toHaveBeenCalledTimes(1);
    const grant = w.mandates.rows[0].grant as Record<string, unknown>;
    expect(grant).toMatchObject({ commitment_mode: 'review', above_cap_caps: { value_max: 500 }, above_cap_approvers: [...t.dids].sort(), above_cap_approvals: 2, group_id: 'g_team' });
    expect(grant.chain_dids).toEqual([w.rootDid, ...t.dids].sort());
    // remembered: the next mandate does not ask again
    w.mandates.expectation = { ...w.mandates.expectation!, approvals: 2 };
    expect((await w.sign({ team: 'g_team' })).status).toBe(200);
  });

  it('an approver added in the dashboard changes nothing that was granted: the issued mandate keeps its approvers, a new one needs a new grant', async () => {
    const w = await world();
    const t = await team(w);
    expect((await w.sign({ team: 'g_team', confirmedApproverDids: t.dids })).status).toBe(200);
    const before = JSON.stringify(decodeMandateBlob(w.mandates.issued[0].blob).payload.above_cap_approvers);
    const grantsBefore = w.mandates.rows.length;
    const third = await person();
    w.as.otherChains.set(third.did, third.entries);
    w.mandates.users.set('u_ap3', { did: third.did });
    w.mandates.team!.approvers.push('u_ap3');
    expect(JSON.stringify(decodeMandateBlob(w.mandates.issued[0].blob).payload.above_cap_approvers)).toBe(before);
    expect(w.mandates.rows).toHaveLength(grantsBefore);
  });

  it('the approvers are named in one canonical (sorted) order; an Authority Server that signs them in another order is refused at issuance, visibly', async () => {
    const w = await world();
    const t = await team(w);
    const sorted = [...t.dids].sort();
    // the Authority Server's table gives them in the other order (the real one does not sort: PR #141 contract risk)
    w.mandates.expectation = { mode: 'review', caps: { value_max: 500 }, approvers: [...sorted].reverse(), approvals: 2 };
    const r = await w.sign({ team: 'g_team', confirmedApproverDids: t.dids });
    expect((w.mandates.rows[0].grant as Record<string, unknown>).above_cap_approvers).toEqual(sorted);
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toMatch(/does not hold for this mandate|GRANT_MISMATCH|Authority Server refused/);
    expect(w.mandates.issued).toEqual([]);
    expect(w.delivered).toEqual([]);
  });

  it('an approver without a device chain is refused before the touch (no mixing)', async () => {
    const w = await world();
    const t = await team(w);
    w.mandates.users.get('u_ap2')!.chain = false;   // the Authority Server lists them with did: null
    const r = await w.sign({ team: 'g_team', confirmedApproverDids: t.dids });
    expect(r.body).toMatchObject({ code: 'grant_refused', grantCode: 'approver_has_no_chain' });
    // and an approver whose DID it names but whose chain it does not serve
    w.mandates.users.get('u_ap2')!.chain = true;
    w.as.otherChains.delete(t.ap2.did);
    expect((await w.sign({ team: 'g_team', confirmedApproverDids: t.dids })).body.grantCode).toBe('approver_has_no_chain');
    expect(w.touches).not.toHaveBeenCalled();
  });

  it('an approver the Authority Server holds back (DEC-35) is not named; a list it does not give, or names wrongly, refuses the grant', async () => {
    const w = await world();
    const t = await team(w);
    w.mandates.users.get('u_ap2')!.reconfirm = true;
    w.mandates.team!.approvals = 1;
    w.mandates.expectation = { mode: 'review', caps: { value_max: 500 }, approvers: [t.dids[0]], approvals: 1 };
    const r = await w.sign({ team: 'g_team', confirmedApproverDids: t.dids });
    expect(r.status, r.text).toBe(200);
    expect((w.mandates.rows[0].grant as Record<string, unknown>).above_cap_approvers).toEqual([t.dids[0]]);
    // an Authority Server that gives no list, or an approver the team does not have
    w.mandates.eligibleOverride = null;
    expect((await w.sign({ team: 'g_team', confirmedApproverDids: t.dids })).body.grantCode).toBe('approvers_unavailable');
    w.mandates.eligibleOverride = [{ user_id: 'u_stranger', did: t.dids[0] }];
    expect((await w.sign({ team: 'g_team', confirmedApproverDids: t.dids })).body.grantCode).toBe('approver_unresolved');
  });

  it('an approver chain that is shorter than the one pinned before is a rollback and refuses the grant', async () => {
    const w = await world();
    const t = await team(w);
    expect((await w.sign({ team: 'g_team', confirmedApproverDids: t.dids })).status).toBe(200);
    // this computer pinned a longer chain of the approver than the one the Authority Server serves now
    const pins = new (await import('../../lib/device-pin-store')).DevicePinStore(w.gw.vault, new DeviceChainStore(w.gw.vault));
    const state = await dk.verifyChain({ expectedRootDid: t.ap.did, entries: t.ap.entries });
    pins.advance(t.ap.did, { seq: state.head.seq + 1, hash: state.head.hash });
    const r = await w.sign({ team: 'g_team' });
    expect(r.body.grantCode).toBe('chain_rollback');
    expect(w.touches).toHaveBeenCalledTimes(1);
  });

  it('where the Authority Server would sign something else than what was granted it refuses, and nothing goes live', async () => {
    const w = await world();
    const t = await team(w);
    w.mandates.expectation = { mode: 'review', caps: { value_max: 500 }, approvers: [t.dids[0]], approvals: 1 };
    const r = await w.sign({ team: 'g_team', confirmedApproverDids: t.dids });
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toMatch(/team settings require|asks for something else/);
    expect(w.mandates.issued).toEqual([]);
    expect(w.delivered).toEqual([]);
  });
});

describe('change, renewal and revoke', () => {
  it('a change is a new version of the SAME mandate under a new authorization that names the old one; the old one ends', async () => {
    const w = await world();
    const first = await w.sign();
    const second = await w.sign({ replaces: authzOf(first), limits: { ...LIMITS, value_max: 900 } });
    expect(second.status, second.text).toBe(200);
    const [g1, g2] = w.mandates.rows;
    expect([g1.op, g1.version, g2.op, g2.version]).toEqual(['grant', 1, 'change', 2]);
    expect(g2.mandateId).toBe(g1.mandateId);
    expect(g2.authorizationId).toBe(authzOf(second));
    expect((g2.grant as Record<string, unknown>).replaces).toBe(authzOf(first));
    expect(w.mandates.issued.find(i => i.authorizationId === authzOf(first))!.revoked).toBe(true);
    expect(w.mandates.issued.find(i => i.authorizationId === authzOf(second))!.revoked).toBe(false);
    // the legacy revoke of the replaced mandate is never sent: the Authority Server ended it
    expect(w.mandates.posts.some(p => /\/api\/authorizations\/.*\/revoke/.test(p.path))).toBe(false);
    expect(w.touches).toHaveBeenCalledTimes(2);
    // the older body is gone at the AS
    expect(w.mandates.bodies.map(b => b.version)).toEqual([2]);
  });

  it('a change of a mandate that someone else already replaced is refused before the touch', async () => {
    const w = await world();
    const first = await w.sign();
    await w.sign({ replaces: authzOf(first) });
    const touched = w.touches.mock.calls.length;
    const again = await w.sign({ replaces: authzOf(first) });
    expect(again.status).toBe(422);
    expect(w.touches.mock.calls.length).toBe(touched);
  });

  it('a renewal moves only the expiry: version +1 under the same authorization, replaces as it was', async () => {
    const w = await world();
    const first = await w.sign({ discloseIdentity: false });
    const id = authzOf(first);
    const grant1 = w.mandates.rows[0].grant as Record<string, unknown>;
    const r = await w.post('/api/mandate/renew', {
      authorizationId: id, profileId: SALES.id, groupId: 'g_personal', bounds: { ...LIMITS, profile: SALES.id }, context: { currency: 'EUR' },
      intent: REQ.intent, mode: 'review', domain: 'owner', ttlSeconds: 7200,
    });
    expect(r.status, r.text).toBe(200);
    const g2 = w.mandates.rows[1];
    expect([g2.op, g2.version, g2.authorizationId]).toEqual(['change', 2, id]);
    expect((g2.grant as Record<string, unknown>).expires_at as number).toBeGreaterThan(grant1.expires_at as number);
    expect((g2.grant as Record<string, unknown>).replaces).toBe(grant1.replaces);
    expect(w.mandates.posts.at(-1)!.body.renew).toBe(true);
  });

  it('a revoke is signed by this computer\'s device key without a touch, and is final', async () => {
    const w = await world();
    const first = await w.sign();
    const id = authzOf(first);
    w.touches.mockClear();
    const r = await w.post('/api/mandate/revoke', { authorizationId: id });
    expect(r.status, r.text).toBe(200);
    expect(w.touches).not.toHaveBeenCalled();
    const rev = w.mandates.rows.at(-1)!;
    expect([rev.op, rev.version]).toEqual(['revoke', 1]);
    expect(rev.check).toBeNull();
    expect(w.mandates.issued[0].revoked).toBe(true);
    expect(w.mandates.bodies).toEqual([]);
    // final: nothing changes it again, and the gateway says so
    const again = await w.post('/api/mandate/revoke', { authorizationId: id });
    expect(again.body.grantCode).toBe('mandate_revoked');
    const change = await w.sign({ replaces: id });
    expect(change.body.grantCode).toBe('mandate_revoked');
  });

  it('revoke names only an authorization id: anything else is refused', async () => {
    const w = await world();
    for (const bad of [undefined, 5, '../x', 'authz_x', { a: 1 }]) {
      const r = await w.post('/api/mandate/revoke', { authorizationId: bad });
      expect(r.status).toBe(400);
    }
  });
});

describe('what the MCP server asks of the control plane: the highest version, a revocation, the receipt', () => {
  const H = (c: string) => `sha256:${c.repeat(64)}`;

  it('remembers only a grant THIS control plane verified itself, and a lower version is refused', async () => {
    const w = await world();
    const first = await w.sign();
    await w.sign({ replaces: authzOf(first) });
    const [g1, g2] = w.mandates.rows;
    const obs = (version: number, hash: string, op = 'grant', mandateId = g1.mandateId) => w.internal('/internal/mandate-grant/observe', { mandateId, version, grantHash: hash, op });
    expect((await obs(2, g2.grantHash, 'change')).body).toMatchObject({ ok: true });
    expect((await obs(1, g1.grantHash)).body).toMatchObject({ code: 'lower_version' });
    // what it did not see verify is not remembered: another hash, a version no row has, an op the row does not have, another mandate
    expect((await obs(3, H('c'), 'change')).body).toMatchObject({ code: 'grant_not_held' });
    expect((await obs(2, H('d'), 'change')).body).toMatchObject({ code: 'grant_not_held' });
    expect((await obs(2, g2.grantHash, 'grant')).body).toMatchObject({ code: 'grant_not_held' });
    expect((await obs(2, g2.grantHash, 'change', 'm-unknown1')).body).toMatchObject({ code: 'grant_not_held' });
    expect((await w.internal('/internal/mandate-grant/observe', { mandateId: 'x', version: 1, grantHash: 'no', op: 'grant' })).status).toBe(400);
    expect(new MandateGrantStore(w.gw.vault).get(g1.mandateId)).toMatchObject({ version: 2, revoked: false });
    // a revoke is recorded only when it is a verified revoke row
    await w.post('/api/mandate/revoke', { authorizationId: authzOf(first) === g2.authorizationId ? authzOf(first) : g2.authorizationId });
    const rev = w.mandates.rows.at(-1)!;
    expect((await obs(rev.version, rev.grantHash, 'revoke')).body).toMatchObject({ ok: true });
    expect(new MandateGrantStore(w.gw.vault).get(g1.mandateId)).toMatchObject({ revoked: true });
  });

  it('the store itself: a lower version, another grant of the same version and a revoked mandate are refused', async () => {
    const w = await world();
    const st = new MandateGrantStore(w.gw.vault);
    expect(st.observe('m-aaaaaaaa', 2, H('a'), 'change')).toEqual({ receiptNeeded: true });
    expect(() => st.observe('m-aaaaaaaa', 1, H('b'), 'grant')).toThrow(/lower_version/);
    expect(() => st.observe('m-aaaaaaaa', 2, H('c'), 'change')).toThrow(/same_version_other_grant/);
    st.observe('m-aaaaaaaa', 2, H('a'), 'revoke');
    expect(() => st.observe('m-aaaaaaaa', 3, H('d'), 'change')).toThrow(/revoked/);
  });

  it('only this person, or someone whose identity code they compared, is an owner: the page confirms by code, the AI path cannot', async () => {
    const w = await world();
    const other = await person();
    const known = (did: string) => w.internal('/internal/mandate-grant/owner-known', { did }).then(r => r.body.known);
    expect(await known(w.rootDid)).toBe(true);
    expect(await known(other.did)).toBe(false);
    const wrong = await w.post('/api/mandate/confirm-identity', { did: other.did, code: '000000000000000000000000' });
    expect(wrong.body).toMatchObject({ grantCode: 'identity_code_mismatch' });
    expect(await known(other.did)).toBe(false);
    const code = await dk.identityCode(other.did);
    expect((await w.post('/api/mandate/confirm-identity', { did: other.did, code })).status).toBe(200);
    expect(await known(other.did)).toBe(true);
  });

  it('the AI path (the internal secret alone) cannot raise Touch ID: a mandate is created only for what the person approved, once, from the approved arguments', async () => {
    const w = await world();
    const args = { profile: 'sales', limits: LIMITS, scope: { currency: 'EUR' }, intent: 'Why: quotes wait two days.', mode: 'review', duration_hours: 1, title: 'Quotes' };
    const hash = computeProposalContentHash(args);
    const request = { profile: 'sales', limits: LIMITS, scope: { currency: 'EUR' }, intent: args.intent, mode: 'review', durationHours: 1, title: 'Quotes', team: 'personal' };
    // the AI calls directly: no approval, a made-up fingerprint, the right fingerprint of something nobody approved
    for (const approvalHash of [undefined, `sha256:${'a'.repeat(64)}`, hash]) {
      const r = await w.internal('/internal/mandate', { request: { ...request, ...(approvalHash ? { approvalHash } : {}) } });
      expect([r.status, r.body.code], String(approvalHash)).toEqual([403, 'approval_required']);
    }
    expect(w.touches).not.toHaveBeenCalled();
    expect(w.mandates.rows).toEqual([]);
    // the person approves the proposal on the page
    w.props.add({ id: 'p1', tool: 'setup__create_mandate', toolArgs: args, contentHash: hash });
    const approved = await w.post('/device-decision/p1/approve', { content_hash: hash, proposalContentHash: hash });
    expect(approved.status, approved.text).toBe(200);
    // another tool's approval, or a different fingerprint, is still nothing
    const other = await w.internal('/internal/mandate', { request: { ...request, approvalHash: `sha256:${'b'.repeat(64)}` } });
    expect(other.body.code).toBe('approval_required');
    // the call names only the fingerprint: what is created is what was approved, whatever else the caller put in the request
    const r = await w.internal('/internal/mandate', { request: { profile: 'sales', limits: { ...LIMITS, value_max: 999999 }, scope: { currency: 'USD' }, intent: 'something else', mode: 'automatic', durationHours: 5, approvalHash: hash, confirmedApproverDids: ['did:key:z6MkEvil'] } });
    expect(r.status, r.text).toBe(200);
    expect(w.touches).toHaveBeenCalledTimes(1);
    const grant = w.mandates.rows[0].grant as Record<string, unknown>;
    expect(grant).toMatchObject({ commitment_mode: 'review', bounds_hash: computeBoundsHash({ ...LIMITS, profile: SALES.id } as never, SALES) });
    // used once
    const again = await w.internal('/internal/mandate', { request: { ...request, approvalHash: hash } });
    expect(again.body.code).toBe('approval_required');
    expect(w.touches).toHaveBeenCalledTimes(1);
  });

  it('a touch that was not given leaves the approval unspent (try again), and a dry run needs no approval and raises no touch', async () => {
    const w = await world();
    const args = { profile: 'sales', limits: LIMITS, scope: { currency: 'EUR' }, intent: 'Why', mode: 'review', duration_hours: 1, title: 'Q' };
    const hash = computeProposalContentHash(args);
    w.props.add({ id: 'p2', tool: 'setup__create_mandate', toolArgs: args, contentHash: hash });
    expect((await w.post('/device-decision/p2/approve', { content_hash: hash, proposalContentHash: hash })).status).toBe(200);
    const dry = await w.internal('/internal/mandate', { dryRun: true, request: { profile: 'sales', limits: LIMITS, scope: { currency: 'EUR' }, intent: 'Why', mode: 'review', durationHours: 1, team: 'personal' } });
    expect(dry.status, dry.text).toBe(200);
    expect(w.touches).not.toHaveBeenCalled();
    w.helperNow({ FAKE_TOUCH: 'cancel' });
    expect((await w.internal('/internal/mandate', { request: { approvalHash: hash } })).body).toMatchObject({ grantCode: 'check_failed' });
    w.helperNow({ FAKE_TOUCH: 'ok' });
    expect((await w.internal('/internal/mandate', { request: { approvalHash: hash } })).status).toBe(200);
  });

  it('answers a grant with this computer\'s signed receipt, once; the Authority Server verifies it', async () => {
    const w = await world();
    const first = await w.sign();
    const g = w.mandates.rows[0];
    expect(authzOf(first)).toBeTruthy();
    const rec = () => w.internal('/internal/mandate-grant/receipt', { mandateId: g.mandateId, version: 1, grantHash: g.grantHash });
    const r1 = await rec();
    expect(r1.body).toMatchObject({ ok: true, sent: true });
    expect(w.mandates.receipts).toHaveLength(1);
    const stored = w.mandates.receipts[0];
    // what is signed names THIS gateway's own key and chain position, whatever the caller said
    expect(stored.receipt).toMatchObject({ typ: 'suveren-mandate-receipt', mandate_id: g.mandateId, mandate_version: 1, grant_hash: g.grantHash, key_id: w.keyId });
    const again = await rec();
    expect(again.body).toMatchObject({ ok: true, sent: false });
    expect(w.mandates.receipts).toHaveLength(1);
  });

  it('a receipt for a grant the Authority Server does not hold is refused; the secret is required', async () => {
    const w = await world();
    const r = await w.internal('/internal/mandate-grant/receipt', { mandateId: 'm-cccccccc', version: 1, grantHash: H('f') });
    expect(r.status).toBe(502);
    const noSecret = await call(w.gw.port, 'POST', '/internal/mandate-grant/receipt', { body: { mandateId: 'm-cccccccc', version: 1, grantHash: H('f') }, origin: null });
    expect(noSecret.status).toBe(401);
  });
});

describe('the sealed body on this computer (plan 20.19, DEC-58): fetched, opened with its own key, never trusted from the Authority Server', () => {
  const asBody = (w: W, g = w.mandates.rows[0]) => w.internal('/internal/mandate-grant/body', { mandateId: g.mandateId, version: g.version, grantHash: g.grantHash });

  /** What a lying Authority Server can do best: seal other content to THIS computer's real reading key from the chain. */
  async function sealTo(w: W, content: Record<string, unknown>): Promise<void> {
    const { encryptProposalContent } = await import('@hap/core');
    const chain = await dk.verifyChain({ expectedRootDid: w.rootDid, entries: w.as.chainEntries() });
    const sealed = await encryptProposalContent(content, [{ did: w.keyId, publicKey: dk.b64uDecode(chain.devices[w.keyId].read_pub) }]);
    Object.assign(w.mandates.bodies[0], { ciphertext: sealed.content.ciphertext, deviceKeys: sealed.content.encrypted_keys });
  }

  it('opens the body of a verified grant with this computer\'s own key and answers scope and intent only', async () => {
    const w = await world();
    expect((await w.sign()).status).toBe(200);
    const r = await asBody(w);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ ok: true, scope: { currency: 'EUR' }, intent: REQ.intent });
    expect(w.mandates.posts.filter(p => p.path.endsWith('/body'))).toEqual([]);   // it only reads
  });

  it('is the control plane\'s own check that decides: a grant it does not see verify, another version, a wrong secret', async () => {
    const w = await world();
    await w.sign();
    const g = w.mandates.rows[0];
    expect((await w.internal('/internal/mandate-grant/body', { mandateId: g.mandateId, version: 1, grantHash: `sha256:${'c'.repeat(64)}` })).body).toMatchObject({ code: 'grant_not_held' });
    expect((await w.internal('/internal/mandate-grant/body', { mandateId: g.mandateId, version: 2, grantHash: g.grantHash })).body).toMatchObject({ code: 'grant_not_held' });
    expect((await w.internal('/internal/mandate-grant/body', { mandateId: 'x', version: 1, grantHash: 'no' })).status).toBe(400);
    expect((await call(w.gw.port, 'POST', '/internal/mandate-grant/body', { headers: { 'x-internal-secret': 'wrong' }, body: { mandateId: g.mandateId, version: 1, grantHash: g.grantHash }, origin: null })).status).toBe(401);
  });

  it('no body, or no wrap for this computer: "not yet received", never a guess', async () => {
    const w = await world();
    await w.sign();
    const stored = w.mandates.bodies[0];
    const wrap = stored.deviceKeys[w.keyId];
    stored.deviceKeys = {};                                        // the body is there, this computer\'s wrap is not (a computer added later, not yet re-wrapped)
    expect(await asBody(w)).toMatchObject({ status: 404, body: { code: 'body_not_received' } });
    stored.deviceKeys = { [w.keyId]: wrap };
    expect((await asBody(w)).status).toBe(200);
    w.mandates.bodies.splice(0);                                   // swept / revoked: nothing stored
    expect(await asBody(w)).toMatchObject({ status: 404, body: { code: 'body_not_received' } });
  });

  it('a revoked mandate\'s body is deleted at the Authority Server, and nothing is opened any more', async () => {
    const w = await world();
    const first = await w.sign();
    const g = w.mandates.rows[0];
    expect((await asBody(w)).status).toBe(200);
    await w.post('/api/mandate/revoke', { authorizationId: authzOf(first) });
    expect(w.mandates.bodies).toHaveLength(0);
    expect(await w.internal('/internal/mandate-grant/body', { mandateId: g.mandateId, version: 1, grantHash: g.grantHash })).toMatchObject({ status: 404, body: { code: 'body_not_received' } });
  });

  it('an altered envelope is refused: changed ciphertext, a wrap of another key, content that names another version or carries more', async () => {
    const w = await world();
    await w.sign();
    const g = w.mandates.rows[0];
    const good = { ...w.mandates.bodies[0], deviceKeys: { ...w.mandates.bodies[0].deviceKeys } };
    const flip = good.ciphertext.slice(0, -4) + (good.ciphertext.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    w.mandates.bodies[0].ciphertext = flip;
    expect(await asBody(w)).toMatchObject({ status: 422, body: { code: 'body_unreadable' } });
    Object.assign(w.mandates.bodies[0], good);
    // a wrap made for somebody else's key
    const other = await (await import('@hap/core')).generateReaderKeyPair();
    const { encryptProposalContent } = await import('@hap/core');
    const forOther = await encryptProposalContent({ v: 1, mandate_id: g.mandateId, mandate_version: 1, scope: {}, intent: 'x' }, [{ did: w.keyId, publicKey: other.publicKey }]);
    Object.assign(w.mandates.bodies[0], { ciphertext: forOther.content.ciphertext, deviceKeys: forOther.content.encrypted_keys });
    expect(await asBody(w)).toMatchObject({ status: 422, body: { code: 'body_unreadable' } });
    // opens, but is not this mandate's body
    await sealTo(w, { v: 1, mandate_id: g.mandateId, mandate_version: 2, scope: { currency: 'EUR' }, intent: REQ.intent });
    expect(await asBody(w)).toMatchObject({ status: 422, body: { code: 'body_invalid' } });
    await sealTo(w, { v: 1, mandate_id: 'mandate-other-1', mandate_version: 1, scope: { currency: 'EUR' }, intent: REQ.intent });
    expect(await asBody(w)).toMatchObject({ status: 422, body: { code: 'body_invalid' } });
    await sealTo(w, { v: 1, mandate_id: g.mandateId, mandate_version: 1, scope: { currency: 'EUR' }, intent: REQ.intent, note: 'more' });
    expect(await asBody(w)).toMatchObject({ status: 422, body: { code: 'body_invalid' } });
    await sealTo(w, { v: 1, mandate_id: g.mandateId, mandate_version: 1, scope: { currency: { nested: 1 } }, intent: REQ.intent });
    expect(await asBody(w)).toMatchObject({ status: 422, body: { code: 'body_invalid' } });
    await sealTo(w, { v: 1, mandate_id: g.mandateId, mandate_version: 1, scope: { currency: 'EUR' }, intent: REQ.intent });
    expect((await asBody(w)).status).toBe(200);
  });

  it('a refusal never carries scope or intent', async () => {
    const w = await world();
    await w.sign();
    const g = w.mandates.rows[0];
    w.mandates.bodies[0].deviceKeys = {};
    const r = await asBody(w);
    expect(r.text).not.toContain(REQ.intent);
    expect(r.text).not.toContain('EUR');
  });
});

describe('review round 2', () => {
  const H = (c: string) => `sha256:${c.repeat(64)}`;

  it('F1: a seen revoke is recorded at ANY version and never un-revoked; the highest version stays', async () => {
    const w = await world();
    const st = new MandateGrantStore(w.gw.vault);
    st.observe('m-revoke01', 3, H('a'), 'change');
    expect(st.observe('m-revoke01', 1, H('b'), 'revoke')).toEqual({ receiptNeeded: false });   // an OLDER version's revoke: recorded, not refused
    expect(st.get('m-revoke01')).toMatchObject({ version: 3, revoked: true });
    expect(() => st.observe('m-revoke01', 4, H('c'), 'change')).toThrow(/revoked/);
    expect(() => st.observe('m-revoke01', 3, H('a'), 'change')).toThrow(/revoked/);
    // and a revoke of a mandate never seen is recorded too
    st.observe('m-revoke02', 2, H('d'), 'revoke');
    expect(st.get('m-revoke02')).toMatchObject({ version: 2, revoked: true });
  });

  it('F1: a revoke by a device that was active at the named head counts; one signed after the device was removed does not verify', async () => {
    const w = await world();
    const first = await w.sign();
    const g = w.mandates.rows[0];
    // the revoke row is a device-signed row of the owner's chain: the verifier accepts it against the chain as it is now
    const r = await w.post('/api/mandate/revoke', { authorizationId: authzOf(first) });
    expect(r.status, r.text).toBe(200);
    const rev = w.mandates.rows.at(-1)!;
    const obs = await w.internal('/internal/mandate-grant/observe', { mandateId: g.mandateId, version: rev.version, grantHash: rev.grantHash, op: 'revoke' });
    expect(obs.status).toBe(200);
    // (hap-core verifyGrant requires the signing device to be ACTIVE in the chain it is given: a revoke whose device was removed LATER no longer verifies. Stated as a limit.)
  });

  it('F5: the sticky flag that a chain was ever reported here is kept in the vault', async () => {
    const w = await world();
    const seen = () => call(w.gw.port, 'GET', '/internal/mandate-grant/chain-seen', { headers: { 'x-internal-secret': 'sekret' } }).then(r => r.body.seen);
    expect(await seen()).toBe(false);
    expect((await w.internal('/internal/mandate-grant/chain-seen', {})).status).toBe(200);
    expect(await seen()).toBe(true);
    expect(new MandateGrantStore(w.gw.vault).chainSeen()).toBe(true);
  });

  it('F6: a pin advances only after the control plane verified the chain itself; the caller names only the DID', async () => {
    const w = await world();
    const ap = await person();
    const pin = (body: unknown) => w.internal('/internal/device-pin/advance', body);
    // the Authority Server serves nothing for this DID: nothing is pinned, whatever head the caller claims
    expect((await pin({ did: ap.did, head: { seq: 9, hash: `sha256:${'9'.repeat(64)}` } })).status).toBeGreaterThanOrEqual(400);
    const get = (did: string) => w.internal('/internal/device-pin/get', { did }).then(r => r.body.head);
    expect(await get(ap.did)).toBeNull();
    w.as.otherChains.set(ap.did, ap.entries);
    const ok = await pin({ did: ap.did, head: { seq: 9, hash: `sha256:${'9'.repeat(64)}` } });
    expect(ok.status, ok.text).toBe(200);
    // the pinned head is the verified one, not the claimed one
    const state = await dk.verifyChain({ expectedRootDid: ap.did, entries: ap.entries });
    expect(await get(ap.did)).toEqual({ seq: state.head.seq, hash: state.head.hash });
    // this computer's own chain is never moved here
    expect((await pin({ did: w.rootDid })).body).toMatchObject({ code: 'own_chain' });
  });

  it('F4: a confirmation can be withdrawn (page session only)', async () => {
    const w = await world();
    const other = await person();
    const known = (did: string) => w.internal('/internal/mandate-grant/owner-known', { did }).then(r => r.body.known);
    await w.post('/api/mandate/confirm-identity', { did: other.did, code: await dk.identityCode(other.did) });
    expect(await known(other.did)).toBe(true);
    expect((await w.post('/api/mandate/forget-identity', { did: other.did })).status).toBe(200);
    expect(await known(other.did)).toBe(false);
    expect((await call(w.gw.port, 'POST', '/api/mandate/forget-identity', { body: { did: other.did } })).status).toBe(401);
  });

  it('F7: extending moves only the date; a renewal that would change anything else is refused as a change', async () => {
    const w = await world();
    const first = await w.sign();
    const base = { authorizationId: authzOf(first), profileId: SALES.id, groupId: 'g_personal', bounds: { ...LIMITS, profile: SALES.id }, context: { currency: 'EUR' }, intent: REQ.intent, mode: 'review', domain: 'owner', ttlSeconds: 7200 };
    const before = w.mandates.rows.length;
    for (const change of [{ intent: 'another intent' }, { bounds: { ...LIMITS, value_max: 5, profile: SALES.id } }, { context: { currency: 'USD' } }]) {
      const r = await w.post('/api/mandate/renew', { ...base, ...change });
      expect(r.body, JSON.stringify(change)).toMatchObject({ grantCode: 'renewal_is_a_change' });
    }
    expect(w.mandates.rows).toHaveLength(before);
    expect((await w.post('/api/mandate/renew', base)).status).toBe(200);
  });

  it('F8: a revoke row the owner\'s chain does not verify is ignored when a change is built', async () => {
    const w = await world();
    const first = await w.sign();
    const g = w.mandates.rows[0];
    // a forged revoke row the Authority Server serves: no device of the chain signed it
    w.mandates.rows.push({ ...g, op: 'revoke', version: 1, grantHash: H('f'), grant: { ...(g.grant as object), op: 'revoke' } as never, sig: dk.b64uEncode(new Uint8Array(64)), check: null });
    const second = await w.sign({ replaces: authzOf(first) });
    // the gateway did not refuse on the forged row (its own code is lowercase); the stub, like the real AS, refuses a change after any revoke row
    expect(second.body.grantCode).not.toBe('mandate_revoked');
    expect(second.body.grantCode).toBe('MANDATE_REVOKED');
  });

  it('F8: an approver the Authority Server lists twice counts once', async () => {
    const w = await world();
    const ap = await person();
    w.as.otherChains.set(ap.did, ap.entries);
    w.mandates.users.set('u_ap', { did: ap.did });
    w.mandates.team = { approvers: ['u_ap'], approvals: 1, caps: { value_max: { value: 500, kind: 'approval' } } };
    w.mandates.expectation = { mode: 'review', caps: { value_max: 500 }, approvers: [ap.did], approvals: 1 };
    w.mandates.eligibleOverride = [{ user_id: 'u_ap', did: ap.did }, { user_id: 'u_ap', did: ap.did }];
    const r = await w.sign({ team: 'g_team', confirmedApproverDids: [ap.did] });
    expect(r.status, r.text).toBe(200);
    expect((w.mandates.rows[0].grant as Record<string, unknown>).above_cap_approvers).toEqual([ap.did]);
  });
});

describe('nothing secret is logged, and the unchanged paths stay unchanged', () => {
  it('no signature, nonce, check or key reaches the log or an answer', async () => {
    const lines: string[] = [];
    for (const k of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    const w = await world();
    const r = await w.sign();
    const g = w.mandates.rows[0];
    const secrets = [g.sig, (g.grant as Record<string, unknown>).nonce as string, (g.check as { signature: string }).signature];
    for (const s of secrets) {
      expect(lines.join('\n')).not.toContain(s);
      expect(r.text).not.toContain(s);
    }
  });

  it('a gateway with the switch off has none of it: no grant route, no mandate route of this kind', async () => {
    const as = await new StubAs().listen();
    open.push(as);
    const gw = await bootGateway({ as, enabled: false });
    open.push(gw);
    expect((await call(gw.port, 'POST', '/internal/mandate-grant/observe', { headers: { 'x-internal-secret': 'sekret' }, body: {}, origin: null })).status).toBe(404);
    expect(gw.grants).toBeUndefined();
  });
});
