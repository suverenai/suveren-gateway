/**
 * ERP's invoicing area (erp.json's `create_invoice`/`create_credit_note`/
 * reads, all `"profile": "invoicing"` — area per tool, see
 * area-per-tool-gating.test.ts / area-per-tool-manifest.test.ts for the
 * GENERIC mechanism) against the REAL invoicing profile and the REAL
 * manifest on disk.
 *
 * `invoice_net_max`'s and `credit_net_max`'s `requiredFor`/`of` separation —
 * which numeric comparison hap-core's Gatekeeper actually runs for a given
 * action — is hap-core's own tested responsibility (unit-tested there, same
 * separation every gateway test with a mocked `verifyExecution` already
 * assumes — see numeric-amount-bound.test.ts's header comment). What this
 * file pins is the DATA that makes that enforcement land correctly for
 * THESE two tools: the profile declares `net_total`/`credit_total` as
 * separate, each required for only its own action type, and the manifest's
 * executionMapping feeds each tool's own field — never the other one's —
 * so an invoice limit can never apply to a credit note (or the reverse).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProfile, clearProfiles } from '@hap/core';
import { loadProfiles } from '../src/lib/profile-loader';
import { loadManifests, getManifest, invalidManifestReadGateReason, invalidManifestOverrideProfilesReason } from '../src/lib/manifest-loader';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');
const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR
  ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');

beforeAll(() => {
  loadProfiles(PROFILES_DIR);
  loadManifests(MANIFESTS_DIR);
});
afterAll(() => clearProfiles());

type BoundsField = { boundType?: { kind: string; of?: string; requiredFor?: string[]; window?: string } };
type Overrides = Record<string, { profile?: string; category?: string; boundField?: string; requiredValue?: string; executionMapping?: Record<string, unknown>; staticExecution?: Record<string, unknown> }>;

describe('invoicing profile registered + erp.json loads under it', () => {
  it('the invoicing profile resolves (short name)', () => {
    expect(getProfile('invoicing')).toBeTruthy();
  });

  it('erp.json loads (not refused) with its invoicing overrides', () => {
    expect(getManifest('erp')).toBeDefined();
  });

  it('erp.json passes BOTH per-profile checks explicitly (sales AND invoicing)', () => {
    const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'erp.json'), 'utf8'));
    expect(invalidManifestOverrideProfilesReason(manifest)).toBeNull();
    expect(invalidManifestReadGateReason(manifest)).toBeNull();
  });
});

describe('invoicing profile — net_total and credit_total are kept apart', () => {
  const fields = () => (getProfile('invoicing')?.boundsSchema as { fields: Record<string, BoundsField> }).fields;

  it('invoice_net_max is a per_transaction bound of net_total, required for "invoice" only', () => {
    const f = fields().invoice_net_max.boundType!;
    expect(f.kind).toBe('per_transaction');
    expect(f.of).toBe('net_total');
    expect(f.requiredFor).toEqual(['invoice']);
  });

  it('credit_net_max is a per_transaction bound of credit_total, required for "credit" only', () => {
    const f = fields().credit_net_max.boundType!;
    expect(f.kind).toBe('per_transaction');
    expect(f.of).toBe('credit_total');
    expect(f.requiredFor).toEqual(['credit']);
  });

  it('neither per-document bound requires the OTHER action type — an invoice limit cannot apply to a credit note or vice versa', () => {
    expect(fields().invoice_net_max.boundType!.requiredFor).not.toContain('credit');
    expect(fields().credit_net_max.boundType!.requiredFor).not.toContain('invoice');
  });
});

describe('erp.json — create_invoice / create_credit_note map the right field, and only it', () => {
  const overrides = () => (JSON.parse(readFileSync(join(MANIFESTS_DIR, 'erp.json'), 'utf8')).toolGating.overrides) as Overrides;

  it('create_invoice maps net_total, and does NOT map credit_total', () => {
    const o = overrides().create_invoice;
    expect(o.profile).toBe('invoicing');
    expect(o.staticExecution?.action_type).toBe('invoice');
    expect(Object.values(o.executionMapping ?? {})).toContain('net_total');
    expect(Object.values(o.executionMapping ?? {})).not.toContain('credit_total');
  });

  it('create_credit_note maps credit_total, and does NOT map net_total', () => {
    const o = overrides().create_credit_note;
    expect(o.profile).toBe('invoicing');
    expect(o.staticExecution?.action_type).toBe('credit');
    expect(Object.values(o.executionMapping ?? {})).toContain('credit_total');
    expect(Object.values(o.executionMapping ?? {})).not.toContain('net_total');
  });

  it('the four reads are under invoicing, gated by read_access:unlimited (like the sales reads)', () => {
    const o = overrides();
    for (const tool of ['list_invoices', 'get_invoice', 'list_credit_notes', 'get_credit_note']) {
      expect(o[tool], tool).toMatchObject({ profile: 'invoicing', category: 'read', boundField: 'read_access', requiredValue: 'unlimited' });
    }
  });

  it('every per_transaction bound invoicing requires is a `required` field on the profile (declared shape a mandate must set — the manifest cannot invent coverage for a field the profile never asks for)', () => {
    const invoicing = getProfile('invoicing')!;
    const f = (invoicing.boundsSchema as { fields: Record<string, { required?: boolean }> }).fields;
    expect(f.invoice_net_max.required).toBe(true);
    expect(f.credit_net_max.required).toBe(true);
  });
});

describe('sales is untouched — erp.json\'s existing tools still resolve to "sales"', () => {
  it('create_quote has no own profile override (stays on the manifest\'s)', () => {
    const o = (JSON.parse(readFileSync(join(MANIFESTS_DIR, 'erp.json'), 'utf8')).toolGating.overrides) as Overrides;
    expect(o.create_quote.profile).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'erp.json'), 'utf8'));
    expect(manifest.profile).toBe('sales');
  });
});
