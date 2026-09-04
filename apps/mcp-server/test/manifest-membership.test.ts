/**
 * A tool no manifest entry describes MUST be refused.
 *
 * protocol.md → Tool-Gating Manifests: "The Gatekeeper MUST refuse any tool
 * that is not described in a loaded manifest. There is no 'permissive default'
 * — read-only tools also require an entry (with category: 'read')."
 *
 * `resolveToolGating` fell back to `toolGating.default` for any tool with no
 * `overrides` entry, which IS a permissive default. What that meant in practice:
 * a downstream server — especially a REMOTE one, where the tool list is
 * whatever the vendor deployed today — could add a tool after the manifest was
 * written, and the gateway would gate it with a generic entry nobody wrote for
 * it. The default's `executionMapping` is empty by construction, so the call's
 * real parameters (amount, recipient, resource) mapped into nothing and were
 * checked against nothing; the receipt then recorded an action whose values the
 * bounds never saw.
 *
 * `default` is not an inheritance template either — the override branch reads
 * each entry's own executionMapping/staticExecution and merges nothing — so
 * dropping it as a gate changes nothing for tools that ARE described.
 *
 * Asserted here: an unlisted tool resolves to a refusal and the gate refuses
 * it (whether the default would have called it a read or a write), the refusal
 * tells the operator what to add, and every kind of listed entry resolves
 * exactly as before.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntegrationManager } from '../src/lib/integration-manager';
import { createGatedToolHandler } from '../src/lib/tool-proxy';
import type { ToolGatingConfig } from '../src/lib/integration-registry';
import type { DiscoveredTool, IntegrationManager as IM } from '../src/lib/integration-manager';
import type { SharedState } from '../src/lib/shared-state';
import type { ProfileToolGating } from '@hap/core';

const PROFILE = 'github.com/humanagencyprotocol/hap-profiles/charge@0.5';

/** Call the private resolver — the single decision point under test. */
function resolve(gating: ProfileToolGating | null, toolName: string): ToolGatingConfig | null {
  const manager = new IntegrationManager(new Map()) as unknown as {
    resolveToolGating(
      profileId: string | null,
      profileGating: ProfileToolGating | null,
      toolName: string,
    ): ToolGatingConfig | null;
  };
  return manager.resolveToolGating(PROFILE, gating, toolName);
}

/**
 * Two manifests that differ ONLY in what their `default` says, so the tests
 * show the outcome no longer depends on it: a default that would have called
 * unlisted tools reads, and one that would have called them writes.
 */
const READ_DEFAULT: ProfileToolGating = {
  default: { executionMapping: {}, staticExecution: { action_type: 'read' } },
  overrides: {
    create_payment: { executionMapping: { amount: 'amount' }, staticExecution: { action_type: 'charge' } },
    get_payment: { category: 'read', readGovernance: 'none', readGovernanceReason: 'test' } as never,
    legacy_tool: { category: 'disabled' } as never,
    exempt_tool: null,
  },
};
const WRITE_DEFAULT: ProfileToolGating = {
  default: { executionMapping: {}, staticExecution: { action_type: 'unclassified' } },
  overrides: READ_DEFAULT.overrides,
};

describe('resolveToolGating — a tool with no manifest entry', () => {
  it('resolves to a refusal, not to the default (read-flavoured default)', () => {
    const gating = resolve(READ_DEFAULT, 'tool_nobody_described');
    expect(gating).toMatchObject({ category: 'disabled', disabledReason: 'not described in manifest' });
  });

  it('resolves to a refusal, not to the default (write-flavoured default)', () => {
    const gating = resolve(WRITE_DEFAULT, 'tool_nobody_described');
    expect(gating).toMatchObject({ category: 'disabled', disabledReason: 'not described in manifest' });
  });

  it('carries no execution mapping — there is nothing to gate it with', () => {
    // The old fallback handed the write path an empty mapping and let the call
    // through: the amount, the recipient and the resource all mapped into
    // nothing, so the bounds check had nothing to compare.
    expect(resolve(WRITE_DEFAULT, 'tool_nobody_described')!.executionMapping).toEqual({});
  });
});

describe('resolveToolGating — tools the manifest DOES describe are unchanged', () => {
  it('a write entry keeps its mapping and action type', () => {
    expect(resolve(READ_DEFAULT, 'create_payment')).toMatchObject({
      profile: PROFILE,
      executionMapping: { amount: 'amount' },
      staticExecution: { action_type: 'charge' },
    });
    expect(resolve(READ_DEFAULT, 'create_payment')!.category).toBeUndefined();
  });

  it('a read entry stays a read', () => {
    expect(resolve(READ_DEFAULT, 'get_payment')).toMatchObject({ category: 'read' });
  });

  it('a null entry (shorthand for read) stays a read', () => {
    expect(resolve(READ_DEFAULT, 'exempt_tool')).toMatchObject({ category: 'read' });
  });

  it('an explicitly disabled entry stays disabled, with no invented reason', () => {
    // The manifest said so — the refusal must not tell the operator to add an
    // entry that already exists.
    const gating = resolve(READ_DEFAULT, 'legacy_tool')!;
    expect(gating.category).toBe('disabled');
    expect(gating.disabledReason).toBeUndefined();
  });
});

describe('the gate refuses the unlisted tool', () => {
  /** Any access to state or the integration means the call was not refused. */
  const explode = new Proxy({}, { get() { throw new Error('the call was not refused'); } });

  function handlerFor(gating: ToolGatingConfig, originalName: string) {
    const tool = {
      originalName,
      namespacedName: `mollie__${originalName}`,
      integrationId: 'mollie',
      description: '',
      inputSchema: {},
      gating,
    } as unknown as DiscoveredTool;
    return createGatedToolHandler(tool, explode as unknown as IM, explode as unknown as SharedState);
  }

  it('refuses the call and never touches the downstream integration', async () => {
    const gating = resolve(WRITE_DEFAULT, 'SomeToolAddedLastWeek')!;
    const result = await handlerFor(gating, 'SomeToolAddedLastWeek')({ amount: 9999 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('refused');
    expect(result.content[0].text).toContain('not described in manifest');
  });

  it('tells the operator to add a manifest entry, naming the tool', async () => {
    // The refusal is a manifest defect report, not a permission error: nobody
    // can fix it by granting more authority.
    const gating = resolve(WRITE_DEFAULT, 'SomeToolAddedLastWeek')!;
    const result = await handlerFor(gating, 'SomeToolAddedLastWeek')({});

    expect(result.content[0].text).toContain('toolGating.overrides');
    expect(result.content[0].text).toContain('SomeToolAddedLastWeek');
  });

  it('refuses a read-looking call the same way — there is no ungated read', async () => {
    // The name says "get", the default said "read". Neither is a manifest
    // entry, and only a manifest entry can make a read governed.
    const gating = resolve(READ_DEFAULT, 'GetSomethingUndescribed')!;
    const result = await handlerFor(gating, 'GetSomethingUndescribed')({ id: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not described in manifest');
  });
});

describe('the shipped mollie manifest (a REMOTE server — the live case)', () => {
  // mollie runs via mcp-remote against mcp.mollie.com, so its tool list is
  // whatever the vendor serves, not what this repo declares. Its `default`
  // gated undeclared tools as writes with an empty mapping; they are now
  // refused until someone describes them.
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'content', 'integrations', 'mollie.json'),
      'utf8',
    ),
  ) as { toolGating: ProfileToolGating };

  it('still gates a tool it describes', () => {
    const gating = resolve(manifest.toolGating, 'CreatePayment')!;
    expect(gating.category).not.toBe('disabled');
    expect(gating.staticExecution?.action_type).toBe('charge');
  });

  it('refuses a tool the vendor may expose but this manifest does not describe', () => {
    expect(resolve(manifest.toolGating, 'ToolTheVendorAddedToday')).toMatchObject({
      category: 'disabled',
      disabledReason: 'not described in manifest',
    });
  });
});
