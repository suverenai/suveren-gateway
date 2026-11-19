/**
 * A mandate of a chain account is honoured only with a grant its owner's device signed (device-keys plan 4.4, section 7
 * "new mandate-grant check"; build step 13, computer part), through the REAL AttestationCache, SPClient, grant gate and
 * hap-core verifier, and the REAL control-plane router for the chain state, the pinned heads and the highest verified version
 * (routes/internal-device.ts over its real stores; only the vault's disk is a Map).
 *
 * The Authority Server is the only stand-in: a local HTTP server on a free port with the shapes of PR #141 (`GET
 * /api/mandates/:id/grants`, `POST /api/mandates/:id/receipts`, `GET /api/devices/chain`, `GET /api/mandates?authorization_id=`).
 * It can LIE, and every lie must end in a mandate that is not honoured: no grant, a grant without the check or with a check over
 * another object, a grant that says something else than the mandate, an older version served again, a revoked mandate, a rolled
 * back chain. The people, chains, check keys and grants are written out by hand (test/helpers/device-people.ts); the signing of a
 * receipt is the control plane's job (tested there), stood in by the owner's device key here.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import * as dk from '@hap/core/device-keys';
import { AttestationCache } from '../src/lib/attestation-cache';
import { SPClient, type SPProposal } from '../src/lib/sp-client';
import { makeGrantGate, resyncVerdict, checkMandateGrant } from '../src/lib/mandate-grants';
import { gateStoreHold, type BodyHold } from '../src/lib/mandate-bodies';
import { GateStore } from '../src/lib/gate-store';
import { registerProfile, clearProfiles, computeProfileHash, computeScopeHash, computeIntentHash, encryptProposalContent, decryptProposalContent, generateReaderKeyPair, type AgentProfile } from '@hap/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signedMandateFacts, CpRefused } from '../src/lib/device-decisions';
import { checkDeviceDecisions, controlPlaneDevice, resolveProposalFacts } from '../src/lib/device-decisions';
import { createInternalDeviceRouter } from '../../control-plane/src/routes/internal-device';
import { DeviceChainStore } from '../../control-plane/src/lib/device-chain-store';
import { DevicePinStore } from '../../control-plane/src/lib/device-pin-store';
import { MandateGrantStore } from '../../control-plane/src/lib/mandate-grant-store';
import { pinChainStub } from './helpers/cp-pin-stub';
import { person, headOf, addDevice, removeDevice, blob, mandatePayload, grantFor, now, MANDATE_ID, AUTHZ, type Person, type GrantRow, type GrantOpts } from './helpers/device-people';

const open: Array<() => Promise<void>> = [];

class FakeAs {
  readonly requests: Array<{ method: string; path: string; body: string }> = [];
  chains = new Map<string, { entries: unknown[]; head?: { seq: number; hash: string } | null }>();
  grants = new Map<string, GrantRow[]>();
  blobs = new Map<string, string[]>();
  proposals = new Map<string, Record<string, unknown>>();
  receipts: Array<{ mandateId: string; receipt: dk.MandateReceipt; sig: string }> = [];
  /** Sealed bodies as `GET /api/mandates/:id/body` serves them (PR #141): this gateway's own wrap only, `device_key` null when it has none. */
  bodies = new Map<string, Array<{ mandate_version: number; ciphertext: string; device_key: { ct: string; enc: string } | null }>>();
  failBody = false;
  /** A grant listing that fails (the Authority Server is down for it). */
  failGrants = false;
  /** `GET /api/authorizations/:id` answers 404 (the group is not known) */
  noSummary = false;
  /** The DID `GET /api/auth/session` names (the account), or null (the route answers 401). */
  sessionDid: string | null = 'did:key:z6MkLegacyLegacyLegacyLegacyLegacyLegacy1';
  /** What `GET /api/mandates?authorization_id=` answers as `authorization_id` (a mix-up) */
  answerAuthz: string | null = null;
  private server!: Server;
  url = '';

  async listen(): Promise<this> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  close(): Promise<void> { return new Promise(r => { this.server.closeAllConnections?.(); this.server.close(() => r()); }); }

  async setChain(p: Person, over?: { entries?: unknown[]; head?: { seq: number; hash: string } | null }): Promise<void> {
    this.chains.set(p.did, { entries: over?.entries ?? p.entries, head: over && 'head' in over ? over.head : await headOf(p) });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await new Promise<string>(r => { let d = ''; req.on('data', c => (d += c)); req.on('end', () => r(d)); });
    const url = new URL(req.url ?? '/', 'http://x');
    this.requests.push({ method: req.method ?? '', path: url.pathname + url.search, body: raw });
    const json = (status: number, body: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!/^Bearer [A-Za-z0-9-]+$/.test(String(req.headers.authorization ?? ''))) return json(401, { approved: false, errors: [{ code: 'UNAUTHENTICATED', message: 'Authentication required' }] });
    let m: RegExpExecArray | null;
    if (req.method === 'GET' && url.pathname === '/api/auth/session') return this.sessionDid ? json(200, { user: { id: 'u1', did: this.sessionDid } }) : json(500, { error: 'no' });
    if (req.method === 'GET' && (m = /^\/api\/authorizations\/([^/]+)$/.exec(url.pathname))) return this.noSummary ? json(404, { error: 'no' }) : json(200, { authorization_id: decodeURIComponent(m[1]), profile_id: 'test-pay@1', group_id: 'g1' });
    if (req.method === 'GET' && url.pathname === '/api/devices/chain') {
      const did = url.searchParams.get('did') ?? '';
      const c = this.chains.get(did);
      if (!c) return json(404, { approved: false, errors: [{ code: 'NO_CHAIN', message: 'no device chain for this DID' }] });
      return json(200, { root_did: did, entries: c.entries, head: c.head });
    }
    if (req.method === 'GET' && (m = /^\/api\/mandates\/([^/]+)\/grants$/.exec(url.pathname))) {
      if (this.failGrants) return json(500, { error: 'boom' });
      return json(200, { grants: (this.grants.get(decodeURIComponent(m[1])) ?? []).map(g => ({ ...g, mandate_id: g.grant.mandate_id })) });
    }
    if (req.method === 'GET' && (m = /^\/api\/mandates\/([^/]+)\/body$/.exec(url.pathname))) {
      if (this.failBody) return json(500, { error: 'boom' });
      const id = decodeURIComponent(m[1]);
      return json(200, { bodies: (this.bodies.get(id) ?? []).map(b => ({ mandate_id: id, ...b, submitted_by_key_id: 'k', granted: true, stored_at: now(), expires_at: now() + 3600 })) });
    }
    if (req.method === 'POST' && (m = /^\/api\/mandates\/([^/]+)\/receipts$/.exec(url.pathname))) {
      const body = JSON.parse(raw) as { receipt: dk.MandateReceipt; sig: string };
      const id = decodeURIComponent(m[1]);
      const rows = this.grants.get(id) ?? [];
      const row = rows.find(r => r.mandate_version === body.receipt.mandate_version);
      const owner = [...this.chains.entries()].find(([, c]) => (c.entries[0] as dk.ChainEntry | undefined)?.device)?.[0];
      if (!row) return json(404, { approved: false, errors: [{ code: 'GRANT_NOT_FOUND', message: 'no grant' }] });
      const state = await dk.verifyChain({ expectedRootDid: String(row.grant.owner_did), entries: this.chains.get(String(row.grant.owner_did))!.entries });
      try { await dk.verifyReceipt(body, { chain: state, grant: row.grant as never }); } catch (e) { return json(403, { approved: false, errors: [{ code: (e as { code?: string }).code ?? 'X', message: 'receipt refused' }] }); }
      void owner;
      this.receipts.push({ mandateId: id, receipt: body.receipt, sig: body.sig });
      return json(201, { stored: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/mandates') {
      const id = url.searchParams.get('authorization_id') ?? '';
      const list = this.blobs.get(id);
      if (!list) return json(200, { authorization_id: id, mandates: [], complete: false });
      return json(200, {
        authorization_id: this.answerAuthz ?? id, profile_id: 'test-pay@1', bounds: { profile: 'test-pay@1' }, scope_hash: 'sha256:s', complete: true, revoked: false,
        required_domains: ['owner'], attested_domains: ['owner'], deferred_commitment_domains: ['owner'],
        mandates: list.map(b => ({ domain: 'owner', blob: b, expires_at: now() + 3600 })),
      });
    }
    if (req.method === 'GET' && (m = /^\/api\/proposals\/([^/]+)$/.exec(url.pathname))) {
      const p = this.proposals.get(decodeURIComponent(m[1]));
      return p ? json(200, { proposal: p }) : json(404, { error: 'Proposal not found' });
    }
    return json(404, { error: 'not found' });
  }
}

interface World {
  as: FakeAs;
  owner: Person;
  own: Person;
  sp: SPClient;
  cache: AttestationCache;
  payload: Record<string, unknown>;
  grantStore: MandateGrantStore;
  cpHits: string[];
  ownState: { state: 'none' | 'present' | 'unreadable' };
  /** DIDs the person confirmed by identity code (besides their own). */
  confirmed: Set<string>;
  gate: ReturnType<typeof makeGrantGate>;
  /** This computer's reading key (its wraps open with it). */
  readKey: { publicKey: Uint8Array; privateKey: Uint8Array };
  /** Mark the sticky "a chain was seen here" flag, then the gate must refuse although this gateway says it has none. */
  gateOnceSeen: () => Promise<void>;
  /** Serve the mandate and its grant(s) like the Authority Server does. */
  serve: (grants?: GrantRow[], blobs?: string[]) => Promise<void>;
}

async function world(o: { as?: 'owner' | 'approver'; approvers?: Person[]; extra?: Record<string, unknown>; noGrant?: boolean; bodies?: BodyHold } = {}): Promise<World> {
  const owner = await person('Owner computer', { check: true });
  const approver = o.as === 'approver' ? await person('Approver computer') : undefined;
  const own = approver ?? owner;
  const as = await new FakeAs().listen();
  open.push(() => as.close());
  await as.setChain(owner);
  for (const a of o.approvers ?? []) await as.setChain(a);
  if (approver) await as.setChain(approver);

  const slots = new Map<string, unknown>();
  const vault = {
    getSecretSlot: (n: string) => slots.get(n) ?? null,
    setSecretSlot: (n: string, v: unknown) => { slots.set(n, JSON.parse(JSON.stringify(v))); },
    hasSecretSlot: (n: string) => slots.has(n),
    isUnlocked: () => true,
  };
  const store = new DeviceChainStore(vault as never);
  store.create({ v: 1, rootDid: own.did, keyId: own.dev.keyId, head: await headOf(own), asUrl: as.url, label: 'This computer', setUpAt: now() });
  const ownState: World['ownState'] = { state: 'present' };
  const realState = store.state.bind(store);
  store.state = () => (ownState.state === 'present' ? realState() : ownState.state);
  const grantStore = new MandateGrantStore(vault as never);
  const cpHits: string[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { cpHits.push(`${req.method} ${req.path}`); next(); });
  // The control plane's receipt: built and signed from ITS OWN record (key, chain position), sent to the Authority Server.
  const confirmed = new Set<string>();
  const readKey = await generateReaderKeyPair();
  const refusal = (code: string) => Object.assign(new Error(code), { name: 'GrantRefusal', code });
  const receiptSigner = {
    // the control plane's openBody (tested in ITS suite against the real route): fetch this computer's wrap, open it with this computer's key
    openBody: async (r: { mandateId: string; version: number; grantHash: string }) => {
      const res = await fetch(`${as.url}/api/mandates/${r.mandateId}/body`, { headers: { Authorization: `Bearer ${randomUUID()}` } });
      if (!res.ok) throw refusal('as_answer_invalid');
      const row = ((await res.json()) as { bodies: Array<{ mandate_version: number; ciphertext: string; device_key: { ct: string; enc: string } | null }> }).bodies.find(b => b.mandate_version === r.version);
      if (!row?.device_key) throw refusal('body_not_received');
      try {
        const opened = await decryptProposalContent({ ciphertext: row.ciphertext, encrypted_keys: { [own.dev.keyId]: row.device_key }, readers: [own.dev.keyId], unreadable: [] }, own.dev.keyId, readKey.privateKey);
        const a = opened.arguments as { scope: Record<string, string | number>; intent: string };
        return { scope: a.scope, intent: a.intent };
      } catch { throw refusal('body_unreadable'); }
    },
    // the control plane's own check of a grant (tested in its suite); a recorder here
    verifyHeld: async () => ({}),
    // this person's own DID, or one they compared by identity code
    ownerKnown: (did: string) => did === own.did || confirmed.has(did),
    receipt: async (r: { mandateId: string; version: number; grantHash: string }) => {
      if (grantStore.isReceipted(r.mandateId, r.version)) return { sent: false };
      const h = await headOf(own);
      const receipt = dk.buildReceipt({ mandate_id: r.mandateId, mandate_version: r.version, grant_hash: r.grantHash, key_id: own.dev.keyId, chain_seq: h.seq, chain_head: h.hash, received_at: now() });
      const sig = await dk.signObject(receipt, own.dev.priv);
      const res = await fetch(`${as.url}/api/mandates/${r.mandateId}/receipts`, { method: 'POST', headers: { Authorization: `Bearer ${randomUUID()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ receipt, sig }) });
      if (!res.ok) throw Object.assign(new Error('receipt refused'), { name: 'GrantRefusal', code: 'receipt_refused' });
      grantStore.markReceipted(r.mandateId, r.version);
      return { sent: true };
    },
  };
  const pinStore = new DevicePinStore(vault as never, store);
  (receiptSigner as Record<string, unknown>).pinChain = pinChainStub(as.chains, pinStore, own.did);
  app.use('/internal', createInternalDeviceRouter(() => 'sekret', store, pinStore, { store: grantStore, grants: receiptSigner as never }));
  const cp: Server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  open.push(() => new Promise<void>(r => cp.close(() => r())));
  process.env.SUVEREN_CP_INTERNAL_URL = `http://127.0.0.1:${(cp.address() as { port: number }).port}`;
  process.env.SUVEREN_INTERNAL_SECRET = 'sekret';
  process.env.SUVEREN_DEVICE_KEYS = 'on';

  const sp = new SPClient(as.url, { maxAttempts: 1, delaysMs: [0] });
  sp.setSessionCookie(`Bearer ${randomUUID()}`);
  if (approver) confirmed.add(owner.did);   // an approver's gateway honours the colleague it confirmed
  // an approver's gateway also decides on a colleague's mandate it confirmed; a gateway gating its OWN person's tools honours its own owner only
  const gate = makeGrantGate({ sp, cp: controlPlaneDevice, allowConfirmedOwners: !!approver, ...(o.bodies ? { bodies: o.bodies } : {}) });
  const cache = new AttestationCache(sp);
  cache.setGrantGate(gate);
  const payload = mandatePayload(owner, {
    ...(o.approvers ? { above_cap_approvers: o.approvers.map(a => a.did), above_cap_approvals: 1, above_cap_caps: { value_max: 500 } } : {}),
    ...o.extra,
  });
  const serve: World['serve'] = async (grants, blobs) => {
    as.blobs.set(AUTHZ, blobs ?? [blob(payload)]);
    if (grants) as.grants.set(MANDATE_ID, grants);
    else if (!o.noGrant) as.grants.set(MANDATE_ID, [await grantFor(owner, payload)]);
  };
  const gateOnceSeen = async (): Promise<void> => {
    grantStore.markChainSeen();
    ownState.state = 'none';
    const r = await gate({ authorizationId: AUTHZ, attestations: [{ blob: blob(payload) }] });
    expect(r).toMatchObject({ ok: false, code: 'device_not_set_up_here' });
  };
  const w: World = { as, owner, own, sp, cache, payload, grantStore, cpHits, ownState, confirmed, gate, readKey, gateOnceSeen, serve };
  await serve();
  return w;
}

beforeEach(() => { process.env.SUVEREN_DEVICE_KEYS = 'on'; });
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c();
  delete process.env.SUVEREN_DEVICE_KEYS;
  delete process.env.SUVEREN_CP_INTERNAL_URL;
  delete process.env.SUVEREN_INTERNAL_SECRET;
  vi.restoreAllMocks();
});

const refusedWith = async (w: World, code: RegExp | string) => {
  const r = await w.gate({ authorizationId: AUTHZ, attestations: [{ blob: blob(w.payload) }] });
  expect(r.ok, JSON.stringify(r)).toBe(false);
  if (!r.ok) typeof code === 'string' ? expect(r.code).toBe(code) : expect(r.code).toMatch(code);
};

describe('a mandate with its owner\'s grant is honoured', () => {
  it('the cache holds it, and the owner\'s own gateway answers the grant with its receipt, once', async () => {
    const w = await world();
    const auth = await w.cache.syncAuthorization(AUTHZ);
    expect(auth?.authorizationId).toBe(AUTHZ);
    expect(w.cache.getAllAuthorizations()).toHaveLength(1);
    expect(w.cache.withheldReason(AUTHZ)).toBeUndefined();
    expect(w.as.receipts).toHaveLength(1);
    expect(w.as.receipts[0].receipt).toMatchObject({ mandate_id: MANDATE_ID, mandate_version: 1, key_id: w.owner.dev.keyId });
    expect(w.as.receipts[0].receipt.grant_hash).toBe(await dk.grantHash(w.as.grants.get(MANDATE_ID)![0].grant as never));
    // checked again: honoured again, no second receipt
    await w.cache.syncAuthorization(AUTHZ);
    expect(w.as.receipts).toHaveLength(1);
    // the version is remembered in the control plane
    expect(w.grantStore.get(MANDATE_ID)).toMatchObject({ version: 1, revoked: false });
  });

  it('on an approver\'s gateway the owner\'s mandate is checked against the OWNER\'S chain, and no receipt is sent', async () => {
    const w = await world({ as: 'approver' });
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    expect(w.as.receipts).toEqual([]);
    expect(w.as.requests.some(r => r.path === `/api/devices/chain?did=${encodeURIComponent(w.owner.did)}`)).toBe(true);
  });
});

describe('a mandate the Authority Server signed WITHOUT a grant is not honoured, and no decision is offered under it', () => {
  it('not cached, not listed, says why; the intent kept by the caller is not purged', async () => {
    const w = await world({ noGrant: true });
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(w.cache.getAllAuthorizations()).toEqual([]);
    expect(w.cache.withheldReason(AUTHZ)).toMatchObject({ code: 'mandate_not_granted' });
    expect(w.as.receipts).toEqual([]);
  });

  it('no decision is signed under it (the facts a decision names are refused) and no committed proposal runs on it', async () => {
    const w = await world({ noGrant: true });
    const att = { attestations: [{ blob: blob(w.payload), domain: 'owner', expiresAt: now() + 3600 }] };
    const out = await resolveProposalFacts({
      grants: w.gate, auth: async () => undefined, fetchAuth: async () => att, submission: () => ({ actionType: 'pay' }), manifestActionType: () => 'pay',
    }, { proposalId: 'p1', authorizationId: AUTHZ, tool: 'pay__send', approverDid: w.owner.did });
    expect(out).toEqual({ ok: false, code: 'mandate_not_granted' });
    const check = await checkDeviceDecisions({
      sp: w.sp, cp: controlPlaneDevice, auth: att, grantGate: w.gate,
      proposal: { id: 'p1', tool: 'pay__send', authorizationId: AUTHZ }, actionType: 'pay', proposalContentHash: `sha256:${'a'.repeat(64)}`,
    });
    expect(check).toMatchObject({ ok: false, code: 'mandate_not_granted' });
  });

  it('a mandate whose owner has no chain at the Authority Server: an account is never on both', async () => {
    const w = await world();
    w.as.chains.delete(w.owner.did);
    await refusedWith(w, 'owner_has_no_chain');
  });
});

describe('a grant that does not hold is not honoured', () => {
  const refuseCases: Array<[string, (w: World) => Promise<GrantRow[]>, RegExp]> = [
    ['the device signature alone (no check)', w => grantFor(w.owner, w.payload, { check: 'none' }).then(g => [g]), /grant_check_required/],
    ['a check over another object', w => grantFor(w.owner, w.payload, { check: 'other' }).then(g => [g]), /grant_check_required/],
    ['another mandate id', w => grantFor(w.owner, w.payload, { mandateId: 'mandate-evil-1' }).then(g => { (g.grant as Record<string, unknown>).mandate_id = 'mandate-evil-1'; return [g]; }), /grant_|mandate_not_granted/],
    ['another authorization', w => grantFor(w.owner, w.payload, { authorization: 'authz_22222222-2222-2222-2222-222222222222' }).then(g => [g]), /grant_other_authorization/],
    ['approvers that are not the mandate\'s', w => grantFor(w.owner, w.payload, { override: { above_cap_approvers: ['did:key:z6MkEvilEvilEvilEvilEvilEvilEvilEvil'], chain_dids: [w.owner.did, 'did:key:z6MkEvilEvilEvilEvilEvilEvilEvilEvil'].sort() } }).then(g => [g]), /chain_dids_invalid|grant_mismatch/],
    ['another commitment mode', w => grantFor(w.owner, w.payload, { override: { commitment_mode: 'automatic' } }).then(g => [g]), /grant_mismatch/],
    ['another expiry', w => grantFor(w.owner, w.payload, { override: { expires_at: (w.payload.expires_at as number) + 1000 } }).then(g => [g]), /grant_mismatch/],
    ['other bounds', w => grantFor(w.owner, w.payload, { override: { bounds_hash: `sha256:${'9'.repeat(64)}` } }).then(g => [g]), /grant_mismatch/],
    ['another scope', w => grantFor(w.owner, w.payload, { override: { scope_hash: `sha256:${'9'.repeat(64)}` } }).then(g => [g]), /grant_mismatch/],
    ['another intent', w => grantFor(w.owner, w.payload, { override: { gate_content_hashes: { intent: `sha256:${'9'.repeat(64)}` } } }).then(g => [g]), /grant_mismatch/],
    ['another profile hash', w => grantFor(w.owner, w.payload, { override: { profile_hash: `sha256:${'9'.repeat(64)}` } }).then(g => [g]), /grant_mismatch/],
    ['a member too many', w => grantFor(w.owner, w.payload, { override: { extra: 1 } }).then(g => [g]), /grant_malformed/],
    ['a grant of a person who is not the owner', async w => { const other = await person('Other', { check: true }); return [await grantFor(other, w.payload, { override: { chain_dids: [w.owner.did] } })]; }, /grant_wrong_root/],
    ['a grant by a key that is not in the chain', w => grantFor(w.owner, w.payload, { signer: { keyId: dk.b64uEncode(randomBytes(32)), priv: new Uint8Array(randomBytes(32)) } }).then(g => [g]), /grant_not_active/],
    ['a signature that is not the device\'s', async w => { const g = await grantFor(w.owner, w.payload); g.sig = dk.b64uEncode(randomBytes(64)); return [g]; }, /grant_bad_signature/],
    ['a grant that names a chain head ahead of the chain', w => grantFor(w.owner, w.payload, { head: { seq: 7, hash: `sha256:${'7'.repeat(64)}` } }).then(g => [g]), /grant_chain_ahead/],
    ['a grant that names another hash at a seq the chain has', w => grantFor(w.owner, w.payload, { head: { seq: 0, hash: `sha256:${'7'.repeat(64)}` } }).then(g => [g]), /grant_fork/],
    ['a revoke where a grant is needed', w => grantFor(w.owner, w.payload, { op: 'revoke' }).then(g => [g]), /mandate_revoked/],
  ];
  it.each(refuseCases)('%s', async (_name, make, code) => {
    const w = await world();
    await w.serve(await make(w));
    await refusedWith(w, code);
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(w.cache.getAllAuthorizations()).toEqual([]);
    expect(w.as.receipts).toEqual([]);
  });

  it('a grant for a mandate of protocol 0.7 is not a grant of one', async () => {
    const w = await world({ extra: { version: '0.7' } });
    await refusedWith(w, 'mandate_not_granted');
  });

  it('a grant of a second device of the owner (with its own check) counts; once that device is removed it no longer does', async () => {
    const w = await world();
    const second = await addDevice(w.owner, 'Laptop', { check: true });
    await w.as.setChain(w.owner);
    await w.serve([await grantFor(w.owner, w.payload, { signer: second })]);
    const ok = await w.gate({ authorizationId: AUTHZ, attestations: [{ blob: blob(w.payload) }] });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    await removeDevice(w.owner, second.keyId);
    await w.as.setChain(w.owner);
    await refusedWith(w, /grant_not_active/);
  });
});

// ─── the sealed body (plan 20.19, DEC-58) ───────────────────────────────────

describe('the sealed body on a computer that did not create the mandate: opened, compared with the grant, only then used', () => {
  const PROFILE = {
    id: 'test-pay@1', version: '1', description: 'test',
    boundsSchema: { keyOrder: ['value_max'], actionTypes: ['pay'], fields: { value_max: { type: 'number', required: true } } },
    scopeSchema: { keyOrder: ['currency'], fields: { currency: { type: 'string', required: true } } },
    executionContextSchema: { fields: {} }, requiredGates: [], ttl: { default: 1, max: 1 }, retention_minimum: 1,
  } as unknown as AgentProfile;
  const SCOPE = { currency: 'EUR' };
  const INTENT = 'Why: pay suppliers within the limit.';
  const dirs: string[] = [];
  beforeEach(() => { registerProfile('test-pay@1', PROFILE); });
  afterEach(() => { clearProfiles(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const signed = () => ({
    profile_hash: computeProfileHash(PROFILE), scope_hash: computeScopeHash(SCOPE as never, PROFILE), gate_content_hashes: { intent: computeIntentHash(INTENT) },
  });
  async function second(o: { as?: 'owner' | 'approver' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'bodies-'));
    dirs.push(dir);
    const store = new GateStore(dir);   // this computer: nothing of the mandate held
    const w = await world({ ...o, extra: signed(), bodies: gateStoreHold(() => store) });
    /** What the Authority Server serves as this mandate version's body (sealed by whoever; here: sealed to this computer's key). */
    const seal = async (content: Record<string, unknown>, version = 1, wrapped = true): Promise<void> => {
      const sealed = await encryptProposalContent(content, [{ did: w.own.dev.keyId, publicKey: w.readKey.publicKey }]);
      w.as.bodies.set(MANDATE_ID, [...(w.as.bodies.get(MANDATE_ID) ?? []).filter(b => b.mandate_version !== version), { mandate_version: version, ciphertext: sealed.content.ciphertext, device_key: wrapped ? sealed.content.encrypted_keys[w.own.dev.keyId] : null }]);
    };
    const good = { v: 1, mandate_id: MANDATE_ID, mandate_version: 1, scope: SCOPE, intent: INTENT };
    return { w, store, seal, good };
  }
  const withheld = (w: World) => w.cache.withheldReason(AUTHZ);

  it('a body that matches what the grant signed is kept, and the mandate is honoured and answered with the receipt', async () => {
    const { w, store, seal, good } = await second();
    await seal(good);
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    expect(store.get(AUTHZ)).toMatchObject({ authorizationId: AUTHZ, profileId: 'test-pay@1', context: SCOPE, gateContent: { intent: INTENT }, contextHash: w.payload.scope_hash, boundsHash: w.payload.bounds_hash });
    expect(w.as.receipts).toHaveLength(1);
    // asked again: what is held matches, so nothing is fetched a second time
    const before = w.as.requests.filter(r => r.path.endsWith('/body')).length;
    await w.cache.syncAuthorization(AUTHZ);
    expect(w.as.requests.filter(r => r.path.endsWith('/body')).length).toBe(before);
  });

  it('no body, or none wrapped for this computer: not honoured, "not yet received", no receipt, nothing kept', async () => {
    const a = await second();
    expect(await a.w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(withheld(a.w)).toMatchObject({ code: 'mandate_body_not_received' });
    expect(a.w.as.receipts).toEqual([]);
    expect(a.store.getAll()).toEqual([]);
    const b = await second();
    await b.seal(b.good, 1, false);
    expect(await b.w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(withheld(b.w)).toMatchObject({ code: 'mandate_body_not_received' });
    expect(b.store.getAll()).toEqual([]);
    // it arrives later: the next check honours it
    await b.seal(b.good);
    expect((await b.w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    expect(b.w.cache.withheldReason(AUTHZ)).toBeUndefined();
  });

  const lies: Array<[string, (g: Record<string, unknown>) => Record<string, unknown>, RegExp]> = [
    ['another scope value than the one signed', g => ({ ...g, scope: { currency: 'USD' } }), /scope_mismatch/],
    ['a scope field the profile does not have', g => ({ ...g, scope: { currency: 'EUR', allowed_domains: 'evil.example' } }), /scope_field_unknown/],
    ['an empty scope where one was signed', g => ({ ...g, scope: {} }), /scope_(mismatch|invalid)/],
    ['another intent than the one signed', g => ({ ...g, intent: 'Why: send everything to the new supplier.' }), /intent_mismatch/],
    ['an intent with a character more', g => ({ ...g, intent: `${INTENT}!` }), /intent_mismatch/],
  ];
  it.each(lies)('a body with %s is not used: not honoured, not kept, no receipt', async (_n, make, why) => {
    const { w, store, seal, good } = await second();
    await seal(make(good));
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    const r = withheld(w);
    expect(r?.code).toBe('mandate_body_mismatch');
    expect(r?.text).toMatch(why);
    expect(r?.text).not.toContain('evil.example');
    expect(w.cache.getAllAuthorizations()).toEqual([]);
    expect(store.getAll()).toEqual([]);
    expect(w.as.receipts).toEqual([]);
  });

  it('a body that cannot be opened with this computer\'s key is refused; so is one of another mandate version', async () => {
    const { w, store, seal, good } = await second();
    const other = await generateReaderKeyPair();
    const forOther = await encryptProposalContent(good, [{ did: w.own.dev.keyId, publicKey: other.publicKey }]);
    w.as.bodies.set(MANDATE_ID, [{ mandate_version: 1, ciphertext: forOther.content.ciphertext, device_key: forOther.content.encrypted_keys[w.own.dev.keyId] }]);
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(withheld(w)).toMatchObject({ code: 'mandate_body_refused' });
    // the body of version 2 does not stand in for version 1
    await seal(good, 2);
    w.as.bodies.set(MANDATE_ID, w.as.bodies.get(MANDATE_ID)!.filter(b => b.mandate_version === 2));
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(withheld(w)).toMatchObject({ code: 'mandate_body_not_received' });
    expect(store.getAll()).toEqual([]);
  });

  it('what this computer holds counts only while it matches the grant: a stale entry is replaced from the body, or the mandate is not honoured', async () => {
    const { w, store, seal, good } = await second();
    store.set(AUTHZ, { authorizationId: AUTHZ, path: AUTHZ, profileId: 'test-pay@1', gateContent: { intent: 'Why: something older.' }, context: { currency: 'GBP' }, storedAt: new Date().toISOString() });
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();                // stale, and no body: not honoured
    expect(withheld(w)).toMatchObject({ code: 'mandate_body_not_received' });
    await seal(good);
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    expect(store.get(AUTHZ)).toMatchObject({ context: SCOPE, gateContent: { intent: INTENT } });
  });

  it('the creating computer\'s own entry, matching the grant, needs no fetch at all', async () => {
    const { w, store } = await second();
    store.set(AUTHZ, { authorizationId: AUTHZ, path: AUTHZ, profileId: 'test-pay@1', gateContent: { intent: INTENT }, context: SCOPE, storedAt: new Date().toISOString() });
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    expect(w.as.requests.some(r => r.path.endsWith('/body'))).toBe(false);
  });

  it('the Authority Server failing to serve the body is not "honoured anyway": nothing is gated with, and it says it could not fetch', async () => {
    const { w, store, seal, good } = await second();
    await seal(good);
    w.as.failBody = true;
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    // an outage answers 502 without a code (round 3): transient, so what was honoured stays until it is stale
    expect(withheld(w)).toMatchObject({ code: 'body_unavailable' });
    expect(store.getAll()).toEqual([]);
    expect(w.as.receipts).toEqual([]);
  });

  it('an approver\'s gateway is not a recipient of the owner\'s body and does not ask for it (it decides on the proposal\'s own content)', async () => {
    const { w, store } = await second({ as: 'approver' });
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    expect(w.as.requests.some(r => r.path.endsWith('/body'))).toBe(false);
    expect(store.getAll()).toEqual([]);
  });

  it('no scope or intent appears in what the control plane or the gate says on a refusal', async () => {
    const { w, seal, good } = await second();
    await seal({ ...good, scope: { currency: 'USD' }, intent: 'SECRET-INTENT-TEXT' });
    await w.cache.syncAuthorization(AUTHZ);
    const r = withheld(w)!;
    expect(`${r.code} ${r.text}`).not.toMatch(/SECRET-INTENT-TEXT|USD/);
  });
});

describe('versions and revocation', () => {
  it('a change is honoured as a newer version; an OLDER version served again is refused; the highest verified version is kept', async () => {
    const w = await world();
    const v1 = (await w.as.grants.get(MANDATE_ID))![0];
    const p2 = mandatePayload(w.owner, { expires_at: (w.payload.expires_at as number) + 600 });
    const v2 = await grantFor(w.owner, p2, { op: 'change', version: 2 });
    w.as.grants.set(MANDATE_ID, [v1, v2]);
    w.as.blobs.set(AUTHZ, [blob(p2)]);
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    expect(w.grantStore.get(MANDATE_ID)).toMatchObject({ version: 2 });
    // the Authority Server (or whoever sits there) serves the first version's blob again
    w.as.blobs.set(AUTHZ, [blob(w.payload)]);
    w.as.grants.set(MANDATE_ID, [v1]);
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(w.cache.withheldReason(AUTHZ)?.code).toBe('grant_version_refused');
  });

  it('the newest grant that verifies wins when a newer one is stored but not yet issued: the old blob keeps working', async () => {
    const w = await world();
    const v1 = w.as.grants.get(MANDATE_ID)![0];
    const p2 = mandatePayload(w.owner, { expires_at: (w.payload.expires_at as number) + 600 });
    w.as.grants.set(MANDATE_ID, [v1, await grantFor(w.owner, p2, { op: 'change', version: 2 })]);
    // the blob served is still version 1's
    const r = await w.gate({ authorizationId: AUTHZ, attestations: [{ blob: blob(w.payload) }] });
    expect(r.ok && !r.skipped && r.granted.map(g => g.version)).toEqual([1]);
  });

  it('a revoke is final: the mandate is refused, and so is every later version', async () => {
    const w = await world();
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    const rev = await grantFor(w.owner, w.payload, { op: 'revoke', version: 1 });
    w.as.grants.set(MANDATE_ID, [...w.as.grants.get(MANDATE_ID)!, rev]);
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(w.cache.withheldReason(AUTHZ)?.code).toBe('mandate_revoked');
    // even if the revoke is no longer served, this gateway remembers it
    w.as.grants.set(MANDATE_ID, [await grantFor(w.owner, w.payload, { op: 'change', version: 2 })]);
    w.grantStore.observe(MANDATE_ID, 1, `sha256:${'a'.repeat(64)}`, 'revoke');
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
  });
});

describe('the owner\'s chain is the gateway\'s own verified copy', () => {
  it('a rolled-back chain (shorter than the head pinned before) refuses the mandate; so does a fork', async () => {
    const w = await world({ as: 'approver' });
    await addDevice(w.owner, 'Laptop');
    await w.as.setChain(w.owner);
    await w.serve([await grantFor(w.owner, w.payload)]);
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ); // pins the owner at seq 1
    const short = w.owner.entries.slice(0, 1);
    await w.as.setChain(w.owner, { entries: short, head: await dk.verifyChain({ expectedRootDid: w.owner.did, entries: short }).then(s => s.head) });
    await refusedWith(w, 'chain_rollback');
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(w.cache.getAllAuthorizations()).toEqual([]);
  });

  it('a head named that the entries do not end in is refused', async () => {
    const w = await world();
    await w.as.setChain(w.owner, { head: { seq: 0, hash: `sha256:${'9'.repeat(64)}` } });
    await refusedWith(w, 'chain_head_mismatch');
  });

  it('a chain with an entry the root did not sign is refused', async () => {
    const w = await world();
    const evil = await person('evil');
    const pub = await dk.ed25519PublicKey(evil.dev.priv);
    const rec = await dk.buildDeviceRecord({ sign_pub: dk.b64uEncode(pub), read_pub: dk.b64uEncode(randomBytes(32)), kind: 'gateway', label: 'evil', keystore: 'software' }, pub);
    const e = dk.buildEntry({ root_did: w.owner.did, seq: 1, prev: await dk.entryHash(w.owner.entries[0]), op: 'add', created_at: now(), signer: 'root', device: rec });
    e.sigs.push(await dk.signEntry(e, rec.key_id, evil.dev.priv)); // no root signature
    await w.as.setChain(w.owner, { entries: [...w.owner.entries, e], head: null });
    await refusedWith(w, /chain_invalid/);
  });
});

describe('the held-back list (GET /internal/held-back reads this)', () => {
  it('lists what the gateway holds back with its own verdict, the profile and the owner; drops it when honoured again', async () => {
    const w = await world({ noGrant: true });
    await w.cache.syncAuthorization(AUTHZ);
    expect(w.cache.withheldList()).toEqual([{ authorizationId: AUTHZ, code: 'mandate_not_granted', profileId: 'test-pay@1', ownerDid: w.owner.did, mandateId: MANDATE_ID }]);
    w.as.grants.set(MANDATE_ID, [await grantFor(w.owner, w.payload)]);
    await w.cache.syncAuthorization(AUTHZ);
    expect(w.cache.withheldList()).toEqual([]);
  });
});

describe('the resync of stored gates (bin/http.ts)', () => {
  it('a mandate whose grant does not verify now is WITHHELD, not an orphan: its stored intent is kept; an ended one is an orphan', async () => {
    const w = await world({ noGrant: true });
    const synced = await w.cache.syncAuthorization(AUTHZ);
    expect(resyncVerdict(w.cache, AUTHZ, !!synced)).toBe('withheld');
    // the grant arrives later: the same stored gate gates again, nothing re-entered
    w.as.grants.set(MANDATE_ID, [await grantFor(w.owner, w.payload)]);
    const later = await w.cache.syncAuthorization(AUTHZ);
    expect(resyncVerdict(w.cache, AUTHZ, !!later)).toBe('synced');
    // an authorization the Authority Server no longer serves is an orphan (the existing rule)
    const none = await w.cache.syncAuthorization('authz_33333333-3333-3333-3333-333333333333');
    expect(resyncVerdict(w.cache, 'authz_33333333-3333-3333-3333-333333333333', !!none)).toBe('orphan');
  });
});

describe('the owner is not the Authority Server\'s to name (a rogue server\'s own root, chain and check key)', () => {
  it('a fabricated, self-consistent owner (their own chain, check key and grant) is refused on the owner\'s gateway and on an approver\'s unless confirmed', async () => {
    for (const as of ['owner', 'approver'] as const) {
      const w = await world({ as });
      w.confirmed.delete(w.owner.did);
      const rogue = await person('Rogue', { check: true });
      const payload = mandatePayload(rogue);
      await w.as.setChain(rogue);
      w.as.blobs.set(AUTHZ, [blob(payload)]);
      w.as.grants.set(MANDATE_ID, [await grantFor(rogue, payload)]);
      const r = await w.gate({ authorizationId: AUTHZ, attestations: [{ blob: blob(payload) }] });
      expect(r, as).toMatchObject({ ok: false, code: as === 'owner' ? 'owner_not_this_person' : 'owner_unknown' });
      expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
      expect(w.cache.getAllAuthorizations()).toEqual([]);
      // nothing about the rogue was pinned or remembered
      expect(w.cpHits).not.toContain('POST /internal/device-pin/advance');
      expect(w.grantStore.get(MANDATE_ID)).toBeNull();
      // once the person compared the identity code and accepted that DID, it IS an owner (and only then)
      w.confirmed.add(rogue.did);
      expect((await w.gate({ authorizationId: AUTHZ, attestations: [{ blob: blob(payload) }] })).ok, as).toBe(as === 'approver');   // the decision path only, never the gateway's own gating
    }
  });

  it('the control plane silent about who is confirmed: refused, never assumed', async () => {
    const w = await world({ as: 'approver' });
    process.env.SUVEREN_INTERNAL_SECRET = 'wrong';
    const r = await w.gate({ authorizationId: AUTHZ, attestations: [{ blob: blob(w.payload) }] });
    expect(r.ok).toBe(false);
  });
});

describe('revoke rows, versions per mandate, the answer asked for, the group, the profile', () => {
  it('a revoke row that does not verify is ignored (neither refuses nor is honoured); a verified one is recorded and final', async () => {
    const w = await world();
    const v1 = w.as.grants.get(MANDATE_ID)![0];
    const forged = await grantFor(w.owner, w.payload, { op: 'revoke', version: 1 });
    forged.sig = dk.b64uEncode(randomBytes(64));
    w.as.grants.set(MANDATE_ID, [v1, forged]);
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    expect(w.grantStore.get(MANDATE_ID)).toMatchObject({ revoked: false });
    const real = await grantFor(w.owner, w.payload, { op: 'revoke', version: 1 });
    w.as.grants.set(MANDATE_ID, [v1, real]);
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(w.cache.withheldReason(AUTHZ)?.code).toBe('mandate_revoked');
    expect(w.grantStore.get(MANDATE_ID)).toMatchObject({ revoked: true });
  });

  it('the newest version is per MANDATE: a second mandate of the authorization at version 1 is not hidden by the first at version 2', async () => {
    const w = await world();
    const pA = mandatePayload(w.owner, { expires_at: (w.payload.expires_at as number) + 600 });
    const pB = mandatePayload(w.owner, { mandate_id: 'mandate-grant-2', expires_at: (w.payload.expires_at as number) + 900 });
    w.as.grants.set(MANDATE_ID, [w.as.grants.get(MANDATE_ID)![0], await grantFor(w.owner, pA, { op: 'change', version: 2 })]);
    w.as.grants.set('mandate-grant-2', [await grantFor(w.owner, pB, { mandateId: 'mandate-grant-2' })]);
    const r = await w.gate({ authorizationId: AUTHZ, attestations: [{ blob: blob(pA) }, { blob: blob(pB) }] });
    expect(r.ok && !r.skipped && r.granted.map(g => `${g.mandateId}:${g.version}`).sort()).toEqual([`${MANDATE_ID}:2`, 'mandate-grant-2:1']);
  });

  it('an answer for another authorization than the one asked for is no answer', async () => {
    const w = await world();
    w.as.answerAuthz = 'authz_99999999-9999-9999-9999-999999999999';
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(w.cache.getAllAuthorizations()).toEqual([]);
  });

  it('a team grant whose group is not known is refused; a personal one does not need it', async () => {
    const a = await person('A');
    const w = await world({ approvers: [a] });
    w.as.noSummary = true;
    await refusedWith(w, 'group_unknown');
    const solo = await world();
    solo.as.noSummary = true;
    expect((await solo.gate({ authorizationId: AUTHZ, attestations: [{ blob: blob(solo.payload) }] })).ok).toBe(true);
  });

  it('the profile in the mandate is the one this gateway holds, when it holds one', async () => {
    const w = await world();
    const r = await checkMandateGrant({ sp: w.sp, cp: controlPlaneDevice, localProfileHash: () => `sha256:${'f'.repeat(64)}` }, { authorizationId: AUTHZ, attestations: [{ blob: blob(w.payload) }] });
    expect(r).toMatchObject({ ok: false, code: 'profile_hash_mismatch' });
    const same = await checkMandateGrant({ sp: w.sp, cp: controlPlaneDevice, localProfileHash: () => w.payload.profile_hash as string }, { authorizationId: AUTHZ, attestations: [{ blob: blob(w.payload) }] });
    expect(same.ok).toBe(true);
  });
});

describe('review round 2', () => {
  it('F3: only a failure to ASK is transient (the entry stays); a refusal the control plane gives, with its code, drops it at once', async () => {
    const w = await world();
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    let spy = vi.spyOn(controlPlaneDevice, 'observeGrant');
    spy.mockRejectedValueOnce(new Error('control plane answered 503'));
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(w.cache.getAllAuthorizations()).toHaveLength(1);       // a failure to ask: kept until stale
    for (const code of ['chain_fork', 'chain_rollback', 'grant_invalid', 'owner_unknown', 'grant_not_held']) {
      spy.mockRejectedValueOnce(new CpRefused(code));
      expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
      expect(w.cache.withheldReason(AUTHZ)?.code).toBe(code);
      expect(w.cache.getAllAuthorizations(), code).toEqual([]);   // a refusal: gone
      spy.mockRestore();
      await w.cache.syncAuthorization(AUTHZ);                      // honoured again once the refusal is gone
      spy = vi.spyOn(controlPlaneDevice, 'observeGrant');
    }
  });

  it('F1: a revoke of an OLDER version is recorded and refuses; the mandate is not honoured again however the rows are served later', async () => {
    const w = await world();
    const v1 = w.as.grants.get(MANDATE_ID)![0];
    const p2 = mandatePayload(w.owner, { expires_at: (w.payload.expires_at as number) + 600 });
    const v2 = await grantFor(w.owner, p2, { op: 'change', version: 2 });
    w.as.grants.set(MANDATE_ID, [v1, v2]);
    w.as.blobs.set(AUTHZ, [blob(p2)]);
    await w.cache.syncAuthorization(AUTHZ);
    expect(w.grantStore.get(MANDATE_ID)).toMatchObject({ version: 2 });
    w.as.grants.set(MANDATE_ID, [v1, v2, await grantFor(w.owner, w.payload, { op: 'revoke', version: 1 })]);
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(w.grantStore.get(MANDATE_ID)).toMatchObject({ revoked: true });
    w.as.grants.set(MANDATE_ID, [v1, v2]);                          // the revoke row is no longer served
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    expect(w.cache.withheldReason(AUTHZ)?.code).toBe('mandate_revoked');
  });

  it('F9: once the grant verified, the group of the mandate is the one the owner signed', async () => {
    const w = await world();
    w.as.noSummary = true;
    expect((await w.cache.syncAuthorization(AUTHZ))?.groupId).toBe('g1');
  });
});

describe('a gateway without a chain on an account that has one', () => {
  it('switch on, no chain here, the Authority Server knows a chain for the account: refused; unknown or an error: works as before', async () => {
    const w = await world({ noGrant: true });
    w.ownState.state = 'none';
    w.as.sessionDid = w.owner.did;
    await refusedWith(w, 'device_not_set_up_here');
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
    const w2 = await world({ noGrant: true });
    w2.ownState.state = 'none';
    w2.as.sessionDid = 'did:key:z6MkLegacyLegacyLegacyLegacyLegacyLegacy2';   // the Authority Server knows no chain for it: works as before
    expect((await w2.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    // an answer that cannot be had (no session, an error) is NOT "no chain": refused, and not remembered as "no"
    const w3 = await world({ noGrant: true });
    w3.ownState.state = 'none';
    w3.as.sessionDid = null;
    await refusedWith(w3, 'device_state_unavailable');
    w3.as.sessionDid = 'did:key:z6MkLegacyLegacyLegacyLegacyLegacyLegacy3';
    expect((await w3.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    // sticky: once a chain was reported for this account here, "no chain here" never comes back
    await w3.gateOnceSeen();
  });
});

describe('a granted mandate is only as fresh as its last check', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('rechecked on a timer; dropped from every read when a check has not succeeded for fifteen minutes; a revoke reaches it by the recheck', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = await world();
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(w.cache.getAllAuthorizations()).toHaveLength(1);
    await w.cache.recheckAll();                       // refreshed
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(w.cache.getAllAuthorizations()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 6 * 60_000);        // 16 minutes since the last check
    expect(w.cache.getAllAuthorizations()).toEqual([]);
    expect(w.cache.getAuthorization(AUTHZ)).toBeNull();
    // a check that cannot be made (the grants are not served) leaves a fresh entry in place, and a revoke removes it at the recheck
    const w2 = await world();
    await w2.cache.syncAuthorization(AUTHZ);
    w2.as.failGrants = true;
    await w2.cache.recheckAll();
    expect(w2.cache.getAllAuthorizations()).toHaveLength(1);
    w2.as.failGrants = false;
    w2.as.grants.set(MANDATE_ID, [...w2.as.grants.get(MANDATE_ID)!, await grantFor(w2.owner, w2.payload, { op: 'revoke', version: 1 })]);
    await w2.cache.recheckAll();
    expect(w2.cache.getAllAuthorizations()).toEqual([]);
  });
});

describe('the mandate a decision names is the one the proposal was submitted under', () => {
  it('signedMandateFacts picks by mandate id, never by the newest issued_at', () => {
    const o = 'did:key:z6MkOwnerOwnerOwnerOwnerOwnerOwnerOwner1';
    const a = { blob: blob({ version: '0.8', mandate_id: 'm-aaaaaaaa', commitment_mode: 'review', issued_at: 5, mandate_owners: [{ did: o }] }) };
    const b = { blob: blob({ version: '0.8', mandate_id: 'm-bbbbbbbb', commitment_mode: 'review', issued_at: 9, mandate_owners: [{ did: o }] }) };
    expect(signedMandateFacts([a, b])?.mandateId).toBe('m-bbbbbbbb');
    expect(signedMandateFacts([a, b], 'm-aaaaaaaa')?.mandateId).toBe('m-aaaaaaaa');
    expect(signedMandateFacts([a, b], 'm-cccccccc')).toBeUndefined();
  });
});

describe('the unchanged path', () => {
  it('switch off: nothing is asked of the control plane or the grants, the cache is the one of every earlier release', async () => {
    const w = await world({ noGrant: true });
    delete process.env.SUVEREN_DEVICE_KEYS;
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    expect(w.cpHits).toEqual([]);
    expect(w.as.requests.filter(r => r.path.includes('/grants') || r.path.startsWith('/api/devices'))).toEqual([]);
  });

  it('switch on but this gateway has no device chain: asked once whether it has one, nothing else', async () => {
    const w = await world({ noGrant: true });
    w.ownState.state = 'none';
    expect((await w.cache.syncAuthorization(AUTHZ))?.authorizationId).toBe(AUTHZ);
    expect(w.cpHits).toEqual(['GET /internal/device-chain', 'GET /internal/mandate-grant/chain-seen']);
    // the Authority Server is asked whether this account has a chain (its answer can only add a refusal); never for grants
    expect(w.as.requests.filter(r => r.path.includes('/grants') || r.path.startsWith('/api/devices')).map(r => r.path.split('?')[0])).toEqual(['/api/devices/chain']);
  });

  it('switch on, the control plane silent: fail closed, never "no chain"', async () => {
    const w = await world();
    process.env.SUVEREN_INTERNAL_SECRET = 'wrong';
    await refusedWith(w, 'device_state_unavailable');
    expect(await w.cache.syncAuthorization(AUTHZ)).toBeNull();
  });

  it('the Authority Server cannot give the grants: not honoured, said so', async () => {
    const w = await world();
    w.as.failGrants = true;
    await refusedWith(w, 'grants_unavailable');
  });
});

describe('who may decide comes from the GRANTED mandate (above-cap, from the owner\'s signed caps)', () => {
  const PROFILE = { id: 'test-pay@1', boundsSchema: { fields: { value_max: { boundType: { kind: 'per_transaction', of: 'value' } } } } } as never;

  async function decisionWorld(ctx: Record<string, unknown>, hideFlag = true) {
    const a = await person('Approver A');
    const w = await world({ approvers: [a], extra: { commitment_mode: 'review' } });
    const proposal = { id: 'p1', tool: 'pay__send', authorizationId: AUTHZ, pendingApprovers: hideFlag ? [] : [a.did], approvedBy: {} };
    const hash = `sha256:${'a'.repeat(64)}`;
    const decide = async (who: Person, kind: 'commit' = 'commit') => {
      const h = await headOf(who);
      const d = dk.buildDecision({
        approver_did: who.did, key_id: who.dev.keyId, chain_seq: h.seq, chain_head: h.hash, proposal_id: 'p1', mandate_id: MANDATE_ID, action: 'pay__send', action_type: 'pay',
        decision: kind, content_hash: hash, proposal_content_hash: hash, decided_at: now(), nonce: randomBytes(16).toString('base64url'),
      });
      return { decision: d, sig: await dk.signObject(d, who.dev.priv) };
    };
    const run = async (decisions: Array<{ decision: dk.Decision; sig: string }>) => {
      w.as.proposals.set('p1', { ...proposal, deviceDecisions: decisions });
      return checkDeviceDecisions({
        sp: w.sp, cp: controlPlaneDevice, auth: { attestations: [{ domain: 'owner', blob: blob(w.payload), expiresAt: now() + 3600 }] }, grantGate: w.gate,
        proposal: proposal as unknown as Pick<SPProposal, 'id' | 'tool' | 'pendingApprovers' | 'approvedBy' | 'authorizationId'>, actionType: 'pay', proposalContentHash: hash,
        executionContext: ctx, profile: PROFILE,
      });
    };
    return { w, a, decide, run };
  }

  it('the signed cap is exceeded and the Authority Server hides its flag: the approver is still required (the known gap of step 12 is closed)', async () => {
    const { w, a, decide, run } = await decisionWorld({ value: 900 });
    const owner = await decide(w.owner);
    const r1 = await run([owner]);
    expect(r1).toMatchObject({ ok: false, code: 'decision_missing_approvers' });
    const r2 = await run([owner, await decide(a)]);
    expect(r2).toEqual({ ok: true });
  });

  it('within the signed cap the owner alone decides, as before', async () => {
    const { w, decide, run } = await decisionWorld({ value: 100 });
    expect(await run([await decide(w.owner)])).toEqual({ ok: true });
  });

  it('an amount that is not there is above the cap (hap-core\'s own rule), and so is a cap this gateway cannot compute', async () => {
    const x = await decisionWorld({});
    expect(await x.run([await x.decide(x.w.owner)])).toMatchObject({ ok: false, code: 'decision_missing_approvers' });
  });

  it('a decision by someone the GRANT does not name counts for nothing: the approver list is the owner\'s signed one', async () => {
    const { w, decide, run } = await decisionWorld({ value: 900 });
    const stranger = await person('Stranger');
    await w.as.setChain(stranger);
    expect(await run([await decide(w.owner), await decide(stranger)])).toMatchObject({ ok: false, code: 'decision_missing_approvers' });
  });
});

describe('nothing secret is said', () => {
  it('a refusal names a code and a reason, never a signature, nonce, key or DID of a person', async () => {
    const w = await world();
    await w.serve([await grantFor(w.owner, w.payload, { check: 'none' })]);
    const r = await w.gate({ authorizationId: AUTHZ, attestations: [{ blob: blob(w.payload) }] });
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    const g = w.as.grants.get(MANDATE_ID)![0];
    for (const secret of [g.sig, String(g.grant.nonce), w.owner.did, w.owner.dev.keyId]) expect(text).not.toContain(secret);
  });
});

