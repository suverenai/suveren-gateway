/**
 * S1 increment 3: the CLI as a thin client when the gateway runs under its own
 * account.
 *
 * Unit part: detection and refusals. Scratch part: the REAL CLI is run against a
 * scratch install (SUVEREN_SYSTEM_PREFIX), with a throwaway health server on a
 * high port standing in for the daemon. What this cannot show, and only the VM
 * run with a second account can: that the person's user really cannot read the
 * data folder or stop the process, and that the daemon really starts and
 * serves (docs/own-os-user.md, section 13).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectSystemInstall, thinCliRefusal, systemMarkers } from '../../../../bundle/lib/system-mode.mjs';
import { buildInstallPlan } from '../../../../bundle/lib/system-install-mac.mjs';
import { executePlan } from '../../../../bundle/lib/system-install-exec.mjs';

describe('detectSystemInstall', () => {
  it('needs both the plist and the settings file', () => {
    const m = systemMarkers('/p');
    expect(detectSystemInstall({ prefix: '/p', exists: (f: string) => f === m.plist })).toBe(false);
    expect(detectSystemInstall({ prefix: '/p', exists: (f: string) => f === m.settings })).toBe(false);
    expect(detectSystemInstall({ prefix: '/p', exists: () => true })).toBe(true);
  });
});

describe('thinCliRefusal', () => {
  it('lets the harmless commands through', () => {
    for (const a of [[], ['help'], ['status'], ['open'], ['config', 'get', 'port'], ['config', 'get', 'data-dir'], ['install', '--system'], ['verify-report', 'x']]) {
      expect(thinCliRefusal(a)).toBeNull();
    }
  });
  it('refuses what would touch the gateway\'s files or process, with the admin command', () => {
    expect(thinCliRefusal(['stop'])!.lines.join('\n')).toContain('sudo launchctl bootout system/ai.suveren.gateway');
    expect(thinCliRefusal(['restart'])!.lines.join('\n')).toContain('sudo launchctl kickstart -k system/ai.suveren.gateway');
    expect(thinCliRefusal(['logs'])!.lines.join('\n')).toContain('/var/log/suveren/gateway.log');
    for (const a of [['start'], ['service', 'install'], ['simulation', 'on'], ['config', 'set', 'port', '3500']]) {
      expect(thinCliRefusal(a)!.code).toBe(2);
    }
  });
  it('does not show defaults for settings it cannot read', () => {
    const r = thinCliRefusal(['config', 'get', 'as-url'])!;
    expect(r.lines.join('\n')).toMatch(/cannot be read from here/);
    expect(thinCliRefusal(['config', 'get'])).not.toBeNull();
  });
});

describe('the real CLI against a scratch install', () => {
  const CP = 38911;
  const MCP = 38912;
  let scratch: string;
  let prefix: string;
  let server: Server | null = null;
  const cli = join(__dirname, '../../../../bundle/bin/suveren-gateway.js');

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        SUVEREN_SYSTEM_PREFIX: prefix,
        // The person's own environment must lose against the daemon's settings.
        SUVEREN_CP_PORT: '3400',
        SUVEREN_DATA_DIR: join(scratch, 'persons-own-data'),
      },
      timeout: 15000,
    });

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 's1-thin-')));
    prefix = join(scratch, 'root');
    const pkg = join(scratch, 'pkg');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'server.js'), '');
    const node = join(scratch, 'node');
    writeFileSync(node, '');
    executePlan(
      buildInstallPlan({ version: '1.0.0', packageDir: pkg, nodeBinary: node, freeId: 260, cpPort: CP, mcpPort: MCP, prefix }),
      { prefix },
    );
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server!.close(r));
    rmSync(scratch, { recursive: true, force: true });
  });

  it('reads the ports from the root-owned settings file, not from the person\'s environment', () => {
    const r = run('config', 'get', 'port');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(String(CP));
    expect(r.stdout).not.toContain('3400');
  });

  it('refuses to stop, restart or read the log, and says who can', () => {
    for (const [args, needle] of [[['stop'], 'launchctl bootout'], [['restart'], 'launchctl kickstart'], [['logs'], 'tail']] as const) {
      const r = run(...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('needs an administrator');
      expect(r.stderr).toContain(needle);
    }
  });

  it('status says so plainly when nothing answers (exit 3)', () => {
    const r = run('status');
    expect(r.status).toBe(3);
    expect(r.stdout).toContain(`not answering on port ${CP}`);
  });

  it('status asks /health when the daemon is up and does not look for a pid file', async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/health' ? { vaultUnlocked: false, simulation: false, version: '9.9.9' } : {}));
    });
    await new Promise<void>((r) => server!.listen(CP, '127.0.0.1', r));
    // spawnSync would block this process and starve the server: use the async form.
    const { spawn } = await import('node:child_process');
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const p = spawn(process.execPath, [cli, 'status'], {
        env: { PATH: process.env.PATH, HOME: scratch, SUVEREN_SYSTEM_PREFIX: prefix },
      });
      let stdout = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.on('close', (code) => resolve({ code, stdout }));
    });
    expect(out.code).toBe(0 as number | null);
    expect(out.stdout).toContain('running (under its own account)');
    expect(out.stdout).toContain('locked');
  });
});
