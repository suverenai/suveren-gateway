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
import { makeGrantGate, resyncVerdict } from '../src/lib/mandate-grants';
import { checkDeviceDecisions, controlPlaneDevice, resolveProposalFacts } from '../src/lib/device-decisions';
import { createInternalDeviceRouter } from '../../control-plane/src/routes/internal-device';
import { DeviceChainStore } from '../../control-plane/src/lib/device-chain-store';
import { DevicePinStore } from '../../control-plane/src/lib/device-pin-store';
import { MandateGrantStore } from '../../control-plane/src/lib/mandate-grant-store';
import { person, headOf, addDevice, removeDevice, blob, mandatePayload, grantFor, now, MANDATE_ID, AUTHZ, type Person, type GrantRow, type GrantOpts } from './helpers/device-people';

const open: Array<() => Promise<void>> = [];

class FakeAs {
  readonly requests: Array<{ method: string; path: string; body: string }> = [];
  chains = new Map<string, { entries: unknown[]; head?: { seq: number; hash: string } | null }>();
  grants = new Map<string, GrantRow[]>();
  blobs = new Map<string, string[]>();
  proposals = new Map<string, Record<string, unknown>>();
  receipts: Array<{ mandateId: string; receipt: dk.MandateReceipt; sig: string }> = [];
  /** A grant listing that fails (the Authority Server is down for it). */
  failGrants = false;
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
        authorization_id: id, profile_id: 'test-pay@1', bounds: { profile: 'test-pay@1' }, scope_hash: 'sha256:s', complete: true, revoked: false,
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
  gate: ReturnType<typeof makeGrantGate>;
  /** Serve the mandate and its grant(s) like the Authority Server does. */
  serve: (grants?: GrantRow[], blobs?: string[]) => Promise<void>;
}

async function world(o: { as?: 'owner' | 'approver'; approvers?: Person[]; extra?: Record<string, unknown>; noGrant?: boolean } = {}): Promise<World> {
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
  const receiptSigner = {
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
  app.use('/internal', createInternalDeviceRouter(() => 'sekret', store, new DevicePinStore(vault as never, store), { store: grantStore, grants: receiptSigner as never }));
  const cp: Server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  open.push(() => new Promise<void>(r => cp.close(() => r())));
  process.env.SUVEREN_CP_INTERNAL_URL = `http://127.0.0.1:${(cp.address() as { port: number }).port}`;
  process.env.SUVEREN_INTERNAL_SECRET = 'sekret';
  process.env.SUVEREN_DEVICE_KEYS = 'on';

  const sp = new SPClient(as.url, { maxAttempts: 1, delaysMs: [0] });
  sp.setSessionCookie(`Bearer ${randomUUID()}`);
  const gate = makeGrantGate({ sp, cp: controlPlaneDevice, protectedDids: () => [] });
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
  const w: World = { as, owner, own, sp, cache, payload, grantStore, cpHits, ownState, gate, serve };
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
    expect(w.cpHits).toEqual(['GET /internal/device-chain']);
    expect(w.as.requests.filter(r => r.path.includes('/grants') || r.path.startsWith('/api/devices'))).toEqual([]);
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

