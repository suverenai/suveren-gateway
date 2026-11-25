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
import { eventBus } from '../../lib/event-bus';
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
import { TeamTrustStore } from '../../lib/team-trust-store';
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
  const h = new PlatformHelper({ platform: 'darwin',  locate: () => ({ spec: { command: process.execPath, args: [FAKE], env: { ...process.env, ...env }, files: [] } }), idleMs: 30, touchTimeoutMs: 20_000 });
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
  const readsState: { held: Array<Record<string, unknown>>; signed: (id: string) => Promise<unknown> } = { held: [], signed: async () => ({ refusal: 'none', code: 'MANDATE_NOT_ACTIVE' }) };
  const as = await new StubAs().listen();
  open.push(as);
  const props = new StubProposals(as);   // first: StubMandates chains in front of it
  const mandates = new StubMandates(as, SALES);
  props.issuedMandates = id => mandates.issued.some(i => decodeMandateBlob(i.blob).payload.mandate_id === id);
  const delivered: unknown[] = [];
  const flags = { failDelivery: false };
  const helperEnv: Record<string, string> = {};
  const helper = fakeHost(helperEnv);
  const gw: GatewayRig = await bootGateway({ as, platform: helper, mandate: { deliver: async a => { if (flags.failDelivery) throw new Error('mcp down'); delivered.push(a); }, reads: { heldBack: async () => readsState.held as never, signedMandate: id => readsState.signed(id) as never } }, decision: { facts: async () => ({ mandateId: props.mandateId, actionType: props.actionType }) } });
  open.push(gw);
  const session = await gw.unlock();
  const h = sessionHeaders(session);
  const post = (path: string, body: unknown = {}) => call(gw.port, 'POST', path, { headers: h, body });
  const start = await post('/auth/device/setup/start', o.checkKey === false ? {} : { checkKey: true });
  expect(start.status).toBe(200);
  const fin = await post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: as.issueEnrolmentCode() });
  expect(fin.status).toBe(200);
  mandates.users.set('u1', { did: String(start.body.rootDid) });
  // The page prepares first and echoes the plan's hash with the give (the gateway refuses a give that differs from what was prepared).
  const sign = async (body: Record<string, unknown> = {}) => {
    const req = { ...REQ, ...body };
    const p = await post('/api/mandate/prepare', req);
    if (p.status !== 200) return p;
    return post('/api/mandate/sign', { planHash: p.body.planHash, ...req });
  };
  const internal = (path: string, body: unknown) => call(gw.port, 'POST', path, { headers: { 'x-internal-secret': 'sekret' }, body, origin: null });
  const spy = vi.spyOn(PlatformChecks.prototype, 'sign');
  /** From now on the helper behaves like this (set-up needed its own good touch first). */
  const helperNow = (env: Record<string, string>): void => { Object.assign(helperEnv, env); helper.close(); };
  return { as, props, flags, readsState, mandates, gw, h, post, sign, internal, delivered, helperNow, rootDid: String(start.body.rootDid), recoveryCode: String(start.body.recoveryCode), keyId: String(start.body.deviceKeyId), touches: spy };
}
type W = Awaited<ReturnType<typeof world>>;

/**
 * The team's member list as this gateway VERIFIED it (DEC-73): who counts as a colleague is no longer a per-computer confirmation. Here the
 * verified state is written into the sealed slot the way a successful verification does it (the verification itself, with real chains and
 * real signed lists, is in lib/__tests__/team-trust.test.ts); a fresh state means no fetch is made.
 */
function listTeam(w: W, others: Array<{ did: string }>, version = 1): void {
  new TeamTrustStore(w.gw.vault).accept('g_team', {
    adminDid: w.rootDid, version, hash: `sha256:${String(version).repeat(64).slice(0, 64)}`,
    members: [{ did: w.rootDid, name: 'The admin' }, ...others.map((o, i) => ({ did: o.did, name: `Colleague ${i + 1}` }))],
    verifiedAt: Math.floor(Date.now() / 1000),
  });
}

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
    expect(JSON.stringify(body)).not.toMatch(/quotes wait|"scope"|"intent"/);   // (random base64 may contain any three letters: the words, not a code)
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

  it('the page is told each step of the give, in order, with the stage word only (never a silent wait); a cancelled touch tells nothing', async () => {
    const w = await world();
    const seen: unknown[] = [];
    const off = eventBus.subscribe(e => { if (e.type === 'give-progress') seen.push(e.payload); });
    try {
      const r = await w.sign();
      expect(r.status, r.text).toBe(200);
      expect(seen).toEqual([{ stage: 'touched' }, { stage: 'requesting' }, { stage: 'delivering' }]);
      seen.length = 0;
      w.helperNow({ FAKE_TOUCH: 'cancel' });
      expect((await w.sign()).status).toBe(422);
      expect(seen).toEqual([]);
    } finally { off(); }
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

  async function team(w: W, opts: { approvers?: string[]; listed?: boolean } = {}) {
    const ap = await person();
    const ap2 = await person();
    w.as.otherChains.set(ap.did, ap.entries);
    w.as.otherChains.set(ap2.did, ap2.entries);
    w.mandates.users.set('u_ap', { did: ap.did });
    w.mandates.users.set('u_ap2', { did: ap2.did });
    w.mandates.team = { approvers: opts.approvers ?? ['u_ap', 'u_ap2'], approvals: 2, caps: CAPS };
    const dids = (opts.approvers ?? ['u_ap', 'u_ap2']).map(u => w.mandates.users.get(u)!.did);
    w.mandates.expectation = { mode: 'review', caps: { value_max: 500 }, approvers: [...dids].sort(), approvals: 2 };
    if (opts.listed !== false) listTeam(w, [ap, ap2]);
    return { ap, ap2, dids };
  }

  it('the team\'s approvers (DIDs), caps and count are in the grant; an approver outside the verified member list is refused, and no code is asked', async () => {
    const w = await world();
    const t = await team(w, { listed: false });
    // no verified list: no colleague is named (the stand-in Authority Server serves none)
    const first = await w.sign({ team: 'g_team' });
    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({ code: 'grant_refused', grantCode: 'team_list_unavailable' });
    expect((first.body.approvers as Array<{ did: string; identityCode: string }>).map(a => a.did).sort()).toEqual([...t.dids].sort());
    expect(w.touches).not.toHaveBeenCalled();
    expect(w.mandates.posts).toEqual([]);
    // a verified list that lacks one of them: refused for that approver
    listTeam(w, [t.ap]);
    const partial = await w.sign({ team: 'g_team' });
    expect(partial.body).toMatchObject({ grantCode: 'approver_not_in_team_list' });
    expect((partial.body.approvers as Array<{ did: string }>).map(a => a.did)).toEqual([t.ap2.did]);
    expect(w.touches).not.toHaveBeenCalled();
    // both listed: granted with one touch, nothing compared, nothing typed
    listTeam(w, [t.ap, t.ap2], 2);
    const r = await w.sign({ team: 'g_team' });
    expect(r.status, r.text).toBe(200);
    expect(w.touches).toHaveBeenCalledTimes(1);
    const grant = w.mandates.rows[0].grant as Record<string, unknown>;
    expect(grant).toMatchObject({ commitment_mode: 'review', above_cap_caps: { value_max: 500 }, above_cap_approvers: [...t.dids].sort(), above_cap_approvals: 2, group_id: 'g_team' });
    expect(grant.chain_dids).toEqual([w.rootDid, ...t.dids].sort());
    // a legacy per-computer confirmation changes nothing
    new MandateGrantStore(w.gw.vault).confirmApprovers([t.ap.did, t.ap2.did]);
    listTeam(w, [t.ap], 3);
    expect((await w.sign({ team: 'g_team' })).body).toMatchObject({ grantCode: 'approver_not_in_team_list' });
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
    expect(r.body).toMatchObject({ code: 'grant_refused', grantCode: 'approver_has_no_chain', approverIds: ['u_ap2'] });
    // and an approver whose DID it names but whose chain it does not serve
    w.mandates.users.get('u_ap2')!.chain = true;
    w.as.otherChains.delete(t.ap2.did);
    const r2 = await w.sign({ team: 'g_team', confirmedApproverDids: t.dids });
    expect(r2.body).toMatchObject({ grantCode: 'approver_has_no_chain', approverIds: ['u_ap2'] });
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

  it('the account DID for the MCP server\'s "does the Authority Server know a chain" question: the secret is needed; a session the control plane does not hold, or a Bearer device session with no known user, says `signedIn: false` (the caller asks about the mandates\' owners instead)', async () => {
    const w = await world();
    const ask = (secret: string | null) => call(w.gw.port, 'GET', '/internal/mandate-grant/account-did', { headers: secret ? { 'x-internal-secret': secret } : {}, origin: null });
    expect((await ask(null)).status).toBe(401);
    expect((await ask('wrong')).status).toBe(401);
    const user = w.gw.vault.getSessionUser();
    const r = await ask('sekret');
    if (user) expect(r.body).toEqual({ did: user.did });
    else expect(r.body).toEqual({ signedIn: false });   // device session, no API-key sign-in answer: not "no chain", simply unknown
  });

  it('only this person, or a member of the team\'s VERIFIED list, is an owner: a code compared on this computer no longer makes a colleague', async () => {
    const w = await world();
    const other = await person();
    const listed = await person();
    const known = (did: string) => w.internal('/internal/mandate-grant/owner-known', { did }).then(r => r.body.known);
    expect(await known(w.rootDid)).toBe(true);
    expect(await known(other.did)).toBe(false);
    // the legacy page route still answers, and compares the code, but it makes nobody a colleague
    const wrong = await w.post('/api/mandate/confirm-identity', { did: other.did, code: '000000000000000000000000' });
    expect(wrong.body).toMatchObject({ grantCode: 'identity_code_mismatch' });
    const code = await dk.identityCode(other.did);
    expect((await w.post('/api/mandate/confirm-identity', { did: other.did, code })).status).toBe(200);
    expect(await known(other.did)).toBe(false);
    // the verified list does
    listTeam(w, [listed]);
    expect(await known(listed.did)).toBe(true);
    expect(await known(other.did)).toBe(false);
    // a person with no verified list at all honours no colleague
    new TeamTrustStore(w.gw.vault).warn('g_team', 'team_list_rollback', Math.floor(Date.now() / 1000));
    expect(await known(listed.did)).toBe(false);
    expect(await known(w.rootDid)).toBe(true);
  });

  it('one mechanism (maintainer 2026-11-20): with a chain, the AI path never creates a mandate; the person gives it on the page. A dry run still answers, with no touch', async () => {
    const w = await world();
    const request = { profile: 'sales', limits: LIMITS, scope: { currency: 'EUR' }, intent: 'Why: quotes wait two days.', mode: 'review', durationHours: 1, title: 'Quotes', team: 'personal' };
    const dry = await w.internal('/internal/mandate', { dryRun: true, request });
    expect(dry.status, dry.text).toBe(200);
    for (const extra of [{}, { approvalHash: `sha256:${'a'.repeat(64)}` }]) {
      const r = await w.internal('/internal/mandate', { request: { ...request, ...extra } });
      expect([r.status, r.body.code], r.text).toEqual([403, 'give_on_page']);
    }
    expect(w.touches).not.toHaveBeenCalled();
    expect(w.mandates.rows).toEqual([]);
    // the give page (what the card's "Give this mandate" opens) creates it: the same request, with the touch
    const given = await w.sign();
    expect(w.touches).toHaveBeenCalledTimes(1);
    expect(w.mandates.rows).toHaveLength(1);
    void given;
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

  it('F4: a legacy confirmation can still be withdrawn (page session only); it was never what made a colleague', async () => {
    const w = await world();
    const other = await person();
    await w.post('/api/mandate/confirm-identity', { did: other.did, code: await dk.identityCode(other.did) });
    expect(new MandateGrantStore(w.gw.vault).approverConfirmed(other.did)).toBe(true);
    expect((await w.post('/api/mandate/forget-identity', { did: other.did })).status).toBe(200);
    expect(new MandateGrantStore(w.gw.vault).approverConfirmed(other.did)).toBe(false);
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
    listTeam(w, [ap]);
    const r = await w.sign({ team: 'g_team' });
    expect(r.status, r.text).toBe(200);
    expect((w.mandates.rows[0].grant as Record<string, unknown>).above_cap_approvers).toEqual([ap.did]);
  });
});

describe('review round 3', () => {
  const H = (c: string) => `sha256:${c.repeat(64)}`;

  it('a failure to ASK (the Authority Server not answering, a session problem) is a 502 with no code, so the MCP server keeps what it honoured; a real refusal is a 4xx with its code', async () => {
    const w = await world();
    const first = await w.sign();
    const g = w.mandates.rows[0];
    const obs = () => w.internal('/internal/mandate-grant/observe', { mandateId: g.mandateId, version: 1, grantHash: g.grantHash, op: 'grant' });
    expect((await obs()).status).toBe(200);
    w.as.failChainGets = 5;                                   // the chain cannot be fetched: as_answer_invalid
    const blip = await obs();
    expect([blip.status, blip.body.code]).toEqual([502, undefined]);
    const pin = await w.internal('/internal/device-pin/advance', { did: (await person()).did });
    expect(pin.status).toBeGreaterThanOrEqual(400);
    w.as.failChainGets = 0;
    w.helperNow({});                                          // (no effect on the answers below)
    const refused = await w.internal('/internal/mandate-grant/observe', { mandateId: g.mandateId, version: 1, grantHash: H('9'), op: 'grant' });
    expect([refused.status, refused.body.code]).toEqual([403, 'grant_not_held']);
    void first;
    // the Authority Server's TLS pin not matching, a locked vault: the same, no code
    w.gw.vault.lockExpired();
    expect((await obs()).status).toBeGreaterThanOrEqual(423);
  });

  it('chain-seen is set only by a gateway that has a chain', async () => {
    const as = await new StubAs().listen();
    open.push(as);
    const gw = await bootGateway({ as, platform: fakeHost() });
    open.push(gw);
    const h = sessionHeaders(await gw.unlock());
    void h;
    const r = await call(gw.port, 'POST', '/internal/mandate-grant/chain-seen', { headers: { 'x-internal-secret': 'sekret' }, body: {}, origin: null });
    expect([r.status, r.body.code]).toEqual([409, 'not_set_up']);
    expect(new MandateGrantStore(gw.vault).chainSeen()).toBe(false);
  });

});

describe('step 13 screens: held back list, change preview, Touch ID change', () => {
  it('held-back: the gateway\'s verdicts with the profile name and whose mandate, read-only; a gateway without a chain answers 409', async () => {
    const w = await world();
    w.readsState.held = [
      { authorizationId: 'authz_11111111-1111-1111-1111-111111111111', mandateId: 'm1', code: 'mandate_body_not_received', profileId: SALES.id, ownerDid: w.rootDid },
      { authorizationId: 'authz_22222222-2222-2222-2222-222222222222', code: 'owner_unknown', profileId: SALES.id, ownerDid: 'did:key:z6MkSomeoneElse' },
    ];
    const r = await call(w.gw.port, 'GET', '/api/mandate/held-back', { headers: w.h });
    expect(r.status, r.text).toBe(200);
    expect(r.body.held).toEqual([
      expect.objectContaining({ code: 'mandate_body_not_received', ownerIsYou: true, profileName: SALES.name ?? expect.any(String), ownerName: null, adminName: null }),
      expect.objectContaining({ code: 'owner_unknown', ownerIsYou: false }),
    ]);
    expect((await call(w.gw.port, 'GET', '/api/mandate/held-back')).status).toBe(401);
    const as = await new StubAs().listen();
    open.push(as);
    const bare = await bootGateway({ as, platform: fakeHost(), mandate: {} });
    open.push(bare);
    const h2 = sessionHeaders(await bare.unlock());
    expect((await call(bare.port, 'GET', '/api/mandate/held-back', { headers: h2 })).status).toBe(409);
  });

  it('change-preview computes the diff from the signed mandate and signs nothing; the Touch ID change signs the version the person saw, and a different one is refused', async () => {
    const w = await world();
    const first = await w.sign();
    const id = authzOf(first);
    const old = { authorizationId: id, profileId: SALES.id, groupId: 'g_personal', ownerDid: w.rootDid, bounds: { ...LIMITS, profile: SALES.id }, context: { currency: 'EUR' }, intent: REQ.intent, mode: 'review', expiresAt: Math.floor(Date.now() / 1000) + 3000, title: 'Quotes' };
    w.readsState.signed = async () => ({ old, team: { approverDids: [], approvals: null, caps: {} } });
    const changes = { durationHours: 5 };
    const touchesBefore = w.touches.mock.calls.length;
    const prev = await call(w.gw.port, 'GET', `/api/mandate/change-preview?authorizationId=${id}&changes=${encodeURIComponent(JSON.stringify(changes))}`, { headers: w.h });
    expect(prev.status, prev.text).toBe(200);
    expect((prev.body as any).diff.lastsUntil).toBeTruthy();
    expect((prev.body as any).before).toBeNull();
    expect(w.touches.mock.calls.length).toBe(touchesBefore);       // a preview never touches
    // a different change than the one shown is refused and signs nothing
    const other = await w.post('/api/mandate/change', { authorizationId: id, changes: { limits: { value_max: 5 } }, sealedDiff: (prev.body as any).diff });
    expect([other.status, other.body.code]).toEqual([422, 'changed_since_proposal']);
    expect(w.touches.mock.calls.length).toBe(touchesBefore);
    const done = await w.post('/api/mandate/change', { authorizationId: id, changes, sealedDiff: (prev.body as any).diff });
    expect(done.status, done.text).toBe(200);
    expect(w.touches).toHaveBeenCalledTimes(touchesBefore + 1);
    const g = w.mandates.rows.at(-1)!;
    expect([g.op, g.version]).toEqual(['change', 2]);
    // not a mandate of this gateway / bad input
    expect((await call(w.gw.port, 'GET', '/api/mandate/change-preview?authorizationId=nope', { headers: w.h })).status).toBe(400);
  });

  it('with a team: approvers, approval count and team limits before (signed) and after (settings now), labelled from the member list', async () => {
    const w = await world();
    const ap = await person();
    const ap2 = await person();
    w.as.otherChains.set(ap.did, ap.entries);
    w.as.otherChains.set(ap2.did, ap2.entries);
    w.mandates.users.set('u_ap', { did: ap.did });
    w.mandates.users.set('u_ap2', { did: ap2.did });
    w.mandates.team = { approvers: ['u_ap', 'u_ap2'], approvals: 2, caps: { value_max: { value: 500, kind: 'approval' } } };
    const live = await w.sign();   // an active mandate of this gateway to read
    const old = { authorizationId: authzOf(live), profileId: SALES.id, groupId: 'g_team', ownerDid: w.rootDid, bounds: { ...LIMITS, profile: SALES.id }, context: { currency: 'EUR' }, intent: REQ.intent, mode: 'review', expiresAt: Math.floor(Date.now() / 1000) + 3000 };
    w.readsState.signed = async () => ({ old, team: { approverDids: [ap.did], approvals: 1, caps: { value_max: 300 } } });
    const prev = await call(w.gw.port, 'GET', `/api/mandate/change-preview?authorizationId=${old.authorizationId}&changes=${encodeURIComponent(JSON.stringify({ durationHours: 5 }))}`, { headers: w.h });
    // (the stub's member list is not served: labels fall back to the id; the point is the shape and the numbers)
    expect(prev.status, prev.text).toBe(200);
    expect((prev.body as any).before).toMatchObject({ approvals: 1, limits: [expect.objectContaining({ field: 'value_max', value: 300 })] });
    expect((prev.body as any).before.approvers).toHaveLength(1);
    expect((prev.body as any).after).toMatchObject({ approvals: 2, limits: [expect.objectContaining({ field: 'value_max', value: 500 })] });
    expect((prev.body as any).after.approvers.sort()).toEqual(['u_ap', 'u_ap2']);
  });
});

describe('prepare: what a give would grant, before the touch', () => {
  it('shows the checked plan with the profile\'s own labels, touches nothing, writes nothing at the Authority Server or here', async () => {
    const w = await world();
    const before = w.mandates.posts.length;
    const r = await w.post('/api/mandate/prepare', REQ);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ profileId: SALES.id, profileHash: computeProfileHash(SALES), mode: 'review', ttlSeconds: 3600, team: null, blocked: null, intent: REQ.intent });
    expect(r.body.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const value = (r.body.bounds as Array<{ field: string; label: string; value: unknown }>).find(b => b.field === 'value_max')!;
    expect(value).toMatchObject({ value: 1000, label: SALES.boundsSchema.fields.value_max.displayName ?? 'value_max' });
    expect((r.body.bounds as Array<{ field: string }>).some(b => b.field === 'profile')).toBe(false);
    expect(w.touches).not.toHaveBeenCalled();
    expect(w.mandates.posts.length).toBe(before);           // no grant, no body, no mandate request
    expect(w.mandates.rows).toEqual([]);
    // a request the real give would refuse for its content is refused the same way
    const bad = await w.post('/api/mandate/prepare', { ...REQ, limits: { ...LIMITS, bogus_max: 1 } });
    expect(bad.status).toBe(422);
    // not a chain gateway / no session
    expect((await call(w.gw.port, 'POST', '/api/mandate/prepare', { body: REQ })).status).toBe(401);
  });

  it('a team: approvers with DIDs, identity codes and whether the verified member list holds them; one that is not listed blocks, nothing is remembered by asking', async () => {
    const w = await world();
    const ap = await person();
    const ap2 = await person();
    w.as.otherChains.set(ap.did, ap.entries);
    w.as.otherChains.set(ap2.did, ap2.entries);
    w.mandates.users.set('u_ap', { did: ap.did });
    w.mandates.users.set('u_ap2', { did: ap2.did });
    w.mandates.team = { approvers: ['u_ap', 'u_ap2'], approvals: 2, caps: { value_max: { value: 500, kind: 'approval' } } };
    w.mandates.expectation = { mode: 'review', caps: { value_max: 500 }, approvers: [ap.did, ap2.did].sort(), approvals: 2 };
    const store = new MandateGrantStore(w.gw.vault);
    const r = await w.post('/api/mandate/prepare', { ...REQ, team: 'g_team' });
    expect(r.status, r.text).toBe(200);
    expect((r.body as any).team.approvals).toBe(2);
    expect(((r.body as any).team.approvers as Array<{ did: string; confirmed: boolean; identityCode: string }>).map(a => [a.did, a.confirmed]).sort()).toEqual([[ap.did, false], [ap2.did, false]].sort());
    expect((r.body as any).team.caps).toEqual([expect.objectContaining({ field: 'value_max', value: 500 })]);
    expect(r.body).toMatchObject({ blocked: { code: 'team_list_unavailable' } });
    expect((r.body as any).blocked.approvers).toHaveLength(2);
    // a verified list with both: shown as listed, with the names the admin signed, nothing blocks
    listTeam(w, [ap, ap2]);
    const again = await w.post('/api/mandate/prepare', { ...REQ, team: 'g_team' });
    expect(again.body.blocked).toBeNull();
    expect(((again.body as any).team.approvers as Array<{ did: string; confirmed: boolean; name?: string }>).map(a => [a.did, a.confirmed, a.name]).sort()).toEqual([[ap.did, true, 'Colleague 1'], [ap2.did, true, 'Colleague 2']].sort());
    expect(store.approverConfirmed(ap.did)).toBe(false);
    expect(w.touches).not.toHaveBeenCalled();
    // the plan hash does not depend on who was listed
    expect(again.body.planHash).toBe(r.body.planHash);
  });

  it('the give is bound to what was prepared: no hash, another hash, or a request that differs refuses with nothing signed', async () => {
    const w = await world();
    const p = await w.post('/api/mandate/prepare', REQ);
    const hash = p.body.planHash as string;
    const none = await w.post('/api/mandate/sign', REQ);
    expect([none.status, none.body.code]).toEqual([422, 'prepare_required']);
    const wrong = await w.post('/api/mandate/sign', { ...REQ, planHash: `sha256:${'a'.repeat(64)}` });
    expect([wrong.status, wrong.body.code]).toEqual([422, 'changed_since_prepare']);
    for (const change of [{ limits: { ...LIMITS, value_max: 5000 } }, { intent: 'another why' }, { ttlSeconds: 7200 }, { scope: { currency: 'USD' } }, { mode: 'automatic' }]) {
      const r = await w.post('/api/mandate/sign', { ...REQ, ...change, planHash: hash });
      expect([r.status, r.body.code], JSON.stringify(change)).toEqual([422, 'changed_since_prepare']);
    }
    expect(w.touches).not.toHaveBeenCalled();
    expect(w.mandates.rows).toEqual([]);
    // the request that was prepared is given
    const ok = await w.post('/api/mandate/sign', { ...REQ, planHash: hash });
    expect(ok.status, ok.text).toBe(200);
    expect(w.touches).toHaveBeenCalledTimes(1);
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
