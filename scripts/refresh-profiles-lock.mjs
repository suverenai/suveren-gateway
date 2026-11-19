#!/usr/bin/env node
/**
 * Refresh profiles.lock — run by a PERSON at release time, after reading the
 * profile changes since the last lock (`git -C <checkout> diff <old>..HEAD`).
 *
 *   node scripts/refresh-profiles-lock.mjs [path/to/hap-profiles]
 *
 * The checkout defaults to ../hap-profiles. It pins the checkout's HEAD, so
 * check out the commit you reviewed first. Refuses when:
 *   - the checkout has local changes to tracked files (the lock would not
 *     describe any commit),
 *   - HEAD is not on origin/main (CI could not fetch it from the real repo).
 * The hashes are read from the commit's own blobs (git show), never from the
 * working tree, so a stray local edit cannot slip into the lock.
 * Files under test-results/ (tracked by accident in hap-profiles) are left out: they never ship.
 * It changes no version number; commit the new profiles.lock yourself.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? join(REPO_ROOT, '..', 'hap-profiles'));

const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const text = (...a) => git(...a).toString('utf8').trim();

function fail(msg) { console.error(`[profiles-lock] ${msg}`); process.exit(1); }

let commit;
try { commit = text('rev-parse', 'HEAD'); } catch { fail(`${dir} is not a git checkout of hap-profiles`); }
if (text('status', '--porcelain', '--untracked-files=no') !== '') {
  fail(`${dir} has local changes to tracked files. Commit or discard them: the lock must describe a real commit.`);
}
try { git('fetch', '--quiet', 'origin', 'main'); } catch { fail('could not fetch origin/main to check the commit is published'); }
try { git('merge-base', '--is-ancestor', commit, 'origin/main'); } catch { fail(`${commit} is not on origin/main. Push it first, or check out a published commit.`); }

const repository = text('config', '--get', 'remote.origin.url').replace(/^(https:\/\/|git@)/, '').replace(':', '/').replace(/\.git$/, '');
const files = {};
for (const rel of text('ls-tree', '-r', '--name-only', commit).split('\n').filter(Boolean).filter((rel) => !rel.startsWith('test-results/')).sort()) {
  files[rel] = createHash('sha256').update(git('show', `${commit}:${rel}`)).digest('hex');
}
if (!('index.json' in files)) fail('the commit has no index.json');

const lockPath = join(REPO_ROOT, 'profiles.lock');
writeFileSync(lockPath, JSON.stringify({ repository, commit, files }, null, 2) + '\n');
console.log(`[profiles-lock] ${lockPath}\n  repository ${repository}\n  commit     ${commit}\n  files      ${Object.keys(files).length}`);
