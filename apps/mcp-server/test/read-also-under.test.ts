/**
 * `readAlsoUnder` — a READ may also be authorized under further areas the
 * manifest names (erp.json: the customer lookups serve sales AND invoicing),
 * so one Invoicing mandate is enough to find the customer for an invoice
 * (Rehearsal A3, 2026-10-19). Writes never; reads with an age adapter never.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGatedToolHandler, buildProxiedToolDescription } from '../src/lib/tool-proxy';
import { invalidManifestReadAlsoUnderReason } from '../src/lib/manifest-loader';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';

const P = (short: string) => `github.com/humanagencyprotocol/hap-profiles/${short}@0.1`;

function mandate(short: string, readAccess: string): EnrichedAuthorization {
  const bounds = { profile: P(short), read_access: readAccess };
  return { authorizationId: `authz_${short}`, profileId: P(short), path: short, frame: bounds, bounds, attestations: [],
    requiredDomains: [], attestedDomains: [], deferredCommitmentDomains: [], complete: true, gateContent: null } as unknown as EnrichedAuthorization;
}
function state(...mandates: EnrichedAuthorization[]): SharedState {
  return { getEnrichedAuthorizations: () => mandates, spClient: { isUnlocked: () => true }, asVersionRefusal: undefined } as unknown as SharedState;
}
function readTool(readAlsoUnder?: string[]) {
  const tool = { originalName: 'find_customers', namespacedName: 'erp__find_customers', integrationId: 'erp', description: 'Search customers',
    inputSchema: { type: 'object', properties: {} },
    gating: { profile: 'sales', executionMapping: {}, category: 'read', boundField: 'read_access', requiredValue: 'unlimited', ...(readAlsoUnder ? { readAlsoUnder } : {}) },
  } as unknown as DiscoveredTool;
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '[]' }] });
  const im = { getAllTools: () => [tool], callTool } as unknown as IntegrationManager;
  return { tool, im, callTool };
}

describe('readAlsoUnder — a read authorized by any of its areas', () => {
  it('an Invoicing mandate with read access covers the ERP customer lookup', async () => {
    const { tool, im, callTool } = readTool(['invoicing']);
    const r = await createGatedToolHandler(tool, im, state(mandate('invoicing', 'unlimited')))({});
    expect(r.isError).toBeFalsy();
    expect(callTool).toHaveBeenCalled();
  });
  it('without readAlsoUnder the same mandate does not (one area per tool, as before)', async () => {
    const { tool, im, callTool } = readTool();
    const r = await createGatedToolHandler(tool, im, state(mandate('invoicing', 'unlimited')))({});
    expect(r.isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });
  it('the read gate still applies — an Invoicing mandate WITHOUT read access is refused', async () => {
    const { tool, im, callTool } = readTool(['invoicing']);
    const r = await createGatedToolHandler(tool, im, state(mandate('invoicing', 'none')))({});
    expect(r.isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });
  it('an unrelated area does not cover it', async () => {
    const { tool, im } = readTool(['invoicing']);
    const r = await createGatedToolHandler(tool, im, state(mandate('email', 'unlimited')))({});
    expect(r.isError).toBe(true);
  });
  it('the AI is told every area that covers the read', () => {
    expect(buildProxiedToolDescription(readTool(['invoicing']).tool)).toMatch(/works only under a sales or invoicing mandate/);
  });
});

describe('readAlsoUnder — manifest validation', () => {
  const m = (entry: Record<string, unknown>) => ({ toolGating: { default: { executionMapping: {} }, overrides: { t: entry } } }) as never;
  it('fine on a plain read', () => {
    expect(invalidManifestReadAlsoUnderReason(m({ category: 'read', readAlsoUnder: ['invoicing'] }))).toBeNull();
  });
  it('refused on a write tool', () => {
    expect(invalidManifestReadAlsoUnderReason(m({ readAlsoUnder: ['invoicing'], staticExecution: { action_type: 'create' } }))).toMatch(/read tools only/);
  });
  it('refused with a read adapter (age window)', () => {
    expect(invalidManifestReadAlsoUnderReason(m({ category: 'read', read: { ageField: 'x' }, readAlsoUnder: ['invoicing'] }))).toMatch(/read adapter/);
  });
  it('refused when empty or not a list of names', () => {
    expect(invalidManifestReadAlsoUnderReason(m({ category: 'read', readAlsoUnder: [] }))).toMatch(/non-empty/);
    expect(invalidManifestReadAlsoUnderReason(m({ category: 'read', readAlsoUnder: 'invoicing' }))).toMatch(/non-empty/);
  });
  it('the shipped erp.json passes, and its customer lookups also serve invoicing', () => {
    const erp = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'content', 'integrations', 'erp.json'), 'utf8'));
    expect(invalidManifestReadAlsoUnderReason(erp)).toBeNull();
    expect(erp.toolGating.overrides.find_customers.readAlsoUnder).toEqual(['invoicing']);
    expect(erp.toolGating.overrides.get_customer.readAlsoUnder).toEqual(['invoicing']);
  });
});
