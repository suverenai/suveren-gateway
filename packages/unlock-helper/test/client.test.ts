import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HelperError, UnlockHelperClient, sha256Hash } from '../src/index.js';

// The helper here is a FAKE (test/fake-helper.mjs): the real helper needs a touch. The real
// helper's own tests are in macos/ (swift test) and test/real-helper.test.ts.
const FAKE = fileURLToPath(new URL('./fake-helper.mjs', import.meta.url));
const clients: UnlockHelperClient[] = [];
async function start(env: Record<string, string> = {}, o: { touchTimeoutMs?: number; quickTimeoutMs?: number } = {}) {
  const c = await UnlockHelperClient.start({ command: process.execPath, args: [FAKE], env: { ...process.env, ...env }, ...o });
  clients.push(c);
  return c;
}
afterEach(() => { while (clients.length) clients.pop()!.close(); });

const vaultKey = () => randomBytes(32);
const digestOf = (s: string) => sha256Hash(Buffer.from(s));

describe('start and hello', () => {
  it('reads the helper description', async () => {
    const c = await start();
    expect(await c.hello()).toMatchObject({ protocol: 1, platform: 'macos', secureHardware: true });
  });
  it('reports a missing helper', async () => {
    await expect(UnlockHelperClient.start({ command: '/nonexistent/helper' })).rejects.toMatchObject({ code: 'helper_missing' });
  });
  it('reports a caller refusal and a helper that exits', async () => {
    await expect(start({ FAKE_REFUSE: '1' })).rejects.toMatchObject({ code: 'caller_refused' });
  });
  it('rejects a helper that speaks another protocol', async () => {
    await expect(UnlockHelperClient.start({ command: process.execPath, args: ['-e', `
      process.stdin.on('data',d=>{const r=JSON.parse(d);process.stdout.write(JSON.stringify({id:r.id,ok:true,helper:'x',version:'1',protocol:99,platform:'macos',backend:'b',secureHardware:true,biometry:true,userPresence:true})+'\\n')})`] }))
      .rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('wrap and unwrap', () => {
  it('round-trips the vault key', async () => {
    const c = await start();
    const k = await c.createWrapKey('user-presence');
    const vk = vaultKey();
    const wrapped = await c.wrap({ publicKey: k.publicKey, vaultKey: vk, aad: 'acct-1' });
    expect(Buffer.from(wrapped, 'base64url').length).toBe(126);
    const back = await c.unwrap({ keyBlob: k.keyBlob, wrapped, aad: 'acct-1' });
    expect(back.equals(vk)).toBe(true);
  });
  it('refuses another account, another key, a changed wrap', async () => {
    const c = await start();
    const k = await c.createWrapKey('biometry-current-set');
    const other = await c.createWrapKey('biometry-current-set');
    const wrapped = await c.wrap({ publicKey: k.publicKey, vaultKey: vaultKey(), aad: 'acct-1' });
    await expect(c.unwrap({ keyBlob: k.keyBlob, wrapped, aad: 'acct-2' })).rejects.toMatchObject({ code: 'unwrap_failed' });
    await expect(c.unwrap({ keyBlob: other.keyBlob, wrapped, aad: 'acct-1' })).rejects.toMatchObject({ code: 'unwrap_failed' });
    const bytes = Buffer.from(wrapped, 'base64url'); bytes[90] ^= 1;
    await expect(c.unwrap({ keyBlob: k.keyBlob, wrapped: bytes.toString('base64url'), aad: 'acct-1' })).rejects.toMatchObject({ code: 'unwrap_failed' });
  });
  it('refuses a vault key that is not 32 bytes, before sending', async () => {
    const c = await start();
    const k = await c.createWrapKey('user-presence');
    await expect(c.wrap({ publicKey: k.publicKey, vaultKey: randomBytes(31), aad: 'a' })).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('passes on a cancelled touch and a locked Touch ID', async () => {
    const k = await (await start()).createWrapKey('user-presence');
    for (const [mode, code] of [['cancel', 'user_cancelled'], ['locked', 'biometry_locked']] as const) {
      const c = await start({ FAKE_TOUCH: mode });
      const wrapped = await c.wrap({ publicKey: k.publicKey, vaultKey: vaultKey(), aad: 'a' });
      await expect(c.unwrap({ keyBlob: k.keyBlob, wrapped, aad: 'a' })).rejects.toMatchObject({ code });
    }
  });
});

const entryObject = (op = 'add', label = 'iPhone') => Buffer.from(JSON.stringify({ typ: 'suveren-chain-entry', op, seq: 1, device: { label }, check: null }));

describe('check key', () => {
  it('signs the digest and the signature verifies over the 32 digest bytes', async () => {
    const c = await start();
    const k = await c.createCheckKey('biometry-current-set');
    const object = entryObject();
    const digest = sha256Hash(object);
    const s = await c.signCheck({ keyBlob: k.keyBlob, digest, object });
    expect(s.publicKey).toBe(k.publicKey);
    expect(s.reason).toBe('add the device "iPhone"');
    const { createPublicKey, verify } = await import('node:crypto');
    const pub = Buffer.from(k.publicKey, 'base64url');
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
    const digestBytes = Buffer.from(digest.slice(7), 'hex');
    expect(verify('sha256', digestBytes, { key, dsaEncoding: 'der' }, Buffer.from(s.signature, 'base64url'))).toBe(true);
    expect(verify('sha256', createHash('sha256').update('other').digest(), { key, dsaEncoding: 'der' }, Buffer.from(s.signature, 'base64url'))).toBe(false);
  });
  it('refuses a digest that is not the object hash, before any touch', async () => {
    const c = await start({ FAKE_TOUCH: 'never' });
    const k = await c.createCheckKey('user-presence');
    await expect(c.signCheck({ keyBlob: k.keyBlob, digest: digestOf('a'), object: entryObject() })).rejects.toMatchObject({ code: 'digest_mismatch' });
  });
  it('refuses malformed digests without calling the helper', async () => {
    const c = await start({ FAKE_TOUCH: 'never' });
    const k = await c.createCheckKey('user-presence');
    for (const digest of ['', 'sha256:abc', digestOf('a').toUpperCase(), digestOf('a').slice(7)]) {
      await expect(c.signCheck({ keyBlob: k.keyBlob, digest, object: entryObject() })).rejects.toMatchObject({ code: 'bad_request' });
    }
  });
  it('has no way to pass prompt text: the helper refuses a request that carries a reason', async () => {
    const c = await start({ FAKE_TOUCH: 'never' });
    const k = await c.createCheckKey('user-presence');
    const object = entryObject();
    const raw = (c as unknown as { call(op: string, f: object): Promise<unknown> }).call('check.sign', {
      keyBlob: k.keyBlob, digest: sha256Hash(object), object: object.toString('base64url'), reason: 'grant the mandate: anything',
    });
    await expect(raw).rejects.toMatchObject({ code: 'bad_request' });
  });
  describe('team join prompts (DEC-73)', () => {
    const DID_A = 'did:key:z6MkAdmin1111111111111111111111111111111111';
    const DID_M = 'did:key:z6MkMember111111111111111111111111111111111';
    const anchor = (admin: string | null) => Buffer.from(JSON.stringify({ typ: 'suveren-team-anchor', v: 1, member_did: DID_M, team_id: 't1', admin_did: admin, version: 1, prev: null, key_id: 'k', chain_seq: 0, chain_head: 'h', created_at: 1, nonce: 'n' }));
    const list = (members: unknown[], version = 1, prev: string | null = null) => Buffer.from(JSON.stringify({ typ: 'suveren-team-members', v: 1, team_id: 't1', version, prev, admin_did: DID_A, members, handover: null, key_id: 'k', chain_seq: 0, chain_head: 'h', created_at: 1, nonce: 'n' }));
    const members = [{ did: DID_A, name: 'Anna Muster', code: '7314 2208 5561 0942 3375 0001' }, { did: DID_M, name: 'Maria Huber', code: '4721 8830 1169 2284 0937 1250' }];
    it('an anchor prompt names the admin of the team, with no text from the caller', async () => {
      const c = await start();
      const k = await c.createCheckKey('user-presence');
      const o = anchor(DID_A);
      expect((await c.signCheck({ keyBlob: k.keyBlob, digest: sha256Hash(o), object: o })).reason).toBe('trust the admin of the team you asked to join');
    });
    it('a member list prompt names the focused member and the identity code from the object', async () => {
      const c = await start();
      const k = await c.createCheckKey('user-presence');
      const o = list(members);
      const r = await c.signCheck({ keyBlob: k.keyBlob, digest: sha256Hash(o), object: o, focus: DID_M });
      expect(r.reason).toBe('add "Maria Huber" to the team, code 4721 8830 1169 2284 0937 1250');
    });
    it('a member list after version 1 without previous is refused before any touch', async () => {
      const c = await start({ FAKE_TOUCH: 'never' });
      const k = await c.createCheckKey('user-presence');
      const o = list(members, 2, 'sha256:' + '0'.repeat(64));
      await expect(c.signCheck({ keyBlob: k.keyBlob, digest: sha256Hash(o), object: o, focus: DID_M })).rejects.toMatchObject({ code: 'bad_request' });
    });
    it('a member list without a focus, or a focus that is not in it, is refused before any touch', async () => {
      const c = await start({ FAKE_TOUCH: 'never' });
      const k = await c.createCheckKey('user-presence');
      const o = list(members);
      await expect(c.signCheck({ keyBlob: k.keyBlob, digest: sha256Hash(o), object: o })).rejects.toMatchObject({ code: 'bad_request' });
      await expect(c.signCheck({ keyBlob: k.keyBlob, digest: sha256Hash(o), object: o, focus: 'did:key:z6MkOther' })).rejects.toMatchObject({ code: 'bad_request' });
    });
    it('a code that carries words is refused, so a name cannot smuggle text in through the code', async () => {
      const c = await start({ FAKE_TOUCH: 'never' });
      const k = await c.createCheckKey('user-presence');
      const o = list([{ did: DID_M, name: 'Maria', code: 'approve everything' }]);
      await expect(c.signCheck({ keyBlob: k.keyBlob, digest: sha256Hash(o), object: o, focus: DID_M })).rejects.toMatchObject({ code: 'bad_request' });
    });
  });
  describe('member list changes with `previous` (DEC-73 step 5): the helper diffs the two lists and says what is signed', () => {
    const A = 'did:key:z6MkAdmin1111111111111111111111111111111111';
    const M = 'did:key:z6MkMember111111111111111111111111111111111';
    const N = 'did:key:z6MkNewone111111111111111111111111111111111';
    const mem = (did: string, name: string, code: string) => ({ did, name, code });
    const ANNA = mem(A, 'Anna Muster', '7314 2208 5561 0942 3375 0001');
    const MARIA = mem(M, 'Maria Huber', '4721 8830 1169 2284 0937 1250');
    const NEWO = mem(N, 'Maria Huber', '1111 2222 3333 4444 5555 6666');
    const BOB = mem('did:key:z6MkBob11111111111111111111111111111111111111', 'Bob', '9999 8888 7777 6666 5555 4444');
    const body = (version: number, prev: string | null, admin: string, members: unknown[], handover: unknown = null) =>
      ({ typ: 'suveren-team-members', v: 1, team_id: 't1', version, prev, admin_did: admin, members, handover, key_id: 'k', chain_seq: 0, chain_head: 'h', created_at: 1, nonce: 'n' });
    const bytes = (o: unknown) => Buffer.from(JSON.stringify(o));
    const prevList = bytes(body(2, 'sha256:' + '0'.repeat(64), A, [ANNA, MARIA, BOB]));
    const next = (admin: string, members: unknown[], handover: unknown = null, version = 3, prev = sha256Hash(prevList)) => bytes(body(version, prev, admin, members, handover));
    const sign = async (o: Buffer, previous: Buffer | undefined, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
      const c = await start(env);
      const k = await c.createCheckKey('user-presence');
      return c.signCheck({ keyBlob: k.keyBlob, digest: sha256Hash(o), object: o, ...(previous ? { previous } : {}), ...extra });
    };
    it('removes one member', async () => {
      expect((await sign(next(A, [ANNA, BOB]), prevList)).reason).toBe('remove "Maria Huber" from the team, code 4721 8830 1169 2284');
    });
    it('replaces one member by another, with the new one\'s code', async () => {
      expect((await sign(next(A, [ANNA, NEWO, BOB]), prevList)).reason).toBe('new identity for "Maria Huber", code 1111 2222 3333 4444 5555 6666');
    });
    it('signs the same list again', async () => {
      expect((await sign(next(A, [ANNA, MARIA, BOB]), prevList)).reason).toBe('sign the team list again');
    });
    it('hands the team over to a member', async () => {
      const h = { admin_did: A, key_id: 'ka', chain_seq: 1, chain_head: 'x' };
      expect((await sign(next(M, [ANNA, MARIA, BOB], h), prevList)).reason).toBe('hand the team over to "Maria Huber"');
    });
    it('still adds one (with previous, the added member is found by the helper, no focus needed)', async () => {
      expect((await sign(next(A, [ANNA, MARIA, BOB, NEWO]), prevList)).reason).toBe('add "Maria Huber" to the team, code 1111 2222 3333 4444 5555 6666');
    });
    const refused = async (o: Buffer, previous: Buffer) => {
      const c = await start({ FAKE_TOUCH: 'never' });
      const k = await c.createCheckKey('user-presence');
      await expect(c.signCheck({ keyBlob: k.keyBlob, digest: sha256Hash(o), object: o, previous })).rejects.toMatchObject({ code: 'bad_request' });
    };
    it('refuses a previous that is not the list this one follows, another team, or not the version before', async () => {
      await refused(next(A, [ANNA, BOB], null, 3, 'sha256:' + '1'.repeat(64)), prevList);
      await refused(next(A, [ANNA, BOB], null, 4), prevList);
      await refused(bytes({ ...body(3, sha256Hash(prevList), A, [ANNA, BOB]), team_id: 't2' }), prevList);
      await refused(next(A, [ANNA, BOB]), Buffer.from('{}'));
    });
    it('refuses mixed or unknown differences: two removed, a removed admin, a changed entry, a hand-over that also changes members, a hand-over with the same admin', async () => {
      await refused(next(A, [ANNA]), prevList);
      await refused(next(M, [MARIA, BOB]), prevList);
      await refused(next(A, [ANNA, { ...MARIA, name: 'Mallory' }, BOB]), prevList);
      await refused(next(M, [ANNA, MARIA], { admin_did: A, key_id: 'ka', chain_seq: 1, chain_head: 'x' }), prevList);
      await refused(next(A, [ANNA, MARIA, BOB], { admin_did: A, key_id: 'ka', chain_seq: 1, chain_head: 'x' }), prevList);
      await refused(next(M, [ANNA, MARIA, BOB]), prevList); // a change of admin without the hand-over
    });
    it('the caller cannot add words: a 120-character limit applies to the built text', async () => {
      const long = mem(M, 'x'.repeat(130), MARIA.code);
      const p = bytes(body(2, 'sha256:' + '0'.repeat(64), A, [ANNA, long, BOB]));
      await refused(bytes(body(3, sha256Hash(p), A, [ANNA, BOB])), p);
    });
  });
  it('refuses an object it has no prompt text for', async () => {
    const c = await start({ FAKE_TOUCH: 'never' });
    const k = await c.createCheckKey('user-presence');
    for (const object of [Buffer.from('{}'), Buffer.from('not json'), Buffer.from('{"typ":"suveren-chain-entry","op":"launch"}')]) {
      await expect(c.signCheck({ keyBlob: k.keyBlob, digest: sha256Hash(object), object })).rejects.toMatchObject({ code: 'bad_request' });
    }
  });
});

describe('process behaviour', () => {
  it('answers one request at a time, in order', async () => {
    const c = await start({ FAKE_TOUCH: 'slow' });
    const k = await c.createWrapKey('user-presence');
    const vks = [vaultKey(), vaultKey(), vaultKey()];
    const wraps = await Promise.all(vks.map((vk) => c.wrap({ publicKey: k.publicKey, vaultKey: vk, aad: 'a' })));
    const backs = await Promise.all(wraps.map((w) => c.unwrap({ keyBlob: k.keyBlob, wrapped: w, aad: 'a' })));
    backs.forEach((b, i) => expect(b.equals(vks[i]!)).toBe(true));
  });
  it('times out a touch that never comes and ends the helper', async () => {
    const c = await start({ FAKE_TOUCH: 'never' }, { touchTimeoutMs: 200 });
    const k = await c.createWrapKey('user-presence');
    const wrapped = await c.wrap({ publicKey: k.publicKey, vaultKey: vaultKey(), aad: 'a' });
    await expect(c.unwrap({ keyBlob: k.keyBlob, wrapped, aad: 'a' })).rejects.toMatchObject({ code: 'timeout' });
    await expect(c.hello()).rejects.toBeInstanceOf(HelperError);   // the helper was ended; no late touch can answer
  });
  it('fails pending and later calls when the helper dies', async () => {
    const c = await start();
    const k = await c.createCheckKey('user-presence');
    process.kill((c as unknown as { child: { pid: number } }).child.pid, 'SIGKILL');
    await expect(c.createWrapKey('user-presence')).rejects.toMatchObject({ code: 'helper_exited' });
    await expect(c.signCheck({ keyBlob: k.keyBlob, digest: sha256Hash(entryObject()), object: entryObject() })).rejects.toMatchObject({ code: 'helper_exited' });
  });
  it('rejects an answer that is not valid', async () => {
    const c = await UnlockHelperClient.start({ command: process.execPath, args: ['-e', `
      let n=0;process.stdin.on('data',d=>{const r=JSON.parse(d);n++;
      const base={id:r.id,ok:true,helper:'x',version:'1',protocol:1,platform:'macos',backend:'b',secureHardware:true,biometry:true,userPresence:true};
      process.stdout.write(JSON.stringify(n===1?base:{id:r.id,ok:true,vaultKey:'AAAA'})+'\\n')})`] });
    clients.push(c);
    await expect(c.unwrap({ keyBlob: 'x', wrapped: 'y', aad: 'a' })).rejects.toMatchObject({ code: 'bad_response' });
  });
});
