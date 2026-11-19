/**
 * The profile pin. `profiles.lock` (repo root) names ONE commit of
 * hap-profiles and the sha256 of every file in it. The gateway enforces
 * mandates against the profiles it ships, so what it ships must be exactly
 * what a person reviewed at release time: not whatever `main` of hap-profiles
 * happens to hold when a CI job runs.
 *
 * Plain ESM, no dependencies: used by bundle/build.mjs, by
 * scripts/refresh-profiles-lock.mjs, and by the tests.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A lock path must stay inside the profiles directory: no absolute path, no `..`. */
function safeRelative(rel) {
  if (typeof rel !== 'string' || rel === '' || isAbsolute(rel) || rel.includes('\\')) return false;
  const n = normalize(rel);
  return !n.startsWith('..') && n === rel;
}

/** Read and validate a lock file. Throws with a plain reason when it is unusable. */
export function readLock(lockPath) {
  if (!existsSync(lockPath)) throw new Error(`profiles.lock not found at ${lockPath}`);
  let lock;
  try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); }
  catch (err) { throw new Error(`profiles.lock is not valid JSON: ${err instanceof Error ? err.message : err}`); }
  if (!lock || typeof lock !== 'object') throw new Error('profiles.lock is not an object');
  if (typeof lock.repository !== 'string' || !lock.repository) throw new Error('profiles.lock has no "repository"');
  if (typeof lock.commit !== 'string' || !COMMIT.test(lock.commit)) throw new Error('profiles.lock "commit" must be a full 40-character commit sha');
  if (!lock.files || typeof lock.files !== 'object' || Array.isArray(lock.files)) throw new Error('profiles.lock has no "files"');
  const entries = Object.entries(lock.files);
  if (entries.length === 0) throw new Error('profiles.lock lists no files');
  for (const [rel, hash] of entries) {
    if (!safeRelative(rel)) throw new Error(`profiles.lock names an unsafe path: ${rel}`);
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) throw new Error(`profiles.lock has no valid sha256 for ${rel}`);
  }
  if (!('index.json' in lock.files)) throw new Error('profiles.lock does not list index.json');
  return lock;
}

/**
 * Check a profiles directory against the lock. Returns the problems found
 * (empty = every locked file is present and byte-identical, and the index
 * names only locked files). Files in the directory that the lock does not
 * list are ignored here — they are never copied (see `lockedFiles`).
 */
export function verifyProfilesAgainstLock(dir, lock) {
  const problems = [];
  for (const [rel, expected] of Object.entries(lock.files)) {
    const path = join(dir, rel);
    if (!existsSync(path)) { problems.push(`${rel}: missing`); continue; }
    const actual = sha256OfFile(path);
    if (actual !== expected) problems.push(`${rel}: sha256 is ${actual}, the lock says ${expected}`);
  }
  if (problems.length === 0) {
    // The loader reads exactly what index.json names: every one must be pinned.
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    for (const rel of Object.values(index.profiles ?? {})) {
      if (!(rel in lock.files)) problems.push(`${rel}: named in index.json but not in the lock`);
    }
  }
  return problems;
}

/** The files the bundle may ship from the profiles directory: exactly the locked ones. */
export function lockedFiles(lock) {
  return Object.keys(lock.files);
}

/** Build the lock content from a directory and the commit it was read at. */
export function buildLock({ repository, commit, dir, files }) {
  const out = {};
  for (const rel of [...files].sort()) out[rel] = sha256OfFile(join(dir, rel));
  return { repository, commit, files: out };
}
