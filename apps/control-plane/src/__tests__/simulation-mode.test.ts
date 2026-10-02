/**
 * Control-plane's copy of isSimulationMode (mirrors
 * apps/mcp-server/src/lib/simulation-mode.ts, see its test file for the
 * matching case) — this is what `/health`'s `simulation` field reports to
 * the UI banner.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSimulationMode } from '../lib/simulation-mode';
import { _resetPolicyCacheForTests } from '../lib/policy';

const dirs: string[] = [];

afterEach(() => {
  delete process.env.SUVEREN_SIMULATION;
  delete process.env.SUVEREN_POLICY_FILE;
  _resetPolicyCacheForTests();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('isSimulationMode (control-plane)', () => {
  it('off by default', () => {
    delete process.env.SUVEREN_SIMULATION;
    expect(isSimulationMode()).toBe(false);
  });

  it('on only for the exact value "1"', () => {
    process.env.SUVEREN_SIMULATION = '1';
    expect(isSimulationMode()).toBe(true);
    process.env.SUVEREN_SIMULATION = 'yes';
    expect(isSimulationMode()).toBe(false);
  });

  it('REFUSAL: IT policy wins over SUVEREN_SIMULATION — /health must report the locked value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    dirs.push(dir);
    const path = join(dir, 'gateway-policy.json');
    writeFileSync(path, JSON.stringify({ Simulation: true }), 'utf8');
    process.env.SUVEREN_POLICY_FILE = path;
    process.env.SUVEREN_SIMULATION = '0';
    expect(isSimulationMode()).toBe(true);
  });
});
