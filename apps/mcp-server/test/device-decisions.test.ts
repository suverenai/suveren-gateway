/**
 * A committed proposal runs only on device decisions this gateway verified itself
 * (device-keys plan 4.2, section 7; step 12, computer part), through the REAL
 * `executeCommitted` + `CommittedExecutor` + `SPClient`, the real hap-core verifier and the
 * REAL control-plane router for the chain state and pinned heads (routes/internal-device.ts
 * over its real pin store; only the vault's disk is a Map).
 *
 * The Authority Server is the only stand-in: a local HTTP server on a free port that answers
 * `GET /api/proposals/:id`, `GET /api/devices/chain` and `POST /api/as/ticket` in the real
 * routes' shapes and keeps a record of every call. It can LIE (rewritten chains, swapped
 * decisions, a "committed" state with nothing behind it): each lie must end in a refusal that
 * names its reason, and in NO ticket request, because asking for the ticket is what marks the
 * proposal executed there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { randomBytes, randomUUID, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dk from '@hap/core/device-keys';
import { ExecutionJournal, hashToolArgs } from '../src/lib/execution-journal';
import { executeCommitted, installCommittedExecutor } from '../src/tools/commitments';
import { CommittedExecutor } from '../src/lib/committed-executor';
import { computeProposalContentHash } from '../src/lib/proposal-content';
import { SPClient, type SPProposal } from '../src/lib/sp-client';
import { resolveProposalFacts, signedMandateFacts } from '../src/lib/device-decisions';
import type { GrantCheck } from '../src/lib/mandate-grants';
import type { SharedState } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import { testReceiptKeypair, makeSignedReceipt, echoTicketRequest } from './helpers/real-receipt';
import { createInternalDeviceRouter } from '../../control-plane/src/routes/internal-device';
import { DeviceChainStore } from '../../control-plane/src/lib/device-chain-store';
import { DevicePinStore } from '../../control-plane/src/lib/device-pin-store';
import { pinChainStub } from './helpers/cp-pin-stub';
import { MandateGrantStore } from '../../control-plane/src/lib/mandate-grant-store';

// ─── people with real device chains ──────────────────────────────────────

interface Person {
  did: string;
  rootSeed: Uint8Array;
  entries: dk.ChainEntry[];
  /** The first device. */
  dev: { keyId: string; priv: Uint8Array };
  /** The first device's check key (a P-256 key standing for the Secure Enclave one), when it has one. */
  check?: KeyObject;
}

/** A platform check: ECDSA P-256 over the 32 digest bytes of a `sha256:` hash, DER (what the helper's Secure Enclave key gives). */
function checkSignature(priv: KeyObject, hash: string): { signature: string } {
  const digest = Buffer.from(hash.slice('sha256:'.length), 'hex');
  return { signature: cryptoSign('sha256', digest, { key: priv, dsaEncoding: 'der' }).toString('base64url') };
}
function newCheckKey(): { priv: KeyObject; key: { type: 'platform'; pub: string } } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { priv: privateKey, key: { type: 'platform', pub: pub.toString('base64url') } };
}

const now = () => Math.floor(Date.now() / 1000);

async function newDevice(label: string, check?: ReturnType<typeof newCheckKey>, kind: 'gateway' | 'approve-app' = 'gateway') {
  const priv = randomBytes(32);
  const pub = await dk.ed25519PublicKey(priv);
  const record = await dk.buildDeviceRecord({ sign_pub: dk.b64uEncode(pub), read_pub: dk.b64uEncode(randomBytes(32)), kind, label, keystore: 'software', ...(check ? { check: check.key } : {}) }, pub);
  return { priv: new Uint8Array(priv), record };
}

async function person(label = 'Computer', o: { check?: boolean } = {}): Promise<Person> {
  const { seed } = await dk.generateRecoveryCode();
  const root = await dk.deriveRootKey(seed);
  const check = o.check ? newCheckKey() : undefined;
  const d = await newDevice(label, check);
  const e0 = dk.buildEntry({ root_did: root.did, seq: 0, prev: null, op: 'genesis', created_at: now(), signer: 'root', device: d.record });
  e0.sigs.push(await dk.signEntry(e0, 'root', root.privateSeed), await dk.signEntry(e0, d.record.key_id, d.priv));
  if (check) e0.checks.push({ by: d.record.key_id, check: checkSignature(check.priv, await dk.entryHash(e0)) });
  await dk.verifyChain({ expectedRootDid: root.did, entries: [e0] });
  return { did: root.did, rootSeed: root.privateSeed, entries: [e0], dev: { keyId: d.record.key_id, priv: d.priv }, ...(check ? { check: check.priv } : {}) };
}

async function addDevice(p: Person, label: string, kind: 'gateway' | 'approve-app' = 'gateway'): Promise<{ keyId: string; priv: Uint8Array }> {
  const d = await newDevice(label, undefined, kind);
  const e = dk.buildEntry({ root_did: p.did, seq: p.entries.length, prev: await dk.entryHash(p.entries.at(-1)!), op: 'add', created_at: now(), signer: 'root', device: d.record });
  e.sigs.push(await dk.signEntry(e, 'root', p.rootSeed), await dk.signEntry(e, d.record.key_id, d.priv));
  await dk.verifyChain({ expectedRootDid: p.did, entries: [...p.entries, e] });
  p.entries.push(e);
  return { keyId: d.record.key_id, priv: d.priv };
}

async function removeDevice(p: Person, keyId: string): Promise<void> {
  const e = dk.buildEntry({ root_did: p.did, seq: p.entries.length, prev: await dk.entryHash(p.entries.at(-1)!), op: 'remove', created_at: now(), signer: 'root', target: keyId });
  e.sigs.push(await dk.signEntry(e, 'root', p.rootSeed));
  await dk.verifyChain({ expectedRootDid: p.did, entries: [...p.entries, e] });
  p.entries.push(e);
}

const headOf = (p: Person) => dk.verifyChain({ expectedRootDid: p.did, entries: p.entries }).then(s => s.head);

// ─── the proposal under test ─────────────────────────────────────────────

const TOOL_ARGS = { repo: 'o/r', commit: 'abc' };
const CONTENT_HASH = computeProposalContentHash(TOOL_ARGS);
const MANDATE_ID = 'mandate-1';
const TOOL_NAME = 'deploy-github__release';
const AUTHZ = 'authz_1';

function blob(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ payload, signature: 'sig' })).toString('base64url');
}

/** A v0.8 mandate payload as the Authority Server would sign it (a chain account is granted 0.8 mandates only). */
function mandatePayload(owner: Person, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.8', mandate_id: MANDATE_ID, profile_id: 'test-deploy@1', profile_hash: `sha256:${'1'.repeat(64)}`, commitment_mode: 'review', issuer: 'did:key:as',
    issued_at: now(), bounds_hash: `sha256:${'2'.repeat(64)}`, scope_hash: `sha256:${'3'.repeat(64)}`, execution_context_hash: `sha256:${'4'.repeat(64)}`,
    gate_content_hashes: { intent: `sha256:${'5'.repeat(64)}` }, expires_at: now() + 3600, mandate_owners: [{ did: owner.did }], ...extra,
  };
}
function mandateBlob(owner: Person, extra: Record<string, unknown> = {}): string {
  return blob(mandatePayload(owner, extra));
}

/**
 * The owner's grant for a mandate payload, its members written out by hand (the Authority Server's list), signed with the
 * owner's first device and its check key. `override` changes a member AFTER the mandate was fixed (a grant that says something
 * else), `op`/`version` name another version, `check` 'none' or 'other' takes the check away or signs another object.
 */
async function grantFor(owner: Person, payload: Record<string, unknown>, o: { op?: 'grant' | 'change'; version?: number; override?: Record<string, unknown>; check?: 'own' | 'none' | 'other'; authorization?: string; mandateId?: string } = {}) {
  const head = await headOf(owner);
  const approvers = (payload.above_cap_approvers as string[] | undefined) ?? null;
  const members = {
    version: payload.version, profile_id: payload.profile_id, profile_hash: payload.profile_hash, bounds_hash: payload.bounds_hash, scope_hash: payload.scope_hash,
    execution_context_hash: payload.execution_context_hash, gate_content_hashes: payload.gate_content_hashes, commitment_mode: payload.commitment_mode,
    expires_at: payload.expires_at, intent_disclosure_hash: payload.intent_disclosure_hash ?? null, above_cap_caps: payload.above_cap_caps ?? null,
    above_cap_approvers: approvers, above_cap_approvals: payload.above_cap_approvals ?? null, disclose_fields: null, subjects_disclosed: false,
    authorization_id: o.authorization ?? AUTHZ, group_id: 'g1', replaces: null, chain_dids: [owner.did, ...(approvers ?? [])].sort(), ...o.override,
  };
  const grant = dk.buildGrant({
    op: o.op ?? 'grant', owner_did: owner.did, key_id: owner.dev.keyId, chain_seq: head.seq, chain_head: head.hash,
    mandate_id: o.mandateId ?? (payload.mandate_id as string), mandate_version: o.version ?? 1, granted_at: now(), nonce: dk.b64uEncode(randomBytes(16)),
  }, members);
  const sig = await dk.signObject(grant, owner.dev.priv);
  const mode = o.check ?? 'own';
  const check = mode === 'none' ? undefined : checkSignature(owner.check!, mode === 'own' ? await dk.objectHash(grant) : `sha256:${'0'.repeat(64)}`);
  return { mandate_version: grant.mandate_version, op: grant.op, grant, sig, check: check ?? null };
}
type GrantRow = Awaited<ReturnType<typeof grantFor>>;

interface World {
  as: FakeAs;
  cpUrl: string;
  dir: string;
  owner: Person;
  state: SharedState;
  callTool: ReturnType<typeof vi.fn>;
  proposal: SPProposal;
  sp: SPClient;
  run: (p?: SPProposal) => ReturnType<typeof executeCommitted>;
  decisionFor: (who: Person, dev: { keyId: string; priv: Uint8Array }, over?: Partial<dk.Decision>) => Promise<{ decision: dk.Decision; sig: string }>;
  own: { state: 'none' | 'present' | 'unreadable' };
  cpHits: string[];
}

class FakeAs {
  readonly requests: Array<{ method: string; path: string }> = [];
  readonly chains = new Map<string, { entries: unknown[]; head?: { seq: number; hash: string } | null }>();
  proposals = new Map<string, Record<string, unknown>>();
  /** The grants this Authority Server carries, by mandate id (PR #141's `GET /api/mandates/:id/grants`). */
  grants = new Map<string, GrantRow[]>();
  tickets = 0;
  failDecisionsRead = false;
  private server!: Server;
  url = '';
  constructor(private readonly issue: (body: Record<string, unknown>) => Record<string, unknown>) {}

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

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const raw = await new Promise<string>(r => { let d = ''; req.on('data', c => (d += c)); req.on('end', () => r(d)); });
    const url = new URL(req.url ?? '/', 'http://x');
    this.requests.push({ method: req.method ?? '', path: url.pathname + url.search });
    const json = (status: number, body: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!/^Bearer [A-Za-z0-9-]+$/.test(String(req.headers.authorization ?? ''))) return json(401, { approved: false, errors: [{ code: 'UNAUTHENTICATED', message: 'Authentication required' }] });
    let m: RegExpExecArray | null;
    if (req.method === 'GET' && (m = /^\/api\/proposals\/([^/]+)$/.exec(url.pathname))) {
      const p = this.proposals.get(decodeURIComponent(m[1]));
      if (!p) return json(404, { error: 'Proposal not found' });
      const { deviceDecisions, ...rest } = p;
      return json(200, { proposal: this.failDecisionsRead ? rest : p, ...(deviceDecisions === undefined ? {} : {}) });
    }
    if (req.method === 'GET' && (m = /^\/api\/authorizations\/([^/]+)$/.exec(url.pathname))) return json(200, { authorization_id: decodeURIComponent(m[1]), profile_id: 'test-pay@1', group_id: 'g1' });
    if (req.method === 'GET' && url.pathname === '/api/devices/chain') {
      const did = url.searchParams.get('did') ?? '';
      const c = this.chains.get(did);
      if (!c) return json(404, { approved: false, errors: [{ code: 'NO_CHAIN', message: 'no device chain for this DID' }] });
      return json(200, { root_did: did, entries: c.entries, head: c.head });
    }
    if (req.method === 'GET' && (m = /^\/api\/mandates\/([^/]+)\/grants$/.exec(url.pathname))) {
      return json(200, { grants: (this.grants.get(decodeURIComponent(m[1])) ?? []).map(g => ({ ...g, mandate_id: (g.grant as { mandate_id: string }).mandate_id })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/as/ticket') {
      this.tickets++;
      return json(200, { approved: true, ticket: this.issue(JSON.parse(raw) as Record<string, unknown>) });
    }
    return json(404, { error: 'not found' });
  }
}

const kp = testReceiptKeypair();
const TOOL: DiscoveredTool = {
  originalName: 'release', namespacedName: TOOL_NAME, integrationId: 'deploy-github', description: '',
  inputSchema: { type: 'object', properties: {} },
  gating: { profile: 'deploy', executionMapping: {}, staticExecution: { action_type: 'send' } } as unknown as DiscoveredTool['gating'],
};

let toClose: Array<() => Promise<void>> = [];

async function world(o: {
  mandateExtra?: Record<string, unknown>;
  deciders?: Person[];
  proposalExtra?: Record<string, unknown>;
  decisions?: Array<{ decision: dk.Decision; sig: string }>;
  /** The head this gateway pinned for the owner before (its own chain record). */
  pinnedOwnHead?: { seq: number; hash: string };
  /** The Authority Server carries no grant for the mandate (it signed a mandate its owner's device never granted). */
  noGrant?: boolean;
} = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'hap-devdec-'));
  const owner = await person('Owner computer', { check: true });
  const as = await new FakeAs(body => makeSignedReceipt(kp, {
    id: `ticket-${randomUUID()}`, action: TOOL_NAME, actionType: 'send', executionContext: {}, authorizationId: AUTHZ,
    profileId: 'test-deploy@1', proposalId: body.proposalId, mandateId: MANDATE_ID, version: '0.8', ...(body.proposalContentHash ? { proposalContentHash: body.proposalContentHash } : {}), ...echoTicketRequest(body),
  })).listen();
  toClose.push(() => as.close());

  // the control plane's REAL router for chain state and pins, over an in-memory vault
  const slots = new Map<string, unknown>();
  const vault = {
    getSecretSlot: (n: string) => slots.get(n) ?? null,
    setSecretSlot: (n: string, v: unknown) => { slots.set(n, JSON.parse(JSON.stringify(v))); },
    hasSecretSlot: (n: string) => slots.has(n),
    isUnlocked: () => true,
  };
  const store = new DeviceChainStore(vault as never);
  const ownHead = await headOf(owner);
  const own: World['own'] = { state: 'present' };
  store.create({ v: 1, rootDid: owner.did, keyId: owner.dev.keyId, head: o.pinnedOwnHead ?? ownHead, asUrl: as.url, label: 'Owner computer', setUpAt: now() });
  const cpHits: string[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { cpHits.push(`${req.method} ${req.path}`); next(); });
  const realStateFn = store.state.bind(store);
  store.state = () => (own.state === 'present' ? realStateFn() : own.state);
  // the grant memory is the real one too; the receipt signer is the real route's job (tested in the control plane), a recorder here
  const receipts: Array<{ mandateId: string; version: number }> = [];
  const grantStore = new MandateGrantStore(vault as never);
  const pinStore = new DevicePinStore(vault as never, store);
  app.use('/internal', createInternalDeviceRouter(() => 'sekret', store, pinStore, {
    store: grantStore, grants: { receipt: async (r: { mandateId: string; version: number }) => { receipts.push(r); return { sent: true }; }, ownerKnown: (d: string) => d === owner.did, verifyHeld: async () => ({}), pinChain: pinChainStub(as.chains, pinStore, owner.did) } as never,
  }));
  const cp: Server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  toClose.push(() => new Promise<void>(r => cp.close(() => r())));
  const cpUrl = `http://127.0.0.1:${(cp.address() as { port: number }).port}`;
  process.env.SUVEREN_CP_INTERNAL_URL = cpUrl;
  process.env.SUVEREN_INTERNAL_SECRET = 'sekret';
  process.env.SUVEREN_DEVICE_KEYS = 'on';

  await as.setChain(owner);
  for (const d of o.deciders ?? []) await as.setChain(d);

  const payload = mandatePayload(owner, {
    ...(o.deciders ? { above_cap_approvers: o.deciders.map(d => d.did), above_cap_approvals: o.deciders.length, above_cap_caps: {} } : {}),
    ...o.mandateExtra,
  });
  const mandate = blob(payload);
  if (!o.noGrant) as.grants.set(MANDATE_ID, [await grantFor(owner, payload)]);
  const auth = {
    authorizationId: AUTHZ, profileId: 'test-deploy@1', mandateId: MANDATE_ID, mandateIds: [MANDATE_ID],
    attestations: [{ domain: 'owner', blob: mandate, expiresAt: now() + 3600 }],
  };
  const sp = new SPClient(as.url, { maxAttempts: 1, delaysMs: [0] });
  sp.setSessionCookie(`Bearer ${randomUUID()}`);

  const proposal: SPProposal = {
    id: 'prop-1', authorizationId: AUTHZ, profileId: 'test-deploy@1', path: 'deploy@0.9', pendingDomains: [],
    committedBy: { owner: { userId: 'u-owner', at: 0 } }, rejectedBy: null, tool: TOOL_NAME, toolArgs: TOOL_ARGS,
    contentHash: CONTENT_HASH, executionContext: {}, status: 'committed', executionResult: null, createdAt: 0, expiresAt: 0,
    ...o.proposalExtra,
  };
  as.proposals.set(proposal.id, { ...proposal, deviceDecisions: (o.decisions ?? []).map(d => ({ proposalId: proposal.id, userId: 'x', keyId: d.decision.key_id, deviceLabel: 'x', decision: d.decision, sig: d.sig, asChainSeq: 0, storedAt: 0 })) });

  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'dispatched' }] });
  const im = { getAllTools: () => [TOOL], callTool } as unknown as IntegrationManager;
  const state = {
    spClient: sp,
    cache: {
      getAllAuthorizations: () => [auth],
      syncAuthorization: async () => auth,
      getTrustedIssuer: async () => kp.issuer,
      getPublicKey: async () => kp.publicKeyHex,
    },
    proposalSubmissions: {
      get: () => ({
        proposalId: proposal.id, tool: TOOL_NAME, toolArgsHash: hashToolArgs(TOOL_ARGS), executionContextHash: hashToolArgs({}),
        authorizationId: AUTHZ, profileId: 'test-deploy@1', actionType: 'send', submittedAt: now(),
      }),
      record: vi.fn(),
    },
    executionLog: { record: vi.fn() },
    executionJournal: new ExecutionJournal(dir),
    archiveReceipt: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharedState;

  const decisionFor: World['decisionFor'] = async (who, dev, over = {}) => {
    const h = await headOf(who);
    const d = dk.buildDecision({
      approver_did: who.did, key_id: dev.keyId, chain_seq: h.seq, chain_head: h.hash, proposal_id: proposal.id, mandate_id: MANDATE_ID,
      action: TOOL_NAME, action_type: 'send', decision: 'commit', content_hash: CONTENT_HASH, proposal_content_hash: CONTENT_HASH,
      decided_at: now(), nonce: randomBytes(16).toString('base64url'), ...over,
    });
    return { decision: d, sig: await dk.signObject(d, dev.priv) };
  };
  const setDecisions = (ds: Array<{ decision: dk.Decision; sig: string }>) => {
    as.proposals.set(proposal.id, { ...as.proposals.get(proposal.id)!, deviceDecisions: ds.map(d => ({ proposalId: proposal.id, userId: 'x', keyId: d.decision.key_id, deviceLabel: 'x', decision: d.decision, sig: d.sig, asChainSeq: 0, storedAt: 0 })) });
  };
  const w: World = { as, cpUrl, dir, owner, state, callTool, proposal, sp, own, cpHits, decisionFor, run: (p) => executeCommitted(p ?? proposal, state, im) };
  (w as World & { setDecisions: typeof setDecisions }).setDecisions = setDecisions;
  return w;
}

const setDecisions = (w: World, ds: Array<{ decision: dk.Decision; sig: string }>) => (w as World & { setDecisions: (d: typeof ds) => void }).setDecisions(ds);
const ticketCalls = (w: World) => w.as.requests.filter(r => r.method === 'POST' && r.path === '/api/as/ticket').length;

beforeEach(() => { process.env.SUVEREN_DEVICE_KEYS = 'on'; });
afterEach(async () => {
  for (const c of toClose.splice(0).reverse()) await c();
  delete process.env.SUVEREN_DEVICE_KEYS;
  delete process.env.SUVEREN_CP_INTERNAL_URL;
  delete process.env.SUVEREN_INTERNAL_SECRET;
  vi.restoreAllMocks();
});

/** Like expectRefused, for a proposal whose earlier run already asked for its ticket. */
async function expectRefusedAfterTicket(w: World, reason: RegExp): Promise<string> {
  const before = ticketCalls(w);
  const r = await w.run();
  expect(r.isError, r.text).toBe(true);
  expect(r.text).toMatch(reason);
  expect(ticketCalls(w)).toBe(before);
  return r.text;
}

/** The refusal must name its reason, ask for no ticket and run nothing. */
async function expectRefused(w: World, reason: RegExp): Promise<string> {
  const r = await w.run();
  expect(r.isError, r.text).toBe(true);
  expect(r.text).toMatch(/blocked/);
  expect(r.text).toMatch(reason);
  expect(r.text).toMatch(/not executed/);
  expect(ticketCalls(w)).toBe(0);
  expect(w.callTool).not.toHaveBeenCalled();
  return r.text;
}

// ─── the happy path and the unchanged path ───────────────────────────────

describe('a gateway with a device chain', () => {
  it('runs a committed proposal that rests on the owner\'s device decision, checked by this gateway', async () => {
    const w = await world();
    setDecisions(w, [await w.decisionFor(w.owner, w.owner.dev)]);
    const r = await w.run();
    expect(r.isError, r.text).toBeUndefined();
    expect(ticketCalls(w)).toBe(1);
    expect(w.callTool).toHaveBeenCalledOnce();
    // it read the person's chain and pinned its head in the control plane
    expect(w.as.requests.some(q => q.path.startsWith('/api/devices/chain?did='))).toBe(true);
    expect(w.cpHits).toContain('POST /internal/device-pin/advance');
  });

  it('a decision from a second device of the owner (added later) counts, and the list the poll loop holds need not carry the decisions', async () => {
    const w = await world();
    const second = await addDevice(w.owner, 'Laptop');
    await w.as.setChain(w.owner);
    setDecisions(w, [await w.decisionFor(w.owner, second)]);
    const r = await w.run({ ...w.proposal }); // no `deviceDecisions` on the copy it was handed
    expect(r.isError, r.text).toBeUndefined();
    expect(w.callTool).toHaveBeenCalledOnce();
  });

  it('through the one CommittedExecutor, like the poll loop and the nudge: refused the same way, runs once when it may', async () => {
    const w = await world();
    const exec = new CommittedExecutor<SPProposal>(p => w.run(p));
    installCommittedExecutor(exec);
    const blocked = await exec.execute(w.proposal);
    expect(blocked.isError).toBe(true);
    expect(w.callTool).not.toHaveBeenCalled();
    setDecisions(w, [await w.decisionFor(w.owner, w.owner.dev)]);
    const [a, b] = await Promise.all([exec.execute(w.proposal), exec.execute(w.proposal)]);
    expect(a).toBe(b);
    expect(w.callTool).toHaveBeenCalledOnce();
    expect(ticketCalls(w)).toBe(1);
  });

  it('a decision signed by a PHONE (approve-app) key under a mandate the Authority Server signed WITHOUT an owner grant: mandate_not_granted, nothing runs', async () => {
    const w = await world({ noGrant: true });
    const phone = await addDevice(w.owner, 'My iPhone', 'approve-app');
    await w.as.setChain(w.owner);
    setDecisions(w, [await w.decisionFor(w.owner, phone)]);
    // the gate's refusal for code mandate_not_granted reads: "this mandate has no grant: the Authority Server signed it, but its owner's device did not"
    await expectRefused(w, /this mandate has no grant/);
    expect(ticketCalls(w)).toBe(0);
    expect(w.callTool).not.toHaveBeenCalled();
  });

  it('a "committed" state with NO device decision does not run, asks for no ticket, and says why', async () => {
    const w = await world();
    const text = await expectRefused(w, /Mandate Owner has no verified device decision/);
    expect(text).toMatch(/no device decision of theirs is on file/);
  });

  it('an Authority Server that does not give the decisions on file (an older answer without them) runs nothing', async () => {
    const w = await world();
    setDecisions(w, [await w.decisionFor(w.owner, w.owner.dev)]);
    w.as.failDecisionsRead = true;
    await expectRefused(w, /no device decision of theirs is on file/);
  });

  it('the control plane says nothing (down): fail closed, not "no chain"', async () => {
    const w = await world();
    setDecisions(w, [await w.decisionFor(w.owner, w.owner.dev)]);
    process.env.SUVEREN_INTERNAL_SECRET = 'wrong';
    await expectRefused(w, /control plane did not say/);
  });

  it('a stored chain that cannot be read: refused with its own reason', async () => {
    const w = await world();
    w.own.state = 'unreadable';
    await expectRefused(w, /stored device chain cannot be read/);
  });
});

describe('the unchanged path', () => {
  it('switch off: nothing is asked of the control plane or of the chain routes, a committed proposal runs exactly as before', async () => {
    const w = await world();
    delete process.env.SUVEREN_DEVICE_KEYS;
    const r = await w.run();
    expect(r.isError, r.text).toBeUndefined();
    expect(w.callTool).toHaveBeenCalledOnce();
    expect(w.cpHits).toEqual([]);
    expect(w.as.requests.filter(q => q.path.startsWith('/api/devices') || q.path.startsWith('/api/proposals'))).toEqual([]);
  });

  it('switch on but this gateway has no device chain: nothing else is asked, it runs exactly as before', async () => {
    const w = await world();
    w.own.state = 'none';
    const r = await w.run();
    expect(r.isError, r.text).toBeUndefined();
    expect(w.callTool).toHaveBeenCalledOnce();
    expect(w.cpHits).toEqual(['GET /internal/device-chain']);
    expect(w.as.requests.filter(q => q.path.startsWith('/api/devices') || q.path.startsWith('/api/proposals'))).toEqual([]);
  });
});

// ─── decisions that must not count ───────────────────────────────────────

describe('a decision that does not rest on this proposal, this content and this person\'s chain', () => {
  it.each([
    ['another proposal', { proposal_id: 'prop-other' }, /PROPOSAL_MISMATCH/],
    ['other content', { proposal_content_hash: `sha256:${'a'.repeat(64)}` }, /PROPOSAL_MISMATCH/],
    ['another action', { action: 'files__delete' }, /PROPOSAL_MISMATCH/],
    ['another action type', { action_type: 'delete' }, /PROPOSAL_MISMATCH/],
    ['another mandate', { mandate_id: 'mandate-evil' }, /PROPOSAL_MISMATCH/],
    ['a reject where a commit is needed', { decision: 'reject' as const }, /not_a_commit/],
    ['a withdrawal where a commit is needed', { decision: 'withdraw' as const }, /not_a_commit/],
  ])('%s is refused', async (_name, over, reason) => {
    const w = await world();
    setDecisions(w, [await w.decisionFor(w.owner, w.owner.dev, over as Partial<dk.Decision>)]);
    await expectRefused(w, reason);
  });

  it('a decision with a signature that is not the device\'s (a key made up by the AI) is refused', async () => {
    const w = await world();
    const fake = { keyId: w.owner.dev.keyId, priv: new Uint8Array(randomBytes(32)) };
    setDecisions(w, [await w.decisionFor(w.owner, fake)]);
    await expectRefused(w, /BAD_SIGNATURE/);
  });

  it('a decision by a key that is not in the chain at all is refused', async () => {
    const w = await world();
    const stranger = await newDevice('x');
    setDecisions(w, [await w.decisionFor(w.owner, { keyId: stranger.record.key_id, priv: stranger.priv })]);
    await expectRefused(w, /NOT_ACTIVE/);
  });

  it('a decision by a device that was removed since is refused', async () => {
    const w = await world();
    const second = await addDevice(w.owner, 'Laptop');
    const d = await w.decisionFor(w.owner, second);
    await removeDevice(w.owner, second.keyId);
    await w.as.setChain(w.owner);
    setDecisions(w, [d]);
    await expectRefused(w, /NOT_ACTIVE/);
  });

  it('a decision naming a chain head ahead of the chain this gateway verified is refused', async () => {
    const w = await world();
    const d = await w.decisionFor(w.owner, w.owner.dev, { chain_seq: 5, chain_head: `sha256:${'c'.repeat(64)}` });
    // the decision is signed over a head the owner\'s chain does not have yet
    setDecisions(w, [d]);
    await expectRefused(w, /CHAIN_AHEAD/);
  });

  it('a decision naming another hash at a seq this chain has (a fork) is refused', async () => {
    const w = await world();
    setDecisions(w, [await w.decisionFor(w.owner, w.owner.dev, { chain_head: `sha256:${'d'.repeat(64)}` })]);
    await expectRefused(w, /FORK/);
  });

  it('the same decision presented on another proposal is refused (replay)', async () => {
    const w = await world();
    const d = await w.decisionFor(w.owner, w.owner.dev);
    const other = { ...w.proposal, id: 'prop-2' };
    w.as.proposals.set('prop-2', { ...other, deviceDecisions: [{ decision: d.decision, sig: d.sig }] });
    (w.state.proposalSubmissions as unknown as { get: () => unknown }).get = () => ({
      proposalId: 'prop-2', tool: TOOL_NAME, toolArgsHash: hashToolArgs(TOOL_ARGS), executionContextHash: hashToolArgs({}),
      authorizationId: AUTHZ, profileId: 'test-deploy@1', actionType: 'send', submittedAt: now(),
    });
    const r = await w.run(other);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/PROPOSAL_MISMATCH/);
    expect(ticketCalls(w)).toBe(0);
  });

  it('a decision by a person the signed mandate does not name counts for nothing, however valid its chain', async () => {
    const w = await world();
    const stranger = await person('Stranger');
    await w.as.setChain(stranger);
    setDecisions(w, [await w.decisionFor(stranger, stranger.dev)]);
    await expectRefused(w, /no device decision of theirs is on file/);
    // and the stranger's chain was never even fetched: who may decide comes from the mandate alone
    expect(w.as.requests.some(q => q.path.includes(encodeURIComponent(stranger.did)))).toBe(false);
  });

  it('the owner\'s chain missing at the Authority Server: refused with its own reason', async () => {
    const w = await world();
    const d = await w.decisionFor(w.owner, w.owner.dev);
    w.as.chains.delete(w.owner.did);
    setDecisions(w, [d]);
    await expectRefused(w, /has no device chain/);
  });
});

// ─── a lying Authority Server ─────────────────────────────────────────────

describe('an Authority Server that lies about the chain', () => {
  it('a chain of another root served under the owner\'s DID is refused (never a key from its word)', async () => {
    const w = await world();
    const impostor = await person('Impostor');
    // the AS serves the impostor's valid chain as if it were the owner's
    await w.as.setChain(w.owner, { entries: impostor.entries, head: await headOf(impostor) });
    setDecisions(w, [await w.decisionFor(impostor, impostor.dev, { approver_did: w.owner.did })]);
    await expectRefused(w, /does not verify \(WRONG_ROOT\)/);
  });

  it('a chain with an entry added without the root\'s signature is refused', async () => {
    const w = await world();
    const evil = await newDevice('AI');
    const e = dk.buildEntry({ root_did: w.owner.did, seq: 1, prev: await dk.entryHash(w.owner.entries[0]), op: 'add', created_at: now(), signer: 'root', device: evil.record });
    e.sigs.push(await dk.signEntry(e, evil.record.key_id, evil.priv)); // no root signature
    await w.as.setChain(w.owner, { entries: [...w.owner.entries, e], head: null });
    setDecisions(w, [await w.decisionFor(w.owner, { keyId: evil.record.key_id, priv: evil.priv })]);
    await expectRefused(w, /does not verify/);
  });

  it('a head named that the entries do not end in is refused', async () => {
    const w = await world();
    await w.as.setChain(w.owner, { head: { seq: 0, hash: `sha256:${'9'.repeat(64)}` } });
    setDecisions(w, [await w.decisionFor(w.owner, w.owner.dev)]);
    await expectRefused(w, /named another chain head/);
  });

  it('a rollback (an approver\'s chain served shorter than the head pinned before) is refused', async () => {
    const a = await person('A');
    const w = await world({ deciders: [a], mandateExtra: { commitment_mode: 'review_above_cap' }, proposalExtra: { pendingApprovers: ['u-a'] } });
    const second = await addDevice(a, 'Laptop');
    await w.as.setChain(a);
    setDecisions(w, [await w.decisionFor(a, second)]);
    expect((await w.run()).isError).toBeUndefined(); // pins A at seq 1
    const p2: SPProposal = { ...w.proposal, id: 'prop-2' };
    const d2 = await w.decisionFor(a, a.dev, { proposal_id: 'prop-2', chain_seq: 0, chain_head: await dk.entryHash(a.entries[0]) });
    w.as.proposals.set('prop-2', { ...p2, deviceDecisions: [{ decision: d2.decision, sig: d2.sig }] });
    await w.as.setChain(a, { entries: a.entries.slice(0, 1), head: { seq: 0, hash: await dk.entryHash(a.entries[0]) } });
    (w.state.proposalSubmissions as unknown as { get: () => unknown }).get = () => ({
      proposalId: 'prop-2', tool: TOOL_NAME, toolArgsHash: hashToolArgs(TOOL_ARGS), executionContextHash: hashToolArgs({}),
      authorizationId: AUTHZ, profileId: 'test-deploy@1', actionType: 'send', submittedAt: now(),
    });
    const r = await w.run(p2);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/shorter than the one this gateway verified/);
    expect(ticketCalls(w)).toBe(1); // only the first proposal asked for a ticket
  });

  it('a fork (another hash at the seq pinned before) is refused', async () => {
    const w = await world({ pinnedOwnHead: { seq: 0, hash: `sha256:${'7'.repeat(64)}` } });
    setDecisions(w, [await w.decisionFor(w.owner, w.owner.dev)]);
    await expectRefused(w, /differs from the one this gateway verified before/);
  });
});

// ─── replay ──────────────────────────────────────────────────────────────

describe('replay: a reused proposal id or decision nonce', () => {
  const asProposal = (w: World, id: string, d: { decision: dk.Decision; sig: string }) => {
    w.as.proposals.set(id, { ...w.proposal, id, deviceDecisions: [{ decision: d.decision, sig: d.sig }] });
    (w.state.proposalSubmissions as unknown as { get: () => unknown }).get = () => ({
      proposalId: id, tool: TOOL_NAME, toolArgsHash: hashToolArgs(TOOL_ARGS), executionContextHash: hashToolArgs({}),
      authorizationId: AUTHZ, profileId: 'test-deploy@1', actionType: 'send', submittedAt: now(),
    });
    return { ...w.proposal, id };
  };

  it('the same proposal id with other decisions is refused; the same decisions again (a retry) are not', async () => {
    const w = await world();
    setDecisions(w, [await w.decisionFor(w.owner, w.owner.dev)]);
    expect((await w.run()).isError).toBeUndefined();
    await w.run(); // same decisions again: the ledger lets it by; the execution journal decides what runs
    const second = await addDevice(w.owner, 'Laptop');
    await w.as.setChain(w.owner);
    setDecisions(w, [await w.decisionFor(w.owner, second)]); // a NEW decision for the same proposal id
    const text = await expectRefusedAfterTicket(w, /already used with other decisions/);
    expect(text).toBeTruthy();
  });

  it('a nonce used for another proposal is refused', async () => {
    const w = await world();
    const nonce = randomBytes(16).toString('base64url');
    const d1 = await w.decisionFor(w.owner, w.owner.dev, { nonce });
    setDecisions(w, [d1]);
    expect((await w.run()).isError).toBeUndefined();
    const d2 = await w.decisionFor(w.owner, w.owner.dev, { nonce, proposal_id: 'prop-2' });
    const p2 = asProposal(w, 'prop-2', d2);
    const r = await w.run(p2);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already used for another proposal/);
    expect(ticketCalls(w)).toBe(1);
  });
});

/**
 * These tests are about WHICH facts a decision names (the signed mandate id, the action type, who may decide). The mandate
 * grant check has its own tests (test/mandate-grants.test.ts) and is the only thing skipped here; the end-to-end tests above
 * run with the real gate.
 */
const skipGate: GrantCheckFn = async () => ({ ok: true, skipped: true });
type GrantCheckFn = (i: { authorizationId: string; attestations: ReadonlyArray<{ blob: string }> }) => Promise<GrantCheck>;
const facts = (d: Omit<Parameters<typeof resolveProposalFacts>[0], 'grants'> & { grants?: GrantCheckFn }, q: Parameters<typeof resolveProposalFacts>[1]) => resolveProposalFacts({ grants: skipGate, ...d }, q);

describe('proposal facts compared with this gateway\'s own submission record', () => {
  const att = { blob: blob({ version: '0.7', mandate_id: 'm1', commitment_mode: 'review', issued_at: 1, mandate_owners: [{ did: 'did:key:z6MkO' }] }) };
  it('refuses early when the Authority Server reports another tool or grant than this gateway submitted', async () => {
    const d = { auth: async () => ({ attestations: [att] }), manifestActionType: () => 'send', submission: () => ({ tool: 't__x', authorizationId: 'a', actionType: 'send' }) };
    expect(await facts(d, { proposalId: 'p', authorizationId: 'a', tool: 't__other' })).toEqual({ ok: false, code: 'proposal_mismatch' });
    expect(await facts(d, { proposalId: 'p', authorizationId: 'b', tool: 't__x' })).toEqual({ ok: false, code: 'proposal_mismatch' });
    expect((await facts(d, { proposalId: 'p', authorizationId: 'a', tool: 't__x' })).ok).toBe(true);
  });
});

describe('an approver\'s gateway: no grant cached, no connector installed', () => {
  const owner = 'did:key:z6MkOwner';
  const approver = 'did:key:z6MkApprover';
  const mandate = { blob: blob({ version: '0.7', mandate_id: 'm1', commitment_mode: 'review_above_cap', issued_at: 5, mandate_owners: [{ did: owner }], above_cap_approvers: [approver] }) };
  const q = { proposalId: 'p', authorizationId: 'a', tool: 'files__x', reportedActionType: 'send', approverDid: approver };
  const base = { auth: async () => undefined, submission: () => undefined, manifestActionType: () => undefined, fetchAuth: async () => ({ attestations: [mandate] }) };

  it('reads the mandate for this one proposal from the AS and takes the action type the proposal stores', async () => {
    const fetched: string[] = [];
    const out = await facts({ ...base, fetchAuth: async id => { fetched.push(id); return { attestations: [mandate] }; } }, q);
    expect(out).toEqual({ ok: true, mandateId: 'm1', actionType: 'send' });
    expect(fetched).toEqual(['a']);
  });

  it('does not fetch when the grant is already held, and checks the person is the owner or a signed approver', async () => {
    const fetched: string[] = [];
    const held = { ...base, auth: async () => ({ attestations: [mandate] }), fetchAuth: async (id: string) => { fetched.push(id); return undefined; } };
    expect((await facts(held, q)).ok).toBe(true);
    expect(fetched).toEqual([]);
    expect(await facts(base, { ...q, approverDid: owner }).then(r => r.ok)).toBe(true);
    expect(await facts(base, { ...q, approverDid: 'did:key:z6MkStranger' })).toEqual({ ok: false, code: 'not_a_signed_decider' });
  });

  it('refuses clearly when neither the mandate nor the action type can be had, or when two sources disagree', async () => {
    expect(await facts({ ...base, fetchAuth: async () => undefined }, q)).toEqual({ ok: false, code: 'mandate_unavailable' });
    expect(await facts({ ...base, fetchAuth: async () => { throw new Error('down'); } }, q)).toEqual({ ok: false, code: 'mandate_unavailable' });
    expect(await facts(base, { ...q, reportedActionType: undefined })).toEqual({ ok: false, code: 'action_type_unknown' });
    expect(await facts({ ...base, manifestActionType: () => 'delete' }, q)).toEqual({ ok: false, code: 'action_type_mismatch' });
    expect(await facts({ ...base, submission: () => ({ actionType: 'delete' }) }, q)).toEqual({ ok: false, code: 'action_type_mismatch' });
  });
});

// ─── above-cap approvers ─────────────────────────────────────────────────

describe('above-cap proposals: the signed approvers, as many as the mandate says', () => {
  it('two signed approvers are needed: one is refused, two run; the owner and a repeat do not count as an approver', async () => {
    const a = await person('A');
    const b = await person('B');
    const w = await world({ deciders: [a, b], mandateExtra: { commitment_mode: 'review_above_cap' }, proposalExtra: { pendingApprovers: ['u-a', 'u-b'] } });
    const da = await w.decisionFor(a, a.dev);
    const dOwner = await w.decisionFor(w.owner, w.owner.dev);
    setDecisions(w, [dOwner, da, await w.decisionFor(a, a.dev)]);
    await expectRefused(w, /1 of 2 required above-cap approvers/);
    const db = await w.decisionFor(b, b.dev);
    setDecisions(w, [da, db]);
    const r = await w.run();
    expect(r.isError, r.text).toBeUndefined();
    expect(w.callTool).toHaveBeenCalledOnce();
    expect(ticketCalls(w)).toBe(1);
  });

  it('a `review` mandate needs the owner even when approvers decided', async () => {
    const a = await person('A');
    const w = await world({ deciders: [a], proposalExtra: { pendingApprovers: ['u-a'] }, mandateExtra: { above_cap_approvers: [] } });
    setDecisions(w, [await w.decisionFor(a, a.dev)]);
    await expectRefused(w, /Mandate Owner has no verified device decision/);
  });

  it('an approver whose chain the Authority Server does not have is named, not skipped', async () => {
    const a = await person('A');
    const w = await world({ deciders: [a], mandateExtra: { commitment_mode: 'review_above_cap' }, proposalExtra: { pendingApprovers: ['u-a'] } });
    const d = await w.decisionFor(a, a.dev);
    w.as.chains.delete(a.did);
    setDecisions(w, [d]);
    await expectRefused(w, /has no device chain/);
  });
});

// ─── what the refusal and the logs may hold ──────────────────────────────

describe('the answer to the AI and the logs', () => {
  it('a refusal names the reason and carries no signature, nonce, key or DID of a person', async () => {
    const w = await world();
    const bad = await w.decisionFor(w.owner, { keyId: w.owner.dev.keyId, priv: new Uint8Array(randomBytes(32)) });
    setDecisions(w, [bad]);
    const lines: string[] = [];
    const sink = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    vi.spyOn(console, 'error').mockImplementation(sink);
    vi.spyOn(console, 'log').mockImplementation(sink);
    const text = await expectRefused(w, /BAD_SIGNATURE/);
    for (const secret of [bad.sig, bad.decision.nonce, bad.decision.key_id, w.owner.did]) {
      expect(text).not.toContain(secret);
      expect(lines.join('\n')).not.toContain(secret);
    }
  });

  it('with no signed mandate at hand (cache evicted, not fetched again) nobody is known to be allowed to decide: refused', async () => {
    const w = await world();
    setDecisions(w, [await w.decisionFor(w.owner, w.owner.dev)]);
    const cache = w.state.cache as unknown as { getAllAuthorizations: () => unknown[]; syncAuthorization: () => Promise<unknown> };
    const held = cache.syncAuthorization;
    cache.getAllAuthorizations = () => [];
    cache.syncAuthorization = async () => null;
    await expectRefused(w, /signed mandate .* is not available/);
    // evicted but fetched again: the same decisions run it
    cache.syncAuthorization = held;
    const r = await w.run();
    expect(r.isError, r.text).toBeUndefined();
  });

  it('with no action type of its own record, nothing can be checked: refused', async () => {
    const w = await world();
    setDecisions(w, [await w.decisionFor(w.owner, w.owner.dev)]);
    (w.state.proposalSubmissions as unknown as { get: () => unknown }).get = () => ({
      proposalId: 'prop-1', tool: TOOL_NAME, toolArgsHash: hashToolArgs(TOOL_ARGS), executionContextHash: hashToolArgs({}),
      authorizationId: AUTHZ, profileId: 'test-deploy@1', submittedAt: now(),
    });
    await expectRefused(w, /no action type/);
  });
});

// ─── the facts the control plane asks for ────────────────────────────────

describe('resolveProposalFacts: the mandate id and the action type of a decision come from this gateway', () => {
  const owner = { did: 'did:key:z6MkOwner' };
  const att = (extra: Record<string, unknown> = {}, id = 'm1', at = 100) => ({
    blob: blob({ version: '0.7', mandate_id: id, commitment_mode: 'review', issued_at: at, mandate_owners: [owner], ...extra }),
  });

  it('takes the most recently issued signed mandate and the submission record before the manifest', async () => {
    const out = await facts({
      auth: async () => ({ attestations: [att({}, 'old', 10), att({}, 'new', 20)] }),
      submission: () => ({ actionType: 'send' }), manifestActionType: () => 'send',
    }, { proposalId: 'p', authorizationId: 'a', tool: 't__x' });
    expect(out).toEqual({ ok: true, mandateId: 'new', actionType: 'send' });
  });

  it('falls back to the manifest for a proposal another gateway of the same person submitted', async () => {
    const out = await facts({
      auth: async () => ({ attestations: [att()] }), submission: () => undefined, manifestActionType: t => (t === 't__x' ? 'send' : undefined),
    }, { proposalId: 'p', authorizationId: 'a', tool: 't__x' });
    expect(out).toEqual({ ok: true, mandateId: 'm1', actionType: 'send' });
  });

  it('says so when it has no signed mandate or no action type, instead of guessing', async () => {
    const none = await facts({ auth: async () => null, submission: () => undefined, manifestActionType: () => 'send' }, { proposalId: 'p', authorizationId: 'a', tool: 't' });
    expect(none).toEqual({ ok: false, code: 'mandate_unavailable' });
    const broken = await facts({ auth: async () => ({ attestations: [{ blob: 'not-a-blob' }] }), submission: () => undefined, manifestActionType: () => 'send' }, { proposalId: 'p', authorizationId: 'a', tool: 't' });
    expect(broken).toEqual({ ok: false, code: 'mandate_unavailable' });
    const noType = await facts({ auth: async () => ({ attestations: [att()] }), submission: () => undefined, manifestActionType: () => undefined }, { proposalId: 'p', authorizationId: 'a', tool: 't' });
    expect(noType).toEqual({ ok: false, code: 'action_type_unknown' });
  });

  it('signedMandateFacts reads only the signed payload and ignores what does not decode', () => {
    expect(signedMandateFacts([{ blob: 'garbage' }, att({ above_cap_approvers: ['did:key:z6MkA'], above_cap_approvals: 2 })])).toMatchObject({
      mandateId: 'm1', ownerDid: 'did:key:z6MkOwner', deciders: ['did:key:z6MkA'], aboveCapApprovals: 2, commitmentMode: 'review',
    });
    expect(signedMandateFacts(undefined)).toBeUndefined();
  });
});

void rmSync;
