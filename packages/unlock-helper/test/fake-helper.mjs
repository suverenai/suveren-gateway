// A FAKE helper for tests: speaks the protocol (DESIGN.md section 3) with Node crypto and software
// keys, no hardware and no touch. It also serves as the reference for the wrap format that the
// Swift helper and a future Windows helper must match.
// Behaviour switches (environment): FAKE_TOUCH = ok | cancel | slow | locked | never
//                                   FAKE_REFUSE = 1 (answer caller_refused and exit)
import crypto from 'node:crypto';

const INFO = Buffer.from('suveren-unlock-wrap-v1');

export function newKey() {
  const e = crypto.createECDH('prime256v1');
  e.generateKeys();
  return { blob: e.getPrivateKey().toString('base64url'), pub: e.getPublicKey(null, 'uncompressed') };
}
function load(blob) {
  const d = Buffer.from(blob, 'base64url');
  if (d.length !== 32) throw err('key_invalid', 'Bad key blob.');
  const e = crypto.createECDH('prime256v1');
  e.setPrivateKey(d);
  return e;
}
function derive(secret, eph, wrapPub) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.concat([eph, wrapPub]), INFO, 32));
}
export function wrapKey(wrapPub, vaultKey, aad) {
  const e = crypto.createECDH('prime256v1');
  e.generateKeys();
  const ephPub = e.getPublicKey(null, 'uncompressed');
  const key = derive(e.computeSecret(wrapPub), ephPub, wrapPub);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(vaultKey), c.final()]);
  return Buffer.concat([Buffer.from([1]), ephPub, nonce, ct, c.getAuthTag()]);
}
export function unwrapKey(blob, wrapped, aad) {
  const e = load(blob);
  if (wrapped.length !== 126 || wrapped[0] !== 1) throw err('unwrap_failed', 'Not a wrap this helper made.');
  const ephPub = wrapped.subarray(1, 66), nonce = wrapped.subarray(66, 78), ct = wrapped.subarray(78, 110), tag = wrapped.subarray(110);
  try {
    const key = derive(e.computeSecret(ephPub), ephPub, e.getPublicKey(null, 'uncompressed'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(Buffer.from(aad)); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch { throw err('unwrap_failed', 'The wrap does not open here.'); }
}
export function signDigest(blob, digestBytes) {
  const e = load(blob);
  const pub = e.getPublicKey(null, 'uncompressed');
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: e.getPrivateKey().toString('base64url'), x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  return { signature: crypto.sign('sha256', digestBytes, { key, dsaEncoding: 'der' }), pub };
}

function err(code, message) { return Object.assign(new Error(message), { code }); }

async function touch() {
  const mode = process.env.FAKE_TOUCH ?? 'ok';
  if (mode === 'cancel') throw err('user_cancelled', 'The person cancelled.');
  if (mode === 'locked') throw err('biometry_locked', 'Touch ID is locked.');
  if (mode === 'never') await new Promise(() => {});
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 300));
}

const b = (s, k) => { if (typeof s[k] !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s[k])) throw err('bad_request', `${k} must be base64url.`); return Buffer.from(s[k], 'base64url'); };

async function run(r) {
  switch (r.op) {
    case 'hello':
      return { helper: 'fake-helper', version: '0.0.0', protocol: 1, platform: 'macos', backend: 'fake', secureHardware: true, biometry: true, userPresence: true };
    case 'wrap.create': case 'check.create': {
      if (!['user-presence', 'biometry-current-set', 'biometry-any'].includes(r.policy)) throw err('bad_request', 'policy');
      const k = newKey();
      return { keyBlob: k.blob, publicKey: k.pub.toString('base64url'), policy: r.policy };
    }
    case 'wrap': {
      const vk = b(r, 'vaultKey');
      if (vk.length !== 32) throw err('bad_request', 'vaultKey must be 32 bytes.');
      return { wrapped: wrapKey(b(r, 'publicKey'), vk, String(r.aad)).toString('base64url') };
    }
    case 'unwrap': {
      await touch();
      return { vaultKey: unwrapKey(r.keyBlob, b(r, 'wrapped'), String(r.aad)).toString('base64url') };
    }
    case 'check.sign': {
      if (!/^sha256:[0-9a-f]{64}$/.test(r.digest)) throw err('bad_request', 'digest');
      const digest = Buffer.from(r.digest.slice(7), 'hex');
      if (r.object !== undefined && !crypto.createHash('sha256').update(b(r, 'object')).digest().equals(digest)) throw err('digest_mismatch', 'digest is not the SHA-256 of object.');
      process.stderr.write(`fake prompt: "${r.reason}"\n`);
      await touch();
      const s = signDigest(r.keyBlob, digest);
      return { signature: s.signature.toString('base64url'), publicKey: s.pub.toString('base64url') };
    }
    case 'shutdown': return {};
    default: throw err('unsupported', `Unknown op ${r.op}.`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.env.FAKE_REFUSE === '1') {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'caller_refused', message: 'The caller is not the gateway.' } }) + '\n');
    process.exit(77);
  }
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let req;
      try { req = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ ok: false, error: { code: 'bad_request', message: 'Not JSON.' } }) + '\n'); continue; }
      let out = { id: req.id };
      try { out = { ...out, ok: true, ...(await run(req)) }; }
      catch (e) { out = { id: req.id, ok: false, error: { code: e.code ?? 'internal', message: e.message } }; }
      process.stdout.write(JSON.stringify(out) + '\n');
      if (req.op === 'shutdown') process.exit(0);
    }
  });
}
