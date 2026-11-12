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
 * A test cannot create a file it does not own, and the owner may always
 * change its own files (chmod / access list). Where a test needs "this user
 * cannot change it", the fixture's `writable` answers for that path; the real
 * answers per host are tested against system files in
 * setup-check-engine.test.ts. Tests that need "can change" use the real
 * providers on the host.
 *
 * One test deliberately uses the REAL process list: it starts a process with
 * a fake Mollie-style token in its arguments and checks the token is
 * flagged and printed nowhere.
 *
 * The check is read-only; nothing here starts a gateway.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_RUN_LIMIT_MS, IS_WINDOWS_HOST, cliTestTimeout, hostIsolatedEnv } from './setup-check-host.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(__dirname, '../../../../bundle');
const CLI = join(BUNDLE, 'bin', 'suveren-gateway.js');

const MCP_PORT = '19841';
const CP_PORT = '19840';
const GW_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;

/** A process list with nothing in it, in the host's format (`ps` text, or
 *  PowerShell JSON — where empty OUTPUT counts as a failure). */
const EMPTY_PROCESS_LIST = IS_WINDOWS_HOST ? '[]' : '';

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* ignore */ } }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

interface World { base: string; home: string; root: string; data: string; fixture: string }

function world(fixture: Record<string, unknown> = {}): World {
  const base = mkdtempSync(join(tmpdir(), 'cli-check-'));
  dirs.push(base);
  const w = { base, home: join(base, 'home'), root: join(base, 'root'), data: join(base, 'data'), fixture: join(base, 'fixture.json') };
  for (const d of [w.home, w.root, w.data]) mkdirSync(d, { recursive: true });
  writeFileSync(w.fixture, JSON.stringify({ root: w.root, psOutput: EMPTY_PROCESS_LIST, groupsOutput: 'staff everyone', ...fixture }));
  return w;
}

function put(path: string, content: string | object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
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
  const res = spawnSync(process.execPath, ['--no-warnings', opts.cli ?? CLI, 'check', ...args], { env, encoding: 'utf-8', timeout: opts.timeoutMs ?? CLI_RUN_LIMIT_MS });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('suveren-gateway check — usage', () => {
  it('unknown option: exit 2 with the help', { timeout: cliTestTimeout(1) }, () => {
    const w = world();
    const r = run(w, ['--fix']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unknown option for check: --fix');
    expect(r.stderr).toContain('suveren-gateway check [--json]');
  });

  it('--help: exit 0, explains the three results, no promise words', { timeout: cliTestTimeout(1) }, () => {
    const w = world();
    const r = run(w, ['--help']);
    expect(r.status).toBe(0);
    for (const s of ['closed', 'open', 'cannot tell', 'not a guarantee']) expect(r.stdout).toContain(s);
    expect(r.stdout).not.toMatch(/\b(secure|safe|certified|proven)\b/i);
  });

  it('is listed in the main help', { timeout: cliTestTimeout(1) }, () => {
    const res = spawnSync(process.execPath, ['--no-warnings', CLI, 'help'], { encoding: 'utf-8', timeout: CLI_RUN_LIMIT_MS, env: { ...process.env, SUVEREN_CP_PORT: CP_PORT, SUVEREN_MCP_PORT: MCP_PORT } });
    expect(res.stdout).toContain('suveren-gateway check [--json]');
  });
});

describe('suveren-gateway check — results and exit codes', () => {
  it('another connector: exit 1; text sections in order; nothing written to disk', { timeout: cliTestTimeout(1) }, () => {
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
    // The note names exactly what the fixture replaces.
    expect(r.stdout).toContain(`Test fixture in use (${w.fixture}): system folders, the process list and the group list in this report are not this computer's.`);
    expect(r.stdout + r.stderr).not.toContain('NOLEAK');
    expect(readdirSync(w.data)).toEqual(before);
  });

  it('--json: same findings with group/result/subject/detail/source, exit code inside and outside', { timeout: cliTestTimeout(1) }, () => {
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

  it('nothing open: exit 0 ("cannot tell" alone does not make it 1)', { timeout: cliTestTimeout(1) }, () => {
    const w = world();
    const program = join(w.base, 'install', 'gateway');
    const policy = join(w.base, 'policy', 'gateway-policy.json');
    // A copy of the CLI with a known version, run from its own folder.
    mkdirSync(program, { recursive: true });
    cpSync(join(BUNDLE, 'bin'), join(program, 'bin'), { recursive: true });
    cpSync(join(BUNDLE, 'lib'), join(program, 'lib'), { recursive: true });
    put(join(program, 'package.json'), { name: '@suveren/gateway', version: '0.0.0-test', type: 'module' });
    // An IT settings file that fixes the Authority Server address (and the
    // team), read through the real policy.mjs.
    put(policy, { AsUrl: 'https://as.example.com', Team: 'grp_test', Simulation: true });
    // "This user cannot change them" comes from the fixture: a test cannot
    // create files it does not own, and the owner may always change its own
    // files (chmod / access list). The real answers on each host are tested
    // against system files in setup-check-engine.test.ts, and the Windows
    // access-list path in setup-check-windows.test.ts. Keyed as the CLI
    // spells its own folder: Node resolves the main script with realpath
    // (e.g. /var → /private/var on macOS).
    writeFileSync(w.fixture, JSON.stringify({
      root: w.root, psOutput: EMPTY_PROCESS_LIST, groupsOutput: 'staff everyone',
      writable: { [realpathSync(program)]: false, [policy]: false },
    }));

    const r = run(w, [], { cli: join(program, 'bin', 'suveren-gateway.js'), env: { SUVEREN_POLICY_FILE: policy } });
    expect(r.stdout).toContain('AI apps found: none recognised');
    expect(r.stdout).toContain('Gateway: version 0.0.0-test, simulation on');
    expect(r.stdout).toContain('  closed       IT has fixed the Authority Server address, and this user cannot change that\n');
    expect(r.stdout).toContain("  closed       This user cannot change the gateway's program files");
    expect(r.stdout).toMatch(/Result: 0 open, [1-9]\d* to confirm by hand/);
    expect(r.stdout).toContain('  cannot tell  ');
    expect(r.status).toBe(0);
  });

  it('IT settings through the real policy.mjs: a writable file → open; no file → one open line', { timeout: cliTestTimeout(2) }, () => {
    const w = world();
    const policy = join(w.base, 'policy', 'gateway-policy.json');
    put(policy, { AsUrl: 'https://as.example.com' });
    // The real host decides: this user created the file, so it can change it.
    const writableRun = run(w, [], { env: { SUVEREN_POLICY_FILE: policy } });
    const expectedWritable = `  open         IT has fixed the Authority Server address, but this user can change the settings file (${policy})`;
    expect(writableRun.stdout).toContain(expectedWritable);
    const none = run(w, []);
    const lines = none.stdout.split('\n').filter((l) => /IT settings|create that file/.test(l));
    // On a Windows host the check also names the machine registry key, where
    // IT can fix the address instead of the file.
    const alsoRegistry = IS_WINDOWS_HOST ? ', or the registry key HKLM\\SOFTWARE\\Policies\\Suveren\\Gateway' : '';
    expect(lines).toEqual([
      `  open         No IT settings file: this user can point the gateway at another Authority Server. IT closes this by fixing the address in the settings file (${join(w.base, 'no-policy.json')}${alsoRegistry}); this user could also create that file themselves`,
    ]);
  });

  it('a user-writable lock file: open, exit 1', { timeout: cliTestTimeout(1) }, () => {
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
    expect(r.stdout).toMatch(/open {9}Claude Code: IT allows only the gateway as connector, but this user can change the lock/);
    expect(r.status).toBe(1);
  });
});

describe('suveren-gateway check — real process list', () => {
  // Every host: `ps` on macOS/Linux, PowerShell Get-CimInstance on Windows,
  // whose first start can be slow (a CI runner needed 50 s): each CLI run may
  // take up to the check's own PowerShell limit (see cliTestTimeout).
  it('flags a Bearer token in a running process, prints the program name only', { timeout: cliTestTimeout(2) }, async () => {
    const w = world();
    // A stand-in for the gateway's Mollie connector: `mcp-remote <url> --header "Authorization: Bearer <token>"`.
    const token = `access_TESTONLY${Date.now()}x9`;
    const script = join(w.base, 'node_modules', 'mcp-remote', 'dist', 'proxy.js');
    // Lives until the test kills it (afterEach): the check may need a minute
    // before it reads the list on a slow runner, so a fixed lifetime (60 s
    // before) could end the child first.
    put(script, 'setInterval(() => {}, 60_000);');
    const child = spawn(process.execPath, [script, 'https://mcp.mollie.com/mcp', '--header', `Authorization: Bearer ${token}`], { stdio: 'ignore' });
    children.push(child);
    await new Promise((r) => setTimeout(r, 1000));
    // No psOutput in the fixture: the CLI reads the real process list.
    writeFileSync(w.fixture, JSON.stringify({ root: w.root, groupsOutput: 'staff' }));

    const text = run(w, []);
    const json = run(w, ['--json']);
    expect(text.stdout).toContain(`Test fixture in use (${w.fixture}): system folders and the group list in this report are not this computer's.`);
    expect(text.stdout).toMatch(/open {9}mcp-remote: a sign-in token \(Authorization: Bearer\) in its start command/);
    expect(text.stdout + text.stderr).not.toContain(token);
    expect(json.stdout + json.stderr).not.toContain(token);
    expect(JSON.parse(json.stdout).findings.some((f: { subject: string; result: string }) => f.subject === 'mcp-remote' && f.result === 'open')).toBe(true);
  });
});
