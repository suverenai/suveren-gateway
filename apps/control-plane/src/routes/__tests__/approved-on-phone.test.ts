/**
 * An AI proposal to create or change a mandate, approved on a computer WITHOUT a check key (DEC-90): the computer cannot grant it, so it
 * goes to the person's phone, exactly like "Give on your phone" on the give page. Nothing is requested from the Authority Server until the
 * phone's grant is here and matches; the background completion (index.ts) requests it even with no page open.
 *
 * Real: the routers (`/internal/mandate`, `/api/mandate/*`), the device approvals, the ceremony, the vault, the chain store, hap-core.
 * Stood in: the Authority Server's network (StubAs + StubProposals + StubMandates) and the phone (signs as the app does; the app's own
 * code is tested in apps/approve).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto, randomBytes as nodeRandom } from 'node:crypto';
import * as dk from '@hap/core/device-keys';
import { buildMandateProjection, decryptProposalContent, decodeMandateBlob, type MandatePayload } from '@hap/core';
import { createGrantMembers } from '@hap/core/mandate-grant';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { StubMandates } from '../../__tests__/helpers/stub-as-mandates';
import { StubProposals } from '../../__tests__/helpers/stub-as-proposals';
import { bootGateway, call, sessionHeaders, type GatewayRig } from '../../__tests__/helpers/device-rig';
import { generateKeyPair } from '../../lib/e2e-crypto';
import { asAuthHeaders } from '../../lib/as-credential';
import { computeProposalContentHash } from '../../lib/content-crypto';
import { completeWaitingGives } from '../../lib/mandate-ceremony';

const profilesDir = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'hap-profiles');
const SALES = JSON.parse(readFileSync(join(profilesDir, 'sales', '0.4.profile.json'), 'utf8'));
const LIMITS = { read_access: 'unlimited', value_max: 1000, discount_max: 10, order_value_daily_max: 5000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 0, setup_daily_max: 0 };
const RP = 'approve.test';
const { grantMembersOf } = createGrantMembers(buildMandateProjection);

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const o of open.splice(0).reverse()) await o.close(); });

async function makePhone() {
  const seed = new Uint8Array(nodeRandom(32));
  const signPub = await dk.ed25519PublicKey(seed);
  const read = await generateKeyPair();
  const pk = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pk.publicKey));
  const record = await dk.buildDeviceRecord({
    sign_pub: dk.b64uEncode(signPub), read_pub: dk.b64uEncode(read.publicKey), kind: 'approve-app', label: 'My iPhone', keystore: 'platform',
    check: { type: 'webauthn', rp_id: RP, cred_id: dk.b64uEncode(new Uint8Array(nodeRandom(16))), pub: dk.b64uEncode(dk.encodeCoseEc2(raw.slice(1, 33), raw.slice(33, 65))) },
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
  const props = new StubProposals(as);
  const mandates = new StubMandates(as, SALES);
  props.issuedMandates = id => mandates.issued.some(i => decodeMandateBlob(i.blob).payload.mandate_id === id);
  const reads = { heldBack: async () => [] as never, signedMandate: async () => ({ refusal: 'none', code: 'MANDATE_NOT_ACTIVE' }) as never };
  // No native helper: this computer has no check key.
  const gw: GatewayRig = await bootGateway({ as, mandate: { deliver: async () => {}, reads }, decision: { facts: async () => ({ mandateId: props.mandateId, actionType: props.actionType }) } });
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
  const addPhone = async (phone: Phone) => {
    const state = await dk.verifyChain({ expectedRootDid: rootDid, entries: as.chainEntries() as dk.ChainEntry[] });
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
  const internal = (path: string, body: unknown) => call(gw.port, 'POST', path, { headers: { 'x-internal-secret': 'sekret' }, body, origin: null });
  return { as, props, mandates, gw, post, get, internal, rootDid, addPhone, asPost };
}
type W = Awaited<ReturnType<typeof world>>;

/** The phone opens the sealed request with its own key, rebuilds the members from the plaintext and signs them with its touch. */
async function phoneGives(w: W, phone: Phone) {
  const body = w.mandates.bodies.at(-1)!;
  const opened = await decryptProposalContent({ ciphertext: body.ciphertext, encrypted_keys: { [phone.record.key_id]: body.deviceKeys[phone.record.key_id] }, readers: [phone.record.key_id], unreadable: [] }, phone.record.key_id, phone.read.privateKey);
  const c = opened.arguments as Record<string, any>;
  const g = c.give;
  const members = grantMembersOf(g.payload as MandatePayload, { authorizationId: g.place.authorization_id, groupId: g.place.group_id, replaces: g.place.replaces, chainDids: g.place.chain_dids });
  const state = await dk.verifyChain({ expectedRootDid: w.rootDid, entries: w.as.chainEntries() });
  const grant = dk.buildGrant({
    op: g.op, owner_did: w.rootDid, key_id: phone.record.key_id, chain_seq: state.head.seq, chain_head: state.head.hash,
    mandate_id: c.mandate_id, mandate_version: c.mandate_version, granted_at: Math.floor(Date.now() / 1000), nonce: dk.b64uEncode(new Uint8Array(nodeRandom(16))),
  }, members);
  return w.asPost(`/api/mandates/${encodeURIComponent(c.mandate_id)}/grants`, { grant, sig: await dk.signObject(grant, phone.seed), check: await phone.prove(await dk.objectHash(grant)) });
}

const ARGS = { profile: 'sales', limits: LIMITS, scope: { currency: 'EUR' }, intent: 'Why: quotes wait two days.', mode: 'review', duration_hours: 1, title: 'Quotes' };

async function approved(w: W) {
  const hash = computeProposalContentHash(ARGS);
  w.props.add({ id: 'p1', tool: 'setup__create_mandate', toolArgs: ARGS, contentHash: hash });
  const ok = await w.post('/device-decision/p1/approve', { content_hash: hash, proposalContentHash: hash });
  expect(ok.status, ok.text).toBe(200);
  return hash;
}

describe('an approved AI proposal on a computer without Touch ID goes to the phone (DEC-90)', () => {
  it('no phone either: the computer\'s own refusal, nothing sent, the approval given back', async () => {
    const w = await world();
    const hash = await approved(w);
    const r = await w.internal('/internal/mandate', { request: { approvalHash: hash } });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'grant_refused', grantCode: 'no_check_key' });
    expect(w.mandates.bodies).toHaveLength(0);
    expect(w.props.spends.get('p1')).toBeUndefined();
  });

  it('with a phone: sent to it, nothing requested; the card finds it by proposal; the background completion issues it once the phone gives', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const hash = await approved(w);
    const r = await w.internal('/internal/mandate', { request: { approvalHash: hash } });
    expect(r.status, r.text).toBe(200);
    expect(r.body.onPhone).toMatchObject({ mandateId: expect.any(String), mandateVersion: 1 });
    const mandateId = String((r.body.onPhone as { mandateId: string }).mandateId);
    // the give carries the mandate id the approval's claim names, and the claim is kept (not released, not spent before issuance)
    expect(w.props.spends.get('p1')).toMatchObject({ mandateId, spentAt: null });
    expect(w.mandates.issued).toHaveLength(0);
    // the approval card asks by its proposal
    expect((await w.get('/api/mandate/give-on-phone?proposal=p1')).body).toEqual({ waiting: { mandateId, startedAt: expect.any(Number) } });
    expect((await w.get('/api/mandate/give-on-phone?proposal=other')).body).toEqual({ waiting: null });
    // the AI asks again with the same approval: refused (the claim is held), nothing sent a second time
    const again = await w.internal('/internal/mandate', { request: { approvalHash: hash } });
    expect(again.status).not.toBe(200);
    expect(w.mandates.bodies).toHaveLength(1);

    const deps = () => ({ ...w.gw.ceremony!(), newAuthorizationId: () => `authz_${Math.random().toString(36).slice(2)}` });
    const done: string[] = [];
    // before the phone gives: nothing happens
    await completeWaitingGives(deps(), x => done.push(x.authorizationId));
    expect(done).toEqual([]);
    expect(w.mandates.issued).toHaveLength(0);

    const g = await phoneGives(w, phone);
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    await completeWaitingGives(deps(), x => done.push(x.authorizationId));
    expect(done).toHaveLength(1);
    expect(w.mandates.issued).toHaveLength(1);
    expect(decodeMandateBlob(w.mandates.issued[0].blob).payload.mandate_id).toBe(mandateId);
    // the card's poll after the background finished it hears "done", not "nothing waits"
    expect((await w.get(`/api/mandate/give-on-phone/${mandateId}`)).body).toMatchObject({ state: 'done', authorizationId: done[0] });
    expect((await w.get('/api/mandate/give-on-phone?proposal=p1')).body).toEqual({ waiting: null });
    // once issued, the approval cannot run again
    const third = await w.internal('/internal/mandate', { request: { approvalHash: hash } });
    expect(third.status).not.toBe(200);
    expect(w.mandates.issued).toHaveLength(1);
  });

  it('the page and the background asking at the same moment request the mandate once', async () => {
    const w = await world();
    const phone = await makePhone();
    await w.addPhone(phone);
    const hash = await approved(w);
    const r = await w.internal('/internal/mandate', { request: { approvalHash: hash } });
    const mandateId = String((r.body.onPhone as { mandateId: string }).mandateId);
    expect((await phoneGives(w, phone)).status).toBe(201);
    const deps = () => ({ ...w.gw.ceremony!(), newAuthorizationId: () => `authz_${Math.random().toString(36).slice(2)}` });
    const [, page] = await Promise.all([completeWaitingGives(deps(), () => {}), w.get(`/api/mandate/give-on-phone/${mandateId}`)]);
    expect(['waiting', 'done']).toContain(page.body.state);
    expect(w.mandates.issued).toHaveLength(1);
  });
});
