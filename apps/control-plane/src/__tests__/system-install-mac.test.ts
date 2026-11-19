/**
 * S1 increment 1: the macOS system-install plan.
 *
 * The module only builds data and text, so everything here runs without admin
 * rights, a second account or launchd. What the plan DOES to a real machine
 * (account, LaunchDaemon, root-owned folders) is tested by the real-machine
 * steps in docs/own-os-user.md, section 13.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNT_NAME, DAEMON_LABEL, DAEMON_PATH, ID_RANGE,
  buildLayout, parseDsclIds, pickFreeId, buildAccountSteps, buildDaemonPlist,
  buildSettingsJson, buildFileManifest, diffManifests, checkPreconditions,
  buildInstallPlan, renderPlan, resolveNodeDistribution, nodeLinkProblems,
} from '../../../../bundle/lib/system-install-mac.mjs';

describe('buildLayout', () => {
  it('puts code, data and settings in their own places', () => {
    const l = buildLayout({ version: '0.45.0' });
    expect(l.codeDir).toBe('/usr/local/libexec/suveren/0.45.0');
    expect(l.currentLink).toBe('/usr/local/libexec/suveren/current');
    expect(l.dataDir).toBe('/var/lib/suveren');
    expect(l.daemonPlist).toBe(`/Library/LaunchDaemons/${DAEMON_LABEL}.plist`);
  });
  it('moves everything under a prefix for tests', () => {
    const l = buildLayout({ version: '1.0.0', prefix: '/scratch/root' });
    for (const v of Object.values(l)) expect(v.startsWith('/scratch/root/')).toBe(true);
  });
  it('refuses a version that is not a safe folder name', () => {
    expect(() => buildLayout({ version: '../x' })).toThrow();
    expect(() => buildLayout({ version: '' })).toThrow();
  });
  it('refuses a relative prefix', () => {
    expect(() => buildLayout({ version: '1.0.0', prefix: 'rel' })).toThrow();
  });
});

describe('free ids', () => {
  it('parses dscl output, ignoring names and blank lines', () => {
    const text = 'daemon                  1\n_apple 200\n\nroot 0\n';
    expect(parseDsclIds(text)).toEqual([1, 200, 0]);
  });
  it('picks the lowest free id in the range', () => {
    expect(pickFreeId([200, 201, 203])).toBe(202);
    expect(pickFreeId([])).toBe(ID_RANGE.min);
  });
  it('ignores used ids outside the range', () => {
    expect(pickFreeId([0, 1, 501])).toBe(ID_RANGE.min);
  });
  it('throws when the range is full', () => {
    const all = Array.from({ length: ID_RANGE.max - ID_RANGE.min + 1 }, (_, i) => ID_RANGE.min + i);
    expect(() => pickFreeId(all)).toThrow(/No free id/);
  });
});

describe('buildAccountSteps', () => {
  it('creates a hidden account with no shell and no home in /Users', () => {
    const flat = buildAccountSteps({ id: 250 }).map((s) => (s.kind === 'run' ? s.argv.join(' ') : ''));
    expect(flat).toContain('dscl . -create /Users/_suveren UserShell /usr/bin/false');
    expect(flat).toContain('dscl . -create /Users/_suveren NFSHomeDirectory /var/empty');
    expect(flat).toContain('dscl . -create /Users/_suveren IsHidden 1');
    expect(flat).toContain('dscl . -create /Users/_suveren UniqueID 250');
    expect(flat).toContain('dscl . -create /Groups/_suveren PrimaryGroupID 250');
  });
  it('never makes the account an administrator', () => {
    const flat = buildAccountSteps({ id: 250 }).map((s) => (s.kind === 'run' ? s.argv.join(' ') : '')).join('\n');
    expect(flat).not.toMatch(/admin/);
  });
  it('refuses ids outside the range and odd names', () => {
    expect(() => buildAccountSteps({ id: 501 })).toThrow();
    expect(() => buildAccountSteps({ id: 250, name: 'root' })).toThrow();
  });
});

describe('buildDaemonPlist', () => {
  const layout = buildLayout({ version: '1.0.0' });
  const plist = buildDaemonPlist({ layout });
  it('runs as the role account at boot and restarts', () => {
    expect(plist).toContain(`<key>UserName</key>\n  <string>${ACCOUNT_NAME}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
  });
  it('starts only root-owned code', () => {
    expect(plist).toContain('<string>/usr/local/libexec/suveren/current/node/bin/node</string>');
    expect(plist).toContain('<string>/usr/local/libexec/suveren/current/server.js</string>');
  });
  it('takes nothing from the person: fixed PATH, root-owned settings, own data folder', () => {
    expect(plist).toContain(`<string>/usr/local/libexec/suveren/current/node/bin:${DAEMON_PATH}</string>`);
    expect(plist).toContain('<string>/usr/local/etc/suveren/gateway.json</string>');
    expect(plist).toContain('<key>SUVEREN_DATA_DIR</key>\n    <string>/var/lib/suveren</string>');
    expect(plist).not.toMatch(/\/Users\//);
  });
  it('carries no secret', () => {
    expect(plist).not.toMatch(/API_?KEY|TOKEN|PASSWORD|SECRET/i);
  });
  it('escapes a prefix with XML characters', () => {
    const p = buildDaemonPlist({ layout: buildLayout({ version: '1.0.0', prefix: '/a&b' }) });
    expect(p).toContain('/a&amp;b/');
    expect(p).not.toContain('/a&b/');
  });
});

describe('buildSettingsJson', () => {
  it('has the three fields install-settings reads', () => {
    const layout = buildLayout({ version: '1.0.0' });
    expect(JSON.parse(buildSettingsJson({ layout, cpPort: 3400, mcpPort: 3430 })))
      .toEqual({ cpPort: 3400, mcpPort: 3430, dataDir: '/var/lib/suveren' });
  });
});

describe('manifests', () => {
  it('detect a changed, a missing and an extra file, and record symlinks', () => {
    const dir = mkdtempSync(join(tmpdir(), 's1-manifest-'));
    try {
      mkdirSync(join(dir, 'lib'));
      writeFileSync(join(dir, 'server.js'), 'a');
      writeFileSync(join(dir, 'lib', 'x.mjs'), 'b');
      symlinkSync('server.js', join(dir, 'link'));
      const m = buildFileManifest(dir);
      expect(Object.keys(m)).toEqual(['lib/x.mjs', 'link', 'server.js']);
      expect(m.link).toBe('-> server.js');
      expect(diffManifests(m, buildFileManifest(dir)).ok).toBe(true);

      writeFileSync(join(dir, 'server.js'), 'changed');
      writeFileSync(join(dir, 'new.js'), 'c');
      rmSync(join(dir, 'lib', 'x.mjs'));
      const d = diffManifests(m, buildFileManifest(dir));
      expect(d).toMatchObject({ ok: false, changed: ['server.js'], extra: ['new.js'], missing: ['lib/x.mjs'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkPreconditions', () => {
  it('accepts root on macOS with admin rights', () => {
    expect(checkPreconditions({ platform: 'darwin', uid: 0, isAdmin: true })).toEqual([]);
  });
  it('names each reason it refuses', () => {
    expect(checkPreconditions({ platform: 'linux', uid: 501, isAdmin: false })).toHaveLength(3);
  });
});

describe('buildInstallPlan', () => {
  const plan = buildInstallPlan({
    version: '1.0.0', packageDir: '/pkg', node: { binary: '/n/bin/node', npmDir: '/n/lib/node_modules/npm' }, freeId: 260, cpPort: 3400, mcpPort: 3430,
  });
  const owned = (path: string) => plan.steps.find((s) => 'path' in s && s.path === path) as any;

  it('keeps code and settings with root, data with the account', () => {
    expect(owned(plan.layout.codeDir).owner).toBe('root:wheel');
    expect(owned(plan.layout.settingsFile).owner).toBe('root:wheel');
    expect(owned(plan.layout.dataDir)).toMatchObject({ owner: '_suveren:_suveren', mode: '0700' });
  });
  it('never gives the account write access to code or settings', () => {
    for (const s of plan.steps as any[]) {
      const target = s.path ?? s.to;
      if (target && (target.startsWith(plan.layout.codeRoot) || target.startsWith(plan.layout.settingsDir))) {
        expect(s.owner ?? 'root:wheel').toBe('root:wheel');
      }
    }
  });
  it('flips `current` after the code is copied and starts the service last', () => {
    const kinds = plan.steps.map((s) => s.kind + ':' + ('path' in s ? s.path : 'to' in s ? s.to : (s as any).argv?.[1]));
    const iCopy = kinds.indexOf(`copy:${plan.layout.codeDir}`);
    const iLink = kinds.indexOf(`symlink:${plan.layout.currentLink}`);
    expect(iCopy).toBeGreaterThan(-1);
    expect(iLink).toBeGreaterThan(iCopy);
    expect(plan.steps.at(-1)).toEqual({ kind: 'run', argv: ['launchctl', 'bootstrap', 'system', plan.layout.daemonPlist] });
  });
  it('creates the account before any folder is chowned to it', () => {
    const firstMkdir = plan.steps.findIndex((s) => s.kind === 'mkdir');
    const lastDscl = plan.steps.map((s) => s.kind === 'run' && s.argv[0] === 'dscl').lastIndexOf(true);
    expect(lastDscl).toBeLessThan(firstMkdir);
  });
  it('renders one line per step', () => {
    expect(renderPlan(plan).trim().split('\n')).toHaveLength(plan.steps.length);
  });
});

describe('our own node with npm and npx', () => {
  const dist = { binary: '/n/bin/node', npmDir: '/n/lib/node_modules/npm' };
  const plan = buildInstallPlan({ version: '1.0.0', packageDir: '/pkg', node: dist, freeId: 260, cpPort: 3400, mcpPort: 3430 });
  it('copies node and npm into the root-owned code folder and links npm and npx', () => {
    const base = `${plan.layout.codeDir}/node`;
    expect(plan.steps).toContainEqual({ kind: 'copy', from: dist.binary, to: `${base}/bin/node`, owner: 'root:wheel', mode: '0755' });
    expect(plan.steps).toContainEqual({ kind: 'copy', from: dist.npmDir, to: `${base}/lib/node_modules/npm`, owner: 'root:wheel', mode: 'go-w' });
    expect(plan.steps).toContainEqual({ kind: 'symlink', path: `${base}/bin/npx`, target: '../lib/node_modules/npm/bin/npx-cli.js' });
  });
  it('resolves npm behind npx, also when npx is a link to another folder', () => {
    const files = new Set(['/h/bin/node', '/h/bin/npx', '/lib/npm/package.json']);
    const real = (p: string) => ({ '/h/bin/npx': '/lib/npm/bin/npx-cli.js' } as Record<string, string>)[p] ?? p;
    expect(resolveNodeDistribution('/h/bin/node', { realpath: real, exists: (p: string) => files.has(p) }))
      .toEqual({ binary: '/h/bin/node', npmDir: '/lib/npm' });
  });
  it('says so when the Node has no npx', () => {
    expect(() => resolveNodeDistribution('/h/bin/node', { realpath: (p: string) => p, exists: () => false })).toThrow(/no npm and npx/);
  });
  it('flags a Node that loads libraries from outside macOS (Homebrew), accepts the official one', () => {
    const brew = '/x/node:\n\t/usr/lib/libz.1.dylib (c)\n\t/opt/homebrew/opt/libuv/lib/libuv.1.dylib (c)\n\t@rpath/libnode.dylib (c)\n';
    expect(nodeLinkProblems(brew)).toEqual(['/opt/homebrew/opt/libuv/lib/libuv.1.dylib', '@rpath/libnode.dylib']);
    expect(nodeLinkProblems('/x/node:\n\t/usr/lib/libSystem.B.dylib (c)\n\t/System/Library/Frameworks/CoreFoundation (c)\n')).toEqual([]);
  });
});
