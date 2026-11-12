/**
 * Setup check on Windows, without a Windows machine:
 *   - win-acl.mjs against REAL `icacls` output captured in a Windows 11 VM
 *     on 2026-11-12 (fixtures/icacls-windows11-2026-11-12.txt, six paths).
 *     The expected answers for a standard user were confirmed there by real
 *     write attempts for the first two paths.
 *   - the `whoami /user /fo csv /nh` and `whoami /groups /fo csv /nh` lines
 *     below are RECONSTRUCTED from the group names and SIDs reported from
 *     that VM (CSV layout per Microsoft's documentation of /fo csv), not
 *     captured. Re-run on the VM to confirm.
 *   - the Windows process list (PowerShell JSON) and the per-location
 *     `verified` flag, through the engine and through the real CLI with a
 *     fixture.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIcacls, parseWhoami, evaluateWrite, type WindowsIdentity } from '../../../../bundle/lib/setup-check/win-acl.mjs';
import * as real from '../../../../bundle/lib/setup-check/providers.mjs';
import { runSetupCheck, type CheckIo } from '../../../../bundle/lib/setup-check/engine.mjs';
import { renderJson, renderText } from '../../../../bundle/lib/setup-check/report.mjs';
import { CAPTURED, ENABLED, STANDARD_USER_CSV, csv, hostIsolatedEnv, icaclsBlock, icaclsBlockFor, standardGroupsCsv } from './setup-check-host.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '../../../../bundle/bin/suveren-gateway.js');

const PATHS = CAPTURED;
/** The block `icacls <path>` printed for one captured path. Built from the
 *  capture with LF line endings whatever git checked out (CRLF on Windows);
 *  CRLF, as icacls itself prints it, is tested separately below. */
const icaclsFor = icaclsBlock;
const groupsCsv = standardGroupsCsv;

function identity(userCsv: string, groups: string): WindowsIdentity {
  const id = parseWhoami(userCsv, groups);
  if (!id.ok) throw new Error('whoami fixture did not parse');
  return id;
}

const STANDARD = identity(csv('win-vm\\worker', 'S-1-5-21-1-2-3-1002'), groupsCsv());
const OWNER_USER_UNELEVATED = identity(
  csv('testpc\\owner', 'S-1-5-21-1-2-3-1001'),
  groupsCsv([csv('BUILTIN\\Administrators', 'Alias', 'S-1-5-32-544', 'Group used for deny only')]),
);
const ADMIN_ELEVATED = identity(
  csv('win-vm\\it', 'S-1-5-21-1-2-3-500'),
  groupsCsv([csv('BUILTIN\\Administrators', 'Alias', 'S-1-5-32-544', `${ENABLED}, Group owner`)]),
);

function canWrite(path: string, id: WindowsIdentity): boolean | null {
  const parsed = parseIcacls(icaclsFor(path), path);
  if (!parsed.ok) throw new Error(`capture for ${path} did not parse`);
  return evaluateWrite(parsed.entries, id);
}

describe('win-acl — real icacls output from the Windows 11 VM', () => {
  it('parses all six captured paths, with LF and with CRLF line endings (icacls prints CRLF)', () => {
    for (const p of Object.values(PATHS)) {
      const lf = icaclsFor(p);
      const crlf = lf.replace(/\n/g, '\r\n');
      const a = parseIcacls(lf, p);
      const b = parseIcacls(crlf, p);
      expect(a.ok, p).toBe(true);
      expect(b.ok, p).toBe(true);
      expect(JSON.stringify(b, (_k, v) => (v instanceof Set ? [...v] : v))).toBe(JSON.stringify(a, (_k, v) => (v instanceof Set ? [...v] : v)));
    }
    const dir = parseIcacls(icaclsFor(PATHS.lockDir), PATHS.lockDir);
    expect(dir.ok && dir.entries.length).toBe(13);
  });

  it('standard user: Program Files lock file and folder cannot be written; C:\\ folder and ProgramData can', () => {
    expect(canWrite(PATHS.lockFile, STANDARD)).toBe(false);
    expect(canWrite(PATHS.lockDir, STANDARD)).toBe(false); // (IO) entries apply to children only
    expect(canWrite(PATHS.rootDir, STANDARD)).toBe(true); // Authenticated Users:(I)(M)
    expect(canWrite(PATHS.rootFile, STANDARD)).toBe(true);
    expect(canWrite(PATHS.userPrograms, STANDARD)).toBe(false); // another user's folder
    expect(canWrite(PATHS.programData, STANDARD)).toBe(true); // Users:(CI)(WD,AD,WEA,WA)
  });

  it('the owner of the per-user folder can write it, even with Administrators "for deny only"', () => {
    expect(canWrite(PATHS.userPrograms, OWNER_USER_UNELEVATED)).toBe(true);
    // Not elevated: the Administrators allow entries do not apply.
    expect(canWrite(PATHS.lockFile, OWNER_USER_UNELEVATED)).toBe(false);
    expect(canWrite(PATHS.lockDir, OWNER_USER_UNELEVATED)).toBe(false);
  });

  it('an elevated administrator can write everything', () => {
    for (const p of Object.values(PATHS)) expect(canWrite(p, ADMIN_ELEVATED)).toBe(true);
  });

  it('SYSTEM can write everything', () => {
    const system = identity(csv('nt authority\\system', 'S-1-5-18'), [
      csv('BUILTIN\\Administrators', 'Alias', 'S-1-5-32-544', `${ENABLED}, Group owner`),
      csv('Everyone', 'Well-known group', 'S-1-1-0', ENABLED),
      csv('NT AUTHORITY\\Authenticated Users', 'Well-known group', 'S-1-5-11', ENABLED),
      csv('Mandatory Label\\System Mandatory Level', 'Label', 'S-1-16-16384', ''),
    ].join('\r\n'));
    for (const p of Object.values(PATHS)) expect(canWrite(p, system)).toBe(true);
  });
});

describe('re-labelled captures (used as fixtures on a Windows host)', () => {
  it('keep the entries and evaluate the same for any path', () => {
    for (const target of ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cli-check-x\\install\\gateway', '/tmp/cli-check-x/policy/gateway-policy.json']) {
      for (const [captured, expected] of [[CAPTURED.lockDir, false], [CAPTURED.lockFile, false], [CAPTURED.rootDir, true]] as const) {
        const parsed = parseIcacls(icaclsBlockFor(captured, target), target);
        const original = parseIcacls(icaclsFor(captured), captured);
        expect(parsed.ok && original.ok && parsed.entries.length === original.entries.length, `${captured} → ${target}`).toBe(true);
        expect(parsed.ok && evaluateWrite(parsed.entries, STANDARD)).toBe(expected);
      }
    }
  });

  it('through the real CLI (platform win32): the program folder answered from the fixture → closed', () => {
    const base = mkdtempSync(join(tmpdir(), 'cli-check-win-acl-'));
    try {
      const home = join(base, 'home');
      const data = join(base, 'data');
      mkdirSync(home, { recursive: true });
      mkdirSync(data, { recursive: true });
      // The folder the CLI runs from (its PKG_ROOT), as the CLI itself spells it.
      const programDir = resolve(dirname(CLI), '..');
      const fixture = join(base, 'fixture.json');
      writeFileSync(fixture, JSON.stringify({
        platform: 'win32', root: join(base, 'root'), psOutput: '[]', groupsOutput: groupsCsv(),
        whoamiUser: STANDARD_USER_CSV, whoamiGroups: groupsCsv(),
        icacls: { [programDir]: icaclsBlockFor(CAPTURED.lockDir, programDir) },
        owners: { [programDir]: TRUSTED_INSTALLER },
      }));
      const env = {
        ...hostIsolatedEnv(home, base), SUVEREN_DATA_DIR: data, SUVEREN_CP_PORT: '19870', SUVEREN_MCP_PORT: '19871',
        SUVEREN_INSTALL_SETTINGS_FILE: join(base, 'is.json'), SUVEREN_POLICY_FILE: join(base, 'no-policy.json'),
        SUVEREN_POLICY_REGISTRY: 'off', SUVEREN_CHECK_FIXTURE: fixture,
      };
      const r = spawnSync(process.execPath, ['--no-warnings', CLI, 'check'], { env, encoding: 'utf-8' });
      expect(r.stdout).toContain("  closed       This user cannot change the gateway's program files");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('win-acl — what gives "cannot tell"', () => {
  const evalText = (text: string, id = STANDARD) => {
    const p = 'C:\\X';
    const parsed = parseIcacls(`${p} ${text.trim().split('\n').join('\n    ')}\n\nSuccessfully processed 1 files; Failed processing 0 files\n`, p);
    return parsed.ok ? evaluateWrite(parsed.entries, id) : 'unparsed';
  };

  it('deny entries: F → cannot write; a partial deny → cannot tell; a deny for another account → ignored', () => {
    expect(evalText('BUILTIN\\Users:(DENY)(F)\nBUILTIN\\Users:(M)')).toBe(false);
    expect(evalText('Everyone:(DENY)(W)\nBUILTIN\\Users:(M)')).toBe(null);
    expect(evalText('BUILTIN\\Guests:(DENY)(F)\nBUILTIN\\Users:(M)')).toBe(true);
  });

  it('a deny entry applies through a "deny only" group; an allow entry does not', () => {
    expect(evalText('BUILTIN\\Administrators:(F)', OWNER_USER_UNELEVATED)).toBe(false);
    expect(evalText('BUILTIN\\Administrators:(DENY)(F)\nBUILTIN\\Users:(M)', OWNER_USER_UNELEVATED)).toBe(false);
  });

  it('owner-dependent principals and integrity labels are not evaluated', () => {
    expect(evalText('CREATOR OWNER:(F)\nBUILTIN\\Users:(RX)')).toBe(null);
    expect(evalText('OWNER RIGHTS:(M)')).toBe(null);
    expect(evalText('BUILTIN\\Users:(M)\nMandatory Label\\High Mandatory Level:(NW)')).toBe(null);
    // Inherit-only CREATOR OWNER (the usual case) applies to children only.
    expect(evalText('CREATOR OWNER:(OI)(CI)(IO)(F)\nBUILTIN\\Users:(RX)')).toBe(false);
  });

  it('a non-English Windows: unrecognised group state → cannot tell for allow-via-group', () => {
    const german = identity(csv('pc\\mitarbeiter', 'S-1-5-21-9-9-9-1001'), [
      csv('VORDEFINIERT\\Benutzer', 'Alias', 'S-1-5-32-545', 'Verbindliche Gruppe, Standardmäßig aktiviert, Aktivierte Gruppe'),
    ].join('\r\n'));
    expect(evalText('VORDEFINIERT\\Benutzer:(M)', german)).toBe(null);
    expect(evalText('VORDEFINIERT\\Benutzer:(RX)', german)).toBe(false);
    // A garbled (non-ASCII) account name that grants write cannot be matched.
    expect(evalText('PC\\Prüfer:(M)', german)).toBe(null);
  });

  it('changing the access list or the owner counts as write', () => {
    expect(evalText('BUILTIN\\Users:(WDAC)')).toBe(true);
    expect(evalText('BUILTIN\\Users:(RX,WO)')).toBe(true);
  });

  it('unknown rights, a missing path line or garbage → not parsed (the provider answers cannot tell)', () => {
    expect(evalText('BUILTIN\\Users:(I)(ZZ)')).toBe('unparsed');
    expect(parseIcacls('C:\\Other BUILTIN\\Users:(F)\n', 'C:\\X').ok).toBe(false);
    expect(parseIcacls('Access is denied.\n', 'C:\\X').ok).toBe(false);
    expect(parseWhoami('garbage', '').ok).toBe(false);
  });
});

const TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const WORKER_SID = 'S-1-5-21-1-2-3-1002';

describe('providers.writable on Windows — read-only, via icacls + whoami (+ owner when "cannot write")', () => {
  const runnerFor = (map: Record<string, string>, userCsv: string, groups: string, owners: Record<string, string> = {}) => {
    const calls: { bin: string; args: string[]; env: Record<string, string> | null | undefined }[] = [];
    const runner = (bin: string, args: string[], _t?: number, env?: Record<string, string> | null) => {
      calls.push({ bin, args, env });
      if (bin === 'whoami') return { ok: true as const, stdout: args[0] === '/user' ? userCsv : groups };
      if (bin === 'icacls' && args.length === 1 && args[0] in map) return { ok: true as const, stdout: map[args[0]] };
      if (bin === 'powershell.exe' && args[args.length - 1] === real.WINDOWS_OWNER_SCRIPT && env?.SUVEREN_CHECK_PATH && env.SUVEREN_CHECK_PATH in owners) {
        return { ok: true as const, stdout: owners[env.SUVEREN_CHECK_PATH] };
      }
      return { error: 'failed' };
    };
    return { runner, calls };
  };
  const worker = () => csv('win-vm\\worker', WORKER_SID);

  it('answers true / false from the access list; runs only whoami, `icacls <path>` and the read-only owner lookup', () => {
    const map = { [PATHS.lockFile]: icaclsFor(PATHS.lockFile), [PATHS.rootDir]: icaclsFor(PATHS.rootDir) };
    const { runner, calls } = runnerFor(map, worker(), groupsCsv(), { [PATHS.lockFile]: TRUSTED_INSTALLER });
    expect(real.writable(PATHS.lockFile, 'win32', runner)).toBe(false);
    expect(real.writable(PATHS.rootDir, 'win32', runner)).toBe(true);
    for (const c of calls) {
      expect(['whoami', 'icacls', 'powershell.exe']).toContain(c.bin);
      // No /save, /grant, /reset … — only the plain read form.
      if (c.bin === 'icacls') expect(c.args.length).toBe(1);
      // The path reaches PowerShell only as an environment variable, never in the script.
      if (c.bin === 'powershell.exe') {
        expect(c.args[c.args.length - 1]).toBe(real.WINDOWS_OWNER_SCRIPT);
        expect(c.env?.SUVEREN_CHECK_PATH).toBe(PATHS.lockFile);
      }
    }
    // The owner is asked only when the list says "cannot write".
    expect(calls.filter((c) => c.bin === 'powershell.exe')).toHaveLength(1);
  });

  it('the owner can always give themselves write access again: "cannot write" becomes "can change"', () => {
    const map = { [PATHS.lockFile]: icaclsFor(PATHS.lockFile) };
    // Owned by this user.
    expect(real.writable(PATHS.lockFile, 'win32', runnerFor(map, worker(), groupsCsv(), { [PATHS.lockFile]: WORKER_SID }).runner)).toBe(true);
    // Owned by Administrators: counts only for an ELEVATED administrator.
    const admins = 'S-1-5-32-544';
    const elevated = groupsCsv([csv('BUILTIN\\Administrators', 'Alias', admins, `${ENABLED}, Group owner`)]);
    const denyOnly = groupsCsv([csv('BUILTIN\\Administrators', 'Alias', admins, 'Group used for deny only')]);
    expect(real.writable(PATHS.lockFile, 'win32', runnerFor(map, worker(), denyOnly, { [PATHS.lockFile]: admins }).runner)).toBe(false);
    // (Elevated admins are allowed by the list itself already.)
    expect(real.writable(PATHS.lockFile, 'win32', runnerFor(map, worker(), elevated, { [PATHS.lockFile]: admins }).runner)).toBe(true);
  });

  it('owner unknown → cannot tell; an OWNER RIGHTS entry takes the owner\'s implicit rights away', () => {
    const map = { [PATHS.lockFile]: icaclsFor(PATHS.lockFile) };
    expect(real.writable(PATHS.lockFile, 'win32', runnerFor(map, worker(), groupsCsv(), {}).runner)).toBe(null);
    const p = 'C:\\IT\\lock.json';
    const withOwnerRights = `${p} OWNER RIGHTS:(RX)\n    BUILTIN\\Users:(RX)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;
    const { runner, calls } = runnerFor({ [p]: withOwnerRights }, worker(), groupsCsv(), { [p]: WORKER_SID });
    expect(real.writable(p, 'win32', runner)).toBe(false);
    expect(calls.some((c) => c.bin === 'powershell.exe')).toBe(false);
  });

  it('icacls or whoami failing → null (cannot tell), never "writable"', () => {
    const { runner } = runnerFor({}, worker(), groupsCsv());
    expect(real.writable('C:\\Nope', 'win32', runner)).toBe(null);
    const broken = (bin: string) => (bin === 'whoami' ? { error: 'failed' } : { ok: true as const, stdout: icaclsFor(PATHS.rootDir) });
    expect(real.writable(PATHS.rootDir, 'win32', broken)).toBe(null);
  });

  it('the owner lookup script loads no module (no cmdlet), so it needs no command lookup', () => {
    // Only .NET types and $env — no `Verb-Noun` cmdlet names.
    expect(real.WINDOWS_OWNER_SCRIPT).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/);
    expect(real.WINDOWS_OWNER_SCRIPT).toContain('$env:SUVEREN_CHECK_PATH');
  });
});

describe('Windows process list (PowerShell Get-CimInstance JSON)', () => {
  const TOKEN = 'access_WINPS_NOLEAK_0123456789';

  it('is a fixed, non-interactive, profile-less PowerShell call with a structured output', () => {
    const [bin, args] = real.WINDOWS_PROCESS_COMMAND;
    expect(bin).toBe('powershell.exe');
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden']));
    expect(args[args.length - 1]).toMatch(/Get-CimInstance -ClassName Win32_Process \| Select-Object Name, CommandLine \| ConvertTo-Json -Compress$/);
  });

  it('parses an array, a single object and an empty answer; skips processes without a readable command line', () => {
    expect(real.parseProcessList('win32', JSON.stringify([{ Name: 'a', CommandLine: 'a.exe x' }, { Name: 'b', CommandLine: null }])))
      .toEqual({ ok: true, commands: ['a.exe x'] });
    expect(real.parseProcessList('win32', JSON.stringify({ Name: 'a', CommandLine: 'a.exe' }))).toEqual({ ok: true, commands: ['a.exe'] });
    // A real list is never empty: no output is a failure, never "no programs".
    expect(real.parseProcessList('win32', '')).toEqual({ error: 'unreadable', reason: 'gave no output' });
    expect(real.parseProcessList('win32', '[]')).toEqual({ ok: true, commands: [] });
  });

  it('unparseable output → error without the text in it', () => {
    const r = real.parseProcessList('win32', `not json ${TOKEN}`);
    expect(r.ok).toBeFalsy();
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('through the real CLI with platform win32: flagged, scoped wording, token nowhere', () => {
    const base = mkdtempSync(join(tmpdir(), 'cli-check-win-'));
    try {
      const home = join(base, 'home');
      const data = join(base, 'data');
      mkdirSync(home, { recursive: true });
      mkdirSync(data, { recursive: true });
      const processes = [
        { Name: 'System', CommandLine: null },
        { Name: 'node.exe', CommandLine: `"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\w\\.suveren\\integrations\\node_modules\\.bin\\mcp-remote https://mcp.mollie.com/mcp --header "Authorization: Bearer ${TOKEN}"` },
      ];
      const fixture = join(base, 'fixture.json');
      writeFileSync(fixture, JSON.stringify({
        platform: 'win32', root: join(base, 'root'), psOutput: JSON.stringify(processes),
        groupsOutput: groupsCsv(), whoamiUser: csv('win-vm\\worker', 'S-1-5-21-1-2-3-1002'), whoamiGroups: groupsCsv(), icacls: {},
      }));
      const env = {
        ...hostIsolatedEnv(home, base), SUVEREN_DATA_DIR: data, SUVEREN_CP_PORT: '19850', SUVEREN_MCP_PORT: '19851',
        SUVEREN_INSTALL_SETTINGS_FILE: join(base, 'is.json'), SUVEREN_POLICY_FILE: join(base, 'no-policy.json'),
        SUVEREN_POLICY_REGISTRY: 'off', SUVEREN_CHECK_FIXTURE: fixture,
      };
      const text = spawnSync(process.execPath, ['--no-warnings', CLI, 'check'], { env, encoding: 'utf-8' });
      const json = spawnSync(process.execPath, ['--no-warnings', CLI, 'check', '--json'], { env, encoding: 'utf-8' });
      expect(text.stdout).toMatch(/open {9}mcp-remote: a sign-in token \(Authorization: Bearer\) in its start command, readable by programs of this user and by administrators; on Windows, without administrator rights this check sees only this user's programs/);
      // No icacls answer for the program folder → cannot tell, never "open".
      expect(text.stdout).toMatch(/cannot tell {2}Whether this user can change the gateway's program files could not be read/);
      for (const out of [text.stdout, text.stderr, json.stdout, json.stderr]) expect(out).not.toContain(TOKEN);
      expect(JSON.parse(json.stdout).findings.find((f: { subject: string }) => f.subject === 'mcp-remote').source)
        .toBe('process list (PowerShell Get-CimInstance Win32_Process)');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});


/** Locations the engine looked at for Codex (found via its config dir). */
function resolveVerified(platform: string, env: Record<string, string>) {
  const home = platform === 'win32' ? 'C:\\Users\\it' : '/Users/it';
  const codexDir = platform === 'win32' ? 'C:\\Users\\it\\.codex' : '/Users/it/.codex';
  const io: CheckIo = {
    readText: () => ({ missing: true }),
    exists: (p) => p === codexDir,
    isDir: () => false,
    list: () => null,
    writable: () => false,
    nearestCreatable: () => ({ ancestor: null, writable: false }),
    ownerUid: () => null,
    ps: () => ({ ok: true, commands: [] }),
    groups: () => ({ ok: true, stdout: '' }),
    plist: () => ({ missing: true }),
    registry: () => ({ missing: true }),
  };
  const r = runSetupCheck({ platform, home, env: { PATH: '', ...env }, uid: null, mcpPort: 3430, io, root: '', gateway: { policy: { locked: [] } } });
  return r.locations.filter((l) => l.app === 'ChatGPT desktop app / Codex');
}

describe('Linux without `ps`: /proc fallback', () => {
  const TOKEN = 'access_PROC_NOLEAK_987654321';
  function procTree(base: string) {
    const proc = join(base, 'root', 'proc');
    const write = (pid: string, args: string[] | null) => {
      mkdirSync(join(proc, pid), { recursive: true });
      if (args) writeFileSync(join(proc, pid, 'cmdline'), args.join('\0') + '\0');
    };
    write('1', ['/sbin/init']);
    write('42', ['node', '/home/w/.suveren/integrations/node_modules/.bin/mcp-remote', 'https://mcp.mollie.com/mcp', '--header', `Authorization: Bearer ${TOKEN}`]);
    write('43', null); // gone / unreadable: skipped
    write('44', []); // kernel thread: empty cmdline
    mkdirSync(join(proc, 'self'), { recursive: true }); // not a pid
    return proc;
  }

  it('reads NUL-separated arguments, skips what it cannot read', () => {
    const base = mkdtempSync(join(tmpdir(), 'proc-'));
    try {
      const r = real.procCommands(procTree(base));
      expect(r.ok).toBe(true);
      expect(r.ok && [...r.commands].sort()).toEqual([
        '/sbin/init',
        `node /home/w/.suveren/integrations/node_modules/.bin/mcp-remote https://mcp.mollie.com/mcp --header Authorization: Bearer ${TOKEN}`,
      ]);
      expect(real.procCommands(join(base, 'nope')).ok).toBeFalsy();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('through the real CLI (platform linux, ps missing): flagged from /proc, token nowhere', () => {
    const base = mkdtempSync(join(tmpdir(), 'cli-check-proc-'));
    try {
      const proc = procTree(base);
      const home = join(base, 'home');
      const data = join(base, 'data');
      mkdirSync(home, { recursive: true });
      mkdirSync(data, { recursive: true });
      const fixture = join(base, 'fixture.json');
      writeFileSync(fixture, JSON.stringify({ platform: 'linux', root: join(base, 'root'), psOutput: null, groupsOutput: 'w' }));
      const env = {
        ...hostIsolatedEnv(home, base), SUVEREN_DATA_DIR: data, SUVEREN_CP_PORT: '19860', SUVEREN_MCP_PORT: '19861',
        SUVEREN_INSTALL_SETTINGS_FILE: join(base, 'is.json'), SUVEREN_POLICY_FILE: join(base, 'no-policy.json'),
        SUVEREN_POLICY_REGISTRY: 'off', SUVEREN_CHECK_FIXTURE: fixture,
      };
      const text = spawnSync(process.execPath, ['--no-warnings', CLI, 'check'], { env, encoding: 'utf-8' });
      const json = spawnSync(process.execPath, ['--no-warnings', CLI, 'check', '--json'], { env, encoding: 'utf-8' });
      expect(text.stdout).toMatch(/open {9}mcp-remote: a sign-in token \(Authorization: Bearer\) in its start command, readable by every user of this computer/);
      for (const out of [text.stdout, text.stderr, json.stdout, json.stderr]) expect(out).not.toContain(TOKEN);
      expect(JSON.parse(json.stdout).findings.find((f: { subject: string }) => f.subject === 'mcp-remote').source).toBe(`process list (${proc})`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('verified per location', () => {
  it('Codex requirements.toml: tested on Windows only; macOS path and the user config stay untested', () => {
    const win = resolveVerified('win32', { ProgramData: 'C:\\ProgramData' });
    expect(win.find((l) => l.location === 'C:\\ProgramData\\OpenAI\\Codex\\requirements.toml'))
      .toMatchObject({ verified: true, verifiedNote: 'tested 2026-11-12 with codex-cli 0.167.2 on Windows 11' });
    const mac = resolveVerified('darwin', {});
    expect(mac.find((l) => l.location.endsWith('/etc/codex/requirements.toml'))?.verified).toBe(false);
    expect(win.filter((l) => l.verified).map((l) => l.location)).toEqual(['C:\\ProgramData\\OpenAI\\Codex\\requirements.toml']);
  });

  it('Claude Code managed-mcp.json on Windows counts as tested; the footer counts the rest', () => {
    const files = new Map<string, string>([
      ['C:\\Users\\it\\.claude.json', JSON.stringify({ mcpServers: { other: { command: 'x' } } })],
      ['C:\\Program Files\\ClaudeCode\\managed-mcp.json', JSON.stringify({ mcpServers: { suveren: { url: 'http://127.0.0.1:3430/mcp' } } })],
    ]);
    const io: CheckIo = {
      readText: (p) => (files.has(p) ? { ok: true, text: files.get(p)! } : { missing: true }),
      exists: (p) => files.has(p),
      isDir: () => false,
      list: () => null,
      writable: () => false,
      nearestCreatable: () => ({ ancestor: 'C:\\', writable: false }),
      ownerUid: () => null,
      ps: () => ({ ok: true, commands: [] }),
      groups: () => ({ ok: true, stdout: groupsCsv() }),
      plist: () => ({ missing: true }),
      registry: () => ({ missing: true }),
    };
    const r = runSetupCheck({
      platform: 'win32', home: 'C:\\Users\\it', env: { PATH: '', ProgramFiles: 'C:\\Program Files' }, uid: null,
      now: new Date(2026, 10, 12), mcpPort: 3430, io,
      gateway: { version: '0.44.1', dataDir: 'C:\\Users\\it\\.suveren', policy: { locked: [] } },
    });
    const lockLoc = r.locations.find((l) => l.location === 'C:\\Program Files\\ClaudeCode\\managed-mcp.json');
    expect(lockLoc).toMatchObject({ verified: true, verifiedNote: 'tested 2026-11-12 with Claude Code 2.1.322 on Windows 11', present: true });
    const unverified = r.locations.filter((l) => !l.verified).length;
    expect(unverified).toBe(r.locations.length - 1);
    expect(r.notes).toContain(`${unverified} of the ${r.locations.length} settings and lock locations this check looked at come from the vendors' documentation and are not yet tested on a real install.`);
    // The Windows exclusive lock: the leftover connector is switched off, closed.
    const conn = r.findings.find((f) => f.subject === 'Claude Code' && /only connector/.test(f.detail));
    expect(conn?.result).toBe('closed');
    expect(conn?.detail).toBe("the gateway is the only connector (1 entry in the user's settings is switched off by the lock)");
    expect(renderText(r)).toContain('closed       Claude Code: the gateway is the only connector (1 entry');
    expect(JSON.parse(renderJson(r)).locations.length).toBe(r.locations.length);
  });
});
