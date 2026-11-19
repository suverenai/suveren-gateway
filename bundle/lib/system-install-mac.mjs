/**
 * S1, macOS: the gateway under its own operating-system user.
 *
 * This module only DESCRIBES the install. It builds file contents and an
 * ordered list of steps as plain data, and renders that list as text. It runs
 * nothing, creates no account and writes no file outside a folder it is given
 * (the manifest helpers read a folder they are handed). A later step executes
 * the plan; the tests of this module therefore need no admin rights, no second
 * account and no launchd.
 *
 * Design: docs/own-os-user.md, sections 2.1 and 2.5.
 *
 *   account   hidden role account `_suveren`, no shell, no home in /Users
 *   service   LaunchDaemon ai.suveren.gateway (starts at boot, runs as the account)
 *   code      /usr/local/libexec/suveren/<version>/ owned by root, `current` symlink
 *   data      /var/lib/suveren, only the account can read it
 *   settings  /usr/local/etc/suveren/gateway.json owned by root (ports, data folder)
 *
 * Nothing the person's own user can write is ever part of what the daemon runs.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { escapeXml } from './autostart-templates.mjs';

export const ACCOUNT_NAME = '_suveren';
export const DAEMON_LABEL = 'ai.suveren.gateway';
export const AGENT_LABEL = 'ai.suveren.agent';

/** Ids for the role account are taken from this range (design 2.1). */
export const ID_RANGE = { min: 200, max: 399 };

/** The fixed PATH of the daemon. Never the person's PATH: it may name folders they can write. */
export const DAEMON_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * All paths of one install. `prefix` is prepended to every absolute path so a
 * test can lay the whole tree out inside a scratch folder. The empty prefix is
 * the real machine.
 */
export function buildLayout({ version, prefix = '' }) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(String(version ?? ''))) {
    throw new Error(`Not a usable version for a folder name: "${version}"`);
  }
  if (prefix && !prefix.startsWith('/')) throw new Error('prefix must be an absolute path');
  const p = (path) => `${prefix}${path}`;
  const codeRoot = p('/usr/local/libexec/suveren');
  return {
    codeRoot,
    codeDir: `${codeRoot}/${version}`,
    currentLink: `${codeRoot}/current`,
    nodeDir: `${codeRoot}/current/node`,
    nodeBinDir: `${codeRoot}/current/node/bin`,
    nodeBinary: `${codeRoot}/current/node/bin/node`,
    serverEntry: `${codeRoot}/current/server.js`,
    settingsDir: p('/usr/local/etc/suveren'),
    settingsFile: p('/usr/local/etc/suveren/gateway.json'),
    dataDir: p('/var/lib/suveren'),
    logDir: p('/var/log/suveren'),
    logFile: p('/var/log/suveren/gateway.log'),
    runDir: p('/var/run/suveren'),
    daemonPlist: p(`/Library/LaunchDaemons/${DAEMON_LABEL}.plist`),
    agentPlist: p(`/Library/LaunchAgents/${AGENT_LABEL}.plist`),
  };
}

// ─── The role account ───────────────────────────────────────────────────

/** Numbers from `dscl . -list /Users UniqueID` or `... /Groups PrimaryGroupID`. */
export function parseDsclIds(text) {
  const ids = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /(?:^|\s)(-?\d+)\s*$/.exec(line);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}

/**
 * The lowest id in the range that no user and no group uses. One number serves
 * as user id and group id, so both lists are considered. Never a fixed number:
 * the ids in use differ from machine to machine (design 2.1).
 */
export function pickFreeId(usedIds, range = ID_RANGE) {
  const used = new Set(usedIds);
  for (let id = range.min; id <= range.max; id++) {
    if (!used.has(id)) return id;
  }
  throw new Error(`No free id between ${range.min} and ${range.max}`);
}

/** The `dscl` calls that create the group and the hidden role account. Data, not executed. */
export function buildAccountSteps({ id, name = ACCOUNT_NAME }) {
  if (!Number.isInteger(id) || id < ID_RANGE.min || id > ID_RANGE.max) {
    throw new Error(`Account id ${id} is outside ${ID_RANGE.min} to ${ID_RANGE.max}`);
  }
  if (!/^_[a-z][a-z0-9]*$/.test(name)) throw new Error(`Not a role account name: "${name}"`);
  const g = `/Groups/${name}`;
  const u = `/Users/${name}`;
  const dscl = (...args) => ({ kind: 'run', argv: ['dscl', '.', ...args] });
  return [
    dscl('-create', g),
    dscl('-create', g, 'PrimaryGroupID', String(id)),
    dscl('-create', g, 'RealName', 'Suveren gateway'),
    dscl('-create', u),
    dscl('-create', u, 'UniqueID', String(id)),
    dscl('-create', u, 'PrimaryGroupID', String(id)),
    dscl('-create', u, 'UserShell', '/usr/bin/false'),
    dscl('-create', u, 'NFSHomeDirectory', '/var/empty'),
    dscl('-create', u, 'RealName', 'Suveren gateway'),
    dscl('-create', u, 'IsHidden', '1'),
  ];
}

// ─── Service definitions ────────────────────────────────────────────────

/**
 * The LaunchDaemon. It starts at boot, before any login, runs as the role
 * account, and carries no secret (the gateway comes up locked, as today).
 * Ports and data folder reach the gateway through a root-owned settings file,
 * never through the person's environment.
 */
export function buildDaemonPlist({ layout, account = ACCOUNT_NAME }) {
  const env = [
    ['HOME', layout.dataDir],
    // Our own node and npx first: connectors are started with `npx`.
    ['PATH', `${layout.nodeBinDir}:${DAEMON_PATH}`],
    ['SUVEREN_DATA_DIR', layout.dataDir],
    ['SUVEREN_INSTALL_SETTINGS_FILE', layout.settingsFile],
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(DAEMON_LABEL)}</string>
  <key>UserName</key>
  <string>${escapeXml(account)}</string>
  <key>GroupName</key>
  <string>${escapeXml(account)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(layout.nodeBinary)}</string>
    <string>${escapeXml(layout.serverEntry)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(layout.dataDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(layout.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(layout.logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>\n`).join('')}  </dict>
</dict>
</plist>
`;
}

/** The root-owned settings file, in the format install-settings.mjs reads. */
export function buildSettingsJson({ layout, cpPort, mcpPort }) {
  return JSON.stringify({ cpPort, mcpPort, dataDir: layout.dataDir }, null, 2) + '\n';
}

// ─── Hashes of the installed files ──────────────────────────────────────

/**
 * Walk a folder and return `{ "relative/path": "sha256hex" | "-> target" }`,
 * sorted. Symlinks are recorded, not followed. The same function describes the
 * package before the copy and the root-owned folder after it, so an installer
 * compares the two (design 2.5, "checks the file hashes it ships with").
 */
export function buildFileManifest(dir) {
  const out = {};
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = relative(dir, full).split(sep).join('/');
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out[rel] = `-> ${readlinkSync(full)}`;
      else if (st.isDirectory()) walk(full);
      else if (st.isFile()) out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** Differences between two manifests; empty lists mean identical. */
export function diffManifests(expected, actual) {
  const missing = Object.keys(expected).filter((k) => !(k in actual));
  const extra = Object.keys(actual).filter((k) => !(k in expected));
  const changed = Object.keys(expected).filter((k) => k in actual && expected[k] !== actual[k]);
  return { missing, extra, changed, ok: !missing.length && !extra.length && !changed.length };
}


// ─── Our own Node, with npm and npx ─────────────────────────────────────

/**
 * Find the pieces of a Node distribution from the node binary that runs the CLI:
 * the real binary and the npm folder behind `npx`. Throws, in words, when the
 * Node has no npm (connectors are started with `npx`).
 */
export function resolveNodeDistribution(execPath, { realpath = realpathSync, exists = existsSync } = {}) {
  const binary = realpath(execPath);
  for (const dir of [dirname(execPath), dirname(binary)]) {
    const npx = join(dir, 'npx');
    if (!exists(npx)) continue;
    const real = realpath(npx);
    const npmDir = dirname(dirname(real));
    if (real.endsWith('/bin/npx-cli.js') && exists(join(npmDir, 'package.json'))) return { binary, npmDir };
  }
  throw new Error(`The Node at ${execPath} has no npm and npx next to it. Install the official Node from nodejs.org and run this again with it.`);
}

/**
 * Libraries a node binary needs that are not part of macOS. The official Node
 * needs none; a Homebrew Node loads libraries from /opt/homebrew, a folder the
 * person's own user can write, which would defeat the root-owned code folder.
 * `otoolOutput` is the text of `otool -L <binary>`.
 */
export function nodeLinkProblems(otoolOutput) {
  const out = [];
  for (const line of String(otoolOutput).split(/\r?\n/).slice(1)) {
    const m = /^\s+(\S+)\s+\(/.exec(line);
    if (!m) continue;
    const lib = m[1];
    if (lib.startsWith('/usr/lib/') || lib.startsWith('/System/')) continue;
    out.push(lib);
  }
  return out;
}

/** Steps that put the node binary, npm and the npm/npx links into the code folder. */
function nodeSteps(layout, node) {
  const root = 'root:wheel';
  const dir = `${layout.codeDir}/node`;
  const npmTarget = (name) => `../lib/node_modules/npm/bin/${name}-cli.js`;
  return [
    { kind: 'mkdir', path: `${dir}/bin`, owner: root, mode: '0755' },
    { kind: 'mkdir', path: `${dir}/lib/node_modules`, owner: root, mode: '0755' },
    { kind: 'copy', from: node.binary, to: `${dir}/bin/node`, owner: root, mode: '0755' },
    { kind: 'copy', from: node.npmDir, to: `${dir}/lib/node_modules/npm`, owner: root, mode: 'go-w' },
    { kind: 'symlink', path: `${dir}/bin/npm`, target: npmTarget('npm') },
    { kind: 'symlink', path: `${dir}/bin/npx`, target: npmTarget('npx') },
  ];
}

// ─── The plan ───────────────────────────────────────────────────────────

/**
 * Why this machine cannot take the protected install. Empty list = it can.
 * `isAdmin` and `uid` are passed in so the function stays pure.
 */
export function checkPreconditions({ platform, uid, isAdmin }) {
  const problems = [];
  if (platform !== 'darwin') problems.push('The protected install is built for macOS first.');
  if (uid !== 0) problems.push('It must run as root (sudo suveren-gateway install --system).');
  if (!isAdmin) problems.push('Only an administrator can create the account and the service. Without admin rights the home-folder install stays, without Touch ID.');
  return problems;
}

/**
 * Ordered steps of a first install. Step kinds:
 *   run      { argv }                 run a program (the executor refuses anything but the listed ones)
 *   mkdir    { path, owner, mode }
 *   copy     { from, to, owner, mode } a file or a folder; hashes are checked after
 *   write    { path, content, owner, mode }
 *   symlink  { path, target }         flipped last, so `current` never points at a half-copied folder
 *   remove   { path }                 recursive; used by uninstall only
 *
 * `owner` is "user:group". Code is root:wheel; data is the role account.
 */
export function buildInstallPlan({
  version,
  packageDir,
  node,
  freeId,
  cpPort,
  mcpPort,
  prefix = '',
  account = ACCOUNT_NAME,
}) {
  const layout = buildLayout({ version, prefix });
  const root = 'root:wheel';
  const svc = `${account}:${account}`;
  const steps = [];

  steps.push(...buildAccountSteps({ id: freeId, name: account }));

  // Folders. Code and settings are root's; only data and log belong to the account.
  steps.push({ kind: 'mkdir', path: layout.codeDir, owner: root, mode: '0755' });
  steps.push({ kind: 'mkdir', path: layout.settingsDir, owner: root, mode: '0755' });
  steps.push({ kind: 'mkdir', path: layout.dataDir, owner: svc, mode: '0700' });
  steps.push({ kind: 'mkdir', path: layout.logDir, owner: svc, mode: '0755' });
  steps.push({ kind: 'mkdir', path: layout.runDir, owner: svc, mode: '0755' });

  // Code: the package and a Node of our own (the person's nvm or Homebrew Node is writable by them).
  steps.push({ kind: 'copy', from: packageDir, to: layout.codeDir, owner: root, mode: 'go-w' });
  steps.push(...nodeSteps(layout, node));
  steps.push({ kind: 'write', path: layout.settingsFile, content: buildSettingsJson({ layout, cpPort, mcpPort }), owner: root, mode: '0644' });
  steps.push({ kind: 'symlink', path: layout.currentLink, target: version });

  // Service last, so nothing starts before the files are in place.
  steps.push({ kind: 'write', path: layout.daemonPlist, content: buildDaemonPlist({ layout, account }), owner: root, mode: '0644' });
  steps.push({ kind: 'run', argv: ['launchctl', 'bootstrap', 'system', layout.daemonPlist] });

  return { layout, steps };
}

/** The steps as text, for `--dry-run` and for a person reading what will happen. */
export function renderPlan(plan) {
  const lines = [];
  for (const s of plan.steps) {
    switch (s.kind) {
      case 'run': lines.push(`run      ${s.argv.join(' ')}`); break;
      case 'mkdir': lines.push(`mkdir    ${s.path}   ${s.owner}  ${s.mode}`); break;
      case 'copy': lines.push(`copy     ${s.from}  ->  ${s.to}   ${s.owner}  ${s.mode}`); break;
      case 'write': lines.push(`write    ${s.path}   ${s.owner}  ${s.mode}`); break;
      case 'symlink': lines.push(`symlink  ${s.path}  ->  ${s.target}`); break;
      case 'remove': lines.push(`remove   ${s.path}`); break;
      default: lines.push(`?        ${JSON.stringify(s)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * A new version next to the old one: copy, verify, flip `current`, restart.
 * The daemon never updates its own code (design 2.5); an admin runs this.
 */
export function buildUpdatePlan({ version, packageDir, node, prefix = '' }) {
  const layout = buildLayout({ version, prefix });
  const root = 'root:wheel';
  return {
    layout,
    steps: [
      { kind: 'mkdir', path: layout.codeDir, owner: root, mode: '0755' },
      { kind: 'copy', from: packageDir, to: layout.codeDir, owner: root, mode: 'go-w' },
      ...nodeSteps(layout, node),
      { kind: 'symlink', path: layout.currentLink, target: version },
      { kind: 'run', argv: ['launchctl', 'kickstart', '-k', `system/${DAEMON_LABEL}`] },
    ],
  };
}

/**
 * Remove what install made. The data folder (it holds the vault) goes only when
 * the caller says so after asking the person; the account goes with it, because
 * an account that owns nothing is clutter but one that still owns the vault must stay.
 */
export function buildUninstallPlan({ prefix = '', removeData = false, account = ACCOUNT_NAME }) {
  const layout = buildLayout({ version: '0', prefix });
  const steps = [
    { kind: 'run', argv: ['launchctl', 'bootout', `system/${DAEMON_LABEL}`] },
    { kind: 'remove', path: layout.daemonPlist },
    { kind: 'remove', path: layout.codeRoot },
    { kind: 'remove', path: layout.settingsDir },
    { kind: 'remove', path: layout.runDir },
    { kind: 'remove', path: layout.logDir },
  ];
  if (removeData) {
    steps.push({ kind: 'remove', path: layout.dataDir });
    steps.push({ kind: 'run', argv: ['dscl', '.', '-delete', `/Users/${account}`] });
    steps.push({ kind: 'run', argv: ['dscl', '.', '-delete', `/Groups/${account}`] });
  }
  return { layout, steps };
}
