/**
 * S1 increment 2: running a plan in a scratch folder.
 *
 * Runs as the normal user. Account, launchd and owner steps are recorded, not
 * run; the file tree, modes, hash check and the atomic flip of `current` are
 * real. The real-machine run is in docs/own-os-user.md, section 13.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync, statSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildInstallPlan, buildUpdatePlan, buildUninstallPlan,
} from '../../../../bundle/lib/system-install-mac.mjs';
import { executePlan, isAllowedCommand, validatePlan } from '../../../../bundle/lib/system-install-exec.mjs';

let scratch: string;
let pkg: string;
let node: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 's1-exec-')));
  pkg = join(scratch, 'pkg');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'server.js'), 'console.log(1)');
  writeFileSync(join(pkg, 'lib', 'a.mjs'), 'export {}');
  node = join(scratch, 'fake-node');
  writeFileSync(node, '#!/bin/sh\n');
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const prefix = () => join(scratch, 'root');
const install = (version = '1.0.0') =>
  buildInstallPlan({ version, packageDir: pkg, nodeBinary: node, freeId: 260, cpPort: 3400, mcpPort: 3430, prefix: prefix() });

describe('isAllowedCommand', () => {
  it('allows only the calls the plans make', () => {
    expect(isAllowedCommand(['dscl', '.', '-create', '/Users/_suveren', 'IsHidden', '1'])).toBe(true);
    expect(isAllowedCommand(['launchctl', 'bootstrap', 'system', '/Library/LaunchDaemons/ai.suveren.gateway.plist'])).toBe(true);
    expect(isAllowedCommand(['launchctl', 'kickstart', '-k', 'system/ai.suveren.gateway'])).toBe(true);
  });
  it('refuses anything else', () => {
    expect(isAllowedCommand(['rm', '-rf', '/'])).toBe(false);
    expect(isAllowedCommand(['dscl', '.', '-create', '/Users/root'])).toBe(false);
    expect(isAllowedCommand(['dscl', '.', '-delete', '/Users/someone'])).toBe(false);
    expect(isAllowedCommand(['launchctl', 'bootout', 'system/com.apple.something'])).toBe(false);
    expect(isAllowedCommand(['launchctl', 'bootstrap', 'gui/501', '/x.plist'])).toBe(false);
    expect(isAllowedCommand([])).toBe(false);
  });
});

describe('validatePlan', () => {
  it('refuses a path outside the scratch prefix', () => {
    expect(() => validatePlan([{ kind: 'remove', path: '/etc/hosts' }], { prefix: prefix() })).toThrow(/outside/);
    expect(() => validatePlan([{ kind: 'remove', path: `${prefix()}/../x` }], { prefix: prefix() })).toThrow(/outside/);
  });
  it('refuses a forbidden program in a plan', () => {
    expect(() => validatePlan([{ kind: 'run', argv: ['sudo', 'sh'] }])).toThrow(/Refusing/);
  });
});

describe('install in a scratch folder', () => {
  it('lays out the tree, points current at the version, records account and launchd steps', () => {
    const plan = install();
    const log = executePlan(plan, { prefix: prefix() });
    const l = plan.layout;
    expect(readFileSync(join(l.codeDir, 'server.js'), 'utf8')).toBe('console.log(1)');
    expect(existsSync(join(l.codeDir, 'lib', 'a.mjs'))).toBe(true);
    expect(existsSync(join(l.codeDir, 'node'))).toBe(true);
    expect(readlinkSync(l.currentLink)).toBe('1.0.0');
    expect(existsSync(join(l.currentLink, 'server.js'))).toBe(true);
    expect(JSON.parse(readFileSync(l.settingsFile, 'utf8'))).toMatchObject({ cpPort: 3400, mcpPort: 3430 });
    expect(readFileSync(l.daemonPlist, 'utf8')).toContain('<string>_suveren</string>');
    const recorded = log.filter((e) => e.recorded).map((e) => e.recorded as string);
    expect(recorded.some((r) => r.startsWith('dscl . -create /Users/_suveren'))).toBe(true);
    expect(recorded.some((r) => r.startsWith('launchctl bootstrap system'))).toBe(true);
    expect(recorded.some((r) => r.startsWith('chown _suveren:_suveren'))).toBe(true);
  });

  it('gives modes: data 0700, code not writable by group or others', () => {
    const plan = install();
    executePlan(plan, { prefix: prefix() });
    expect(statSync(plan.layout.dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(plan.layout.codeDir, 'server.js')).mode & 0o022).toBe(0);
    expect(statSync(plan.layout.codeDir).mode & 0o022).toBe(0);
    expect(statSync(plan.layout.settingsFile).mode & 0o777).toBe(0o644);
  });

  it('aborts on a hash mismatch and leaves current unset', () => {
    const plan = install();
    const steps = plan.steps;
    const dest = plan.layout.codeDir;
    mkdirSync(dest, { recursive: true });
    // A stale extra file in the destination makes it differ from the source.
    writeFileSync(join(dest, 'stale.js'), 'old');
    expect(() => executePlan({ steps }, { prefix: prefix() })).toThrow(/differs from the source/);
    expect(existsSync(plan.layout.currentLink)).toBe(false);
  });
});

describe('update and uninstall in a scratch folder', () => {
  it('update adds a version, flips current and keeps the old one', () => {
    executePlan(install('1.0.0'), { prefix: prefix() });
    writeFileSync(join(pkg, 'server.js'), 'console.log(2)');
    const up = buildUpdatePlan({ version: '1.1.0', packageDir: pkg, nodeBinary: node, prefix: prefix() });
    const log = executePlan(up, { prefix: prefix() });
    expect(readlinkSync(up.layout.currentLink)).toBe('1.1.0');
    expect(readFileSync(join(up.layout.currentLink, 'server.js'), 'utf8')).toBe('console.log(2)');
    expect(readFileSync(join(up.layout.codeRoot, '1.0.0', 'server.js'), 'utf8')).toBe('console.log(1)');
    expect(log.some((e) => e.recorded === 'launchctl kickstart -k system/ai.suveren.gateway')).toBe(true);
  });

  it('uninstall keeps the data folder unless asked', () => {
    const plan = install();
    executePlan(plan, { prefix: prefix() });
    writeFileSync(join(plan.layout.dataDir, 'vault.enc.json'), '{}');
    executePlan(buildUninstallPlan({ prefix: prefix() }), { prefix: prefix() });
    expect(existsSync(plan.layout.codeRoot)).toBe(false);
    expect(existsSync(plan.layout.daemonPlist)).toBe(false);
    expect(existsSync(plan.layout.settingsDir)).toBe(false);
    expect(existsSync(join(plan.layout.dataDir, 'vault.enc.json'))).toBe(true);
  });

  it('uninstall --remove-data removes it and records the account removal', () => {
    const plan = install();
    executePlan(plan, { prefix: prefix() });
    const log = executePlan(buildUninstallPlan({ prefix: prefix(), removeData: true }), { prefix: prefix() });
    expect(existsSync(plan.layout.dataDir)).toBe(false);
    expect(log.some((e) => e.recorded === 'dscl . -delete /Users/_suveren')).toBe(true);
  });
});
