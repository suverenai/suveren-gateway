import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { HelperError, UnlockHelperClient, sha256Hash, platformCheckKey, platformCheckProof } from '../src/index.js';
import { unwrapKey, wrapKey } from './fake-helper.mjs';

// The REAL macOS helper, debug build (`pnpm build:helper` makes release; `cd macos && swift build`
// makes debug). Skipped when the binary is not there.
//  - software backend: real process, real protocol, P-256 keys without hardware (no touch)
//  - Secure Enclave backend with SUVEREN_HELPER_NO_PROMPT=1: keys are really made in the Secure
//    Enclave, but every use is refused instead of asking for a touch
const HELPER = fileURLToPath(new URL('../macos/.build/debug/suveren-unlock-helper', import.meta.url));
const have = process.platform === 'darwin' && existsSync(HELPER);
const run = describe.skipIf(!have);

const tmp = mkdtempSync(join(tmpdir(), 'unlock-helper-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function start(args: string[], env: Record<string, string> = {}) {
  return UnlockHelperClient.start({ command: HELPER, args: ['serve', ...args], env: { ...process.env, ...env } });
}
const software = () => start(['--backend', 'software', '--allow-any-caller']);

function pubKey(b64: string) {
  const p = Buffer.from(b64, 'base64url');
  return createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: p.subarray(1, 33).toString('base64url'), y: p.subarray(33).toString('base64url') } });
}

run('real helper, software keys: same code path as the Secure Enclave, no touch', () => {
  it('the wrap format matches the Node reference in both directions', async () => {
    const c = await software();
    try {
      const k = await c.createWrapKey('user-presence');
      const vk = randomBytes(32);
      // Swift wraps, Node unwraps
      const w = await c.wrap({ publicKey: k.publicKey, vaultKey: vk, aad: 'acct-1' });
      expect(unwrapKey(k.keyBlob, Buffer.from(w, 'base64url'), 'acct-1').equals(vk)).toBe(true);
      // Node wraps, Swift unwraps
      const w2 = wrapKey(Buffer.from(k.publicKey, 'base64url'), vk, 'acct-1').toString('base64url');
      expect((await c.unwrap({ keyBlob: k.keyBlob, wrapped: w2, aad: 'acct-1' })).equals(vk)).toBe(true);
      await expect(c.unwrap({ keyBlob: k.keyBlob, wrapped: w2, aad: 'acct-2' })).rejects.toMatchObject({ code: 'unwrap_failed' });
    } finally { c.close(); }
  });

  it('a check signature verifies with Node crypto over the 32 digest bytes, and not over another', async () => {
    const c = await software();
    try {
      const k = await c.createCheckKey('biometry-current-set');
      const object = Buffer.from('{"typ":"suveren-chain-entry","seq":4}');
      const digest = sha256Hash(object);
      const s = await c.signCheck({ keyBlob: k.keyBlob, digest, reason: 'add the device "iPhone"', object });
      const der = Buffer.from(s.signature, 'base64url');
      expect(der[0]).toBe(0x30);
      const key = pubKey(k.publicKey);
      expect(verify('sha256', Buffer.from(digest.slice(7), 'hex'), { key, dsaEncoding: 'der' }, der)).toBe(true);
      expect(verify('sha256', createHash('sha256').update('x').digest(), { key, dsaEncoding: 'der' }, der)).toBe(false);
    } finally { c.close(); }
  });

  it('the helper refuses a digest that is not the hash of the object', async () => {
    const c = await software();
    try {
      const k = await c.createCheckKey('user-presence');
      // bypass the client's own check to hit the helper's
      const raw = (c as unknown as { call(op: string, f: object): Promise<unknown> }).call('check.sign', {
        keyBlob: k.keyBlob, digest: sha256Hash(Buffer.from('a')), reason: 'x', object: Buffer.from('b').toString('base64url'),
      });
      await expect(raw).rejects.toMatchObject({ code: 'digest_mismatch' });
    } finally { c.close(); }
  });

  // hap-core 0.14.0's device-keys module: the verifier the AS and other gateways use.
  // The gateway's hap-core is still 0.13.0, so the path is given by HAP_CORE_DEVICE_KEYS
  // (e.g. .../node_modules/@humanagencyp/hap-core/dist/device-keys/index.mjs).
  it('hap-core verifyCheck accepts the platform check, and refuses it for another object', async (ctx) => {
    let core: any = null;
    const path = process.env.HAP_CORE_DEVICE_KEYS;
    try { core = path ? await import(pathToFileURL(path).href) : await import('@humanagencyp/hap-core/device-keys' as string); } catch { /* not available */ }
    if (!core?.verifyCheck) ctx.skip('hap-core 0.14 device-keys not found: set HAP_CORE_DEVICE_KEYS to its dist/device-keys/index.mjs');
    const c = await software();
    try {
      const k = await c.createCheckKey('biometry-current-set');
      const hash = sha256Hash(Buffer.from('entry bytes'));
      const s = await c.signCheck({ keyBlob: k.keyBlob, digest: hash, reason: 'add the device "iPhone"' });
      expect(await core.verifyCheck(platformCheckKey(k.publicKey), hash, platformCheckProof(s.signature))).toBe(true);
      expect(await core.verifyCheck(platformCheckKey(k.publicKey), sha256Hash(Buffer.from('other entry')), platformCheckProof(s.signature))).toBe(false);
      const other = await c.createCheckKey('user-presence');
      expect(await core.verifyCheck(platformCheckKey(other.publicKey), hash, platformCheckProof(s.signature))).toBe(false);
    } finally { c.close(); }
  });
});

run('real helper, Secure Enclave, prompts switched off', () => {
  const env = { SUVEREN_HELPER_NO_PROMPT: '1' };
  it('describes the computer, makes keys, wraps, and refuses every touch-bound use', async () => {
    const c = await start(['--allow-any-caller'], env);
    try {
      const info = await c.hello();
      expect(info.backend).toBe('secure-enclave');
      if (!info.secureHardware) return;
      const policy = info.biometry ? 'biometry-current-set' : 'user-presence';
      const w = await c.createWrapKey(policy);
      const wrapped = await c.wrap({ publicKey: w.publicKey, vaultKey: randomBytes(32), aad: 'acct-1' });
      await expect(c.unwrap({ keyBlob: w.keyBlob, wrapped, aad: 'acct-1' })).rejects.toMatchObject({ code: 'interaction_required' });
      const ck = await c.createCheckKey(policy);
      await expect(c.signCheck({ keyBlob: ck.keyBlob, digest: sha256Hash(Buffer.from('x')), reason: 'test' })).rejects.toMatchObject({ code: 'interaction_required' });
      await expect(c.unwrap({ keyBlob: 'AAAA', wrapped, aad: 'acct-1' })).rejects.toMatchObject({ code: 'key_invalid' });
    } finally { c.close(); }
  });
});

run('real helper refuses a caller that is not the gateway', () => {
  const gw = join(tmp, 'gw');
  mkdirSync(gw);
  const launcher = join(gw, 'launcher.mjs');
  // Stands in for the gateway: starts the helper, sends hello, prints what came back.
  writeFileSync(launcher, `
    import { spawn } from 'node:child_process';
    const [helper, callers] = process.argv.slice(2);
    const args = ['serve', '--backend', 'software', ...(callers ? ['--allowed-callers', callers] : [])];
    const c = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => out += d); c.stderr.on('data', (d) => err += d);
    c.stdin.on('error', () => {});
    c.stdin.write(JSON.stringify({ id: 1, op: 'hello' }) + '\\n');
    c.on('exit', (code) => { console.log(JSON.stringify({ code, out, err })); });
    setTimeout(() => c.stdin.end(), 700);
  `);
  const callersFile = (prefix: string, name: string) => {
    const f = join(tmp, name);
    writeFileSync(f, JSON.stringify({ v: 1, callers: [{ exe: process.execPath, scriptPrefix: prefix }] }));
    return f;
  };
  const launch = (nodeArgs: string[], callers: string, env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [...nodeArgs, launcher, HELPER, callers], { env: { ...process.env, ...env }, encoding: 'utf8' });
    return JSON.parse(r.stdout) as { code: number; out: string; err: string };
  };

  it('serves the gateway', () => {
    const r = launch([], callersFile(gw, 'ok.json'));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.split('\n')[0]!)).toMatchObject({ ok: true, protocol: 1 });
  });
  it('refuses a parent whose script is outside the gateway install', () => {
    const r = launch([], callersFile(join(tmp, 'elsewhere'), 'other.json'));
    expect(r.code).toBe(77);
    expect(r.out).toBe('');
  });
  it('refuses a parent started with node options', () => {
    expect(launch(['--no-warnings'], callersFile(gw, 'ok2.json')).code).toBe(77);
    expect(launch([], callersFile(gw, 'ok3.json'), { NODE_OPTIONS: '--no-warnings' }).code).toBe(77);
  });
  it('refuses when there is no list of allowed callers', () => {
    expect(launch([], join(tmp, 'missing.json')).code).toBe(77);
  });
  it('refuses a program that starts it without being an allowed parent', async () => {
    // this test process is the parent, and it is not the "gateway"
    await expect(start(['--backend', 'software', '--allowed-callers', callersFile(gw, 'ok4.json')]))
      .rejects.toBeInstanceOf(HelperError);
  });
});
