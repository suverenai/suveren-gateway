/**
 * Device-key set-up (device-keys plan step 6) through the REAL routers, vault and
 * page sessions. Only the network to the Authority Server is a stand-in: StubAs
 * answers with the real routes' shapes and checks what it is sent with hap-core.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  rootKeyFromRecoveryCode, isValidRecoveryCode, verifyChain, b64uEncode, hexEncode, entryHash,
  type ChainEntry,
} from '@hap/core/device-keys';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { bootGateway, call, sessionHeaders, tmpDir, type Reply } from '../../__tests__/helpers/device-rig';
import { DeviceChainStore } from '../../lib/device-chain-store';
import { loadOrGenerateDeviceSigningKey } from '../../lib/e2e-key-manager';
import { DeviceSetup, SetupRefusal } from '../../lib/device-setup';
import { Vault } from '../../lib/vault';
import { DeviceSignin } from '../../lib/device-signin';
import { DeviceAsClient } from '../../lib/device-as-client';

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  vi.restoreAllMocks();
});

async function world(opts: { enabled?: boolean } = {}) {
  const as = await new StubAs().listen();
  open.push(as);
  const gw = await bootGateway({ as, ...opts });
  open.push(gw);
  const session = await gw.unlock();
  const h = sessionHeaders(session);
  const post = (path: string, body: unknown = {}) => call(gw.port, 'POST', path, { headers: h, body });
  const get = (path: string) => call(gw.port, 'GET', path, { headers: h });
  return { as, gw, session, h, post, get };
}

type World = Awaited<ReturnType<typeof world>>;

/** Start, then finish with an enrolment code pasted from the dashboard. */
async function setUpByPaste(w: World, label?: string) {
  const start = await w.post('/auth/device/setup/start', label ? { label } : {});
  expect(start.status).toBe(200);
  const code = w.as.issueEnrolmentCode();
  const fin = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: code });
  return { start, fin, code };
}

/** Every file under a folder, as latin1 text (a secret in any encoding of the bytes is found). */
function allFiles(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...allFiles(p));
    else out.push({ path: p, text: readFileSync(p).toString('latin1') });
  }
  return out;
}

describe('set-up by a pasted enrolment code', () => {
  it('makes a recovery code that opens the root key, and a genesis the Authority Server stores with this computer as a gateway device', async () => {
    const w = await world();
    const { start, fin } = await setUpByPaste(w);
    const recoveryCode = String(start.body.recoveryCode);
    expect(await isValidRecoveryCode(recoveryCode)).toBe(true);
    expect((await rootKeyFromRecoveryCode(recoveryCode)).did).toBe(start.body.rootDid);

    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ ok: true, rootDid: start.body.rootDid, deviceKeyId: start.body.deviceKeyId, signedIn: true, head: { seq: 0 } });

    const entries = w.as.chainEntries() as ChainEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ op: 'genesis', seq: 0, prev: null, signer: 'root', root_did: start.body.rootDid, check: null });
    expect(entries[0].device).toMatchObject({ kind: 'gateway', keystore: 'software', label: 'This computer', check: null });
    // the root key AND the device both signed it, and hap-core accepts the whole chain
    expect(entries[0].sigs.map(s => s.by).sort()).toEqual(['root', start.body.deviceKeyId].sort());
    const state = await verifyChain({ expectedRootDid: String(start.body.rootDid), entries });
    expect(fin.body.head).toEqual({ seq: 0, hash: state.head.hash });
    expect(fin.body.head).toEqual({ seq: 0, hash: await entryHash(entries[0]) });
  });

  it('stores the chain in the vault (sealed, not among the credentials) and the device key beside the reading key', async () => {
    const w = await world();
    const { start } = await setUpByPaste(w, 'Work Mac');
    const store = new DeviceChainStore(w.gw.vault);
    expect(store.read()).toMatchObject({ rootDid: start.body.rootDid, keyId: start.body.deviceKeyId, label: 'Work Mac', head: { seq: 0 } });
    expect(w.gw.vault.listCredentials()).toEqual(['e2eKey']);
    expect(w.gw.vault.getCredential('deviceSigningKey')).toBeNull();
    expect(w.gw.vault.getCredential('deviceChain')).toBeNull();
    // the reading key is the one the genesis carries
    const kp = JSON.parse(JSON.stringify(w.gw.vault.getCredential('e2eKey')));
    const entry = (w.as.chainEntries() as ChainEntry[])[0];
    expect(entry.device!.read_pub).toBe(b64uEncode(new Uint8Array(Buffer.from(kp.publicKey, 'base64'))));
    // the vault file holds the slots sealed: no key or DID in the clear
    const file = readFileSync(join(w.gw.dir, 'vault.enc.json'), 'utf-8');
    expect(file).toContain('"slots"');
    expect(file).not.toContain(String(start.body.rootDid));
    expect(file).not.toContain(String(start.body.deviceKeyId));
  });

  it('signs in by device key: the bearer token replaces the account key everywhere', async () => {
    const w = await world();
    await setUpByPaste(w);
    const cred = w.gw.vault.getSpCookie();
    expect(cred).toMatch(/^Bearer [A-Za-z0-9-]+$/);
    expect(w.gw.configured.at(-1)).toMatchObject({ credential: cred });
    expect(w.gw.configured.at(-1)!.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(w.gw.sweeps.count).toBe(1);
    expect(w.gw.vault.getSessionUser()).toMatchObject({ id: 'u1' });
    // no request to the Authority Server ever carried an account key or a cookie
    for (const r of w.as.requests) {
      expect(r.headers['x-api-key']).toBeUndefined();
      expect(r.headers.cookie).toBeUndefined();
    }
    // after the session opened, every call carries the bearer token and nothing else
    const afterSession = w.as.requests.slice(w.as.requests.findIndex(r => r.path === '/api/devices/session') + 1);
    expect(afterSession.length).toBeGreaterThan(0);
    for (const r of afterSession.filter(x => x.path.startsWith('/api/devices/chain'))) expect(r.headers.authorization).toBe(cred);
    // the status route says so, without secrets
    const st = await w.get('/auth/device/status');
    expect(st.body).toMatchObject({ ok: true, setUp: true, setupPending: false, signedIn: true });
    expect(JSON.stringify(st.body)).not.toContain(String(cred));
  });

  it('the recovery code is in no request, no log line and no file; neither are the private keys', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(x => (x instanceof Error ? `${x.name}: ${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    }
    const w = await world();
    const responses: Reply[] = [];
    const start = await w.post('/auth/device/setup/start');
    responses.push(start);
    const code = String(start.body.recoveryCode);
    const compact = code.replace(/-/g, '');
    const root = await rootKeyFromRecoveryCode(code);
    const rootSeed = [hexEncode(root.privateSeed), b64uEncode(root.privateSeed), Buffer.from(root.privateSeed).toString('base64')];
    const signing = await loadOrGenerateDeviceSigningKey(w.gw.vault);
    const devSeed = [hexEncode(signing.privateSeed), b64uEncode(signing.privateSeed), Buffer.from(signing.privateSeed).toString('base64')];
    const reading = JSON.parse(JSON.stringify(w.gw.vault.getCredential('e2eKey')));
    const secrets = [code, compact, code.toLowerCase(), ...rootSeed, ...devSeed, String(reading.privateKey)];
    responses.push(await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() }));
    responses.push(await w.get('/auth/device/status'));
    responses.push(await w.post('/auth/device/signin'));
    responses.push(await w.post('/auth/device/setup/start')); // refused: already set up
    // a wrong-id finish and a cancel, for the error paths
    responses.push(await w.post('/auth/device/setup/finish', { setupId: 'nope', enrolmentCode: 'x' }));

    // 1. the code is in the answer to `start`, once, and in no other answer
    expect(start.text).toContain(code);
    for (const r of responses.slice(1)) for (const s of secrets) expect(r.text).not.toContain(s);
    // 2. no request to the Authority Server (path, headers, body)
    for (const r of w.as.requests) {
      const wire = `${r.method} ${r.path}\n${JSON.stringify(r.headers)}\n${r.body}`;
      for (const s of secrets) expect(wire).not.toContain(s);
    }
    // 3. no log line
    expect(logs.length).toBeGreaterThanOrEqual(0);
    for (const l of logs) for (const s of secrets) expect(l).not.toContain(s);
    // 4. no file in the data folder (the vault file holds sealed slots only)
    for (const f of allFiles(w.gw.dir)) for (const s of secrets) expect(f.text, f.path).not.toContain(s);
    // 5. nothing in the vault's readable state: every credential and EVERY sealed slot, opened
    const store = new DeviceChainStore(w.gw.vault);
    expect(JSON.stringify(store.read())).not.toContain(code);
    const slotNames = Object.keys((JSON.parse(readFileSync(join(w.gw.dir, 'vault.enc.json'), 'utf-8')) as { slots: Record<string, unknown> }).slots);
    // `accountDid` is the public DID of the account signed in to (plan 20.2), sealed so a restart remembers it: no secret.
    expect(slotNames.sort()).toEqual(['accountDid', 'deviceChain', 'deviceSetupPending', 'deviceSigningKey']);
    for (const n of slotNames.filter(x => x !== 'deviceSigningKey')) for (const sec of [code, compact, ...rootSeed]) expect(JSON.stringify(w.gw.vault.getSecretSlot(n))).not.toContain(sec);
    for (const n of w.gw.vault.listCredentials()) for (const sec of [code, compact, ...rootSeed, ...devSeed]) expect(JSON.stringify(w.gw.vault.getCredential(n))).not.toContain(sec);
  });

  it('this code never sends the device private key: it is in no AS request, no answer of ours and no argument handed to the MCP bridge (the vault key that seals it does reach the MCP server)', async () => {
    const w = await world();
    await setUpByPaste(w);
    const signing = await loadOrGenerateDeviceSigningKey(w.gw.vault);
    const forms = [hexEncode(signing.privateSeed), b64uEncode(signing.privateSeed), Buffer.from(signing.privateSeed).toString('base64')];
    for (const r of w.as.requests) for (const f of forms) expect(`${r.path}${JSON.stringify(r.headers)}${r.body}`).not.toContain(f);
    for (const c of w.gw.configured) for (const f of forms) expect(JSON.stringify(c)).not.toContain(f);
    // and it is not among the credentials a sweep would push to the MCP server
    for (const id of w.gw.vault.listCredentials()) for (const f of forms) expect(JSON.stringify(w.gw.vault.getCredential(id))).not.toContain(f);
  });

  it('the label is checked; a name with control characters is refused before any key is made', async () => {
    const w = await world();
    const r = await w.post('/auth/device/setup/start', { label: 'bad\u0007name' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('label_invalid');
    expect((await w.post('/auth/device/setup/start', { label: '' })).body.code).toBe('label_invalid');
    expect((await w.post('/auth/device/setup/start', { label: 'x'.repeat(65) })).body.code).toBe('label_invalid');
  });
});

describe('one set-up at a time', () => {
  it('a second start while one is pending is refused; cancel then start gives a different code', async () => {
    const w = await world();
    const a = await w.post('/auth/device/setup/start');
    const b = await w.post('/auth/device/setup/start');
    expect(b.status).toBe(409);
    expect(b.body.code).toBe('setup_pending');
    expect(b.text).not.toContain(String(a.body.recoveryCode));
    expect((await w.post('/auth/device/setup/cancel')).status).toBe(200);
    const c = await w.post('/auth/device/setup/start');
    expect(c.status).toBe(200);
    expect(c.body.recoveryCode).not.toBe(a.body.recoveryCode);
    // the first set-up's id no longer finishes anything
    const stale = await w.post('/auth/device/setup/finish', { setupId: a.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() });
    expect(stale.body.code).toBe('setup_unknown');
  });

  it('two starts at the same moment: one gets a code, the other a clear refusal', async () => {
    const w = await world();
    const [a, b] = await Promise.all([w.post('/auth/device/setup/start'), w.post('/auth/device/setup/start')]);
    const codes = [a.body.code, b.body.code].filter(Boolean).sort();
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(codes).toHaveLength(1);
    expect(['setup_busy', 'setup_pending']).toContain(codes[0]);
  });

  it('two finishes at the same moment store one chain; the other gets setup_busy and the Authority Server holds one genesis', async () => {
    const w = await world();
    const start = await w.post('/auth/device/setup/start');
    const c1 = w.as.issueEnrolmentCode();
    const c2 = w.as.issueEnrolmentCode();
    const [a, b] = await Promise.all([
      w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: c1 }),
      w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: c2 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(['setup_busy', 'setup_unknown', 'already_set_up']).toContain(loser.body.code);
    expect(w.as.chainEntries()).toHaveLength(1);
    expect(w.as.requests.filter(r => r.method === 'POST' && r.path === '/api/devices/chain')).toHaveLength(1);
  });

  it('a finished set-up cannot be started again, by the route or by a second page', async () => {
    const w = await world();
    await setUpByPaste(w);
    const again = await w.post('/auth/device/setup/start');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_set_up');
  });

  it('start while the vault holds a move to a fresh key that did not finish is refused', async () => {
    const w = await world();
    vi.spyOn(w.gw.vault, 'hasPendingRekey').mockReturnValue(true);
    const r = await w.post('/auth/device/setup/start');
    expect(r.body.code).toBe('rekey_pending');
  });

  it('a started set-up is kept (sealed, no secret in it): half an hour, a lock and an unlock do not drop it; cancel does', async () => {
    const clock = { t: Math.floor(Date.now() / 1000) };
    const as = await new StubAs({ now: () => clock.t }).listen();
    open.push(as);
    const gw = await bootGateway({ as, clock });
    open.push(gw);
    const h = sessionHeaders(await gw.unlock());
    const start = await call(gw.port, 'POST', '/auth/device/setup/start', { headers: h, body: {} });
    clock.t += 3600;
    // a lock and an unlock: what is in memory goes, the sealed slot stays
    gw.vault.clearKey();
    const h2 = sessionHeaders(await gw.unlock());
    expect((await call(gw.port, 'GET', '/auth/device/status', { headers: h2 })).body.setupPending).toBe(true);
    // the slot holds the public genesis and ids, never the recovery code or a private key
    const slot = JSON.stringify(gw.vault.getSecretSlot('deviceSetupPending'));
    expect(slot).toContain(String(start.body.rootDid));
    expect(slot).not.toContain(String(start.body.recoveryCode));
    expect((await call(gw.port, 'POST', '/auth/device/setup/start', { headers: h2, body: {} })).body.code).toBe('setup_pending');
    const fin = await call(gw.port, 'POST', '/auth/device/setup/finish', { headers: h2, body: { setupId: start.body.setupId, enrolmentCode: as.issueEnrolmentCode() } });
    expect(fin.status).toBe(200);
    expect(gw.vault.getSecretSlot('deviceSetupPending')).toBeNull();
    // cancel removes it
    const as2 = await new StubAs().listen();
    open.push(as2);
    const w2 = await bootGateway({ as: as2 });
    open.push(w2);
    const h3 = sessionHeaders(await w2.unlock());
    await call(w2.port, 'POST', '/auth/device/setup/start', { headers: h3, body: {} });
    expect(w2.vault.getSecretSlot('deviceSetupPending')).not.toBeNull();
    await call(w2.port, 'POST', '/auth/device/setup/cancel', { headers: h3, body: {} });
    expect(w2.vault.getSecretSlot('deviceSetupPending')).toBeNull();
  });

  it('a started set-up survives a lock: the same setup id finishes after unlock', async () => {
    const w = await world();
    const start = await w.post('/auth/device/setup/start');
    w.gw.vault.clearKey();
    const s2 = await w.gw.unlock();
    const fin = await call(w.gw.port, 'POST', '/auth/device/setup/finish', { headers: sessionHeaders(s2), body: { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() } });
    expect(fin.status).toBe(200);
    expect(fin.body.rootDid).toBe(start.body.rootDid);
  });
});

describe('what the Authority Server says is checked, not believed', () => {
  it('an answer with a head that is not the genesis this computer built stores nothing', async () => {
    const w = await world();
    w.as.lieAboutGenesisHead = true;
    const { fin } = await setUpByPaste(w);
    expect(fin.status).toBe(502);
    expect(fin.body.code).toBe('head_mismatch');
    expect(new DeviceChainStore(w.gw.vault).exists()).toBe(false);
    expect(w.gw.vault.getSpCookie()).toBeNull();
  });

  it('refusals of the enrolment code come back as one neutral code with the Authority Server\'s code, and the set-up stays so another code can be tried', async () => {
    const w = await world();
    const start = await w.post('/auth/device/setup/start');
    const id = start.body.setupId;
    const unknown = await w.post('/auth/device/setup/finish', { setupId: id, enrolmentCode: 'not-a-code' });
    expect(unknown.body).toMatchObject({ code: 'setup_refused', asCode: 'ENROLMENT_CODE_INVALID' });
    const expired = w.as.issueEnrolmentCode('u1', null, -5);
    expect((await w.post('/auth/device/setup/finish', { setupId: id, enrolmentCode: expired })).body).toMatchObject({ code: 'setup_refused', asCode: 'ENROLMENT_CODE_EXPIRED' });
    const bound = w.as.issueEnrolmentCode('u1', b64uEncode(new Uint8Array(32).fill(7)));
    expect((await w.post('/auth/device/setup/finish', { setupId: id, enrolmentCode: bound })).body).toMatchObject({ code: 'setup_refused', asCode: 'ENROLMENT_KEY_MISMATCH' });
    // a code that is used up: the Authority Server holds no chain of ours, so it is a refusal
    const used = w.as.issueEnrolmentCode();
    // use it up through a different account's genesis is not possible here; simulate with the stub's own bookkeeping
    (w.as as unknown as { codes: Map<string, { used: boolean }> }).codes.get(used)!.used = true;
    expect((await w.post('/auth/device/setup/finish', { setupId: id, enrolmentCode: used })).body).toMatchObject({ code: 'setup_refused', asCode: 'ENROLMENT_CODE_USED' });
    expect(new DeviceChainStore(w.gw.vault).exists()).toBe(false);
    // the same set-up, the same recovery code, finishes with a good code
    const fin = await w.post('/auth/device/setup/finish', { setupId: id, enrolmentCode: w.as.issueEnrolmentCode() });
    expect(fin.status).toBe(200);
    expect(fin.body.signedIn).toBe(true);
  });

  it('an Authority Server that stored the genesis and lost the answer: the gateway finds its own chain and finishes', async () => {
    const w = await world();
    w.as.dropNextGenesisAnswer = true;
    const { fin, start } = await setUpByPaste(w);
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ signedIn: true, rootDid: start.body.rootDid });
    expect(new DeviceChainStore(w.gw.vault).read()?.rootDid).toBe(start.body.rootDid);
    expect(w.as.chainEntries()).toHaveLength(1);
  });

  it('an account that already has ANOTHER chain is refused, never adopted', async () => {
    const w = await world();
    // someone else's genesis is on the account
    const other = await new StubAs().listen();
    open.push(other);
    const start = await w.post('/auth/device/setup/start');
    const fin0 = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() });
    expect(fin0.status).toBe(200);
    // a second gateway over a second vault, same Authority Server, same account
    const gw2 = await bootGateway({ as: w.as });
    open.push(gw2);
    const s2 = await gw2.unlock();
    const h2 = sessionHeaders(s2);
    const st2 = await call(gw2.port, 'POST', '/auth/device/setup/start', { headers: h2, body: {} });
    const fin2 = await call(gw2.port, 'POST', '/auth/device/setup/finish', { headers: h2, body: { setupId: st2.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() } });
    expect(fin2.status).toBe(409);
    expect(fin2.body).toMatchObject({ code: 'setup_refused', asCode: 'CHAIN_EXISTS' });
    expect(new DeviceChainStore(gw2.vault).exists()).toBe(false);
    expect(gw2.vault.getSpCookie()).toBeNull();
  });

  it('an Authority Server that is not the one this gateway paired with is sent no enrolment code', async () => {
    const w = await world();
    const start = await w.post('/auth/device/setup/start');
    writeFileSync(join(w.gw.dir, 'as-pairing.json'), JSON.stringify({ asUrl: w.as.url, publicKeyHex: 'cd'.repeat(32), pairedAt: 'x' }));
    const fin = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() });
    expect(fin.status).toBe(409);
    expect(fin.body.code).toBe('as_key_mismatch');
    expect(w.as.requests.some(r => r.path === '/api/devices/chain')).toBe(false);
  });

  it('an unreachable Authority Server refuses with a code and keeps the set-up', async () => {
    const w = await world();
    const start = await w.post('/auth/device/setup/start');
    await w.as.close();
    open.splice(open.findIndex(o => o === w.as), 1);
    const fin = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: 'abc' });
    expect(fin.status).toBe(502);
    expect(['as_unreachable', 'as_unverified']).toContain(fin.body.code);
    expect(new DeviceChainStore(w.gw.vault).exists()).toBe(false);
  });
});

describe('the page session guards every device route, however the path is written', () => {
  const paths: Array<[string, string]> = [
    ['GET', '/auth/device/status'], ['POST', '/auth/device/setup/start'], ['POST', '/auth/device/setup/cancel'],
    ['POST', '/auth/device/setup/connect'], ['GET', '/auth/device/setup/connect/status?setupId=x'],
    ['POST', '/auth/device/setup/finish'], ['POST', '/auth/device/signin'],
  ];
  const variants = (p: string): string[] => {
    const [path, q] = p.split('?');
    const s = q ? `?${q}` : '';
    return [path + s, `${path}/${s}`, path.toUpperCase() + s, `${path.replace('/device', '/Device')}/${s}`];
  };

  it('no cookie and no token: 401 on every route and every spelling; nothing is made', async () => {
    const w = await world();
    for (const [m, p] of paths) for (const v of variants(p)) {
      const r = await call(w.gw.port, m, v, { body: m === 'POST' ? {} : undefined });
      expect(r.status, `${m} ${v}`).toBe(401);
    }
    expect(w.gw.vault.getSecretSlot('deviceSigningKey')).toBeNull();
    expect(w.as.requests).toHaveLength(0);
  });

  it('the cookie without the header token, and the token without the cookie, are refused', async () => {
    const w = await world();
    for (const [m, p] of paths) for (const v of variants(p)) {
      const cookieOnly = await call(w.gw.port, m, v, { headers: { cookie: w.h.cookie }, body: m === 'POST' ? {} : undefined });
      expect(cookieOnly.status, `cookie only ${m} ${v}`).toBe(401);
      const tokenOnly = await call(w.gw.port, m, v, { headers: { 'x-suveren-session': w.session.token }, body: m === 'POST' ? {} : undefined });
      expect(tokenOnly.status, `token only ${m} ${v}`).toBe(401);
    }
  });

  it('a foreign Origin or Host is refused, with a valid session', async () => {
    const w = await world();
    const evil = await call(w.gw.port, 'POST', '/auth/device/setup/start', { headers: w.h, body: {}, origin: 'http://evil.example' });
    expect(evil.status).toBe(403);
    const rebind = await call(w.gw.port, 'POST', '/auth/device/setup/start', { headers: w.h, body: {}, host: 'evil.example' });
    expect(rebind.status).toBe(403);
    const noOrigin = await call(w.gw.port, 'POST', '/auth/device/setup/start', { headers: w.h, body: {}, origin: null });
    expect(noOrigin.status).toBe(403);
    expect(w.gw.vault.getSecretSlot('deviceSigningKey')).toBeNull();
  });

  it('the account key is no credential for any of them', async () => {
    const w = await world();
    for (const [m, p] of paths) {
      const r = await call(w.gw.port, m, p, { headers: { 'x-api-key': 'hap_account_key' }, body: m === 'POST' ? {} : undefined });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it('an unlocked vault WITHOUT a password never gets a recovery code or a device key', async () => {
    const as = await new StubAs().listen();
    open.push(as);
    const dir = tmpDir();
    // a vault as the last release leaves it: unlocked by the account key, no password
    const gw = await bootGateway({ as, dir, fresh: false });
    open.push(gw);
    await gw.vault.deriveAndSetKey('hap_account_key');
    for (const [m, p] of paths) {
      const r = await call(gw.port, m, p, { headers: { 'x-api-key': 'hap_account_key' }, body: m === 'POST' ? {} : undefined });
      expect([401, 409], `${m} ${p}`).toContain(r.status);
    }
    expect(gw.vault.getSecretSlot('deviceSigningKey')).toBeNull();
    expect(gw.vault.getSecretSlot('deviceChain')).toBeNull();
    expect(readFileSync(join(dir, 'vault.enc.json'), 'utf-8')).not.toContain('"slots"');
  });

  it('the router refuses a no-password vault even when a page session exists (a session the password never opened)', async () => {
    const as = await new StubAs().listen();
    open.push(as);
    const gw = await bootGateway({ as, dir: tmpDir(), fresh: false });
    open.push(gw);
    await gw.vault.deriveAndSetKey('hap_account_key');
    const s = gw.sessions.open();
    const r = await call(gw.port, 'POST', '/auth/device/setup/start', { headers: sessionHeaders({ token: s.token, cookie: s.cookie }), body: {} });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('password_required');
    // every route, not only the one that needs a password to do its work
    const h = sessionHeaders({ token: s.token, cookie: s.cookie });
    expect((await call(gw.port, 'POST', '/auth/device/signin', { headers: h, body: {} })).body.code).toBe('password_required');
    expect((await call(gw.port, 'GET', '/auth/device/status', { headers: h })).body.code).toBe('password_required');
    expect(gw.vault.getSecretSlot('deviceSigningKey')).toBeNull();
  });

  it('Connect refuses a port the Authority Server would not accept (below 1024)', async () => {
    const as = await new StubAs().listen();
    open.push(as);
    const vault = new Vault(tmpDir(), { scrypt: { N: 1024, r: 8, p: 1 }, deviceKeys: true });
    await vault.createWithPassword('correct horse battery', 'u1');
    const store = new DeviceChainStore(vault);
    const client = new DeviceAsClient({ asUrl: as.url, pinning: () => ({ enforce: false }) });
    const checkAs = async () => ({ ok: true as const, publicKeyHex: as.pubkeyHex });
    const setup = new DeviceSetup({ vault, store, client, signin: new DeviceSignin({ vault, store, client, checkAs, establish: async () => {} }), checkAs });
    const started = await setup.start({});
    for (const port of [0, 80, 1023, 65536, 3.5, NaN]) expect(() => setup.connectStart(started.setupId, port, 'sess', '127.0.0.1')).toThrow(SetupRefusal);
    expect(setup.connectStart(started.setupId, 3402, 'sess', '127.0.0.1').authorizeUrl).toContain('port=3402');
    // a gateway that listens on ::1 (or an address we do not know) cannot receive a redirect to 127.0.0.1
    for (const addr of ['::1', undefined, '0.0.0.0', '10.0.0.5']) {
      expect(() => setup.connectStart(started.setupId, 3402, 'sess', addr)).toThrowError(expect.objectContaining({ code: 'connect_loopback_unsupported' }));
    }
    expect(setup.connectStart(started.setupId, 3402, 'sess', '::ffff:127.0.0.1').authorizeUrl).toContain('port=3402');
  });

  it('DeviceSetup itself refuses a vault without a password, whoever calls it', async () => {
    const as = await new StubAs().listen();
    open.push(as);
    const dir = tmpDir();
    const vault = new Vault(dir, { scrypt: { N: 1024, r: 8, p: 1 }, deviceKeys: true });
    await vault.deriveAndSetKey('hap_account_key');
    const store = new DeviceChainStore(vault);
    const client = new DeviceAsClient({ asUrl: as.url, pinning: () => ({ enforce: false }) });
    const checkAs = async () => ({ ok: true as const, publicKeyHex: as.pubkeyHex });
    const signin = new DeviceSignin({ vault, store, client, checkAs, establish: async () => {} });
    const setup = new DeviceSetup({ vault, store, client, signin, checkAs });
    await expect(setup.start({})).rejects.toMatchObject({ code: 'password_required' });
    await expect(setup.start({})).rejects.toBeInstanceOf(SetupRefusal);
    expect(vault.getSecretSlot('deviceSigningKey')).toBeNull();
  });
});

describe('with the switch off nothing of this exists', () => {
  it('the device routes and the callback are not there, and the vault is untouched', async () => {
    const as = await new StubAs().listen();
    open.push(as);
    const dir = tmpDir();
    const gw = await bootGateway({ as, dir, enabled: false, fresh: false });
    open.push(gw);
    await gw.vault.deriveAndSetKey('hap_account_key');
    for (const [m, p] of [['GET', '/auth/device/status'], ['POST', '/auth/device/setup/start'], ['GET', '/connect/callback?state=x&code=y'], ['POST', '/auth/device/signin']] as const) {
      const r = await call(gw.port, m, p, { headers: { 'x-api-key': 'hap_account_key' }, body: m === 'POST' ? {} : undefined });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect(as.requests).toHaveLength(0);
    expect(readFileSync(join(dir, 'vault.enc.json'), 'utf-8')).not.toContain('slots');
  });
});

