/**
 * Area per tool — a connector manifest's `profile` applies to all its tools
 * by default, but a `toolGating.overrides[tool]` entry may declare its OWN
 * `profile`, gating THAT tool under a different area. Motivating case: an
 * ERP spans several areas (sales, invoicing, purchasing) under one manifest.
 *
 * `resolveToolGating` (integration-manager.ts) is private; reached the same
 * way manifest-env-mapping.test.ts reaches `resolveEnvKeys` — a direct cast,
 * not a child process, since this is pure data resolution.
 */
import { describe, it, expect } from 'vitest';
import { IntegrationManager } from '../src/lib/integration-manager';
import type { ProfileToolGating } from '../src/lib/tool-gating-types';
import type { ToolGatingConfig } from '../src/lib/integration-registry';

function resolve(
  profileId: string | null,
  gating: ProfileToolGating | null,
  toolName: string,
): ToolGatingConfig | null {
  const im = new IntegrationManager(new Map());
  return (im as unknown as {
    resolveToolGating(p: string | null, g: ProfileToolGating | null, t: string): ToolGatingConfig | null;
  }).resolveToolGating(profileId, gating, toolName);
}

// Widened the same way manifest-loader.ts's own tests widen a manifest's
// overrides: 'disabled' and the per-tool `profile` aren't on the strict
// ProfileToolGatingEntry type (it only types what manifest-loader.ts itself
// needs to shape-check), so the whole literal is cast once.
const TWO_AREA_GATING = {
  default: { executionMapping: {} },
  overrides: {
    // No own profile — stays on the manifest's ("sales").
    create_quote: { executionMapping: { value: 'value' }, staticExecution: { action_type: 'quote' } },
    // Own profile ("invoicing") — a write override.
    create_invoice: {
      profile: 'invoicing',
      executionMapping: { net_total: 'net_total' },
      staticExecution: { action_type: 'invoice' },
    },
    // Own profile, read-only (null-shorthand does NOT carry a profile — only
    // an explicit object can; covered separately below).
    list_invoices: { profile: 'invoicing', category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
    // Own profile, disabled.
    clear_ledger: { profile: 'invoicing', category: 'disabled' },
  },
} as unknown as ProfileToolGating;

describe('resolveToolGating — area per tool', () => {
  it('an override with no own profile falls back to the manifest profile (unchanged behaviour)', () => {
    const g = resolve('sales', TWO_AREA_GATING, 'create_quote');
    expect(g?.profile).toBe('sales');
  });

  it('a WRITE override\'s own profile wins over the manifest profile', () => {
    const g = resolve('sales', TWO_AREA_GATING, 'create_invoice');
    expect(g?.profile).toBe('invoicing');
    expect(g?.category).toBeUndefined();
    expect(g?.staticExecution?.action_type).toBe('invoice');
  });

  it('a READ override\'s own profile wins over the manifest profile', () => {
    const g = resolve('sales', TWO_AREA_GATING, 'list_invoices');
    expect(g?.profile).toBe('invoicing');
    expect(g?.category).toBe('read');
    expect(g?.boundField).toBe('read_access');
  });

  it('a DISABLED override\'s own profile wins over the manifest profile', () => {
    const g = resolve('sales', TWO_AREA_GATING, 'clear_ledger');
    expect(g?.profile).toBe('invoicing');
    expect(g?.category).toBe('disabled');
  });

  it('a tool with no manifest entry at all stays gated under the manifest profile (refused, not reassigned)', () => {
    const g = resolve('sales', TWO_AREA_GATING, 'undeclared_tool');
    expect(g?.profile).toBe('sales');
    expect(g?.category).toBe('disabled');
    expect(g?.disabledReason).toBe('not described in manifest');
  });
});
