/**
 * WS3 (work-plan "Added 2026-10-11 — an account is Personal OR in one
 * team"): `create_mandate` no longer takes a `team` argument — the mandate
 * always goes to the person's active workspace. Full create/approve
 * behaviour is exercised in hap-e2e (real stack); this covers the static
 * contract a unit test CAN check cheaply: the tool's own schema/description/
 * approval view/preview mapping never mention `team` again.
 */
import { describe, it, expect } from 'vitest';
import { setupBuiltin } from '../setup';
import type { BuiltinDeps } from '../index';

// setupBuiltin's factory body only builds static tool definitions — the
// closures that touch `deps` (handler/validate) are never invoked here.
const tools = setupBuiltin({} as BuiltinDeps).tools;
const createMandate = tools.find(t => t.name === 'create_mandate')!;
const describeMandateProposal = tools.find(t => t.name === 'describe_mandate_proposal')!;

describe('setup__create_mandate — no `team` argument (WS3)', () => {
  it('the input schema has no `team` property', () => {
    const schema = createMandate.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty('team');
  });

  it('the description does not tell the AI it may name a team', () => {
    expect(createMandate.description).not.toMatch(/\bteam\b.*`team`|`team`.*\bteam\b/i);
    expect(createMandate.description).not.toContain('`team`');
  });

  it('the approval view has no Team row', () => {
    const integration = setupBuiltin({} as BuiltinDeps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const override = (integration.toolGating as any)?.overrides?.create_mandate;
    expect(override.approvalView).not.toHaveProperty('team');
  });

  it('the AU3 preview call no longer forwards a `team` arg', () => {
    const integration = setupBuiltin({} as BuiltinDeps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const override = (integration.toolGating as any)?.overrides?.create_mandate;
    expect(override.preview.args).not.toHaveProperty('team');
  });

  it('describe_mandate_proposal (the AU3 preview tool) shares the SAME team-less schema', () => {
    const schema = describeMandateProposal.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty('team');
  });
});
