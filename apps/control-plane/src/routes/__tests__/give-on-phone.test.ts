/**
 * Give on the phone (device-keys plan 4.4 "Transport", DEC-86): a computer WITHOUT a check key prepares the give, seals it to the person's
 * devices, and requests the mandate only once the phone's grant is stored and carries exactly the members planned here.
 *
 * Real: the routers (`/api/mandate/*`), the ceremony, the vault, the chain store, hap-core's builder and verifier, the content sealing.
 * Stood in: the Authority Server's network (StubAs + StubMandates, which verify every chain entry and every grant with hap-core) and the
 * phone itself (this file opens the sealed request with the phone's own reading key and signs the grant with the phone's key and a
 * WebAuthn assertion the way the app does; the app's own code is tested in apps/approve).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto, randomBytes as nodeRandom } from 'node:crypto';
import * as dk from '@hap/core/device-keys';
import { buildMandateProjection, decryptProposalContent, computeBoundsHash, computeScopeHash, computeIntentHash, computeProfileHash, computeExecutionContextHash, decodeMandateBlob, type MandatePayload } from '@hap/core';
import { createGrantMembers } from '@hap/core/mandate-grant';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { StubMandates } from '../../__tests__/helpers/stub-as-mandates';
import { bootGateway, call, sessionHeaders, type GatewayRig } from '../../__tests__/helpers/device-rig';
import { generateKeyPair } from '../../lib/e2e-crypto';
import { asAuthHeaders } from '../../lib/as-credential';

const profilesDir = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'hap-profiles');
const SALES = JSON.parse(readFileSync(join(profilesDir, 'sales', '0.4.profile.json'), 'utf8'));
const LIMITS = { read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 0, setup_daily_max: 0 };
const REQ = { profile: 'sales', limits: LIMITS, scope: { currency: 'EUR' }, intent: 'Why: quotes wait two days.', mode: 'review', ttlSeconds: 3600, title: 'Quotes', team: 'personal' };
const RP = 'approve.test';
const { grantMembersOf } = createGrantMembers(buildMandateProjection);

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const o of open.splice(0).reverse()) await o.close(); });

/** The phone: its device key, its reading key, its passkey (P-256), and a WebAuthn assertion over one object hash as a real one is made. */
async function makePhone() {
  const seed = new Uint8Array(nodeRandom(32));
  const signPub = await dk.ed25519PublicKey(seed);
  const read = await generateKeyPair();
  const pk = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pk.publicKey));
  const credId = dk.b64uEncode(new Uint8Array(nodeRandom(16)));
  const record = await dk.buildDeviceRecord({
    sign_pub: dk.b64uEncode(signPub), read_pub: dk.b64uEncode(read.publicKey), kind: 'approve-app', label: 'My iPhone', keystore: 'platform',
    check: { type: 'webauthn', rp_id: RP, cred_id: credId, pub: dk.b64uEncode(dk.encodeCoseEc2(raw.slice(1, 33), raw.slice(33, 65))) },
  } as never, signPub);
  const prove = async (objectHashText: string) => {
    const authData = dk.concat(await dk.sha256(dk.utf8(RP)), Uint8Array.of(0x05), Uint8Array.of(0, 0, 0, 1));
    const clientData = dk.utf8(JSON.stringify({ type: 'webauthn.get', challenge: dk.b64uEncode(dk.hashBytes(objectHashText)), origin: `https://${RP}` }));
    const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pk.privateKey, dk.concat(authData, await dk.sha256(clientData))));
    return { authenticatorData: dk.b64uEncode(authData), clientDataJSON: dk.b64uEncode(clientData), signature: dk.b64uEncode(dk.ecdsaRawToDer(sig)) };
  };
  return { seed, record, read, prove };
}
type Phone = Awaited<ReturnType<typeof makePhone>>;

async function world() {
  const as = await new StubAs().listen();
  open.push(as);
  const mandates = new StubMandates(as, SALES);
  const delivered: unknown[] = [];
  /** This computer's copy of a held mandate (the MCP server's, in production): what a change shows as the previous version. */
  const held = new Map<string, Record<string, unknown>>();
  const reads = { heldBack: async () => [] as never, signedMandate: async (id: string) => (held.has(id) ? { old: held.get(id), team: { approverDids: [], approvals: null, caps: {} } } : { refusal: 'none', code: 'MANDATE_NOT_ACTIVE' }) as never };
  // No native helper: this computer has no check key, so it cannot give a mandate itself.
  const gw: GatewayRig = await bootGateway({ as, mandate: { deliver: async a => { delivered.push(a); }, reads } });
  open.push(gw);
  const h = sessionHeaders(await gw.unlock());
  const post = (path: string, body: unknown = {}) => call(gw.port, 'POST', path, { headers: h, body });
  const get = (path: string) => call(gw.port, 'GET', path, { headers: h });
  const start = await post('/auth/device/setup/start', {});
  expect(start.status, start.text).toBe(200);
  const fin = await post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: as.issueEnrolmentCode() });
  expect(fin.status, fin.text).toBe(200);
  const rootDid = String(start.body.rootDid);
  mandates.users.set('u1', { did: rootDid });
  const root = await dk.rootKeyFromRecoveryCode(String(start.body.recoveryCode));
  /** Admit the phone (no granting device yet: the root key admits it, plan 3.2 rule 3). */
  const addPhone = async (phone: Phone) => {
    const entries = as.chainEntries() as dk.ChainEntry[];
    const state = await dk.verifyChain({ expectedRootDid: rootDid, entries });
    const e = dk.buildEntry({ root_did: rootDid, seq: state.head.seq + 1, prev: state.head.hash, op: 'add', created_at: Math.floor(Date.now() / 1000), signer: 'root', device: phone.record });
    const hash = await dk.entryHash(e);
    e.sigs = [await dk.signEntry(e, 'root', root.privateSeed), await dk.signEntry(e, phone.record.key_id, phone.seed)];
    e.checks = [{ by: phone.record.key_id, check: await phone.prove(hash) }];
    await as.appendEntry(e);
  };
  const asPost = async (path: string, body: unknown) => {
    const r = await fetch(`${as.url}${path}`, { method: 'POST', headers: { ...asAuthHeaders(gw.vault.getSpCookie()!), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
  };
  /** Stop this gateway and start it again on the same folder (a restart), signed in again; `post`/`get` then go to the new one. */
  const restart = async () => {
    await gw.close();
    const again = await bootGateway({ as, dir: gw.dir, fresh: false, mandate: { deliver: async a => { delivered.push(a); }, reads: { heldBack: async () => [] as never, signedMandate: async () => ({ refusal: 'none', code: 'MANDATE_NOT_ACTIVE' }) as never } } });
    open.push(again);
    const h2 = sessionHeaders(await again.unlock());
    // after unlock the gateway signs in again by its device key, in the background (as in device-signin.test.ts)
    for (let i = 0; i < 200 && again.vault.getSpCookie() === null; i++) await new Promise(res => setTimeout(res, 20));
    expect(again.vault.getSpCookie(), 'signed in again after the restart').not.toBeNull();
    return {
      gw: again,
      post: (path: string, body: unknown = {}) => call(again.port, 'POST', path, { headers: h2, body }),
      get: (path: string) => call(again.port, 'GET', path, { headers: h2 }),
    };
  };
  const del = (path: string) => call(gw.port, 'DELETE', path, { headers: h });
  return { as, mandates, gw, post, get, del, rootDid, addPhone, asPost, delivered, restart, held };
}
type W = Awaited<ReturnType<typeof world>>;

/** What the phone does with the sealed request: open it with its own key, recompute every hash from the plaintext, rebuild the members, sign. */
async function phoneOpens(w: W, phone: Phone) {
  const body = w.mandates.bodies.at(-1)!;
  const wrap = body.deviceKeys[phone.record.key_id];
  expect(wrap, 'the request is sealed to the phone too').toBeDefined();
  const opened = await decryptProposalContent({ ciphertext: body.ciphertext, encrypted_keys: { [phone.record.key_id]: wrap }, readers: [phone.record.key_id], unreadable: [] }, phone.record.key_id, phone.read.privateKey);
  const c = opened.arguments as Record<string, any>;
  return { body, c };
}

async function phoneSigns(w: W, phone: Phone, c: Record<string, any>, tamper?: (members: Record<string, unknown>) => void) {
  const g = c.give;
  const payload = g.payload as MandatePayload;
  const members = grantMembersOf(payload, { authorizationId: g.place.authorization_id, groupId: g.place.group_id, replaces: g.place.replaces, chainDids: g.place.chain_dids });
  tamper?.(members);
  const state = await dk.verifyChain({ expectedRootDid: w.rootDid, entries: w.as.chainEntries() });
  const grant = dk.buildGrant({
    op: g.op, owner_did: w.rootDid, key_id: phone.record.key_id, chain_seq: state.head.seq, chain_head: state.head.hash,
    mandate_id: c.mandate_id, mandate_version: c.mandate_version, granted_at: Math.floor(Date.now() / 1000), nonce: dk.b64uEncode(new Uint8Array(nodeRandom(16))),
  }, members);
  const sig = await dk.signObject(grant, phone.seed);
  const check = await phone.prove(await dk.objectHash(grant));
  return w.asPost(`/api/mandates/${encodeURIComponent(c.mandate_id)}/grants`, { grant, sig, check });
}

async function prepareAndSend(w: W) {
  const p = await w.post('/api/mandate/prepare', REQ);
  expect(p.status, p.text).toBe(200);
  return { prepared: p, sent: await w.post('/api/mandate/give-on-phone', { planHash: p.body.planHash, ...REQ }) };
}

describe('give on the phone', () => {
  it('a computer without a check key and no phone cannot give, and is not offered the phone', async () => {
    const w = await world();
    const p = await w.post('/api/mandate/prepare', REQ);
    expect(p.status, p.text).toBe(200);
    expect(p.body.blocked).toMatchObject({ code: 'no_check_key' });
    expect(p.body.onPhone).toBe(false);
    const r = await w.post('/api/mandate/give-on-phone', { planHash: p.body.planHash, ...REQ });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'grant_refused' });
    expect(w.mandates.bodies).toHaveLength(0);
  });

  it('with a phone: the request is sealed to every device, nothing is requested until the phone gives it, then the mandate is issued', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const { prepared, sent } = await prepareAndSend(w);
    expect(prepared.body.onPhone).toBe(true);
    expect(sent.status, sent.text).toBe(200);
    const mandateId = String(sent.body.mandateId);
    // nothing granted, nothing requested yet
    expect(w.mandates.rows).toHaveLength(0);
    expect(w.mandates.issued).toHaveLength(0);
    expect((await w.get(`/api/mandate/give-on-phone/${mandateId}`)).body).toEqual({ state: 'waiting' });

    // the phone opens it: every hash it signs comes from the plaintext it shows
    const { c } = await phoneOpens(w, phone);
    expect(c.v).toBe(2);
    expect(c.scope).toEqual(REQ.scope);
    expect(c.intent).toBe(REQ.intent);
    const pl = c.give.payload;
    expect(computeProfileHash(c.give.profile)).toBe(pl.profile_hash);
    expect(computeBoundsHash(c.give.bounds, c.give.profile)).toBe(pl.bounds_hash);
    expect(computeScopeHash(c.scope, c.give.profile)).toBe(pl.scope_hash);
    expect(computeIntentHash(c.intent)).toBe(pl.gate_content_hashes.intent);
    expect(computeExecutionContextHash(c.give.profile)).toBe(pl.execution_context_hash);

    const g = await phoneSigns(w, phone, c);
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const done = await w.get(`/api/mandate/give-on-phone/${mandateId}`);
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ state: 'done', authorizationId: expect.stringMatching(/^authz_/) });
    expect(w.mandates.issued).toHaveLength(1);
    expect(decodeMandateBlob(w.mandates.issued[0].blob).payload.mandate_id).toBe(mandateId);
    expect(w.delivered).toHaveLength(1);
    // asked again (the page after the background completion, or the reverse): the same answer, and nothing is requested a second time
    expect((await w.get(`/api/mandate/give-on-phone/${mandateId}`)).body).toEqual({ state: 'done', authorizationId: done.body.authorizationId });
    expect(w.mandates.issued).toHaveLength(1);
  });

  it('a phone grant over other members (a longer expiry) is refused here and the mandate is never requested', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const { sent } = await prepareAndSend(w);
    const { c } = await phoneOpens(w, phone);
    const g = await phoneSigns(w, phone, c, m => { m.expires_at = (m.expires_at as number) + 60; });
    expect(g.status, JSON.stringify(g.body)).toBe(201); // the Authority Server only checks the signature and the check
    const r = await w.get(`/api/mandate/give-on-phone/${String(sent.body.mandateId)}`);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'grant_refused', grantCode: 'grant_invalid' });
    expect(w.mandates.issued).toHaveLength(0);
  });

  it('a refusal found first by the background completion is the answer the page hears too, never "nothing waits" (e2e: the card said Stopped)', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const { sent } = await prepareAndSend(w);
    const { c } = await phoneOpens(w, phone);
    const g = await phoneSigns(w, phone, c, m => { m.expires_at = (m.expires_at as number) + 60; });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    // the background completion (index.ts timer) gets there first and ends the give
    const { completeWaitingGives } = await import('../../lib/mandate-ceremony');
    const refusedSeen: string[] = [];
    await completeWaitingGives({ ...w.gw.ceremony!(), newAuthorizationId: () => 'authz_test' }, () => {}, r => refusedSeen.push(r.mandateId));
    expect(refusedSeen).toEqual([String(sent.body.mandateId)]);
    // the page asks afterwards: the same refusal with its code, not state 'unknown'
    const r = await w.get(`/api/mandate/give-on-phone/${String(sent.body.mandateId)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body).toMatchObject({ code: 'grant_refused', grantCode: 'grant_invalid' });
    expect(w.mandates.issued).toHaveLength(0);
  });

  it('a give that changed since it was prepared is not sent', async () => {
    const w = await world();
    await w.addPhone(await makePhone());
    const p = await w.post('/api/mandate/prepare', REQ);
    const r = await w.post('/api/mandate/give-on-phone', { planHash: p.body.planHash, ...REQ, intent: 'Something else.' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'changed_since_prepare' });
    expect(w.mandates.bodies).toHaveLength(0);
  });

  it('a give waiting on the phone survives a restart of the gateway, sealed in its vault (no plain file holds it)', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const { sent } = await prepareAndSend(w);
    const mandateId = String(sent.body.mandateId);
    const r = await w.restart();
    expect((await r.get(`/api/mandate/give-on-phone/${mandateId}`)).body).toEqual({ state: 'waiting' });
    const { c } = await phoneOpens(w, phone);
    expect((await phoneSigns(w, phone, c)).status).toBe(201);
    const done = await r.get(`/api/mandate/give-on-phone/${mandateId}`);
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ state: 'done' });
    expect(w.mandates.issued).toHaveLength(1);
    // nothing of the request lies in the clear in the gateway's folder
    const { readdirSync, readFileSync: rf, statSync } = await import('node:fs');
    const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const f of walk(r.gw.dir)) expect(rf(f, 'utf8').includes(REQ.intent), f).toBe(false);
  });

  it('a cancelled wait is gone: asked again, nothing waits', async () => {
    const w = await world();
    await w.addPhone(await makePhone());
    const { sent } = await prepareAndSend(w);
    const id = String(sent.body.mandateId);
    expect((await w.get(`/api/mandate/give-on-phone/${id}`)).body).toEqual({ state: 'waiting' });
    const d = await w.del(`/api/mandate/give-on-phone/${id}`);
    expect(d.status, d.text).toBe(200);
    expect(d.body).toEqual({ ok: true });
    expect((await w.get(`/api/mandate/give-on-phone/${id}`)).body).toEqual({ state: 'unknown' });
  });

  it('the sealed request stays the body: the computer opens scope and intent from it after the grant', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const { sent } = await prepareAndSend(w);
    const { c } = await phoneOpens(w, phone);
    await phoneSigns(w, phone, c);
    const row = w.mandates.rows.at(-1)!;
    const body = await w.gw.grants!.openBody({ mandateId: String(sent.body.mandateId), version: 1, grantHash: row.grantHash });
    expect(body).toEqual({ scope: REQ.scope, intent: REQ.intent });
  });

  it('a change sent to the phone carries the version it continues (plaintext from this computer), which the phone checks against that grant', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    // version 1, given on the phone
    const { sent } = await prepareAndSend(w);
    const first = await phoneOpens(w, phone);
    expect((await phoneSigns(w, phone, first.c)).status).toBe(201);
    const done = await w.get(`/api/mandate/give-on-phone/${String(sent.body.mandateId)}`);
    expect(done.body).toMatchObject({ state: 'done' });
    const authz1 = String(done.body.authorizationId);
    const v1 = w.mandates.rows.at(-1)!;
    const v1Grant = (v1 as unknown as { grant: Record<string, unknown> }).grant;
    w.held.set(authz1, { authorizationId: authz1, profileId: SALES.id, groupId: 'personal', ownerDid: w.rootDid, bounds: { profile: SALES.id, ...LIMITS }, context: REQ.scope, intent: REQ.intent, mode: 'review', expiresAt: v1Grant.expires_at });

    // version 2: a higher limit, sent to the phone
    const CHANGE = { ...REQ, limits: { ...LIMITS, value_max: 3000 }, replaces: authz1 };
    const p = await w.post('/api/mandate/prepare', CHANGE);
    expect(p.status, p.text).toBe(200);
    const r = await w.post('/api/mandate/give-on-phone', { planHash: p.body.planHash, ...CHANGE });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ mandateVersion: 2 });
    const { c } = await phoneOpens(w, phone);
    expect(c.give.op).toBe('change');
    expect(c.give.previous).toMatchObject({ mandate_version: 1, intent: REQ.intent, scope: REQ.scope, expires_at: v1Grant.expires_at });
    expect(c.give.previous.bounds.value_max).toBe(1000);
    // what the phone recomputes from those values is what version 1's grant carries
    expect(computeBoundsHash(c.give.previous.bounds, c.give.previous.profile)).toBe(v1Grant.bounds_hash);
    expect(computeScopeHash(c.give.previous.scope, c.give.previous.profile)).toBe(v1Grant.scope_hash);
    expect(computeIntentHash(c.give.previous.intent)).toBe((v1Grant.gate_content_hashes as Record<string, string>).intent);
  });

  it('a change whose previous version this computer cannot read is not sent to the phone', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const { sent } = await prepareAndSend(w);
    const first = await phoneOpens(w, phone);
    await phoneSigns(w, phone, first.c);
    const done = await w.get(`/api/mandate/give-on-phone/${String(sent.body.mandateId)}`);
    const authz1 = String(done.body.authorizationId);
    const before = w.mandates.bodies.length;
    const CHANGE = { ...REQ, limits: { ...LIMITS, value_max: 3000 }, replaces: authz1 };
    const p = await w.post('/api/mandate/prepare', CHANGE);
    const r = await w.post('/api/mandate/give-on-phone', { planHash: p.body.planHash, ...CHANGE });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'grant_refused', grantCode: 'previous_unknown' });
    expect(w.mandates.bodies).toHaveLength(before);
  });

  it('an extension on the phone (DEC-90): only the end moves, under the same authorization; requested as a renewal once the phone gives it', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const { sent } = await prepareAndSend(w);
    const first = await phoneOpens(w, phone);
    expect((await phoneSigns(w, phone, first.c)).status).toBe(201);
    const done = await w.get(`/api/mandate/give-on-phone/${String(sent.body.mandateId)}`);
    const authz1 = String(done.body.authorizationId);
    const v1Grant = (w.mandates.rows.at(-1)! as unknown as { grant: Record<string, unknown> }).grant;
    const groupId = String(first.c.give.place.group_id);
    w.held.set(authz1, { authorizationId: authz1, profileId: SALES.id, groupId, ownerDid: w.rootDid, bounds: { profile: SALES.id, ...LIMITS }, context: REQ.scope, intent: REQ.intent, mode: 'review', expiresAt: v1Grant.expires_at });

    const RENEW = { authorizationId: authz1, profileId: SALES.id, groupId, bounds: { profile: SALES.id, ...LIMITS }, context: REQ.scope, intent: REQ.intent, mode: 'review', domain: 'sales', ttlSeconds: 7 * 86400 };
    const r = await w.post('/api/mandate/renew-on-phone', RENEW);
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ mandateVersion: 2 });
    const issuedBefore = w.mandates.issued.length;
    const { c } = await phoneOpens(w, phone);
    expect(c.give).toMatchObject({ op: 'change', renewal: true });
    expect(c.give.place.authorization_id).toBe(authz1);
    expect(c.give.previous).toMatchObject({ mandate_version: 1, expires_at: v1Grant.expires_at });
    expect(c.give.payload.bounds_hash).toBe(v1Grant.bounds_hash);
    expect(c.give.payload.expires_at).toBeGreaterThan(v1Grant.expires_at as number);
    expect(w.mandates.issued.length).toBe(issuedBefore);
    expect((await phoneSigns(w, phone, c)).status).toBe(201);
    const fin = await w.get(`/api/mandate/give-on-phone/${String(r.body.mandateId)}`);
    expect(fin.body).toMatchObject({ state: 'done', authorizationId: authz1 });
    expect(w.mandates.posts.at(-1)!.body).toMatchObject({ authorization_id: authz1, renew: true });
  });

  it('an extension whose previous version this computer cannot read is not sent to the phone', async () => {
    const w = await world();
    await w.addPhone(await makePhone());
    const r = await w.post('/api/mandate/renew-on-phone', { authorizationId: 'authz_00000000-0000-4000-8000-0000000000aa', profileId: SALES.id, groupId: 'personal', bounds: { profile: SALES.id, ...LIMITS }, context: REQ.scope, intent: REQ.intent, mode: 'review', domain: 'sales', ttlSeconds: 3600 });
    expect(r.status).toBe(422);
    expect(w.mandates.bodies).toHaveLength(0);
  });

  it('the Change screen (and Extend) on a computer without Touch ID: the change it showed goes to the phone, a different one is refused', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const { sent } = await prepareAndSend(w);
    const first = await phoneOpens(w, phone);
    expect((await phoneSigns(w, phone, first.c)).status).toBe(201);
    const authz1 = String((await w.get(`/api/mandate/give-on-phone/${String(sent.body.mandateId)}`)).body.authorizationId);
    const v1Grant = (w.mandates.rows.at(-1)! as unknown as { grant: Record<string, unknown> }).grant;
    w.held.set(authz1, { authorizationId: authz1, profileId: SALES.id, groupId: String(first.c.give.place.group_id), ownerDid: w.rootDid, bounds: { profile: SALES.id, ...LIMITS }, context: REQ.scope, intent: REQ.intent, mode: 'review', expiresAt: v1Grant.expires_at, title: 'Quotes' });
    const changes = { durationHours: 5 };
    const prev = await w.get(`/api/mandate/change-preview?authorizationId=${authz1}&changes=${encodeURIComponent(JSON.stringify(changes))}`);
    expect(prev.status, prev.text).toBe(200);
    // this computer cannot sign it itself
    const here = await w.post('/api/mandate/change', { authorizationId: authz1, changes, sealedDiff: prev.body.diff });
    expect(here.body).toMatchObject({ grantCode: 'no_check_key' });
    // a different change than the one shown is not sent
    const other = await w.post('/api/mandate/change-on-phone', { authorizationId: authz1, changes: { limits: { value_max: 5 } }, sealedDiff: prev.body.diff });
    expect([other.status, other.body.code]).toEqual([422, 'changed_since_proposal']);
    const bodies = w.mandates.bodies.length;
    const r = await w.post('/api/mandate/change-on-phone', { authorizationId: authz1, changes, sealedDiff: prev.body.diff });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ mandateVersion: 2 });
    expect(w.mandates.bodies.length).toBe(bodies + 1);
    const { c } = await phoneOpens(w, phone);
    expect(c.give.op).toBe('change');
    expect(c.give.previous).toMatchObject({ mandate_version: 1, expires_at: v1Grant.expires_at });
    expect((await phoneSigns(w, phone, c)).status).toBe(201);
    expect((await w.get(`/api/mandate/give-on-phone/${String(r.body.mandateId)}`)).body).toMatchObject({ state: 'done' });
  });

  it('a give for an AI proposal carries its id to the phone, and asked again for that proposal the waiting give is the answer (one give per proposal)', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const p = await w.post('/api/mandate/prepare', REQ);
    expect(p.status, p.text).toBe(200);
    const first = await w.post('/api/mandate/give-on-phone', { planHash: p.body.planHash, ...REQ, fromProposal: 'prop_offer_0001' });
    expect(first.status, first.text).toBe(200);
    const { c } = await phoneOpens(w, phone);
    expect(c.give.proposal_id).toBe('prop_offer_0001');
    const again = await w.post('/api/mandate/give-on-phone', { planHash: p.body.planHash, ...REQ, fromProposal: 'prop_offer_0001' });
    expect(again.status, again.text).toBe(200);
    expect(again.body.mandateId).toBe(first.body.mandateId);
    expect(w.mandates.bodies, 'nothing prepared a second time').toHaveLength(1);
    // a give without a proposal (the person's own, from the give page) carries no id
    const own = await w.post('/api/mandate/give-on-phone', { planHash: p.body.planHash, ...REQ });
    expect(own.status, own.text).toBe(200);
    expect(own.body.mandateId).not.toBe(first.body.mandateId);
    const { c: c2 } = await phoneOpens(w, phone);
    expect(c2.give.proposal_id).toBeUndefined();
  });

  it('the AI path offers its proposal to the phone (POST /internal/mandate/offer): only with the internal secret, never without a proposal id', async () => {
    const w = await world();
    await w.addPhone(await makePhone());
    const no = await call(w.gw.port, 'POST', '/internal/mandate/offer', { body: { proposalId: 'prop_offer_0002', tool: 'create', args: {} } });
    expect(no.status).toBe(401);
    const bad = await call(w.gw.port, 'POST', '/internal/mandate/offer', { headers: { 'X-Internal-Secret': 'sekret' }, body: { tool: 'create', args: {} } });
    expect(bad.status).toBe(400);
    expect(w.mandates.bodies).toHaveLength(0);
  });

  it('an AI-proposed CHANGE is offered to the phone when it arrives: op change, naming the proposal, with the version it continues', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const { sent } = await prepareAndSend(w);
    const first = await phoneOpens(w, phone);
    expect((await phoneSigns(w, phone, first.c)).status).toBe(201);
    const authz1 = String((await w.get(`/api/mandate/give-on-phone/${String(sent.body.mandateId)}`)).body.authorizationId);
    const v1Grant = (w.mandates.rows.at(-1)! as unknown as { grant: Record<string, unknown> }).grant;
    const old = { authorizationId: authz1, profileId: SALES.id, groupId: String(first.c.give.place.group_id), ownerDid: w.rootDid, bounds: { profile: SALES.id, ...LIMITS }, context: REQ.scope, intent: REQ.intent, mode: 'review', expiresAt: v1Grant.expires_at, title: 'Quotes' };
    w.held.set(authz1, old);
    // what the Setup tool seals into the proposal: the old mandate's id, the changes, the resulting mode, the diff it computed
    const prev = await w.get(`/api/mandate/change-preview?authorizationId=${authz1}&changes=${encodeURIComponent(JSON.stringify({ limits: { value_max: 3000 } }))}`);
    expect(prev.status, prev.text).toBe(200);
    const args = { mandate_id: authz1, limits: { value_max: 3000 }, mode: 'review', change: prev.body.diff };
    const r = await call(w.gw.port, 'POST', '/internal/mandate/offer', { headers: { 'X-Internal-Secret': 'sekret' }, body: { proposalId: 'prop_change_0001', tool: 'change', args, old } });
    expect(r.status, r.text).toBe(200);
    expect(r.body, r.text).toMatchObject({ ok: true, mandateVersion: 2 });
    const { c } = await phoneOpens(w, phone);
    expect(c.give.op).toBe('change');
    expect(c.give.proposal_id).toBe('prop_change_0001');
    expect(c.give.bounds.value_max).toBe(3000);
    expect(c.give.previous).toMatchObject({ mandate_version: 1 });
    const given = (q: string) => call(w.gw.port, 'GET', `/internal/mandate/given/${q}`, { headers: { 'X-Internal-Secret': 'sekret' } });
    // before the phone gives: the give waits; the AI path says so, never "the person signed their own version"
    expect((await given('prop_change_0001')).body).toEqual({ waiting: true });
    expect((await phoneSigns(w, phone, c)).status).toBe(201);
    const done = await w.get(`/api/mandate/give-on-phone/${String(r.body.mandateId)}`);
    expect(done.body).toMatchObject({ state: 'done' });
    // after: the mandate the proposal put in force, named for the AI
    expect((await given('prop_change_0001')).body).toEqual({ given: { authorizationId: done.body.authorizationId, op: 'change' } });
    expect((await given('prop_unknown_01')).body).toEqual({});
    expect((await call(w.gw.port, 'GET', '/internal/mandate/given/prop_change_0001', {})).status).toBe(401);
  });

  it('a page that asks after a give is waiting for it: the background completion leaves the request to that page (it shows Signed first)', async () => {
    const { pageIsWaiting } = await import('../../lib/mandate-ceremony');
    const w = await world();
    await w.addPhone(await makePhone());
    // the page that sent it waits for it from that moment (its first poll comes 2 s later; the phone can be quicker)
    const { sent } = await prepareAndSend(w);
    const id = String(sent.body.mandateId);
    expect(pageIsWaiting(id)).toBe(true);
  });
});

