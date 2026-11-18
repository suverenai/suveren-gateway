#!/usr/bin/env node
// Manual check of the REAL Secure Enclave helper. It asks for Touch ID, so it never runs in tests.
//   node manual-check.mjs unlock [--policy user-presence|biometry-current-set|biometry-any]
//   node manual-check.mjs check  [--policy …] [--label "<device name>"] [--hap-core <path to hap-core dist/device-keys/index.mjs>]
// Uses the debug build (`swift build`) with --allow-any-caller, or the helper named in UNLOCK_HELPER. Prints PASS / FAIL lines only;
// never prints a key. Keys exist in memory for this run only; nothing is stored anywhere.
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
const policy = opt('--policy', 'biometry-current-set');
const helper = process.env.UNLOCK_HELPER ?? fileURLToPath(new URL('.build/debug/suveren-unlock-helper', import.meta.url));
if (!['unlock', 'check'].includes(cmd)) { console.error('usage: manual-check.mjs unlock|check [--policy …]'); process.exit(64); }

const child = spawn(helper, ['serve', '--allow-any-caller'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const waiting = new Map(); let nextId = 1;
child.stdout.setEncoding('utf8').on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
});
const call = (op, f = {}) => new Promise((res) => { const id = nextId++; waiting.set(id, res); child.stdin.write(JSON.stringify({ id, op, ...f }) + '\n'); });
let failed = 0;
const report = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed++; };
const code = (r) => r.ok ? 'ok' : r.error.code;

const hello = await call('hello');
console.log(`helper ${hello.version}, backend ${hello.backend}, secure hardware ${hello.secureHardware}, biometry ${hello.biometry}, user presence ${hello.userPresence}`);
if (!hello.secureHardware) { console.log('FAIL  no Secure Enclave here'); process.exit(1); }

if (cmd === 'unlock') {
  const k = await call('wrap.create', { policy });
  report(k.ok, `make a wrap key in the Secure Enclave (${policy})`);
  const vk = randomBytes(32);
  const w = await call('wrap', { publicKey: k.publicKey, vaultKey: vk.toString('base64url'), aad: 'manual-check' });
  report(w.ok, 'wrap a random 32-byte key (no touch expected)');
  console.log('\n>>> TOUCH 1: the prompt should say "… is trying to unlock the Suveren vault". Touch the sensor.');
  const u = await call('unwrap', { keyBlob: k.keyBlob, wrapped: w.wrapped, aad: 'manual-check' });
  report(u.ok && Buffer.from(u.vaultKey, 'base64url').equals(vk), `unwrap after the touch returns the same key (${code(u)})`);
  console.log('\n>>> TOUCH 2: this time press CANCEL (or Escape).');
  const c = await call('unwrap', { keyBlob: k.keyBlob, wrapped: w.wrapped, aad: 'manual-check' });
  report(code(c) === 'user_cancelled', `cancel gives user_cancelled (${code(c)})`);
  console.log('\n>>> TOUCH 3: touch again; the key is opened but the account does not match, so it must be refused.');
  const x = await call('unwrap', { keyBlob: k.keyBlob, wrapped: w.wrapped, aad: 'another account' });
  report(code(x) === 'unwrap_failed' && !x.vaultKey, `a wrap for another account does not open (${code(x)})`);
} else {
  // The helper builds the prompt text from this object; there is no way to pass text. A longer
  // --label shows how macOS cuts a long prompt (the label is at most 64 characters in a chain).
  const label = opt('--label', 'This computer');
  const k = await call('check.create', { policy });
  report(k.ok, `make a check key in the Secure Enclave (${policy})`);
  const object = Buffer.from(JSON.stringify({ typ: 'suveren-chain-entry', op: 'add', seq: 1, device: { label }, check: null, nonce: randomBytes(8).toString('hex') }));
  const digest = 'sha256:' + createHash('sha256').update(object).digest('hex');
  console.log(`\n>>> TOUCH: the prompt should say "… is trying to add the device "${label}"". Read it fully (is it cut off?), then touch.`);
  const s = await call('check.sign', { keyBlob: k.keyBlob, digest, object: object.toString('base64url') });
  report(s.ok, `sign after the touch (${code(s)})`);
  if (s.ok) {
    const pub = Buffer.from(k.publicKey, 'base64url');
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
    const sig = Buffer.from(s.signature, 'base64url');
    const d = Buffer.from(digest.slice(7), 'hex');
    report(verify('sha256', d, { key, dsaEncoding: 'der' }, sig), 'Node verifies the DER signature over the 32 digest bytes');
    report(!verify('sha256', createHash('sha256').update('another object').digest(), { key, dsaEncoding: 'der' }, sig), 'the same signature is refused for another digest');
    const core = opt('--hap-core');
    if (core) {
      const { verifyCheck } = await import(pathToFileURL(core).href);
      report(await verifyCheck({ type: 'platform', pub: k.publicKey }, digest, { signature: s.signature }), 'hap-core verifyCheck accepts it');
    }
  }
  if (s.ok) console.log(`\nThe helper reports it showed: "${s.reason}"`);
}
child.stdin.end();
process.exit(failed ? 1 : 0);
