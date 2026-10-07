/**
 * `suveren-gateway config set|get|unset port|mcp-port|data-dir` — spawns the
 * REAL shipped CLI, same convention as gateway-cli-managed-settings.test.ts.
 * Saved values go to a temp SUVEREN_INSTALL_SETTINGS_FILE, never the real
 * per-user file or registry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '../../../../bundle/bin/suveren-gateway.js');

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cli-install-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

interface Ctx { settings: string; policy: string }
function ctx(): Ctx {
  const d = tmp();
  return { settings: join(d, 'gateway.json'), policy: join(d, 'no-policy.json') };
}

function run(c: Ctx, args: string[], env: Record<string, string> = {}) {
  // The env tier would win over everything saved — strip it so these tests
  // see the saved values the CLI wrote.
  const base = { ...process.env };
  delete base.SUVEREN_CP_PORT;
  delete base.SUVEREN_MCP_PORT;
  delete base.SUVEREN_DATA_DIR;
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...base, SUVEREN_INSTALL_SETTINGS_FILE: c.settings, SUVEREN_POLICY_FILE: c.policy, ...env },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const saved = (c: Ctx) => JSON.parse(readFileSync(c.settings, 'utf8'));

describe('config set / get / unset', () => {
  it('saves the ports and the data folder, and get shows them as saved', () => {
    const c = ctx();
    const dataDir = join(tmp(), 'gateway-data');
    expect(run(c, ['config', 'set', 'port', '15500']).status).toBe(0);
    expect(run(c, ['config', 'set', 'mcp-port', '15530']).status).toBe(0);
    expect(run(c, ['config', 'set', 'data-dir', dataDir]).status).toBe(0);
    expect(saved(c)).toEqual({ cpPort: 15500, mcpPort: 15530, dataDir });

    const { stdout } = run(c, ['config', 'get']);
    expect(stdout).toContain('port:     15500  (saved)');
    expect(stdout).toContain('mcp-port: 15530  (saved)');
    expect(stdout).toContain(`data-dir: ${dataDir}  (saved)`);
    expect(run(c, ['config', 'get', 'mcp-port']).stdout.trim()).toBe('15530  (saved)');
  });

  it('every other command uses the saved port (status asks the saved port)', () => {
    const c = ctx();
    run(c, ['config', 'set', 'port', '15501']);
    run(c, ['config', 'set', 'data-dir', join(tmp(), 'd')]);
    // Nothing listens there: "not running" proves it looked at the saved data
    // folder (no PID file) and the saved port (no answer), not 3400.
    const { status, stdout } = run(c, ['status']);
    expect(status).toBe(3);
    expect(stdout).toContain('not running');
  });

  it('unset goes back to the default', () => {
    const c = ctx();
    run(c, ['config', 'set', 'port', '15502']);
    expect(run(c, ['config', 'unset', 'port']).status).toBe(0);
    expect(saved(c)).toEqual({});
    expect(run(c, ['config', 'get', 'port']).stdout.trim()).toBe('3400  (default)');
  });

  it('an env var wins and the CLI says so', () => {
    const c = ctx();
    const { stdout } = run(c, ['config', 'set', 'port', '15503'], { SUVEREN_CP_PORT: '15600' });
    expect(stdout).toContain('SUVEREN_CP_PORT is set in this shell');
    expect(run(c, ['config', 'get', 'port'], { SUVEREN_CP_PORT: '15600' }).stdout.trim()).toBe('15600  (from SUVEREN_CP_PORT)');
  });

  it('a new data folder warns that existing data stays where it is', () => {
    const c = ctx();
    const oldDir = join(tmp(), 'old');
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, 'vault.enc'), 'x');
    run(c, ['config', 'set', 'data-dir', oldDir]);
    const newDir = join(tmp(), 'new');
    const { status, stdout } = run(c, ['config', 'set', 'data-dir', newDir]);
    expect(status).toBe(0);
    expect(stdout).toContain(`Your existing data stays in ${oldDir}`);
    expect(stdout).toContain('starts EMPTY');
    expect(existsSync(join(oldDir, 'vault.enc'))).toBe(true); // nothing moved
  });

  it('a new mcp-port tells the user to reconnect their AI assistants', () => {
    const c = ctx();
    const { stdout } = run(c, ['config', 'set', 'mcp-port', '15531']);
    expect(stdout).toContain('http://localhost:15531/mcp');
  });
});

describe('REFUSAL: config set with a bad value saves nothing', () => {
  it.each([
    ['port', '80'],
    ['port', 'abc'],
    ['mcp-port', '70000'],
    ['data-dir', 'relative/folder'],
  ])('%s %s → exit 1', (key, value) => {
    const c = ctx();
    const { status, stderr } = run(c, ['config', 'set', key, value]);
    expect(status).toBe(1);
    expect(stderr).toContain(`Invalid ${key}`);
    expect(existsSync(c.settings)).toBe(false);
  });

  it('the same port twice → exit 1 (also against the other one\'s default)', () => {
    const c = ctx();
    expect(run(c, ['config', 'set', 'port', '3430']).status).toBe(1);
    run(c, ['config', 'set', 'port', '15504']);
    const { status, stderr } = run(c, ['config', 'set', 'mcp-port', '15504']);
    expect(status).toBe(1);
    expect(stderr).toContain('must differ');
  });

  it('IT policy locks port / mcp-port / data-dir', () => {
    const c = ctx();
    writeFileSync(c.policy, JSON.stringify({ Port: 15700, McpPort: 15730, DataDir: tmp() }));
    for (const [key, value] of [['port', '15505'], ['mcp-port', '15535'], ['data-dir', tmp()]]) {
      const { status, stderr } = run(c, ['config', 'set', key, value]);
      expect(status, key).toBe(1);
      expect(stderr).toContain('set by your IT policy');
    }
    expect(existsSync(c.settings)).toBe(false);
    expect(run(c, ['config', 'get', 'port']).stdout.trim()).toBe('15700  (set by your IT)');
  });

  it('a running --detach gateway must be stopped first', () => {
    const c = ctx();
    const dataDir = tmp();
    run(c, ['config', 'set', 'data-dir', dataDir]);
    // A live PID (this test process) in the saved data folder's PID file.
    writeFileSync(join(dataDir, 'gateway.pid'), String(process.pid));
    const { status, stderr } = run(c, ['config', 'set', 'port', '15506']);
    expect(status).toBe(1);
    expect(stderr).toContain('Stop it first');
    expect(saved(c).cpPort).toBeUndefined();
  });
});

describe('REFUSAL: a broken saved value stops the gateway commands, not config', () => {
  it('status refuses with the reason; config get still works so it can be fixed', () => {
    const c = ctx();
    writeFileSync(c.settings, JSON.stringify({ cpPort: 80 }));
    const st = run(c, ['status']);
    expect(st.status).toBe(1);
    expect(st.stderr).toContain('Invalid saved port "80"');

    const get = run(c, ['config', 'get', 'port']);
    expect(get.status).toBe(0);
    expect(get.stderr).toContain('Warning: Invalid saved port "80"');

    expect(run(c, ['config', 'set', 'port', '15507']).status).toBe(0);
    expect(run(c, ['status']).status).toBe(3); // valid again — just not running
  });
});
