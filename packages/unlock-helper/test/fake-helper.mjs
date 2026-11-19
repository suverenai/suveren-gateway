// A FAKE helper for tests: speaks the protocol (DESIGN.md section 3) with Node crypto and software
// keys, no hardware and no touch. It also serves as the reference for the wrap format that the
// Swift helper and a future Windows helper must match.
// Behaviour switches (environment): FAKE_TOUCH = ok | cancel | slow | locked | never
//                                   FAKE_REFUSE = 1 (answer caller_refused and exit)
//                                   FAKE_WRONG_SIGNATURE = 1 (sign another digest than asked: a lying helper)
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

// The prompt text, built from the object being signed (mirror of macos/Sources/UnlockCore/Reason.swift;
// a test compares it with the real helper's on the same objects). PLACEHOLDER wording (O19).
const CHANGE_MEMBERS = ['request_id', 'kind', 'name', 'change_hash', 'gateway_key_id', 'expires_at'].sort().join(',');
const SWITCH_MEMBERS = ['typ', 'v', 'action', 'nonce', 'issued_at'].sort().join(',');
const CANCEL_MEMBERS = ['typ', 'v', 'aud', 'root_did', 'key_id', 'request_id', 'chain_seq', 'chain_head', 'issued_at'].sort().join(',');
const GRANT_FIXED = ['typ', 'v', 'op', 'owner_did', 'key_id', 'chain_seq', 'chain_head', 'mandate_id', 'mandate_version', 'granted_at', 'nonce'];
const quoted = (x) => `"${x.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const ANCHOR_MEMBERS = ['typ', 'v', 'member_did', 'team_id', 'admin_did', 'version', 'prev', 'key_id', 'chain_seq', 'chain_head', 'created_at', 'nonce'].sort().join(',');
const LIST_MEMBERS = ['typ', 'v', 'team_id', 'version', 'prev', 'admin_did', 'members', 'handover', 'key_id', 'chain_seq', 'chain_head', 'created_at', 'nonce'].sort().join(',');
export function reasonFor(bytes, focus) {
  let o;
  try { o = JSON.parse(bytes.toString('utf8')); } catch { throw err('bad_request', 'object is not a JSON object.'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw err('bad_request', 'object is not a JSON object.');
  const label = () => { const l = o.device && o.device.label; if (typeof l !== 'string') throw err('bad_request', 'chain entry has no device label.'); return l; };
  let text;
  if (o.typ === 'suveren-chain-entry') {
    switch (o.op) {
      case 'genesis': text = `set up the device ${quoted(label())} with its own key`; break;
      case 'add': text = `add the device ${quoted(label())}`; break;
      case 'reset': text = `replace every device with ${quoted(label())}`; break;
      case 'remove': text = 'remove a device'; break;
      case 'set': text = o.check == null ? 'remove the check key of a device' : 'give a device a check key'; break;
      case 'rotate-root': text = 'replace the recovery code'; break;
      default: throw err('bad_request', 'chain entry has an unknown op.');
    }
  } else if (Object.keys(o).sort().join(',') === CHANGE_MEMBERS && (o.kind === 'replace' || o.kind === 'remove') && typeof o.name === 'string' && o.name) {
    text = `${o.kind === 'replace' ? 'replace' : 'remove'} the login of ${quoted(o.name)}`;
  } else if (o.typ === 'suveren-platform-unlock' && Object.keys(o).sort().join(',') === SWITCH_MEMBERS && (o.action === 'enable' || o.action === 'disable')) {
    text = o.action === 'enable' ? 'turn on Touch ID unlock for Suveren' : 'turn off Touch ID unlock for Suveren';
  } else if (o.typ === 'suveren-identity-cancel' && Object.keys(o).sort().join(',') === CANCEL_MEMBERS) {
    text = 'cancel the request for a new identity';
  } else if (o.typ === 'suveren-team-anchor' && Object.keys(o).sort().join(',') === ANCHOR_MEMBERS) {
    text = o.admin_did === null ? 'stop trusting the admin of a team' : 'trust the admin of the team you asked to join';
  } else if (o.typ === 'suveren-team-members' && Object.keys(o).sort().join(',') === LIST_MEMBERS) {
    const m = typeof focus === 'string' && Array.isArray(o.members) ? o.members.find(x => x && x.did === focus) : undefined;
    if (!m || typeof m.name !== 'string' || !m.name || typeof m.code !== 'string' || !/^[0-9]{4}( [0-9]{4}){5}$/.test(m.code)) throw err('bad_request', 'a member list needs a focus that names one of its members.');
    text = `add ${quoted(m.name)} to the team, code ${m.code}`;
  } else if (o.typ === 'suveren-mandate-grant' && GRANT_FIXED.every(k => k in o) && typeof o.profile_id === 'string' && o.profile_id && (o.op === 'grant' || o.op === 'change')) {
    text = `${o.op === 'grant' ? 'grant' : 'change'} the mandate for ${quoted(o.profile_id)}`;
  } else throw err('bad_request', 'object is of a kind this helper has no prompt text for.');
  const n = Array.from(text).length;
  if (n < 1 || n > 120 || text.normalize('NFC') !== text || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) throw err('bad_request', 'prompt text is not acceptable.');
  return text;
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
    case 'unwrap': {
      await touch();
      return { vaultKey: unwrapKey(r.keyBlob, b(r, 'wrapped'), String(r.aad)).toString('base64url') };
    }
    case 'check.sign': {
      if (!/^sha256:[0-9a-f]{64}$/.test(r.digest)) throw err('bad_request', 'digest');
      if (r.reason !== undefined) throw err('bad_request', 'reason is not accepted: the helper builds it from the object.');
      const digest = Buffer.from(r.digest.slice(7), 'hex');
      if (typeof r.object !== 'string') throw err('bad_request', 'object must be base64url.');
      const object = b(r, 'object');
      if (!crypto.createHash('sha256').update(object).digest().equals(digest)) throw err('digest_mismatch', 'digest is not the SHA-256 of object.');
      if (r.focus !== undefined && (typeof r.focus !== 'string' || r.focus.length > 200)) throw err('bad_request', 'focus must be a DID string.');
      const reason = reasonFor(object, r.focus);
      process.stderr.write(`fake prompt: "${reason}"\n`);
      await touch();
      const s = signDigest(r.keyBlob, process.env.FAKE_WRONG_SIGNATURE === '1' ? crypto.createHash('sha256').update('other').digest() : digest);
      return { signature: s.signature.toString('base64url'), publicKey: s.pub.toString('base64url'), reason };
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
