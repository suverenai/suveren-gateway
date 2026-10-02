/**
 * `suveren-gateway config get/set` and `simulation on|off` when IT policy
 * locks a setting (see bundle/lib/policy.mjs). Spawns the REAL shipped CLI
 * (`bundle/bin/suveren-gateway.js`) as a child process — not a
 * reimplementation of its logic — same convention as
 * gateway-cli-simulation.test.ts.
 *
 * doc/engineering.md rule 4 (test refusals harder than successes): the whole
 * point of this feature is that the employee CANNOT change a locked
 * setting, so every scenario here is a refusal — plus one control case
 * (no policy file → ordinary unlocked behaviour, unaffected).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '../../../../bundle/bin/suveren-gateway.js');

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cli-managed-'));
  dirs.push(d);
  return d;
}

function policyFile(contents: unknown): string {
  const dir = tmp();
  const path = join(dir, 'gateway-policy.json');
  writeFileSync(path, JSON.stringify(contents), 'utf8');
  return path;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const UNUSED_PORT = '19753';

function run(
  dataDir: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      SUVEREN_DATA_DIR: dataDir,
      SUVEREN_CP_PORT: UNUSED_PORT,
      SUVEREN_MCP_PORT: String(Number(UNUSED_PORT) + 1),
      ...env,
    },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('config get — shows IT-locked settings', () => {
  it('appends "(set by your IT)" to a policy-locked as-url', () => {
    const dataDir = tmp();
    const policy = policyFile({ AsUrl: 'https://as.company.internal' });
    const { stdout } = run(dataDir, ['config', 'get', 'as-url'], { SUVEREN_POLICY_FILE: policy });
    expect(stdout).toContain('https://as.company.internal');
    expect(stdout).toContain('(set by your IT)');
  });

  it('an unlocked setting shows no IT suffix', () => {
    const dataDir = tmp();
    const policy = policyFile({ AsUrl: 'https://as.company.internal' }); // locks asUrl only
    const { stdout } = run(dataDir, ['config', 'get', 'pin-tls'], { SUVEREN_POLICY_FILE: policy });
    expect(stdout).not.toContain('(set by your IT)');
  });
});

describe('REFUSAL: config set on a policy-locked key', () => {
  it('as-url — exit 1, names the policy value, config.json untouched', () => {
    const dataDir = tmp();
    const policy = policyFile({ AsUrl: 'https://as.company.internal' });
    const { status, stderr } = run(dataDir, ['config', 'set', 'as-url', 'https://attacker.example.com'], {
      SUVEREN_POLICY_FILE: policy,
    });
    expect(status).toBe(1);
    expect(stderr).toContain('set by your IT policy');
    expect(stderr).toContain('https://as.company.internal');
  });

  it('ca-file — exit 1, names the policy value', () => {
    const dataDir = tmp();
    const caPath = join(tmp(), 'ca.pem');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\n...', 'utf8');
    const policy = policyFile({ CaFile: caPath });
    const { status, stderr } = run(dataDir, ['config', 'set', 'ca-file', '/tmp/other.pem'], {
      SUVEREN_POLICY_FILE: policy,
    });
    expect(status).toBe(1);
    expect(stderr).toContain('set by your IT policy');
  });

  it('pin-tls — exit 1 even with a plausible --expect-fingerprint', () => {
    const dataDir = tmp();
    const policy = policyFile({ PinTls: false });
    const { status, stderr } = run(
      dataDir,
      ['config', 'set', 'pin-tls', 'on', '--expect-fingerprint', 'ab'.repeat(32)],
      { SUVEREN_POLICY_FILE: policy },
    );
    expect(status).toBe(1);
    expect(stderr).toContain('set by your IT policy');
  });
});

describe('REFUSAL: simulation on|off on a policy-locked Simulation', () => {
  it('"simulation off" refuses even with --confirm live — the policy wins outright', () => {
    const dataDir = tmp();
    const policy = policyFile({ Simulation: true });
    const { status, stderr } = run(dataDir, ['simulation', 'off', '--confirm', 'live'], {
      SUVEREN_POLICY_FILE: policy,
    });
    expect(status).toBe(1);
    expect(stderr).toContain('set by your IT policy');
    expect(stderr).toContain('on'); // names the current (locked) value
  });

  it('"simulation on" also refuses when policy locks it OFF — not just the dangerous direction', () => {
    const dataDir = tmp();
    const policy = policyFile({ Simulation: false });
    const { status, stderr } = run(dataDir, ['simulation', 'on'], { SUVEREN_POLICY_FILE: policy });
    expect(status).toBe(1);
    expect(stderr).toContain('set by your IT policy');
  });

  it('"simulation status" shows the IT suffix on the Saved line', () => {
    const dataDir = tmp();
    const policy = policyFile({ Simulation: true });
    const { stdout } = run(dataDir, ['simulation', 'status'], { SUVEREN_POLICY_FILE: policy });
    expect(stdout).toContain('Saved:   on');
    expect(stdout).toContain('(set by your IT)');
  });
});

describe('REFUSAL: an invalid policy value refuses to start the CLI at all', () => {
  it('config get fails loudly on a bad policy AsUrl — never silently ignored', () => {
    const dataDir = tmp();
    const policy = policyFile({ AsUrl: 'not-a-url' });
    const { status, stderr } = run(dataDir, ['config', 'get'], { SUVEREN_POLICY_FILE: policy });
    expect(status).not.toBe(0);
    expect(stderr).toContain('Invalid policy AsUrl');
  });
});

describe('control: no policy file configured — ordinary unlocked behaviour', () => {
  it('config set as-url still works exactly as before', () => {
    const dataDir = tmp();
    const absentPolicy = join(tmp(), 'absent-gateway-policy.json');
    const { status, stdout } = run(dataDir, ['config', 'set', 'as-url', 'https://my-as.example.com'], {
      SUVEREN_POLICY_FILE: absentPolicy,
    });
    expect(status).toBe(0);
    expect(stdout).toContain('Saved as-url');
    expect(readJson(join(dataDir, 'config.json')).asUrl).toBe('https://my-as.example.com');
  });
});
