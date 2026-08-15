/**
 * Start/stop races on IntegrationManager — the root cause of the read-gate
 * "value-mismatch" fail-open flake (doc/v06-plan.md → FLAKY FAIL-OPEN).
 *
 * Before the per-id operation queue, a start issued while another start for
 * the SAME id was still handshaking saw `running.has(id) === false`, skipped
 * the stop, and spawned a second child. Whichever start finished LAST owned
 * the `running` entry — so the surviving tool GATING was a coin flip, the
 * loser's child leaked, and a permissive manifest config could silently
 * replace a stricter explicit one. That is a fail-open, and reads have no
 * second check by design.
 *
 * These tests pin the deterministic semantics:
 *   • concurrent starts serialize; the LAST CALLER's config wins;
 *   • `skipIfRunning` starts never replace a running instance;
 *   • a stop issued during an in-flight start stops the just-started child
 *     instead of silently doing nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { IntegrationManager } from '../src/lib/integration-manager';
import type { IntegrationConfig } from '../src/lib/integration-registry';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'delayable-mcp-server.mjs');

function config(requiredValue: string, startDelayMs = 0): IntegrationConfig {
  return {
    id: 'race',
    name: 'Race fixture',
    command: process.execPath,
    args: [FIXTURE],
    env: startDelayMs > 0 ? { START_DELAY_MS: String(startDelayMs) } : {},
    envKeys: {},
    profile: 'race-profile',
    // The gating is the payload under test: each start carries a
    // distinguishable requiredValue so the test can tell WHICH config the
    // surviving entry enforces.
    toolGating: {
      default: { executionMapping: {} },
      overrides: {
        echo: { category: 'read', boundField: 'read_access', requiredValue },
      },
    } as IntegrationConfig['toolGating'],
    enabled: true,
  };
}

function survivingRequiredValue(im: IntegrationManager): string | undefined {
  const tools = im.getAllTools();
  expect(tools).toHaveLength(1);
  return tools[0].gating?.requiredValue;
}

describe('IntegrationManager start/stop serialization', () => {
  let im: IntegrationManager;

  afterEach(async () => {
    await im.shutdown();
  });

  it('a start issued during an in-flight start wins — last caller, not last finisher', async () => {
    im = new IntegrationManager(new Map());

    // First start is SLOW (child sleeps before the handshake); second is fast
    // and issued while the first is still connecting. Without serialization
    // the slow start finishes last and clobbers the fast one's entry — the
    // exact shape of the boot-restore vs add-integration race.
    const slow = im.startIntegration(config('FROM_SLOW_FIRST_CALLER', 800));
    await new Promise((r) => setTimeout(r, 100));
    const fast = im.startIntegration(config('FROM_LAST_CALLER'));

    await Promise.all([slow, fast]);

    expect(im.isRunning('race')).toBe(true);
    expect(survivingRequiredValue(im)).toBe('FROM_LAST_CALLER');
  }, 30_000);

  it('skipIfRunning keeps the running instance and its gating', async () => {
    im = new IntegrationManager(new Map());

    await im.startIntegration(config('EXPLICIT'));
    // Opportunistic path (boot restore / respawn) must not replace it…
    const tools = await im.startIntegration(config('OPPORTUNISTIC'), { skipIfRunning: true });

    expect(tools[0].gating?.requiredValue).toBe('EXPLICIT');
    expect(survivingRequiredValue(im)).toBe('EXPLICIT');

    // …and a skipIfRunning start queued BEHIND an in-flight explicit start
    // must also yield to it.
    await im.stopIntegration('race');
    const explicit = im.startIntegration(config('EXPLICIT_2', 400));
    await new Promise((r) => setTimeout(r, 100));
    const opportunistic = im.startIntegration(config('OPPORTUNISTIC_2'), { skipIfRunning: true });
    await Promise.all([explicit, opportunistic]);

    expect(survivingRequiredValue(im)).toBe('EXPLICIT_2');
  }, 30_000);

  it('a stop issued during an in-flight start stops the started child', async () => {
    im = new IntegrationManager(new Map());

    const start = im.startIntegration(config('ANY', 400));
    await new Promise((r) => setTimeout(r, 100));
    const stop = im.stopIntegration('race');

    await Promise.all([start, stop]);

    expect(im.isRunning('race')).toBe(false);
    expect(im.getAllTools()).toHaveLength(0);
  }, 30_000);
});
