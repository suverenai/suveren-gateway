/**
 * Re-encrypt every sealed blob in a data folder from one vault key to another.
 *
 * Every store that uses the vault key (vault, services, gates, tickets, ...)
 * writes `{ iv, ciphertext, tag }` blobs, AES-256-GCM directly under the key,
 * inside a `*.enc.json` file in the data folder. So the move to a fresh key
 * needs no knowledge of any store: walk each file, open each blob with the old
 * key, seal it again with the new one.
 *
 * Idempotent, so a crash halfway (or two processes sharing the folder) is
 * repaired by running it again: a blob the old key opens is re-sealed, a blob
 * the new key already opens is left alone, anything else is left untouched and
 * counted. A file is rewritten (write, then rename) only if one of its blobs
 * changed.
 *
 * Duplicated in apps/mcp-server/src/lib/rekey.ts: the two apps share no code.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Blob { iv: string; ciphertext: string; tag: string }

function isBlob(v: unknown): v is Blob {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return typeof b.iv === 'string' && typeof b.ciphertext === 'string' && typeof b.tag === 'string';
}

function open(key: Buffer, b: Blob): Buffer | null {
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'hex'));
    d.setAuthTag(Buffer.from(b.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(b.ciphertext, 'hex')), d.final()]);
  } catch {
    return null;
  }
}

function seal(key: Buffer, plain: Buffer): Blob {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: iv.toString('hex'), ciphertext: ct.toString('hex'), tag: c.getAuthTag().toString('hex') };
}

export interface RekeyResult { reSealed: number; alreadyNew: number; unreadable: number; files: number }

/**
 * The files the control plane owns and seals with the vault key. The control
 * plane re-seals exactly these; the MCP server re-seals everything else in its
 * folder. Neither touches the other's files, so a re-seal that has not been
 * confirmed by the other side never leaves it holding a key that does not fit.
 */
export const CONTROL_PLANE_FILES: readonly string[] = [
  'vault.enc.json', 'services.enc.json', 'shown-snapshots.enc.json', 'approved-intents.enc.json',
];

export interface RekeyOptions {
  /** Only these files. */
  only?: readonly string[];
  /** Every file except these. */
  skip?: readonly string[];
  /** Property names at the top of a file that are not sealed data (the vault's password header). */
  skipTopLevel?: readonly string[];
}

/**
 * `*.enc.json.corrupt-<time>` are copies a store sets aside when it could not
 * open its file (evidence is never started over). They are sealed data like the
 * rest, so they are re-sealed too: removing them would destroy what they were
 * kept for, and leaving them would leave something the old key opens.
 */
const SEALED_FILE = /^(.+\.enc\.json)(\.corrupt-\d+)?$/;

function selected(name: string, options: RekeyOptions, withCorrupt: boolean): boolean {
  const m = SEALED_FILE.exec(name);
  if (!m) return false;
  if (m[2] && !withCorrupt) return false;
  const base = m[1];
  if (options.only && !options.only.includes(base)) return false;
  return !options.skip?.includes(base);
}

export type SealedWith = 'old' | 'new' | 'mixed' | 'empty';

/**
 * Which key the sealed files here are sealed with (copies set aside are left
 * out: they may be older still). 'empty': nothing either key opens.
 */
export function sealedWith(dir: string, oldKey: Buffer, newKey: Buffer, options: RekeyOptions = {}): SealedWith {
  let opensOld = 0, opensNew = 0, unreadable = 0;
  let names: string[];
  try { names = readdirSync(dir).filter(n => selected(n, options, false)); } catch { return 'empty'; }
  const walk = (v: unknown, depth: number, top: boolean): void => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    if (isBlob(v)) {
      if (open(oldKey, v)) opensOld++; else if (open(newKey, v)) opensNew++; else unreadable++;
      return;
    }
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
      if (top && (options.skipTopLevel ?? ['password']).includes(k)) continue;
      walk(c, depth + 1, false);
    }
  };
  for (const n of names) { try { walk(JSON.parse(readFileSync(join(dir, n), 'utf-8')), 0, true); } catch { /* not evidence either way */ } }
  // Blobs neither key opens (a store another account left behind) are noise:
  // whichever key is handed over, they read the same.
  void unreadable;
  if (opensOld && opensNew) return 'mixed';
  if (opensOld) return 'old';
  if (opensNew) return 'new';
  return 'empty';
}

export function rekeyDirectory(dir: string, oldKey: Buffer, newKey: Buffer, options: RekeyOptions = {}): RekeyResult {
  const skipTopLevel = options.skipTopLevel ?? ['password'];
  const result: RekeyResult = { reSealed: 0, alreadyNew: 0, unreadable: 0, files: 0 };
  let names: string[];
  try { names = readdirSync(dir).filter(n => selected(n, options, true)); } catch { return result; }

  const walk = (v: unknown, depth: number, top: boolean): { value: unknown; changed: boolean } => {
    if (depth > 8 || !v || typeof v !== 'object') return { value: v, changed: false };
    if (isBlob(v)) {
      const plain = open(oldKey, v);
      if (plain) { result.reSealed++; const b = seal(newKey, plain); plain.fill(0); return { value: b, changed: true }; }
      if (open(newKey, v)) result.alreadyNew++; else result.unreadable++;
      return { value: v, changed: false };
    }
    let changed = false;
    if (Array.isArray(v)) {
      const out = v.map(c => { const r = walk(c, depth + 1, false); changed ||= r.changed; return r.value; });
      return { value: out, changed };
    }
    const out: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
      if (top && skipTopLevel.includes(k)) { out[k] = c; continue; }
      const r = walk(c, depth + 1, false);
      changed ||= r.changed;
      out[k] = r.value;
    }
    return { value: out, changed };
  };

  for (const name of names.sort()) {
    const path = join(dir, name);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, 'utf-8')); } catch { continue; }
    const r = walk(parsed, 0, true);
    result.files++;
    if (!r.changed) continue;
    const tmp = `${path}.rekey.tmp`;
    writeFileSync(tmp, JSON.stringify(r.value, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
  }
  return result;
}
