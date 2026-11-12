/**
 * `suveren-gateway check` — the Setup check, through the REAL CLI
 * (`bundle/bin/suveren-gateway.js`) as a child process, same convention as
 * gateway-cli-simulation.test.ts.
 *
 * The CLI runs with the HOST's real platform, so it uses the host's real
 * providers (POSIX permissions and `ps` on macOS/Linux; icacls, whoami and
 * PowerShell on Windows). Isolation, the same on every host (see
 * setup-check-host.ts): the home folder (HOME and, for Windows, USERPROFILE),
 * the Windows app locations (APPDATA, ProgramFiles, …) and PATH are pinned
 * to the fixture / system folders; SUVEREN_DATA_DIR, the ports,
 * SUVEREN_POLICY_FILE and SUVEREN_INSTALL_SETTINGS_FILE point at temp paths;
 * SUVEREN_CHECK_FIXTURE replaces the POSIX system root, the group list and
 * (unless a test wants the real one) the process list.
 *
 * Where a test needs a file this user cannot write, the host decides how:
 * mode bits on POSIX; on Windows the fixture gives `icacls` the real output
 * captured in a Windows 11 VM for a Program Files path, re-labelled. The
 * assertion is the same on every host.
 *
 * One test deliberately uses the REAL process list: it starts a process with
 * a fake Mollie-style token in its arguments and checks the token is
 * flagged and printed nowhere.
 *
 * The check is read-only; nothing here starts a gateway.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTURED, IS_WINDOWS_HOST, STANDARD_USER_CSV, hostIsolatedEnv, icaclsBlockFor, standardGroupsCsv,
} from './setup-check-host.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(__dirname, '../../../../bundle');
const CLI = join(BUNDLE, 'bin', 'suveren-gateway.js');

const MCP_PORT = '19841';
const CP_PORT = '19840';
const GW_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;

/** TEMP DIAGNOSTIC (remove once the Windows CI run is green): what the real
 *  Windows tools print for a path, attached to a failure message only.
 *  Account names and SIDs of the CI runner, no secret. */
function windowsDiagnostic(path: string): string {
  if (!IS_WINDOWS_HOST) return '';
  const out = (bin: string, args: string[]) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
    return `$ ${bin} ${args.join(' ')} → status ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}`;
  };
  return `\n[TEMP DIAGNOSTIC]\n${out('icacls', [path])}\n${out('whoami', ['/user', '/fo', 'csv', '/nh'])}\n${out('whoami', ['/groups', '/fo', 'csv', '/nh'])}`;
}

const dirs: string[] = [];
const locked: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* ignore */ } }
  for (const p of locked.splice(0)) { try { chmodSync(p, 0o755); } catch { /* ignore */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

interface World { base: string; home: string; root: string; data: string; fixture: string }

function world(fixture: Record<string, unknown> = {}): World {
  const base = mkdtempSync(join(tmpdir(), 'cli-check-'));
  dirs.push(base);
  const w = { base, home: join(base, 'home'), root: join(base, 'root'), data: join(base, 'data'), fixture: join(base, 'fixture.json') };
  for (const d of [w.home, w.root, w.data]) mkdirSync(d, { recursive: true });
  writeFileSync(w.fixture, JSON.stringify({ root: w.root, psOutput: '', groupsOutput: 'staff everyone', ...fixture }));
  return w;
}

function put(path: string, content: string | object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
}

function readOnlyTree(dir: string): void {
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) {
      for (const n of readdirSync(p)) walk(join(p, n));
      chmodSync(p, 0o555);
    } else {
      chmodSync(p, 0o444);
    }
    locked.unshift(p);
  };
  walk(dir);
}

function run(w: World, args: string[], opts: { cli?: string; fixture?: boolean; env?: Record<string, string>; timeoutMs?: number } = {}) {
  const env: Record<string, string> = {
    ...hostIsolatedEnv(w.home, w.base),
    SUVEREN_DATA_DIR: w.data,
    SUVEREN_CP_PORT: CP_PORT,
    SUVEREN_MCP_PORT: MCP_PORT,
    SUVEREN_INSTALL_SETTINGS_FILE: join(w.base, 'install-settings.json'),
    SUVEREN_POLICY_FILE: join(w.base, 'no-policy.json'),
    SUVEREN_POLICY_REGISTRY: 'off',
    ...(opts.fixture === false ? {} : { SUVEREN_CHECK_FIXTURE: w.fixture }),
    ...opts.env,
  };
  const res = spawnSync(process.execPath, ['--no-warnings', opts.cli ?? CLI, 'check', ...args], { env, encoding: 'utf-8', timeout: opts.timeoutMs ?? 30_000 });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('suveren-gateway check — usage', () => {
  it('unknown option: exit 2 with the help', () => {
    const w = world();
    const r = run(w, ['--fix']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unknown option for check: --fix');
    expect(r.stderr).toContain('suveren-gateway check [--json]');
  });

  it('--help: exit 0, explains the three results, no promise words', () => {
    const w = world();
    const r = run(w, ['--help']);
    expect(r.status).toBe(0);
    for (const s of ['closed', 'open', 'cannot tell', 'not a guarantee']) expect(r.stdout).toContain(s);
    expect(r.stdout).not.toMatch(/\b(secure|safe|certified|proven)\b/i);
  });

  it('is listed in the main help', () => {
    const res = spawnSync(process.execPath, ['--no-warnings', CLI, 'help'], { encoding: 'utf-8', env: { ...process.env, SUVEREN_CP_PORT: CP_PORT, SUVEREN_MCP_PORT: MCP_PORT } });
    expect(res.stdout).toContain('suveren-gateway check [--json]');
  });
});

describe('suveren-gateway check — results and exit codes', () => {
  it('another connector: exit 1; text sections in order; nothing written to disk', () => {
    const w = world();
    put(join(w.home, '.claude.json'), {
      mcpServers: {
        suveren: { type: 'http', url: GW_URL },
        github: { command: 'npx', args: ['server-github'], env: { GITHUB_TOKEN: 'ghp_CONFIG_NOLEAK_123' } },
      },
    });
    const before = readdirSync(w.data);
    const r = run(w, []);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^Suveren Setup check — \d{1,2} [A-Z][a-z]+ \d{4}\nAI apps found: Claude Code\n/);
    expect(r.stdout).toContain('  open         Claude Code: 1 other connector (github)');
    const order = ['\nNo other route\n', '\nNo passwords within reach\n', '\nNo hand on the gateway\n', '\nConfirm by hand\n', '\nResult: '];
    const idx = order.map((s) => r.stdout.indexOf(s));
    expect(idx.every((n) => n > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(r.stdout).toContain('Test fixture in use');
    expect(r.stdout + r.stderr).not.toContain('NOLEAK');
    expect(readdirSync(w.data)).toEqual(before);
  });

  it('--json: same findings with group/result/subject/detail/source, exit code inside and outside', () => {
    const w = world();
    put(join(w.home, '.codex', 'config.toml'), `[mcp_servers.suveren]\nurl = "${GW_URL}"\n`);
    const r = run(w, ['--json']);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.check).toBe('suveren-setup-check');
    expect(j.aiAppsFound).toEqual([{ id: 'codex', name: 'ChatGPT desktop app / Codex' }]);
    expect(j.gateway.mcpPort).toBe(Number(MCP_PORT));
    for (const f of j.findings) expect(Object.keys(f).sort()).toEqual(['detail', 'group', 'result', 'source', 'subject']);
    // The CLI runs with the host's platform, so `~` is followed by the host's separator.
    expect(j.findings.find((f: { detail: string }) => f.detail === 'the gateway is the only connector').source).toBe(['~', '.codex', 'config.toml'].join(sep));
    expect(j.summary.open).toBeGreaterThan(0);
    expect(j.exitCode).toBe(1);
    expect(j.confirmByHand.length).toBeGreaterThanOrEqual(3);
  });

  it('nothing open: exit 0 ("cannot tell" alone does not make it 1)', () => {
    const w = world();
    const program = join(w.base, 'install', 'gateway');
    const policy = join(w.base, 'policy', 'gateway-policy.json');
    // On Windows, `icacls` answers from the fixture with the real capture of
    // a Program Files folder / file (a standard user may only read); on
    // POSIX the mode bits below decide and the fixture is not consulted.
    writeFileSync(w.fixture, JSON.stringify({
      root: w.root, psOutput: '', groupsOutput: 'staff everyone',
      icacls: {
        [program]: icaclsBlockFor(CAPTURED.lockDir, program),
        [policy]: icaclsBlockFor(CAPTURED.lockFile, policy),
      },
      whoamiUser: STANDARD_USER_CSV,
      whoamiGroups: standardGroupsCsv(),
    }));
    // A read-only copy of the CLI, so "who can change the program files" is closed.
    mkdirSync(program, { recursive: true });
    cpSync(join(BUNDLE, 'bin'), join(program, 'bin'), { recursive: true });
    cpSync(join(BUNDLE, 'lib'), join(program, 'lib'), { recursive: true });
    put(join(program, 'package.json'), { name: '@suveren/gateway', version: '0.0.0-test', type: 'module' });
    readOnlyTree(join(w.base, 'install'));
    // A read-only IT settings file that fixes the Authority Server address
    // (and the team), through the real policy.mjs.
    put(policy, { AsUrl: 'https://as.example.com', Team: 'grp_test', Simulation: true });
    readOnlyTree(join(w.base, 'policy'));

    const r = run(w, [], { cli: join(program, 'bin', 'suveren-gateway.js'), env: { SUVEREN_POLICY_FILE: policy } });
    expect(r.stdout).toContain('AI apps found: none recognised');
    expect(r.stdout).toContain('Gateway: version 0.0.0-test, simulation on');
    expect(r.stdout).toContain('  closed       IT has fixed the Authority Server address, and this user cannot change that\n');
    expect(r.stdout).toContain("  closed       This user cannot change the gateway's program files");
    expect(r.stdout).toMatch(/Result: 0 open, [1-9]\d* to confirm by hand/);
    expect(r.stdout).toContain('  cannot tell  ');
    expect(r.status).toBe(0);
  });

  it('IT settings through the real policy.mjs: a writable file → open; no file → one open line', () => {
    const w = world();
    const policy = join(w.base, 'policy', 'gateway-policy.json');
    put(policy, { AsUrl: 'https://as.example.com' });
    // The real host decides: this user created the file, so it can change it.
    const writableRun = run(w, [], { env: { SUVEREN_POLICY_FILE: policy } });
    expect(writableRun.stdout, windowsDiagnostic(policy)).toContain(`  open         IT has fixed the Authority Server address, but this user can change the settings file (${policy})`);
    const none = run(w, []);
    const lines = none.stdout.split('\n').filter((l) => /IT settings|create that file/.test(l));
    expect(lines, windowsDiagnostic(w.base)).toEqual([
      `  open         No IT settings file: this user can point the gateway at another Authority Server. IT closes this by fixing the address in the settings file (${join(w.base, 'no-policy.json')}); this user could also create that file themselves`,
    ]);
  });

  it('a user-writable lock file: open, exit 1', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: {} });
    // Where Claude Code's lock lives on the host platform (fixture root on
    // POSIX; the fixture ProgramFiles on Windows, see hostIsolatedEnv).
    const lock = IS_WINDOWS_HOST
      ? join(w.base, 'ProgramFiles', 'ClaudeCode', 'managed-mcp.json')
      : process.platform === 'darwin'
        ? join(w.root, 'Library', 'Application Support', 'ClaudeCode', 'managed-mcp.json')
        : join(w.root, 'etc', 'claude-code', 'managed-mcp.json');
    put(lock, { mcpServers: { suveren: { url: GW_URL } } });
    const r = run(w, []);
    expect(r.stdout, windowsDiagnostic(lock)).toMatch(/open {9}Claude Code: IT allows only the gateway as connector, but this user can change the lock/);
    expect(r.status).toBe(1);
  });
});

describe('suveren-gateway check — real process list', () => {
  // Every host: `ps` on macOS/Linux, PowerShell Get-CimInstance on Windows
  // (whose first start can be slow, hence the longer limits).
  it('flags a Bearer token in a running process, prints the program name only', { timeout: 180_000 }, async () => {
    const w = world();
    // A stand-in for the gateway's Mollie connector: `mcp-remote <url> --header "Authorization: Bearer <token>"`.
    const token = `access_TESTONLY${Date.now()}x9`;
    const script = join(w.base, 'node_modules', 'mcp-remote', 'dist', 'proxy.js');
    put(script, 'setTimeout(() => {}, 60_000);');
    const child = spawn(process.execPath, [script, 'https://mcp.mollie.com/mcp', '--header', `Authorization: Bearer ${token}`], { stdio: 'ignore' });
    children.push(child);
    await new Promise((r) => setTimeout(r, 1000));
    // No psOutput in the fixture: the CLI runs the real `ps`.
    writeFileSync(w.fixture, JSON.stringify({ root: w.root, groupsOutput: 'staff' }));

    const text = run(w, [], { timeoutMs: 80_000 });
    const json = run(w, ['--json'], { timeoutMs: 80_000 });
    expect(text.stdout, `status ${text.status}; stderr: ${text.stderr.slice(0, 2000)}`).toMatch(/open {9}mcp-remote: a sign-in token \(Authorization: Bearer\) in its start command/);
    expect(text.stdout + text.stderr).not.toContain(token);
    expect(json.stdout + json.stderr).not.toContain(token);
    expect(JSON.parse(json.stdout).findings.some((f: { subject: string; result: string }) => f.subject === 'mcp-remote' && f.result === 'open')).toBe(true);
  });
});
