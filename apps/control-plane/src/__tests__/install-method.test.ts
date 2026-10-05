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
 * `managed` (SUVEREN_INSTALL_METHOD=managed env, or IT policy
 * InstallMethod=managed — see lib/policy.ts) pre-empts every other signal,
 * including Docker: an IT-provisioned install must never show the gateway's
 * normal upgrade command, regardless of how it happens to be packaged.
 *
 * `msi` — the Windows installer's marker file in the bundle root — comes
 * right after `managed`: a self-installed Windows gateway shows "Download
 * installer", however it was started; IT's managed setting still wins.
 *
 * Tests the real rule in lib/install-method.ts (no copy).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectInstallMethod, INSTALL_MARKER } from '../lib/install-method';

function detect(dir: string, dockerEnv = false, managed = false) {
  return detectInstallMethod({ dir, dockerEnv, managed });
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

  it('managed wins over docker — an IT-provisioned install must never show the normal upgrade path', () => {
    expect(detect('/anywhere', true, true)).toBe('managed');
  });

  it('managed wins over npm/dev detection too', () => {
    expect(detect('/opt/homebrew/lib/node_modules/@suveren/gateway/dist/control-plane', false, true)).toBe('managed');
  });

  it('msi: the Windows installer marker in the bundle root, however the gateway was started', () => {
    const bundle = join(root, 'Suveren', 'gateway');
    const cpDir = join(bundle, 'dist', 'control-plane');
    mkdirSync(cpDir, { recursive: true });
    writeFileSync(join(bundle, INSTALL_MARKER), JSON.stringify({ method: 'msi' }));
    expect(detect(cpDir)).toBe('msi');
  });

  it('managed (IT) wins over the installer marker', () => {
    const bundle = join(root, 'Suveren', 'gateway');
    const cpDir = join(bundle, 'dist', 'control-plane');
    mkdirSync(cpDir, { recursive: true });
    writeFileSync(join(bundle, INSTALL_MARKER), JSON.stringify({ method: 'msi' }));
    expect(detect(cpDir, false, true)).toBe('managed');
  });

  it('a missing, unreadable or foreign marker changes nothing', () => {
    const bundle = join(root, 'b');
    const cpDir = join(bundle, 'dist', 'control-plane');
    mkdirSync(cpDir, { recursive: true });
    expect(detect(cpDir)).toBe('npm');
    writeFileSync(join(bundle, INSTALL_MARKER), 'not json');
    expect(detect(cpDir)).toBe('npm');
    writeFileSync(join(bundle, INSTALL_MARKER), JSON.stringify({ method: 'something-else' }));
    expect(detect(cpDir)).toBe('npm');
  });
});
