/**
 * The Setup check engine (bundle/lib/setup-check/ — plain JS, imported
 * across the package boundary like gateway-policy.test.ts does).
 *
 * The injected platform is 'darwin' (POSIX paths) on EVERY host, so the
 * fixtures are a virtual POSIX file tree (/home/person, /sys, …). Its files
 * are stored under a temp folder of the host and read through the REAL
 * read-only providers (readText, exists, isDir, list); only the mapping from
 * virtual to host path is the test's. This keeps the results identical on a
 * macOS, Linux and Windows host — the engine must behave the same for an
 * injected platform regardless of the host it runs on.
 *
 * Writability is a property of the host's file system (POSIX permissions vs
 * Windows access lists), so here it is an explicit model with the same rule
 * as providers.writable on POSIX: a path counts as writable unless both it
 * and its folder are marked read-only. The real providers' writability is
 * tested against the host itself at the end of this file, and on Windows
 * access lists in setup-check-windows.test.ts.
 *
 * Machine-wide state (process list, group list, plist, registry) is
 * injected. The CLI wiring (exit codes, --json through the real binary, a
 * real process list) is in gateway-cli-check.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as hostJoin, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSetupCheck, resolveAppLocations, programLabel, type CheckContext, type CheckIo, type Finding } from '../../../../bundle/lib/setup-check/engine.mjs';
import { renderText, renderJson } from '../../../../bundle/lib/setup-check/report.mjs';
import { parseTomlLite, TomlLiteError } from '../../../../bundle/lib/setup-check/toml-lite.mjs';
import { APPS } from '../../../../bundle/lib/setup-check/apps/index.mjs';
import * as real from '../../../../bundle/lib/setup-check/providers.mjs';

// Virtual (injected-platform) paths are POSIX on every host.
const { join, dirname } = posix;

const MCP_PORT = 3941;
const GW_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const TEST_UID = 1000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

interface World { base: string; home: string; root: string; data: string; readOnly: Set<string> }

/** The world of the running test (one per test). */
let W: World;

/** Virtual POSIX path → where it is stored on the host. */
function host(v: string): string {
  return hostJoin(W.base, 'fs', ...v.split('/').filter(Boolean));
}

function mkdir(v: string): void {
  mkdirSync(host(v), { recursive: true });
}

function world(): World {
  const base = mkdtempSync(hostJoin(tmpdir(), 'setup-check-'));
  dirs.push(base);
  W = { base, home: '/home/person', root: '/sys', data: '/home/person/.suveren', readOnly: new Set() };
  for (const d of [W.home, W.root, W.data]) mkdir(d);
  return W;
}

function put(path: string, content: string | object): void {
  mkdir(dirname(path));
  writeFileSync(host(path), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
}

/** Mark a path and its folder read-only for this user (writability model). */
function readOnly(path: string): void {
  W.readOnly.add(path);
  W.readOnly.add(dirname(path));
}

/** Same rule as providers.writable on POSIX: the path or its folder. */
function modelWritable(v: string): boolean {
  return !(W.readOnly.has(v) && W.readOnly.has(dirname(v)));
}

function io(overrides: Partial<CheckIo> = {}): CheckIo {
  return {
    readText: (v) => real.readText(host(v)),
    exists: (v) => real.exists(host(v)),
    isDir: (v) => real.isDir(host(v)),
    list: (v) => real.list(host(v)),
    writable: (v) => modelWritable(v),
    nearestCreatable: (v) => {
      let d = dirname(v);
      while (d !== '/' && !real.exists(host(d))) d = dirname(d);
      return { ancestor: d, writable: !W.readOnly.has(d) };
    },
    ownerUid: (v) => (real.exists(host(v)) ? TEST_UID : null),
    ps: () => ({ ok: true, commands: [] }),
    groups: () => ({ ok: true, stdout: 'staff everyone' }),
    plist: () => ({ missing: true }),
    registry: () => ({ missing: true }),
    ...overrides,
  };
}

function ctx(w: World, extra: Partial<CheckContext> = {}): CheckContext {
  return {
    platform: 'darwin',
    home: w.home,
    env: { PATH: '' },
    root: w.root,
    now: new Date(2026, 10, 12),
    uid: TEST_UID,
    mcpPort: MCP_PORT,
    io: io(),
    gateway: {
      version: '0.44.1',
      simulation: false,
      dataDir: w.data,
      programDir: '/opt/suveren-gateway',
      policy: { locked: [], file: join(w.root, 'policy.json'), fileExists: false, registry: null },
      serviceDefinitionText: null,
      serviceDefinitionPath: null,
      inContainer: false,
      settingsErrors: 0,
    },
    ...extra,
  };
}

const find = (fs: Finding[], subject: string, re: RegExp) => fs.find((f) => f.subject === subject && re.test(f.detail));

const CLAUDE_MANAGED = 'Library/Application Support/ClaudeCode';

describe('Claude Code', () => {
  it('not locked, another connector present: connectors open, no-lock open, terminal open', () => {
    const w = world();
    put(join(w.home, '.claude.json'), {
      mcpServers: { suveren: { type: 'http', url: GW_URL }, github: { command: 'npx', args: ['server-github'] } },
      projects: { [join(w.home, 'proj')]: { mcpServers: { postgres: { command: 'pg-mcp' } } } },
    });
    put(join(w.home, 'proj', '.mcp.json'), { mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } } });
    const r = runSetupCheck(ctx(w));
    expect(r.aiAppsFound.map((a) => a.name)).toEqual(['Claude Code']);
    const other = find(r.findings, 'Claude Code', /other connector/);
    expect(other?.result).toBe('open');
    expect(other?.detail).toBe('3 other connectors (github, postgres, linear)');
    expect(find(r.findings, 'Claude Code', /no IT lock/)?.result).toBe('open');
    expect(find(r.findings, 'Claude Code', /terminal/)?.result).toBe('open');
    expect(find(r.findings, 'Claude Code', /not connected/)).toBeUndefined();
    expect(r.exitCode).toBe(1);
  });

  it('locked by managed-mcp.json to the gateway only, read-only lock: closed even with another connector set up', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: { github: { command: 'npx' } } });
    const lock = join(w.root, CLAUDE_MANAGED, 'managed-mcp.json');
    put(lock, { mcpServers: { suveren: { type: 'http', url: `http://localhost:${MCP_PORT}/mcp` } } });
    readOnly(lock);
    const r = runSetupCheck(ctx(w));
    expect(find(r.findings, 'Claude Code', /IT allows only the gateway as connector$/)?.result).toBe('closed');
    // The exclusive lock switches off what is left in the user's settings
    // (observed with Claude Code 2.1.322): not an "open" line.
    const conn = find(r.findings, 'Claude Code', /only connector/);
    expect(conn?.result).toBe('closed');
    expect(conn?.detail).toBe("the gateway is the only connector (1 entry in the user's settings is switched off by the lock)");
    expect(r.findings.filter((f) => f.subject === 'Claude Code' && /other connector/.test(f.detail))).toEqual([]);
    expect(find(r.findings, 'Claude Code', /not connected/)).toBeUndefined();
  });

  it('exclusive lock that lists another connector: that one is open, leftovers still switched off', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: { github: { command: 'npx' }, suveren: { url: GW_URL } } });
    const lock = join(w.root, CLAUDE_MANAGED, 'managed-mcp.json');
    put(lock, { mcpServers: { suveren: { url: GW_URL }, jira: { url: 'https://jira.example/mcp' } } });
    readOnly(lock);
    const r = runSetupCheck(ctx(w));
    expect(find(r.findings, 'Claude Code', /other connector/)?.detail)
      .toBe("1 other connector in IT's list (jira) (2 entries in the user's settings are switched off by the lock)");
    expect(find(r.findings, 'Claude Code', /other connector/)?.result).toBe('open');
  });

  it('a lock whose writability cannot be read: cannot tell, not closed', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: {} });
    const lock = join(w.root, CLAUDE_MANAGED, 'managed-mcp.json');
    put(lock, { mcpServers: { suveren: { url: GW_URL } } });
    const r = runSetupCheck(ctx(w, { io: io({ writable: () => null }) }));
    expect(find(r.findings, 'Claude Code', /IT allows only the gateway/)?.detail).toMatch(/could not be read/);
    expect(find(r.findings, 'Claude Code', /IT allows only the gateway/)?.result).toBe('cannot tell');
    expect(r.findings.find((f) => /program files/.test(f.detail))?.result).toBe('cannot tell');
  });

  it('a user-writable lock file is open', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: {} });
    put(join(w.root, CLAUDE_MANAGED, 'managed-mcp.json'), { mcpServers: { suveren: { url: GW_URL } } });
    const r = runSetupCheck(ctx(w));
    const lock = find(r.findings, 'Claude Code', /IT allows only the gateway/);
    expect(lock?.result).toBe('open');
    expect(lock?.detail).toMatch(/this user can change the lock/);
  });

  it('managed permissions deny Bash: terminal switched off by IT (closed); sandbox note shown', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: { suveren: { url: GW_URL } } });
    const settings = join(w.root, CLAUDE_MANAGED, 'managed-settings.json');
    put(settings, { permissions: { deny: ['Bash', 'Read', 'Edit'] }, sandbox: { enabled: true }, disableClaudeAiConnectors: true });
    readOnly(settings);
    const r = runSetupCheck(ctx(w));
    const terminal = find(r.findings, 'Claude Code', /^terminal/);
    expect(terminal?.result).toBe('closed');
    expect(terminal?.detail).toMatch(/switched off by IT \(commands run in a sandbox set by IT\)/);
    expect(find(r.findings, 'Claude Code', /^file access is switched off by IT/)?.result).toBe('closed');
    expect(r.findings.find((f) => f.subject === 'Connectors in the Claude account')?.result).toBe('closed');
  });

  it('allow list by name only, users cannot extend it: cannot tell (a name proves no address)', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: { suveren: { url: GW_URL } } });
    const settings = join(w.root, CLAUDE_MANAGED, 'managed-settings.json');
    put(settings, { allowedMcpServers: [{ serverName: 'suveren' }], allowManagedMcpServersOnly: true });
    readOnly(settings);
    const r = runSetupCheck(ctx(w));
    expect(find(r.findings, 'Claude Code', /allow list names connectors without their address/)?.result).toBe('cannot tell');
  });

  it('allow list by address that users may extend: cannot tell', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: { suveren: { url: GW_URL } } });
    const settings = join(w.root, CLAUDE_MANAGED, 'managed-settings.json');
    put(settings, { allowedMcpServers: [{ serverUrl: GW_URL }] });
    readOnly(settings);
    const r = runSetupCheck(ctx(w));
    expect(find(r.findings, 'Claude Code', /may be extended/)?.result).toBe('cannot tell');
  });

  it('gateway missing: open line says so', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: {} });
    const r = runSetupCheck(ctx(w));
    expect(find(r.findings, 'Claude Code', /^the gateway is not connected in this app$/)?.result).toBe('open');
    expect(find(r.findings, 'Claude Code', /^no other connectors$/)?.result).toBe('closed');
  });

  it('a different port on localhost is another connector, not the gateway', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: { suveren: { url: 'http://127.0.0.1:3430/mcp' } } });
    const r = runSetupCheck(ctx(w));
    expect(find(r.findings, 'Claude Code', /^1 other connector \(suveren\)$/)?.result).toBe('open');
  });

  it('unparseable config: cannot tell, no crash, no file content in the output', () => {
    const w = world();
    put(join(w.home, '.claude.json'), '{"mcpServers": {"x": {"env": {"K": "sk-live-SHOULDNOTLEAK"}} ');
    const r = runSetupCheck(ctx(w));
    expect(find(r.findings, 'Claude Code', /could not read ~\/.claude.json/)?.result).toBe('cannot tell');
    expect(renderText(r) + renderJson(r)).not.toContain('SHOULDNOTLEAK');
  });
});

describe('Claude desktop app', () => {
  const cfg = (w: World) => join(w.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

  it('not locked: gateway (via mcp-remote) is the only connector, but no lock', () => {
    const w = world();
    put(cfg(w), { mcpServers: { suveren: { command: 'npx', args: ['mcp-remote@latest', `http://localhost:${MCP_PORT}/mcp`, '--allow-http'] } } });
    const r = runSetupCheck(ctx(w));
    expect(find(r.findings, 'Claude desktop app', /^the gateway is the only connector$/)?.result).toBe('closed');
    expect(find(r.findings, 'Claude desktop app', /no IT lock/)?.result).toBe('open');
  });

  it('locked by the managed-preferences profile: local connectors off, IT list = gateway only', () => {
    const w = world();
    put(cfg(w), { mcpServers: { github: { command: 'gh-mcp' } } });
    const plistPath = join(w.root, 'Library', 'Managed Preferences', 'com.anthropic.claudefordesktop.plist');
    put(plistPath, 'placeholder');
    readOnly(plistPath);
    const policy = {
      isLocalDevMcpEnabled: false,
      isDesktopExtensionEnabled: false,
      managedMcpServers: JSON.stringify([{ name: 'suveren', url: GW_URL }]),
      builtinBrowserEnabled: false,
      isClaudeCodeForDesktopEnabled: false,
    };
    const c = ctx(w, { io: io({ plist: (p) => (p === plistPath ? { ok: true, data: policy } : { missing: true }) }) });
    const r = runSetupCheck(c);
    expect(find(r.findings, 'Claude desktop app', /IT allows only the gateway/)?.result).toBe('closed');
    expect(find(r.findings, 'Claude desktop app', /^1 other connector .*but IT allows only the gateway/)?.result).toBe('closed');
    expect(find(r.findings, 'Claude desktop app', /^terminal is switched off by IT$|terminal and browser control are switched off by IT/)?.result).toBe('closed');
  });

  it('IT list present but local connectors not switched off: open', () => {
    const w = world();
    put(cfg(w), { mcpServers: { suveren: { url: GW_URL } } });
    const plistPath = join(w.root, 'Library', 'Managed Preferences', 'com.anthropic.claudefordesktop.plist');
    const c = ctx(w, { io: io({ plist: (p) => (p === plistPath ? { ok: true, data: { managedMcpServers: [{ url: GW_URL }] } } : { missing: true }) }) });
    const r = runSetupCheck(c);
    expect(find(r.findings, 'Claude desktop app', /has not switched off connectors added on this computer/)?.result).toBe('open');
  });

  it('Windows: reads the HKLM policy key and %APPDATA% config (paths chosen by platform)', () => {
    const files = new Map<string, string>([
      ['C:\\Users\\it\\AppData\\Roaming\\Claude\\claude_desktop_config.json', JSON.stringify({ mcpServers: { suveren: { url: GW_URL } } })],
    ]);
    const winIo = io({
      readText: (p) => (files.has(p) ? { ok: true, text: files.get(p)! } : { missing: true }),
      exists: (p) => files.has(p) || p === 'C:\\Users\\it\\AppData\\Roaming\\Claude',
      isDir: () => false,
      list: () => null,
      writable: () => true,
      ownerUid: () => null,
      ps: () => real.parseProcessList('win32', JSON.stringify([
        { Name: 'System', CommandLine: null },
        { Name: 'node.exe', CommandLine: `"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\it\\.suveren\\integrations\\node_modules\\.bin\\mcp-remote https://mcp.mollie.com/mcp --header "Authorization: Bearer access_WINNOLEAK123456"` },
      ])),
      groups: () => ({ ok: true, stdout: 'BUILTIN\\Users  Alias  S-1-5-32-545  Mandatory group' }),
      registry: (key) => (key === 'HKLM\\SOFTWARE\\Policies\\Claude'
        ? { ok: true, data: real.parseRegValues([
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude',
          '    isLocalDevMcpEnabled    REG_DWORD    0x0',
          '    isDesktopExtensionEnabled    REG_DWORD    0x0',
          `    managedMcpServers    REG_SZ    [{"name":"suveren","url":"${GW_URL}"}]`,
        ].join('\r\n')) }
        : { missing: true }),
    });
    const r = runSetupCheck({
      platform: 'win32',
      home: 'C:\\Users\\it',
      env: { APPDATA: 'C:\\Users\\it\\AppData\\Roaming', PATH: '' },
      now: new Date(2026, 10, 12),
      uid: null,
      mcpPort: MCP_PORT,
      io: winIo,
      gateway: { version: '0.44.1', dataDir: 'C:\\Users\\it\\.suveren', policy: { locked: [] } },
    });
    expect(r.aiAppsFound.map((a) => a.name)).toContain('Claude desktop app');
    // Registry locks are admin-only: closed, with the admin line separate.
    expect(find(r.findings, 'Claude desktop app', /IT allows only the gateway/)?.result).toBe('closed');
    expect(r.findings.find((f) => /administrator/.test(f.detail))?.result).toBe('closed');
    const proc = r.findings.find((f) => f.group === 'secrets' && f.subject === 'mcp-remote');
    expect(proc?.result).toBe('open');
    expect(proc?.detail).toMatch(/without administrator rights this check sees only this user's programs/);
    expect(renderText(r) + renderJson(r)).not.toContain('WINNOLEAK');
  });
});

describe('ChatGPT desktop app / Codex', () => {
  it('requirements.toml allows only the gateway and switches off computer use: closed', () => {
    const w = world();
    put(join(w.home, '.codex', 'config.toml'), `[mcp_servers.suveren]\nurl = "${GW_URL}"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n`);
    const req = join(w.root, 'etc', 'codex', 'requirements.toml');
    put(req, `allowed_sandbox_modes = ["read-only"]\n\n[mcp_servers.suveren.identity]\nurl = "${GW_URL}"\n\n[features]\ncomputer_use = false\nbrowser_use = false\n`);
    readOnly(req);
    const r = runSetupCheck(ctx(w));
    const app = 'ChatGPT desktop app / Codex';
    expect(find(r.findings, app, /IT allows only the gateway/)?.result).toBe('closed');
    expect(find(r.findings, app, /browser control and screen control are switched off by IT/)?.result).toBe('closed');
    expect(find(r.findings, app, /^terminal is allowed \(IT limits its sandbox modes\)$/)?.result).toBe('open');
  });

  it('requirements lock lists only the gateway: other user connectors are switched off → closed with the note (codex-cli 0.167.2)', () => {
    const w = world();
    put(join(w.home, '.codex', 'config.toml'), [
      '[mcp_servers.suveren-gateway]', `url = "${GW_URL}"`,
      '[mcp_servers.other]', 'url = "https://example.org/mcp"',
      '[mcp_servers.other2]', 'command = "other2-mcp"',
    ].join('\n') + '\n');
    const req = join(w.root, 'etc', 'codex', 'requirements.toml');
    put(req, `[mcp_servers.suveren-gateway]\nidentity = { url = "${GW_URL}" }\n`);
    readOnly(req);
    const r = runSetupCheck(ctx(w));
    const app = 'ChatGPT desktop app / Codex';
    const conn = find(r.findings, app, /connector/);
    expect(conn?.result).toBe('closed');
    expect(conn?.detail).toBe("the gateway is the only connector (2 entries in the user's settings are switched off by the lock)");
    expect(r.findings.filter((f) => f.subject === app && /other connector/.test(f.detail))).toEqual([]);
    expect(find(r.findings, app, /^IT allows only the gateway as connector$/)?.result).toBe('closed');
  });

  it('requirements lock: the allowed NAME with another address is switched off too → gateway not connected', () => {
    const w = world();
    put(join(w.home, '.codex', 'config.toml'), '[mcp_servers.suveren-gateway]\nurl = "https://example.net/mcp"\n');
    const req = join(w.root, 'etc', 'codex', 'requirements.toml');
    put(req, `[mcp_servers.suveren-gateway]\nidentity = { url = "${GW_URL}" }\n`);
    readOnly(req);
    const r = runSetupCheck(ctx(w));
    const app = 'ChatGPT desktop app / Codex';
    expect(find(r.findings, app, /^no other connectors/)?.detail).toBe("no other connectors (1 entry in the user's settings is switched off by the lock)");
    expect(find(r.findings, app, /^the gateway is not connected in this app$/)?.result).toBe('open');
  });

  it('requirements allow list with another server: open', () => {
    const w = world();
    put(join(w.home, '.codex', 'config.toml'), `[mcp_servers.suveren]\nurl = "${GW_URL}"\n`);
    const req = join(w.root, 'etc', 'codex', 'requirements.toml');
    put(req, `[mcp_servers.suveren.identity]\nurl = "${GW_URL}"\n[mcp_servers.docs.identity]\ncommand = "docs-mcp"\n`);
    readOnly(req);
    const r = runSetupCheck(ctx(w));
    expect(find(r.findings, 'ChatGPT desktop app / Codex', /the IT lock also allows 1 other connector \(docs\)/)?.result).toBe('open');
  });

  it('unparseable TOML: cannot tell, no crash', () => {
    const w = world();
    put(join(w.home, '.codex', 'config.toml'), 'created = 2026-11-12T10:00:00Z\n[mcp_servers.x]\nenv = { KEY = "sk-NOLEAK-123" }\n');
    const r = runSetupCheck(ctx(w));
    expect(find(r.findings, 'ChatGPT desktop app / Codex', /could not read ~\/.codex\/config.toml/)?.result).toBe('cannot tell');
    expect(renderText(r) + renderJson(r)).not.toContain('NOLEAK');
  });
});

describe('GitHub Copilot in VS Code', () => {
  it('reads `servers` from the VS Code mcp.json; terminal is always open with the reason', () => {
    const w = world();
    put(join(w.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'), {
      servers: { suveren: { type: 'http', url: GW_URL }, playwright: { command: 'npx', args: ['@playwright/mcp'] } },
    });
    const r = runSetupCheck(ctx(w));
    const app = 'GitHub Copilot in VS Code';
    expect(find(r.findings, app, /^1 other connector \(playwright\)$/)?.result).toBe('open');
    expect(find(r.findings, app, /terminal is allowed: the terminal cannot be switched off, only set to ask first/)?.result).toBe('open');
    expect(r.findings.find((f) => f.subject === 'Connectors in the GitHub account')?.result).toBe('cannot tell');
  });

  it('is found from the Copilot extension folder alone', () => {
    const w = world();
    mkdir(join(w.home, '.vscode', 'extensions', 'github.copilot-chat-0.30.0'));
    const r = runSetupCheck(ctx(w));
    expect(r.aiAppsFound.map((a) => a.name)).toEqual(['GitHub Copilot in VS Code']);
  });
});

describe('paths per platform (injected platform, no real file read)', () => {
  const app = (id: string) => APPS.find((a) => a.id === id)!;
  const winCtx = { platform: 'win32', home: 'C:\\Users\\it', env: { APPDATA: 'C:\\Users\\it\\AppData\\Roaming', ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' } } as unknown as CheckContext;
  const linCtx = { platform: 'linux', home: '/home/it', env: {}, root: '' } as unknown as CheckContext;

  it('Windows', () => {
    expect(resolveAppLocations(winCtx, app('claude-code')).sources).toMatchObject({
      'managed-settings': 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
      'managed-mcp': 'C:\\Program Files\\ClaudeCode\\managed-mcp.json',
      'user-config': 'C:\\Users\\it\\.claude.json',
    });
    expect(resolveAppLocations(winCtx, app('claude-desktop')).sources).toEqual({
      'user-config': 'C:\\Users\\it\\AppData\\Roaming\\Claude\\claude_desktop_config.json',
      policy: 'HKLM\\SOFTWARE\\Policies\\Claude',
    });
    expect(resolveAppLocations(winCtx, app('codex')).sources.requirements).toBe('C:\\ProgramData\\OpenAI\\Codex\\requirements.toml');
    expect(resolveAppLocations(winCtx, app('copilot-vscode')).sources).toMatchObject({
      'vscode-mcp': 'C:\\Users\\it\\AppData\\Roaming\\Code\\User\\mcp.json',
      'managed-settings': 'C:\\Program Files\\GitHubCopilot\\managed-settings.json',
      'vscode-policy': 'HKLM\\Software\\Policies\\Microsoft\\VSCode',
    });
  });

  it('Linux', () => {
    expect(resolveAppLocations(linCtx, app('claude-code')).sources['managed-settings']).toBe('/etc/claude-code/managed-settings.json');
    expect(resolveAppLocations(linCtx, app('claude-desktop')).sources).toEqual({});
    expect(resolveAppLocations(linCtx, app('codex')).sources.requirements).toBe('/etc/codex/requirements.toml');
    expect(resolveAppLocations(linCtx, app('copilot-vscode')).sources).toMatchObject({
      'vscode-mcp': '/home/it/.config/Code/User/mcp.json',
      'managed-settings': '/etc/github-copilot/managed-settings.json',
      'vscode-policy': '/etc/vscode/policy.json',
    });
  });
});

describe('No passwords within reach', () => {
  const TOKEN = 'access_FAKE0123456789abcdefSECRET';

  it("the Mollie connector's Bearer token in the process list is flagged; the value appears nowhere", () => {
    const w = world();
    const ps = [
      `person  /usr/local/bin/node /Users/a/.npm/_npx/1/node_modules/mcp-remote/dist/proxy.js https://mcp.mollie.com/mcp --header Authorization: Bearer ${TOKEN}`,
      `person  mcp-remote https://mcp.mollie.com/mcp --header Authorization: Bearer ${TOKEN}`,
      'person  /usr/bin/some-tool --api-key=k3y-VALUE-NOLEAK',
      'person  node server.js --token ${MCP_TOKEN}',
    ].join('\n');
    const r = runSetupCheck(ctx(w, { io: io({ ps: () => real.parseProcessList('darwin', ps) }) }));
    const hit = r.findings.find((f) => f.subject === 'mcp-remote');
    expect(hit?.result).toBe('open');
    expect(hit?.detail).toMatch(/Authorization: Bearer.*\(2 processes\)/);
    expect(r.findings.find((f) => f.subject === 'some-tool')?.detail).toMatch(/token or key argument/);
    // A variable reference is not a secret value.
    expect(r.findings.find((f) => f.subject === 'node' || f.subject === 'server')).toBeUndefined();
    const all = renderText(r) + renderJson(r);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('NOLEAK');
  });

  it('a process list that cannot be read says why (fixed phrase, never tool output) and is "cannot tell"', () => {
    const w = world();
    const r = runSetupCheck(ctx(w, { io: io({ ps: () => ({ error: 'failed', reason: 'did not finish within 30 s' }) }) }));
    const line = r.findings.find((f) => /^Process list/.test(f.detail));
    expect(line?.result).toBe('cannot tell');
    expect(line?.detail).toBe('Process list: could not be read (ps did not finish within 30 s)');
  });

  it('program names never carry a value', () => {
    expect(programLabel('node --token abcdef123456 server.js', ['abcdef123456'])).toBe('node');
    expect(programLabel('npx -y mcp-remote@0.14.3 https://x --header Authorization: Bearer abc', ['abc'])).toBe('mcp-remote');
    // How the gateway itself starts the Mollie connector.
    expect(programLabel('node /Users/a/.suveren/integrations/node_modules/.bin/mcp-remote https://mcp.mollie.com/mcp --header Authorization: Bearer abcdef', ['abcdef'])).toBe('mcp-remote');
    expect(programLabel('node /x/node_modules/.pnpm/a@1/node_modules/@scope/pkg/dist/cli.js', [])).toBe('@scope/pkg');
    expect(programLabel('/opt/sk-abcd1234/bin/tool --token sk-abcd1234', ['sk-abcd1234'])).toBe('tool');
    expect(programLabel('/opt/x/tool-sk-abcd1234 --token sk-abcd1234', ['sk-abcd1234'])).toBe('a program');
  });

  it('key files: names and locations only, never content', () => {
    const w = world();
    put(join(w.home, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_NOLEAKNOLEAK\n');
    put(join(w.home, '.aws', 'credentials'), '[default]\naws_access_key_id = AKIA\naws_secret_access_key = NOLEAK2\n');
    put(join(w.home, '.config', 'gh', 'hosts.yml'), 'github.com:\n  user: x\n'); // token in keychain: not flagged
    mkdir(join(w.home, '.config', 'gcloud'));
    put(join(w.home, '.config', 'gcloud', 'application_default_credentials.json'), '{}');
    const r = runSetupCheck(ctx(w));
    const lines = r.findings.filter((f) => f.group === 'secrets' && /Key file/.test(f.detail)).map((f) => f.detail);
    expect(lines).toEqual([
      'Key file for npm sign-in token: ~/.npmrc',
      'Key file for AWS keys: ~/.aws/credentials',
      'Key file for Google Cloud sign-in: ~/.config/gcloud',
    ]);
    expect(renderText(r) + renderJson(r)).not.toMatch(/NOLEAK/);
  });

  it('no key files: one closed line', () => {
    const w = world();
    put(join(w.home, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
    const r = runSetupCheck(ctx(w));
    expect(r.findings.find((f) => /^No key files/.test(f.detail))?.result).toBe('closed');
  });

  it('secret-looking environment names: names only', () => {
    const w = world();
    const r = runSetupCheck(ctx(w, { env: { PATH: '', GITHUB_TOKEN: 'ghp_NOLEAK', DB_PASSWORD: 'NOLEAK', EMPTY_TOKEN: '', HOME: '/x' } }));
    const line = r.findings.find((f) => /Secret-looking names/.test(f.detail));
    expect(line?.result).toBe('open');
    expect(line?.detail).toMatch(/DB_PASSWORD, GITHUB_TOKEN \(/);
    expect(line?.detail).not.toMatch(/EMPTY_TOKEN/);
    expect(renderText(r) + renderJson(r)).not.toContain('NOLEAK');
  });
});

describe('No hand on the gateway', () => {
  it('loopback by default: closed; wider without token: open; wider with token: closed', () => {
    const w = world();
    const line = (env: Record<string, string>) =>
      runSetupCheck(ctx(w, { env: { PATH: '', ...env } })).findings.find((f) => f.group === 'gateway' && /^Gateway (answers|is set)/.test(f.detail))!;
    expect(line({}).result).toBe('closed');
    expect(line({ SUVEREN_BIND_HOST: '127.0.0.1' }).result).toBe('closed');
    expect(line({ SUVEREN_BIND_HOST: '0.0.0.0' }).result).toBe('open');
    const withToken = line({ SUVEREN_BIND_HOST: '0.0.0.0', SUVEREN_MCP_TOKEN: 'tok-NOLEAK' });
    expect(withToken.result).toBe('closed');
    expect(JSON.stringify(withToken)).not.toContain('NOLEAK');
  });

  it('a login service that sets a wide address without token is open', () => {
    const w = world();
    const plist = '<dict><key>EnvironmentVariables</key><dict><key>SUVEREN_BIND_HOST</key><string>0.0.0.0</string></dict></dict>';
    const c = ctx(w);
    c.gateway.serviceDefinitionText = plist;
    const r = runSetupCheck(c);
    expect(r.findings.find((f) => /other computers/.test(f.detail))?.result).toBe('open');
  });

  it('container: cannot tell', () => {
    const w = world();
    const c = ctx(w);
    c.gateway.inContainer = true;
    expect(runSetupCheck(c).findings.find((f) => /container/.test(f.detail))?.result).toBe('cannot tell');
  });

  it('program files: writable = open, read-only = closed', () => {
    const w = world();
    const program = join(w.root, 'pkgparent', 'program');
    mkdir(program);
    const c = ctx(w);
    c.gateway.programDir = program;
    expect(runSetupCheck(c).findings.find((f) => /program files/.test(f.detail))?.result).toBe('open');
    readOnly(program);
    expect(runSetupCheck(c).findings.find((f) => /program files/.test(f.detail))?.result).toBe('closed');
  });

  it('same user account: open with the reason, when an AI app is found here', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: { suveren: { url: GW_URL } } });
    const r = runSetupCheck(ctx(w));
    expect(r.findings.find((f) => /same user account/.test(f.detail))?.detail).toMatch(/relies on the AI app having no terminal/);
  });

  it('administrator: open', () => {
    const w = world();
    const r = runSetupCheck(ctx(w, { io: io({ groups: () => ({ ok: true, stdout: 'staff everyone admin' }) }) }));
    expect(r.findings.find((f) => /administrator/.test(f.detail))?.result).toBe('open');
  });
});

describe('IT settings: the Authority Server address', () => {
  /** All IT-settings lines (everything about the settings file / address). */
  const settingsLines = (r: ReturnType<typeof runSetupCheck>) =>
    r.findings.filter((f) => f.group === 'gateway' && /IT settings|Authority Server address|IT has fixed/.test(f.detail));

  function withPolicy(w: World, policy: NonNullable<CheckContext['gateway']['policy']>, extra: Partial<CheckContext> = {}) {
    const c = ctx(w, extra);
    c.gateway.policy = policy;
    return runSetupCheck(c);
  }

  it('1. address fixed in a settings file this user cannot write → closed (team not fixed: a note, not an open line)', () => {
    const w = world();
    const file = join(w.root, 'it', 'gateway-policy.json');
    put(file, { AsUrl: 'https://as.example.com', Simulation: true });
    readOnly(file);
    const lines = settingsLines(withPolicy(w, { locked: ['asUrl', 'simulation'], sources: { asUrl: 'file', simulation: 'file' }, file, fileExists: true }));
    expect(lines).toHaveLength(1);
    expect(lines[0].result).toBe('closed');
    expect(lines[0].detail).toBe('IT has fixed the Authority Server address, and this user cannot change that (the team is not fixed; teams are optional)');
  });

  it('1. address and team fixed in the machine registry (HKLM) → closed, no note', () => {
    const w = world();
    const lines = settingsLines(withPolicy(w, {
      locked: ['asUrl', 'team'], sources: { asUrl: 'HKLM', team: 'HKLM' },
      file: 'C:\\ProgramData\\Suveren\\gateway-policy.json', fileExists: false,
      machineRegistryKey: 'HKLM\\SOFTWARE\\Policies\\Suveren\\Gateway',
    }));
    expect(lines.map((l) => [l.result, l.detail])).toEqual([['closed', 'IT has fixed the Authority Server address, and this user cannot change that']]);
  });

  it('4. address fixed only in the user\'s own hive (HKCU) → open, with the reason', () => {
    const w = world();
    const lines = settingsLines(withPolicy(w, {
      locked: ['asUrl'], sources: { asUrl: 'HKCU' }, file: join(w.root, 'none.json'), fileExists: false,
      userRegistryKey: 'HKCU\\SOFTWARE\\Policies\\Suveren\\Gateway',
    }));
    expect(lines.map((l) => [l.result, l.detail])).toEqual([[
      'open',
      "IT has fixed the Authority Server address only in this user's own registry hive (HKCU\\SOFTWARE\\Policies\\Suveren\\Gateway), which this user can change",
    ]]);
  });

  it('4. address fixed in a settings file this user can write → open', () => {
    const w = world();
    const file = join(w.root, 'it', 'gateway-policy.json');
    put(file, { AsUrl: 'https://as.example.com' });
    const lines = settingsLines(withPolicy(w, { locked: ['asUrl'], sources: { asUrl: 'file' }, file, fileExists: true }));
    expect(lines.map((l) => [l.result, l.detail])).toEqual([['open', `IT has fixed the Authority Server address, but this user can change the settings file (${file})`]]);
  });

  it('4. writability of the settings file unknown → cannot tell', () => {
    const w = world();
    const file = join(w.root, 'it', 'gateway-policy.json');
    put(file, { AsUrl: 'https://as.example.com' });
    const lines = settingsLines(withPolicy(w, { locked: ['asUrl'], sources: { asUrl: 'file' }, file, fileExists: true }, { io: io({ writable: () => null }) }));
    expect(lines.map((l) => [l.result, l.detail])).toEqual([['cannot tell', `IT has fixed the Authority Server address, but whether this user can change the settings file could not be read (${file})`]]);
  });

  it('3. settings exist but do not fix the address → open, listing what they fix by plain labels', () => {
    const w = world();
    const file = join(w.root, 'it', 'gateway-policy.json');
    put(file, { Simulation: true, Proxy: 'http://proxy:8080' });
    readOnly(file);
    const lines = settingsLines(withPolicy(w, { locked: ['proxy', 'simulation'], sources: { proxy: 'file', simulation: 'file' }, file, fileExists: true }));
    expect(lines.map((l) => [l.result, l.detail])).toEqual([['open', 'The IT settings do not fix the Authority Server address (they fix: proxy and simulation)']]);
  });

  it('2+6. no settings at all → ONE open line, with "could create that file" folded in', () => {
    const w = world();
    const file = join(w.root, 'missing-dir', 'gateway-policy.json'); // nearest existing parent is writable
    const r = withPolicy(w, { locked: [], file, fileExists: false });
    const lines = settingsLines(r);
    expect(lines.map((l) => [l.result, l.detail])).toEqual([[
      'open',
      `No IT settings file: this user can point the gateway at another Authority Server. IT closes this by fixing the address in the settings file (${file}); this user could also create that file themselves`,
    ]]);
    expect(r.findings.filter((f) => /create/.test(f.detail))).toHaveLength(1);
  });

  it('2. no settings, folder not creatable; on Windows the registry key is named too', () => {
    const w = world();
    const r = withPolicy(w, {
      locked: [], file: 'C:\\ProgramData\\Suveren\\gateway-policy.json', fileExists: false,
      machineRegistryKey: 'HKLM\\SOFTWARE\\Policies\\Suveren\\Gateway',
    }, { io: io({ nearestCreatable: () => ({ ancestor: 'C:\\ProgramData', writable: false }) }) });
    expect(settingsLines(r).map((l) => l.detail)).toEqual([
      'No IT settings file: this user can point the gateway at another Authority Server. IT closes this by fixing the address in the settings file (C:\\ProgramData\\Suveren\\gateway-policy.json, or the registry key HKLM\\SOFTWARE\\Policies\\Suveren\\Gateway)',
    ]);
  });

  it('settings that cannot be read → cannot tell; no "IT policy" wording anywhere', () => {
    const w = world();
    const r = withPolicy(w, { error: true, file: join(w.root, 'p.json') });
    expect(settingsLines(r).map((l) => [l.result, l.detail])).toEqual([['cannot tell', 'The IT settings for the gateway could not be read']]);
    expect(renderText(r) + renderJson(r)).not.toMatch(/IT policy/);
  });
});

describe('report shape', () => {
  it('four sections in order, result column, summary; JSON carries group/result/subject/detail/source', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: { suveren: { url: GW_URL }, github: { command: 'x' } } });
    const r = runSetupCheck(ctx(w));
    const text = renderText(r);
    expect(text.startsWith('Suveren Setup check — 12 November 2026\nAI apps found: Claude Code\n')).toBe(true);
    const idx = ['No other route', 'No passwords within reach', 'No hand on the gateway', 'Confirm by hand', 'Result:'].map((s) => text.indexOf(`\n${s}`));
    expect(idx.every((n) => n > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(text).toContain('  open         Claude Code: 1 other connector (github)');
    expect(text).toMatch(/All \d+ settings and lock locations this check looked at come from the vendors' documentation and are not yet tested on a real install\./);
    expect(text).toMatch(new RegExp(`Result: ${r.summary.open} open, ${r.summary.cannotTell} to confirm by hand\\n$`));

    const json = JSON.parse(renderJson(r));
    expect(json.findings.length).toBe(r.findings.length);
    for (const f of json.findings) {
      expect(Object.keys(f).sort()).toEqual(['detail', 'group', 'result', 'source', 'subject']);
      expect(['closed', 'open', 'cannot tell']).toContain(f.result);
      expect(['No other route', 'No passwords within reach', 'No hand on the gateway']).toContain(f.group);
    }
    expect(json.exitCode).toBe(1);
  });

  it('no forbidden promise words anywhere in the output', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: { suveren: { url: GW_URL } } });
    const all = renderText(runSetupCheck(ctx(w)));
    expect(all).not.toMatch(/\b(secure|safe|certified|proven|guarantee[sd]?)\b/i);
  });
});

describe('toml-lite', () => {
  it('reads the subset the AI apps use', () => {
    const t = parseTomlLite([
      '# comment',
      'model = "gpt-5" # trailing',
      "literal = 'C:\\path'",
      'n = 1_000',
      'f = 0.5',
      'on = true',
      'list = [',
      '  "a", # inside',
      '  "b",',
      ']',
      'inline = { url = "http://x", nested.key = 2 }',
      '[mcp_servers."my server"]',
      'command = "npx"',
      'args = ["-y", "pkg"]',
      '[mcp_servers.other.env]',
      'K = "v"',
      'multi = """',
      'line1',
      'line2"""',
      '[[things]]',
      'a = 1',
      '[[things]]',
      'a = 2',
    ].join('\n'));
    expect(t).toEqual({
      model: 'gpt-5', literal: 'C:\\path', n: 1000, f: 0.5, on: true, list: ['a', 'b'],
      inline: { url: 'http://x', nested: { key: 2 } },
      mcp_servers: { 'my server': { command: 'npx', args: ['-y', 'pkg'] }, other: { env: { K: 'v', multi: 'line1\nline2' } } },
      things: [{ a: 1 }, { a: 2 }],
    });
  });

  it('throws TomlLiteError on what it cannot read, without quoting the file', () => {
    for (const bad of ['d = 2026-11-12', 'a = 1\na = 2', 'x = "unterminated', 'k = sk-SECRETVALUE', '[a]\n[a]']) {
      let err: unknown;
      try { parseTomlLite(bad); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(TomlLiteError);
      expect(String((err as Error).message)).not.toContain('SECRETVALUE');
      expect(String((err as Error).message)).not.toContain('2026');
    }
  });
});

describe('providers.writable / nearestCreatable against the host running the tests', () => {
  // The answers come from the host's own file system and tools (POSIX
  // permissions; on Windows real icacls, whoami and the owner lookup), so
  // these tests spawn real processes: on a busy CI runner that needs more
  // than vitest's default 5 s.
  const isWindows = process.platform === 'win32';
  const HOST_TIMEOUT = 120_000;

  /** TEMP DIAGNOSTIC (remove once the Windows CI run is green): what the
   *  real tools printed, built ONLY when an assertion fails (it spawns
   *  tools). Account names and SIDs of the CI runner, no secret. */
  function windowsDiagnostic(path: string): string {
    if (!isWindows) return '';
    const out = (bin: string, args: string[], env?: Record<string, string>) => {
      const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, env: env ? { ...process.env, ...env } : undefined });
      return `$ ${bin} ${args[0] === '-NoProfile' ? '(owner lookup)' : args.join(' ')} → status ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}`;
    };
    return `\n[TEMP DIAGNOSTIC]\n${out('icacls', [path])}\n${out('whoami', ['/user', '/fo', 'csv', '/nh'])}\n${out('whoami', ['/groups', '/fo', 'csv', '/nh'])}\n` +
      out('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', real.WINDOWS_OWNER_SCRIPT], { SUVEREN_CHECK_PATH: path });
  }
  function expectHost<T>(value: T, expected: T, path: string) {
    if (value !== expected) expect(value, `${windowsDiagnostic(path)}\nexists=${real.exists(path)}`).toBe(expected);
  }

  it('a file and folder this user created can be changed; a missing file there can be created', { timeout: HOST_TIMEOUT }, () => {
    const base = mkdtempSync(hostJoin(tmpdir(), 'setup-check-host-'));
    dirs.push(base);
    const file = hostJoin(base, 'mine.json');
    writeFileSync(file, '{}');
    expectHost(real.writable(file), true, file);
    expectHost(real.writable(base), true, base);
    const c = real.nearestCreatable(hostJoin(base, 'a', 'b', 'gateway-policy.json'));
    expect(c.ancestor).toBe(base);
    expectHost(c.writable, true, base);
  });

  it('the owner can change its own file even without write permission (POSIX chmod / Windows access list)', { timeout: HOST_TIMEOUT }, () => {
    const base = mkdtempSync(hostJoin(tmpdir(), 'setup-check-host-'));
    dirs.push(base);
    const dir = hostJoin(base, 'locked');
    mkdirSync(dir);
    const file = hostJoin(dir, 'lock.json');
    writeFileSync(file, '{}');
    // Host mechanism to take this user's write permission away: mode bits,
    // or an access list that only lets Everyone read (inheritance removed).
    const icacls = (args: string[]) => spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true });
    if (isWindows) {
      icacls([file, '/inheritance:r', '/grant:r', '*S-1-1-0:(R)']);
    } else {
      chmodSync(file, 0o444);
      chmodSync(dir, 0o555);
    }
    try {
      // The user still owns the file, so it may give itself write access again.
      expectHost(real.writable(file), true, file);
    } finally {
      if (isWindows) icacls([file, '/reset']);
      else { chmodSync(dir, 0o755); chmodSync(file, 0o644); }
    }
  });

  it('a system file and folder this user does not own → cannot change, nothing can be created inside', { timeout: HOST_TIMEOUT }, () => {
    // Real system objects whose access is set by the operating system;
    // nothing is changed. POSIX: root-owned /etc. Windows: owned by
    // TrustedInstaller, administrators may only read (the CI runner is an
    // elevated administrator; its admin rights to take ownership are what
    // the separate "administrator" line reports).
    if (!isWindows && process.getuid?.() === 0) return; // root may write anything on POSIX: nothing to assert
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const file = isWindows ? hostJoin(systemRoot, 'System32', 'kernel32.dll') : '/etc/hosts';
    const folder = isWindows ? hostJoin(systemRoot, 'WinSxS') : '/etc';
    expectHost(real.writable(file), false, file);
    const inside = real.nearestCreatable(hostJoin(folder, 'suveren-check-test-missing', 'x.json'));
    expect(inside.ancestor).toBe(folder);
    expectHost(inside.writable, false, folder);
  });
});
