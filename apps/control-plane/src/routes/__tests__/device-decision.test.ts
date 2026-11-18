/**
 * Decisions made on the gateway page, signed with this computer's device key
 * (device-keys plan 4.2, 6.3, DEC-47, DEC-39; step 12, computer part) through the REAL
 * routers (mountDeviceKeyRoutes with the page-session guard, the real vault and chain
 * store, the real hap-core builder and verifier). The only stand-in is the network to the
 * Authority Server (StubAs + StubProposals, which verify with the real hap-core verifier and
 * answer in the real routes' shapes) and the MCP server's address (a recorder of `facts`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { encryptProposalContent } from '@hap/core';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { StubProposals } from '../../__tests__/helpers/stub-as-proposals';
import { bootGateway, call, sessionHeaders, tmpDir, type GatewayRig, type Reply } from '../../__tests__/helpers/device-rig';
import { computeProposalContentHash } from '../../lib/content-crypto';
import { loadOrGenerateKeyPair } from '../../lib/e2e-key-manager';
import { DeviceChainStore } from '../../lib/device-chain-store';
import { DevicePinStore } from '../../lib/device-pin-store';
import type { DecisionRoute, DecisionKind } from '../../lib/device-decision';

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const o of open.splice(0).reverse()) await o.close(); vi.restoreAllMocks(); });

const ARGS = { to: 'a@example.test', subject: 'Hello' };
const HASH = computeProposalContentHash(ARGS);

async function world(opts: { facts?: () => Promise<{ mandateId: string; actionType: string }> } = {}) {
  const as = await new StubAs().listen();
  open.push(as);
  const props = new StubProposals(as);
  const decided: Array<[DecisionRoute, DecisionKind]> = [];
  const factsAsked: Array<{ proposalId: string; authorizationId: string; tool: string }> = [];
  const gw = await bootGateway({
    as,
    decision: {
      facts: async p => { factsAsked.push(p); return opts.facts ? opts.facts() : { mandateId: props.mandateId, actionType: props.actionType }; },
      onDecided: (route, kind) => { decided.push([route, kind]); },
    },
  });
  open.push(gw);
  const session = await gw.unlock();
  const h = sessionHeaders(session);
  const post = (path: string, body: unknown = {}) => call(gw.port, 'POST', path, { headers: h, body });
  const start = await post('/auth/device/setup/start');
  const fin = await post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: as.issueEnrolmentCode() });
  expect(fin.status).toBe(200);
  const decide = (id: string, route: string, body: unknown = {}) => post(`/device-decision/${id}/${route}`, body);
  return { as, props, gw, h, post, decide, decided, factsAsked, rootDid: String(start.body.rootDid), keyId: String(start.body.deviceKeyId) };
}

const sentDecision = (w: Awaited<ReturnType<typeof world>>) => w.props.posts.at(-1)!.body.device_decision as { decision: Record<string, unknown>; sig: string };

describe('a decision on the gateway page of a gateway with a device chain', () => {
  it('approve: signed with this computer\'s key, the Authority Server verifies it (real verifier) and the answer is the legacy answer', async () => {
    const w = await world();
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    const r = await w.decide('p1', 'approve', { shown_hash: `sha256:${'a'.repeat(64)}` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'committed', receipt: { id: 'ticket-1' } });
    expect(w.props.proposals.get('p1')!.status).toBe('committed');
    // what the AS stored is what the gateway signed: the proposal's own fields, this computer's key, the chain head it verified
    const d = sentDecision(w).decision;
    expect(d).toMatchObject({
      typ: 'suveren-device-decision', v: 1, approver_did: w.rootDid, key_id: w.keyId, chain_seq: 0,
      proposal_id: 'p1', mandate_id: 'mandate-1', action: 'email__send', action_type: 'send', decision: 'commit',
      proposal_content_hash: HASH,
    });
    expect(d.chain_head).toBe((w.as.chainEntries().length === 1) ? new DeviceChainStore(w.gw.vault).read()!.head.hash : '');
    expect(w.decided).toEqual([['approve', 'commit']]);
  });

  it('reject, resolve(commit), resolve(reject: change needed) and withdraw each sign their own kind and forward the person\'s choices unchanged', async () => {
    const w = await world();
    const sealedNote = { ciphertext: 'abc', keys: { u1: { ct: 'x', enc: 'y' } } };
    const cases: Array<{ route: DecisionRoute; body: Record<string, unknown>; kind: DecisionKind; forwarded: Record<string, unknown> }> = [
      { route: 'reject', body: { reason: 'no', shown_hash: `sha256:${'b'.repeat(64)}` }, kind: 'reject', forwarded: { reason: 'no', shown_hash: `sha256:${'b'.repeat(64)}` } },
      { route: 'resolve', body: { action: 'commit', domain: 'u1' }, kind: 'commit', forwarded: { action: 'commit', domain: 'u1' } },
      { route: 'resolve', body: { action: 'reject', domain: 'u1', outcome: 'change_needed', note_encrypted: sealedNote }, kind: 'reject', forwarded: { action: 'reject', domain: 'u1', outcome: 'change_needed', note_encrypted: sealedNote } },
      { route: 'withdraw', body: { note: 'changed my mind' }, kind: 'withdraw', forwarded: { note: 'changed my mind' } },
    ];
    for (const [i, c] of cases.entries()) {
      const id = `p${i}`;
      w.props.add({ id, tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
      const r = await w.decide(id, c.route, c.body);
      expect(r.status, `${c.route} ${JSON.stringify(c.body)} -> ${r.text}`).toBe(200);
      const sent = w.props.posts.at(-1)!.body;
      expect((sent.device_decision as { decision: { decision: string } }).decision.decision).toBe(c.kind);
      expect(sent).toMatchObject(c.forwarded);
      expect(sent.proposalContentHash).toBe(HASH);
      expect(sent.content_hash).toBe(HASH);
    }
    expect(w.decided.map(x => x.join(':'))).toEqual(['reject:reject', 'resolve:commit', 'resolve:reject', 'withdraw:withdraw']);
  });

  it('what is signed comes from the gateway\'s own copy: a request body that names other fields changes nothing signed and is not forwarded', async () => {
    const w = await world();
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    const forged = { decision: 'reject', proposal_id: 'other', mandate_id: 'm-evil', action: 'commit', action_type: 'delete', tool: 'files__delete', content_hash: `sha256:${'f'.repeat(64)}`, proposalContentHash: `sha256:${'e'.repeat(64)}`, device_decision: { decision: { typ: 'x' }, sig: 'AAAA' }, key_id: 'k', approver_did: 'did:key:z6MkEvil', chain_seq: 99, chain_head: `sha256:${'1'.repeat(64)}`, nonce: 'AAAAAAAAAAAAAAAAAAAAAA' };
    const r = await w.decide('p1', 'approve', forged);
    expect(r.status).toBe(200);
    const sent = w.props.posts.at(-1)!.body;
    const d = sentDecision(w).decision;
    expect(d).toMatchObject({ proposal_id: 'p1', mandate_id: 'mandate-1', action: 'email__send', action_type: 'send', decision: 'commit', approver_did: w.rootDid, key_id: w.keyId, proposal_content_hash: HASH });
    expect(d.nonce).not.toBe('AAAAAAAAAAAAAAAAAAAAAA');
    expect(sent.content_hash).toBe(HASH);
    expect(JSON.stringify(sent)).not.toMatch(/m-evil|files__delete|Evil|did:key:z6MkEvil/);
    expect(Object.keys(sent).sort()).toEqual(['content_hash', 'device_decision', 'proposalContentHash'].sort());
  });

  it('every decision carries a fresh nonce', async () => {
    const w = await world();
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    w.props.add({ id: 'p2', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    await w.decide('p1', 'reject');
    const n1 = sentDecision(w).decision.nonce;
    await w.decide('p2', 'reject');
    expect(sentDecision(w).decision.nonce).not.toBe(n1);
  });

  it('a second decision on a decided proposal is refused by the Authority Server and its answer is passed on; nothing is announced', async () => {
    const w = await world();
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    expect((await w.decide('p1', 'approve')).status).toBe(200);
    w.decided.length = 0;
    const again = await w.decide('p1', 'reject');
    // the gateway's own check says it is no longer waiting; the AS is not asked
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('proposal_not_pending');
    expect(w.props.posts).toHaveLength(1);
    expect(w.decided).toEqual([]);
  });

  it('an Authority Server refusal is passed on with its status and body, and nothing is announced', async () => {
    // the gateway names `send`; the AS stored the proposal under another action type: PROPOSAL_MISMATCH
    const w = await world({ facts: async () => ({ mandateId: 'mandate-1', actionType: 'send' }) });
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    w.props.actionType = 'delete';
    const r = await w.decide('p1', 'approve');
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('PROPOSAL_MISMATCH');
    expect(w.props.proposals.get('p1')!.status).toBe('pending');
    expect(w.decided).toEqual([]);
  });
});

describe('what this computer must be able to show', () => {
  it('opens sealed content, hashes it again and signs only when it is the proposal\'s fingerprint', async () => {
    const w = await world();
    const kp = await loadOrGenerateKeyPair(w.gw.vault);
    const { content, proposalContentHash } = await encryptProposalContent(ARGS, [{ did: w.rootDid, publicKey: kp.publicKey }]);
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: null, content: content as unknown as Record<string, unknown>, contentHash: proposalContentHash });
    const r = await w.decide('p1', 'approve');
    expect(r.status, r.text).toBe(200);
    expect(sentDecision(w).decision.proposal_content_hash).toBe(proposalContentHash);
  });

  it('a commit for content this computer cannot open is refused and the Authority Server is not asked', async () => {
    const w = await world();
    const kp = await loadOrGenerateKeyPair(w.gw.vault);
    // sealed for somebody else only
    const { content, proposalContentHash } = await encryptProposalContent(ARGS, [{ did: 'did:key:z6MkSomeoneElse', publicKey: kp.publicKey }]);
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: null, content: content as unknown as Record<string, unknown>, contentHash: proposalContentHash });
    const r = await w.decide('p1', 'approve');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('content_unreadable');
    expect(w.props.posts).toEqual([]);
    // but a reject of it is allowed and names the proposal's own fingerprint (it claims nothing about having seen it)
    const rej = await w.decide('p1', 'reject');
    expect(rej.status).toBe(200);
    expect(sentDecision(w).decision.proposal_content_hash).toBe(proposalContentHash);
  });

  it('content that does not match the proposal\'s fingerprint is never signed, not even as a reject', async () => {
    const w = await world();
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: { ...ARGS, subject: 'Changed' }, contentHash: HASH });
    for (const route of ['approve', 'reject']) {
      const r = await w.decide('p1', route);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('content_mismatch');
    }
    expect(w.props.posts).toEqual([]);
  });
});

describe('refused before anything is signed or sent', () => {
  it('without the page session, with the cookie alone, or from a foreign Origin: refused, no key used, the AS sees nothing', async () => {
    const w = await world();
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    const url = '/device-decision/p1/approve';
    const none = await call(w.gw.port, 'POST', url, { body: {} });
    const cookieOnly = await call(w.gw.port, 'POST', url, { headers: { cookie: w.h.cookie }, body: {} });
    const tokenOnly = await call(w.gw.port, 'POST', url, { headers: { 'x-suveren-session': w.h['x-suveren-session'] }, body: {} });
    const foreign = await call(w.gw.port, 'POST', url, { headers: w.h, origin: 'http://evil.example', body: {} });
    const foreignHost = await call(w.gw.port, 'POST', url, { headers: w.h, host: 'evil.example', body: {} });
    for (const r of [none, cookieOnly, tokenOnly]) expect(r.status).toBe(401);
    expect(foreign.status).toBe(403);
    expect(foreignHost.status).toBe(403);
    const get = await call(w.gw.port, 'GET', '/device-decision/status');
    expect(get.status).toBe(401);
    expect(w.props.posts).toEqual([]);
    expect(w.factsAsked).toEqual([]);
  });

  it('path spellings do not reach a handler without the session (the router checks the session itself)', async () => {
    const w = await world();
    for (const p of ['/device-decision//p1/approve', '/Device-Decision/p1/approve', '/device-decision/p1/approve/', '/device-decision/%2e%2e/p1/approve', '/device-decision/p1%2fapprove']) {
      const r = await call(w.gw.port, 'POST', p, { body: {} });
      expect([401, 403, 404], p).toContain(r.status);
      expect(r.status === 401 || r.status === 404, p).toBe(true);
    }
    expect(w.props.posts).toEqual([]);
  });

  it('an unknown route name, a resolve without an action, and a wrong action are refused', async () => {
    const w = await world();
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    expect((await w.decide('p1', 'execute')).status).toBe(404);
    expect((await w.decide('p1', 'resolve', {})).status).toBe(400);
    expect((await w.decide('p1', 'resolve', { action: 'executed', domain: 'u1' })).status).toBe(400);
    expect(w.props.posts).toEqual([]);
  });

  it('the gateway cannot tell which mandate and action type the decision names: nothing is signed', async () => {
    const w = await world({ facts: async () => { throw new Error('mcp down'); } });
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    const r = await w.decide('p1', 'approve');
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('facts_unavailable');
    expect(w.props.posts).toEqual([]);
  });

  it('a proposal read that is not the one asked for signs nothing', async () => {
    const w = await world();
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    const real = w.props.proposals.get('p1')!;
    // the AS answers a read of p1 with the body of another proposal
    w.props.proposals.set('p1', { ...real, id: 'p-other' });
    const r = await w.decide('p1', 'approve');
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('as_answer_invalid');
    expect(w.props.posts).toEqual([]);
  });

  it('a gateway that set up no device keys refuses (409), and a switch that is off has no such route', async () => {
    const as = await new StubAs().listen();
    open.push(as);
    const props = new StubProposals(as);
    props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    const gw = await bootGateway({ as, decision: { facts: async () => ({ mandateId: 'm', actionType: 'send' }) } });
    open.push(gw);
    const h = sessionHeaders(await gw.unlock());
    const r = await call(gw.port, 'POST', '/device-decision/p1/approve', { headers: h, body: {} });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('not_set_up');
    expect((await call(gw.port, 'GET', '/device-decision/status', { headers: h })).body).toMatchObject({ deviceKeys: false });
    expect(props.posts).toEqual([]);

    const off = await bootGateway({ as, enabled: false, decision: { facts: async () => ({ mandateId: 'm', actionType: 'send' }) } });
    open.push(off);
    expect((await call(off.port, 'POST', '/device-decision/p1/approve', { body: {} })).status).toBe(404);
    expect((await call(off.port, 'GET', '/device-decision/status')).status).toBe(404);
  });

  it('no decision goes out without the device session: the account key\'s credential is never used for it', async () => {
    const w = await world();
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    w.gw.vault.setSpCookie('hap-session=legacy-cookie');
    const r = await w.decide('p1', 'approve');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('not_signed_in');
    expect(w.props.posts).toEqual([]);
  });
});

describe('what stays out of logs and answers', () => {
  it('no signature, nonce or key reaches a log line or the answer of a refusal', async () => {
    const w = await world();
    const lines: string[] = [];
    const spy = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    vi.spyOn(console, 'error').mockImplementation(spy);
    vi.spyOn(console, 'log').mockImplementation(spy);
    vi.spyOn(console, 'warn').mockImplementation(spy);
    w.props.add({ id: 'p1', tool: 'email__send', toolArgs: ARGS, contentHash: HASH });
    w.props.add({ id: 'p2', tool: 'email__send', toolArgs: { ...ARGS, subject: 'X' }, contentHash: HASH });
    await w.decide('p1', 'approve');
    const sig = sentDecision(w).sig;
    const nonce = String(sentDecision(w).decision.nonce);
    const refusal = await w.decide('p2', 'approve');
    expect(refusal.text).not.toContain(sig);
    expect(lines.join('\n')).not.toContain(sig);
    expect(lines.join('\n')).not.toContain(nonce);
    expect(lines.join('\n')).not.toMatch(/Bearer [A-Za-z0-9-]{20,}/);
  });
});

describe('the control plane\'s answers for the MCP server (/internal/device-*)', () => {
  const SECRET = { 'x-internal-secret': 'sekret' };

  it('needs the internal secret, says whether this gateway has a chain and whose, and keeps heads in the vault', async () => {
    const w = await world();
    const bad = await call(w.gw.port, 'GET', '/internal/device-chain', { headers: { 'x-internal-secret': 'nope' } });
    expect(bad.status).toBe(401);
    expect((await call(w.gw.port, 'GET', '/internal/device-chain')).status).toBe(401);
    const chain = await call(w.gw.port, 'GET', '/internal/device-chain', { headers: SECRET });
    expect(chain.body).toEqual({ state: 'present', rootDid: w.rootDid });

    const other = 'did:key:z6MkSomeoneElse';
    const h1 = { seq: 2, hash: `sha256:${'1'.repeat(64)}` };
    expect((await call(w.gw.port, 'POST', '/internal/device-pin/get', { headers: SECRET, body: { did: other } })).body).toEqual({ head: null });
    expect((await call(w.gw.port, 'POST', '/internal/device-pin/advance', { headers: SECRET, body: { did: other, head: h1 } })).status).toBe(200);
    expect((await call(w.gw.port, 'POST', '/internal/device-pin/get', { headers: SECRET, body: { did: other } })).body).toEqual({ head: h1 });
    // a shorter chain is a rollback, another hash at the same number a fork; neither moves the pin
    const lower = await call(w.gw.port, 'POST', '/internal/device-pin/advance', { headers: SECRET, body: { did: other, head: { seq: 1, hash: `sha256:${'2'.repeat(64)}` } } });
    expect(lower.status).toBe(409); expect(lower.body.code).toBe('rollback');
    const fork = await call(w.gw.port, 'POST', '/internal/device-pin/advance', { headers: SECRET, body: { did: other, head: { seq: 2, hash: `sha256:${'3'.repeat(64)}` } } });
    expect(fork.status).toBe(409); expect(fork.body.code).toBe('fork');
    expect((await call(w.gw.port, 'POST', '/internal/device-pin/get', { headers: SECRET, body: { did: other } })).body).toEqual({ head: h1 });
    // forward is fine
    const h3 = { seq: 3, hash: `sha256:${'4'.repeat(64)}` };
    expect((await call(w.gw.port, 'POST', '/internal/device-pin/advance', { headers: SECRET, body: { did: other, head: h3 } })).status).toBe(200);
    // the pins are sealed in the vault, readable again by a new store over the same vault
    expect(new DevicePinStore(w.gw.vault, new DeviceChainStore(w.gw.vault)).get(other)).toEqual(h3);
    // the owner's own pin is the head of its own chain record, not a second copy
    const own = new DeviceChainStore(w.gw.vault).read()!;
    expect((await call(w.gw.port, 'POST', '/internal/device-pin/get', { headers: SECRET, body: { did: w.rootDid } })).body).toEqual({ head: own.head });
    const ownLower = await call(w.gw.port, 'POST', '/internal/device-pin/advance', { headers: SECRET, body: { did: w.rootDid, head: { seq: 0, hash: `sha256:${'5'.repeat(64)}` } } });
    expect(ownLower.status).toBe(409); expect(ownLower.body.code).toBe('fork');
  });

  it('refuses a malformed did or head, and answers 423 while the vault is locked', async () => {
    const w = await world();
    expect((await call(w.gw.port, 'POST', '/internal/device-pin/get', { headers: SECRET, body: { did: 'not-a-did' } })).status).toBe(400);
    expect((await call(w.gw.port, 'POST', '/internal/device-pin/advance', { headers: SECRET, body: { did: 'did:key:z6MkX', head: { seq: -1, hash: 'x' } } })).status).toBe(400);
    w.gw.vault.lockExpired();
    const locked = await call(w.gw.port, 'POST', '/internal/device-pin/get', { headers: SECRET, body: { did: 'did:key:z6MkX' } });
    expect(locked.status).toBe(423);
    // a locked vault with a chain still says "present", never "none"
    const st = await call(w.gw.port, 'GET', '/internal/device-chain', { headers: SECRET }); expect(st.body.rootDid).toBeUndefined(); expect(st.body.state).toBe('present');
  });
});

export type { GatewayRig, Reply };
void tmpDir;
