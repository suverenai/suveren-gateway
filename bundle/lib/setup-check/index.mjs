/**
 * `suveren-gateway check` — the Setup check, as the CLI runs it.
 *
 * bin/suveren-gateway.js collects what it already knows about this gateway
 * (version, ports, data folder, IT settings) and calls `runSetupCheckCli`.
 * This file wires the real, read-only providers (providers.mjs) to the
 * engine and prints the report.
 *
 * Exit codes: 0 nothing open · 1 at least one line open · 2 usage error ·
 * 3 the check could not finish. "cannot tell" alone never makes it 1.
 *
 * Test hook: SUVEREN_CHECK_FIXTURE=<json file> replaces the system folders'
 * root, the platform, the process list, the group list, registry reads and
 * the Windows access-list tools (`icacls`, `whoami`, the owner lookup) and
 * chosen writability answers with fixture values, so the real CLI can be tested without reading this
 * computer's system state. Whenever it is set, the report says so.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runSetupCheck } from './engine.mjs';
import { renderJson, renderText } from './report.mjs';
import * as real from './providers.mjs';

export const CHECK_HELP = `suveren-gateway check [--json]

Looks at this computer and reports whether an AI app has a way into the
company's systems other than the Suveren gateway. Read-only: it changes
nothing, starts nothing and makes no network request. It never prints a
password, token or key; only where one is.

Every line is one of:
  closed       nothing found that goes around the gateway here
  open         a way around the gateway, or a lock the user can undo
  cannot tell  this check cannot see it; confirm by hand

It is a check, not a guarantee. It ends with what it cannot see.

Options:
  --json       Machine-readable output (same findings, with their source)

Exit codes: 0 nothing open, 1 at least one line open, 2 usage error,
3 the check could not finish.
`;

function loadFixture(env) {
  const path = env.SUVEREN_CHECK_FIXTURE;
  if (!path) return null;
  return { path, data: JSON.parse(readFileSync(path, 'utf8')) };
}

/** Says exactly which parts of the report come from the test fixture, so a
 *  part read from this computer is never labelled as fixture data. */
export function fixtureNote(fixture) {
  const f = fixture.data ?? {};
  const parts = [
    ['platform', 'the platform'],
    ['root', 'system folders'],
    ['psOutput', 'the process list'],
    ['groupsOutput', 'the group list'],
    ['registry', 'registry values'],
    ['icacls', 'access lists'],
    ['whoamiUser', 'the user identity'],
    ['owners', 'file owners'],
    ['writable', 'chosen write permissions'],
    ['uid', 'the user id'],
  ].filter(([key]) => key in f).map(([, label]) => label);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? 'nothing');
  return `Test fixture in use (${fixture.path}): ${list} in this report ${parts.length === 1 ? 'is' : 'are'} not this computer's.`;
}

function buildIo(platform, fixture, root = '') {
  const f = fixture?.data ?? {};
  // Fixture runner for the Windows access-list tools: `icacls` answers from
  // `f.icacls[path]`, `whoami` from `f.whoamiUser` / `f.whoamiGroups`, the
  // owner lookup from `f.owners[path]` (a SID).
  const hasAclFixture = 'icacls' in f || 'whoamiUser' in f;
  const runner = hasAclFixture
    ? (bin, args, _timeoutMs, extraEnv) => {
      if (bin === 'icacls') return args[0] in (f.icacls ?? {}) ? { ok: true, stdout: f.icacls[args[0]] } : { error: 'failed', reason: 'had no fixture answer' };
      if (bin === 'whoami') {
        const v = args[0] === '/user' ? f.whoamiUser : f.whoamiGroups;
        return typeof v === 'string' ? { ok: true, stdout: v } : { error: 'failed', reason: 'had no fixture answer' };
      }
      if (args[args.length - 1] === real.WINDOWS_OWNER_SCRIPT) {
        const path = extraEnv?.SUVEREN_CHECK_PATH;
        return path && f.owners && path in f.owners ? { ok: true, stdout: f.owners[path] } : { error: 'failed', reason: 'had no fixture answer' };
      }
      return { error: 'failed', reason: 'had no fixture answer' };
    }
    : real.run;
  const fixed = (v) => (v === null ? { error: 'failed', reason: 'was not found' } : { ok: true, stdout: v });
  return {
    readText: real.readText,
    exists: real.exists,
    isDir: real.isDir,
    list: real.list,
    // Fixture `writable: { [path]: true|false|null }` answers for those paths
    // (a test cannot make a file it does not own on POSIX).
    writable: (path) => (f.writable && path in f.writable ? f.writable[path] : real.writable(path, platform, runner)),
    nearestCreatable: (path) => real.nearestCreatable(path, platform, runner),
    ownerUid: real.ownerUid,
    ps: () => {
      // A fixture `psOutput: null` stands for "ps is not there".
      const raw = 'psOutput' in f ? fixed(f.psOutput) : real.psList(platform);
      if (raw.ok) return real.parseProcessList(platform, raw.stdout);
      // Linux without `ps` (minimal images): read /proc directly.
      if (platform === 'linux') return real.procCommands(join(root || '/', 'proc'));
      return { error: 'failed', reason: raw.reason };
    },
    groups: () => ('groupsOutput' in f ? fixed(f.groupsOutput) : real.groups(platform)),
    plist: (path) => real.readPlist(path),
    registry: (key) => {
      if (f.registry) {
        return key in f.registry ? { ok: true, data: real.parseRegValues(f.registry[key]) } : { missing: true };
      }
      return real.readRegistry(key, platform);
    },
  };
}

/**
 * @param {string[]} args  arguments after `check`
 * @param {object} gateway what the CLI knows about this gateway — see the
 *   `gateway` field of engine.mjs's runSetupCheck
 * @param {{ mcpPort: number, env?: object, stdout?: (s: string) => void,
 *   stderr?: (s: string) => void, now?: Date }} opts
 * @returns {number} the exit code
 */
export function runSetupCheckCli(args, gateway, opts) {
  const env = opts.env ?? process.env;
  const write = opts.stdout ?? ((s) => process.stdout.write(s));
  const writeErr = opts.stderr ?? ((s) => process.stderr.write(s));

  let json = false;
  for (const a of args) {
    if (a === '--json') json = true;
    else if (a === '--help' || a === '-h' || a === 'help') { write(CHECK_HELP); return 0; }
    else {
      writeErr(`Unknown option for check: ${a}\n\n${CHECK_HELP}`);
      return 2;
    }
  }

  let fixture;
  try {
    fixture = loadFixture(env);
  } catch {
    writeErr(`Could not read the test fixture named in SUVEREN_CHECK_FIXTURE.\n`);
    return 2;
  }

  try {
    const platform = fixture?.data.platform ?? process.platform;
    const root = fixture?.data.root ?? '';
    const uid = fixture?.data.uid !== undefined ? fixture.data.uid : (typeof process.getuid === 'function' ? process.getuid() : null);
    const notes = fixture ? [fixtureNote(fixture)] : [];
    const report = runSetupCheck({
      platform,
      home: homedir(),
      env,
      root,
      uid,
      now: opts.now ?? new Date(),
      mcpPort: opts.mcpPort,
      io: buildIo(platform, fixture, root),
      gateway: {
        ...gateway,
        inContainer: env.SUVEREN_CONTAINER === '1' || (platform !== 'win32' && existsSync(join(root || '/', '.dockerenv'))),
      },
      notes,
    });
    write(json ? renderJson(report) : renderText(report));
    return report.exitCode;
  } catch (err) {
    writeErr(`The Setup check could not finish: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
}
