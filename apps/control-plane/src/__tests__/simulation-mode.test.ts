/**
 * Control-plane's copy of isSimulationMode (mirrors
 * apps/mcp-server/src/lib/simulation-mode.ts, see its test file for the
 * matching case) — this is what `/health`'s `simulation` field reports to
 * the UI banner.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isSimulationMode } from '../lib/simulation-mode';

afterEach(() => {
  delete process.env.SUVEREN_SIMULATION;
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
});
