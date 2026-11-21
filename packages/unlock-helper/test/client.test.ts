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

describe('check key', () => {
  it('signs the digest and the signature verifies over the 32 digest bytes', async () => {
    const c = await start();
    const k = await c.createCheckKey('biometry-current-set');
    const object = Buffer.from('{"typ":"suveren-chain-entry","seq":1}');
    const digest = sha256Hash(object);
    const s = await c.signCheck({ keyBlob: k.keyBlob, digest, reason: 'add the device "iPhone"', object });
    expect(s.publicKey).toBe(k.publicKey);
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
    await expect(c.signCheck({ keyBlob: k.keyBlob, digest: digestOf('a'), reason: 'x', object: Buffer.from('b') })).rejects.toMatchObject({ code: 'digest_mismatch' });
  });
  it('refuses malformed digests and reasons without calling the helper', async () => {
    const c = await start({ FAKE_TOUCH: 'never' });
    const k = await c.createCheckKey('user-presence');
    const base = { keyBlob: k.keyBlob, digest: digestOf('a'), reason: 'ok' };
    for (const digest of ['', 'sha256:abc', digestOf('a').toUpperCase(), digestOf('a').slice(7)]) {
      await expect(c.signCheck({ ...base, digest })).rejects.toMatchObject({ code: 'bad_request' });
    }
    for (const reason of ['', 'a'.repeat(121), 'two\nlines', 'bidi‮override']) {
      await expect(c.signCheck({ ...base, reason })).rejects.toMatchObject({ code: 'bad_request' });
    }
    // exactly 120 characters is accepted (a helper that signs at once)
    const ok = await start();
    const k2 = await ok.createCheckKey('user-presence');
    await expect(ok.signCheck({ keyBlob: k2.keyBlob, digest: digestOf('a'), reason: 'a'.repeat(120) })).resolves.toHaveProperty('signature');
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
    await expect(c.signCheck({ keyBlob: k.keyBlob, digest: digestOf('a'), reason: 'x' })).rejects.toMatchObject({ code: 'helper_exited' });
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
