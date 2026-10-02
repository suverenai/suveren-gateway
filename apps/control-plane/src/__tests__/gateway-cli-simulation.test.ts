/**
 * `suveren-gateway simulation on|off|status` and `start --simulation` — the
 * CLI surface for the gateway-wide switch that blocks every real system (see
 * apps/mcp-server/src/lib/simulation-mode.ts for enforcement).
 *
 * Spawns the REAL shipped CLI (`bundle/bin/suveren-gateway.js`) as a child
 * process — not a reimplementation of its logic — same convention as
 * cli-pin-tls-fingerprint.test.ts. Refusals first (doc/engineering.md rule 4):
 * turning simulation OFF (making real systems reachable again) is the
 * dangerous direction and requires typed confirmation; turning it ON does not.
 *
 * SUVEREN_CP_PORT is pinned to an unused high port on every invocation so
 * `start --simulation` never probes or binds the real gateway's ports
 * (3400/3401/3402/3430/3431/7400/7430) — it only needs to get PAST the
 * "already running?" / "port in use?" checks to reach the save-then-spawn
 * code path; nothing here waits for the gateway to actually come up.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '../../../../bundle/bin/suveren-gateway.js');

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cli-simulation-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** A port nothing in this repo ever binds, so `start` always sees it free. */
const UNUSED_PORT = '19743';

function run(
  dataDir: string,
  args: string[],
  opts: { input?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      SUVEREN_DATA_DIR: dataDir,
      SUVEREN_CP_PORT: UNUSED_PORT,
      SUVEREN_MCP_PORT: String(Number(UNUSED_PORT) + 1),
    },
    encoding: 'utf-8',
    input: opts.input,
    timeout: 15_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('suveren-gateway simulation off — requires typed confirmation', () => {
  it('REFUSAL: no TTY and no --confirm — exit 1, config unchanged', () => {
    const dataDir = tmp();
    run(dataDir, ['simulation', 'on']); // start from a known ON state
    const { status, stderr } = run(dataDir, ['simulation', 'off']); // no --confirm, no TTY under spawnSync

    expect(status).toBe(1);
    expect(stderr.toLowerCase()).toContain('unchanged');
    expect(readJson(join(dataDir, 'config.json')).simulation).toBe(true);
  });

  it('REFUSAL: --confirm with the wrong word — exit 1, config unchanged', () => {
    const dataDir = tmp();
    run(dataDir, ['simulation', 'on']);
    const { status, stderr } = run(dataDir, ['simulation', 'off', '--confirm', 'yes']);

    expect(status).toBe(1);
    expect(stderr).toContain('Aborted');
    expect(readJson(join(dataDir, 'config.json')).simulation).toBe(true);
  });

  it('--confirm live turns it off — exit 0', () => {
    const dataDir = tmp();
    run(dataDir, ['simulation', 'on']);
    const { status, stdout } = run(dataDir, ['simulation', 'off', '--confirm', 'live']);

    expect(status).toBe(0);
    expect(stdout).toContain('OFF');
    expect(readJson(join(dataDir, 'config.json')).simulation).toBe(false);
  });

  it('prints what changes before asking for confirmation', () => {
    const dataDir = tmp();
    const { stderr } = run(dataDir, ['simulation', 'off']);
    expect(stderr).toContain('reachable again');
  });
});

describe('suveren-gateway simulation on — the safe direction, no confirmation', () => {
  it('turns it on with no prompt — exit 0', () => {
    const dataDir = tmp();
    const { status, stdout } = run(dataDir, ['simulation', 'on']);

    expect(status).toBe(0);
    expect(stdout).toContain('ON');
    expect(readJson(join(dataDir, 'config.json')).simulation).toBe(true);
  });
});

describe('suveren-gateway simulation status', () => {
  it('reports off when nothing was ever saved', () => {
    const dataDir = tmp();
    const { status, stdout } = run(dataDir, ['simulation', 'status']);
    expect(status).toBe(0);
    expect(stdout).toContain('Saved:   off');
  });

  it('reports on after `simulation on`', () => {
    const dataDir = tmp();
    run(dataDir, ['simulation', 'on']);
    const { stdout } = run(dataDir, ['simulation', 'status']);
    expect(stdout).toContain('Saved:   on');
  });
});

describe('suveren-gateway start --simulation', () => {
  it('persists simulation:true to config.json before attempting to start', () => {
    const dataDir = tmp();
    // This worktree has no built bundle/dist (apps build to apps/*/dist, not
    // bundle/dist — only `bundle/build.mjs` assembles that), so the spawned
    // server.js fails fast on a missing module. That is fine: the save
    // happens BEFORE the spawn in start()'s own ordering (see its "NOW save"
    // comment), so config.json reflects the flag regardless of whether the
    // child process could come up — exactly what this test checks.
    run(dataDir, ['start', '--simulation']);

    expect(existsSync(join(dataDir, 'config.json'))).toBe(true);
    expect(readJson(join(dataDir, 'config.json')).simulation).toBe(true);
  });

  it('without the flag, an existing saved setting is left alone', () => {
    const dataDir = tmp();
    run(dataDir, ['simulation', 'on']);
    run(dataDir, ['start']); // no --simulation flag this time

    expect(readJson(join(dataDir, 'config.json')).simulation).toBe(true);
  });
});
