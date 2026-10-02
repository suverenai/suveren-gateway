import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSimulationMode, manifestIsSimulated } from '../simulation-mode';
import { _resetPolicyCacheForTests } from '../policy';

const dirs: string[] = [];

afterEach(() => {
  delete process.env.SUVEREN_SIMULATION;
  delete process.env.SUVEREN_POLICY_FILE;
  _resetPolicyCacheForTests();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('isSimulationMode', () => {
  it('off by default — a normal install is unaffected', () => {
    delete process.env.SUVEREN_SIMULATION;
    expect(isSimulationMode()).toBe(false);
  });

  it('on only for the exact value "1" — never any other truthy-looking string', () => {
    process.env.SUVEREN_SIMULATION = '1';
    expect(isSimulationMode()).toBe(true);
    process.env.SUVEREN_SIMULATION = 'true';
    expect(isSimulationMode()).toBe(false);
    process.env.SUVEREN_SIMULATION = '0';
    expect(isSimulationMode()).toBe(false);
  });

  it('REFUSAL: IT policy Simulation=ON wins even when SUVEREN_SIMULATION=0 is set directly — locked means locked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    dirs.push(dir);
    const path = join(dir, 'gateway-policy.json');
    writeFileSync(path, JSON.stringify({ Simulation: true }), 'utf8');
    process.env.SUVEREN_POLICY_FILE = path;
    process.env.SUVEREN_SIMULATION = '0'; // an operator trying to override locally
    expect(isSimulationMode()).toBe(true);
  });

  it('a policy explicitly locking Simulation OFF cannot be turned on by env either', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    dirs.push(dir);
    const path = join(dir, 'gateway-policy.json');
    writeFileSync(path, JSON.stringify({ Simulation: false }), 'utf8');
    process.env.SUVEREN_POLICY_FILE = path;
    process.env.SUVEREN_SIMULATION = '1';
    expect(isSimulationMode()).toBe(false);
  });
});

describe('manifestIsSimulated', () => {
  it('false for a manifest with no simulation marker (e.g. gmail)', () => {
    expect(manifestIsSimulated({ simulation: null })).toBe(false);
    expect(manifestIsSimulated(undefined)).toBe(false);
  });

  it('true for a manifest that declares one (e.g. erp/crm/mail)', () => {
    expect(manifestIsSimulated({ simulation: { field: 'mode', default: 'simulation' } })).toBe(true);
  });
});
