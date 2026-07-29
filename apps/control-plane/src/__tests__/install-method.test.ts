/**
 * Install-method detection decides WHERE update checks look.
 *
 * `dev` compares git commits against origin/main. It used to be the catch-all,
 * which made it the silent failure mode: in a directory that is not a git
 * checkout it finds nothing, reports no update, and never consults the
 * registry — so an unrecognised install layout would stop hearing about
 * releases entirely, including security fixes, while looking exactly like
 * "you're up to date".
 *
 * The rule under test: claim `dev` only with a real .git; otherwise fall back
 * to the npm check. Being told about a version you cannot one-click upgrade to
 * is a far smaller problem than never being told.
 *
 * Reimplemented here rather than imported because index.ts starts a server on
 * import. The duplication is deliberate and the comment above index.ts's copy
 * points here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

type InstallMethod = 'docker' | 'npm' | 'dev';

/** Mirrors detectInstallMethod() in index.ts, with the inputs injected. */
function detect(dir: string, dockerEnv = false): InstallMethod {
  if (dockerEnv) return 'docker';
  if (dir.includes('/node_modules/@suveren/gateway/')) return 'npm';
  let cursor = dir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cursor, '.git'))) return 'dev';
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return 'npm';
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'install-method-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('detectInstallMethod', () => {
  it('docker wins over everything', () => {
    expect(detect('/anywhere', true)).toBe('docker');
  });

  it('recognises a global npm install by its path', () => {
    expect(detect('/opt/homebrew/lib/node_modules/@suveren/gateway/dist/control-plane')).toBe('npm');
  });

  it('claims dev only when a .git is actually above it', () => {
    const deep = join(root, 'bundle', 'dist', 'dist', 'control-plane');
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    expect(detect(deep)).toBe('dev');
  });

  it('falls back to npm — NOT dev — for an unrecognised layout', () => {
    // The bug: this used to return 'dev', which checks git, finds no repo,
    // and silently never checks the registry again.
    const deep = join(root, 'some', 'unpacked', 'location');
    mkdirSync(deep, { recursive: true });
    expect(detect(deep)).toBe('npm');
  });

  it('finds .git several levels up, as a real checkout has', () => {
    const deep = join(root, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    expect(detect(deep)).toBe('dev');
  });

  it('accepts a .git FILE — worktrees and submodules use one', () => {
    const deep = join(root, 'x', 'y');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    expect(detect(deep)).toBe('dev');
  });

  it('does not walk up forever from the filesystem root', () => {
    expect(() => detect('/')).not.toThrow();
  });
});
