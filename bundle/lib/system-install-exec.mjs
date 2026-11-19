/**
 * S1, macOS: runs a plan built by system-install-mac.mjs.
 *
 * Two modes:
 *   real     (no prefix)  runs the listed programs and changes owners. Needs root.
 *   scratch  (a prefix)   lays the file tree out under the prefix as the normal
 *                         user. Program calls and owner changes are RECORDED, not
 *                         run. This is what the tests and a first look use; it
 *                         cannot touch accounts, launchd or /Library.
 *
 * Safety rules, checked before any step runs:
 *   - only `dscl`, `launchctl` may be run, with the subcommands the plans use
 *   - in scratch mode every path must lie inside the prefix
 *   - after a copy the destination is compared with the source by hash; a
 *     difference throws, so a later `symlink` step (the flip of `current`)
 *     never happens on a bad copy
 */

import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync,
  rmSync, symlinkSync, writeFileSync, copyFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { buildFileManifest, diffManifests } from './system-install-mac.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ALLOWED = {
  dscl: (a) => a[0] === '.' && ['-create', '-delete'].includes(a[1]) && /^\/(Users|Groups)\/_[a-z][a-z0-9]*$/.test(a[2] ?? ''),
  launchctl: (a) =>
    (a[0] === 'bootstrap' && a[1] === 'system' && /^\/.*\.plist$/.test(a[2] ?? '')) ||
    (a[0] === 'bootout' && /^system\/ai\.suveren\.[a-z.]+$/.test(a[1] ?? '')) ||
    (a[0] === 'kickstart' && a[1] === '-k' && /^system\/ai\.suveren\.[a-z.]+$/.test(a[2] ?? '')),
};

export function isAllowedCommand(argv) {
  const [prog, ...rest] = argv;
  return Object.prototype.hasOwnProperty.call(ALLOWED, prog) && ALLOWED[prog](rest) === true;
}

function stepPaths(s) {
  return [s.path, s.to].filter(Boolean);
}

/** Throws unless the plan is safe to run in this mode. */
export function validatePlan(steps, { prefix = '' } = {}) {
  for (const s of steps) {
    if (s.kind === 'run' && !isAllowedCommand(s.argv)) {
      throw new Error(`Refusing to run: ${s.argv.join(' ')}`);
    }
    if (prefix) {
      for (const p of stepPaths(s)) {
        if (resolve(p) !== resolve(prefix) && !resolve(p).startsWith(resolve(prefix) + sep)) {
          throw new Error(`Path outside the scratch prefix: ${p}`);
        }
      }
    }
  }
}

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function dropWrite(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  chmodSync(path, st.mode & ~0o022);
  if (st.isDirectory()) for (const n of readdirSync(path)) dropWrite(join(path, n));
}

/**
 * @param plan   { steps }
 * @param opts   prefix: scratch folder or ''. runner(argv) -> {status}. chown(path, owner).
 * @returns      a log of what was done and what was only recorded.
 */
export function executePlan(plan, opts = {}) {
  const { prefix = '' } = opts;
  const scratch = Boolean(prefix);
  const runner = opts.runner ?? ((argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' }));
  const chown = opts.chown ?? ((path, owner, recursive) =>
    runner(['/usr/sbin/chown', ...(recursive ? ['-R'] : []), owner, path]));
  validatePlan(plan.steps, { prefix });

  const log = [];
  const own = (path, owner, recursive = false) => {
    if (scratch) { log.push({ recorded: `chown ${owner} ${path}` }); return; }
    const r = chown(path, owner, recursive);
    if (r && r.status !== 0) throw new Error(`chown ${owner} ${path} failed`);
  };

  for (const s of plan.steps) {
    switch (s.kind) {
      case 'run': {
        if (scratch) { log.push({ recorded: s.argv.join(' ') }); break; }
        const r = runner(s.argv);
        if (r.status !== 0) throw new Error(`${s.argv.join(' ')} failed (${r.status}): ${r.stderr ?? ''}`);
        log.push({ ran: s.argv.join(' ') });
        break;
      }
      case 'mkdir':
        mkdirSync(s.path, { recursive: true });
        chmodSync(s.path, parseInt(s.mode, 8));
        own(s.path, s.owner);
        log.push({ did: `mkdir ${s.path}` });
        break;
      case 'copy': {
        const isDir = lstatSync(s.from).isDirectory();
        if (isDir) cpSync(s.from, s.to, { recursive: true, verbatimSymlinks: true });
        else { mkdirSync(dirname(s.to), { recursive: true }); copyFileSync(s.from, s.to); }
        if (isDir) {
          const d = diffManifests(buildFileManifest(s.from), buildFileManifest(s.to));
          if (!d.ok) throw new Error(`Copy to ${s.to} differs from the source: ${JSON.stringify(d)}`);
        } else if (sha(s.from) !== sha(s.to)) {
          throw new Error(`Copy to ${s.to} differs from the source`);
        }
        if (s.mode === 'go-w') dropWrite(s.to);
        else chmodSync(s.to, parseInt(s.mode, 8));
        own(s.to, s.owner, isDir);
        log.push({ did: `copy ${s.to}` });
        break;
      }
      case 'write':
        mkdirSync(dirname(s.path), { recursive: true });
        writeFileSync(s.path, s.content);
        chmodSync(s.path, parseInt(s.mode, 8));
        own(s.path, s.owner);
        log.push({ did: `write ${s.path}` });
        break;
      case 'symlink': {
        // Atomic: build the new link beside the old one, then rename over it.
        const tmp = `${s.path}.new`;
        rmSync(tmp, { force: true });
        symlinkSync(s.target, tmp);
        renameSync(tmp, s.path);
        log.push({ did: `symlink ${s.path}` });
        break;
      }
      case 'remove':
        if (existsSync(s.path)) rmSync(s.path, { recursive: true, force: true });
        log.push({ did: `remove ${s.path}` });
        break;
      default:
        throw new Error(`Unknown step ${JSON.stringify(s)}`);
    }
  }
  return log;
}
