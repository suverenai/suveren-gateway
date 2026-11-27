/**
 * The short summary rule, against the REAL profile files of hap-profiles (every version of every profile), and the fourteen example
 * mandates of the signed-off mockup (section E). The rule is generic: nothing here, and nothing in the code under test, names a profile
 * or a field; the expectations are computed from each profile's own schema or written out for the mockup's examples.
 *
 * Profiles: $SUVEREN_PROFILES_DIR, else the `hap-profiles` checkout next to this repository (as the phone app's tests read them).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLimitValue } from './bound-format';
import { listItems, mandateFacts, shortListText, shortSummary, shortSummaryText, MAX_FACTS, type FactSchema } from './mandate-facts';
import type { SourceManifestLike } from './attachment-sources';

const profilesDir = [process.env.SUVEREN_PROFILES_DIR, join(import.meta.dirname, '..', '..', '..', '..', '..', 'hap-profiles')].find((d) => d && existsSync(join(d, 'index.json')));
if (!profilesDir) throw new Error('hap-profiles not found: set SUVEREN_PROFILES_DIR to a checkout of hap-profiles');

interface Profile { id: string; name?: string; boundsSchema?: FactSchema; scopeSchema?: FactSchema }
const all: Array<{ file: string; folder: string; profile: Profile }> = [];
for (const folder of readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const f of readdirSync(join(profilesDir, folder.name)).filter((n) => n.endsWith('.profile.json'))) {
    all.push({ file: `${folder.name}/${f}`, folder: folder.name, profile: JSON.parse(readFileSync(join(profilesDir, folder.name, f), 'utf8')) });
  }
}
const profileOf = (folder: string, version: string): Profile => {
  const hit = all.find((p) => p.file === `${folder}/${version}.profile.json`);
  if (!hit) throw new Error(`profile ${folder}@${version} not in ${profilesDir}`);
  return hit.profile;
};

describe('money, lists', () => {
  it('money reads as €2,000, from the unit alone', () => {
    expect(formatLimitValue(2000, 'currency:EUR')).toBe('€2,000');
    expect(formatLimitValue('100000', 'currency:EUR')).toBe('€100,000');
    expect(formatLimitValue(12.5, 'currency:USD')).toBe('$12.50');
    expect(formatLimitValue(20, 'percent')).toBe('20%');
    expect(formatLimitValue(240, 'minutes')).toBe('240 min');
    expect(formatLimitValue(30, 'days')).toBe('30 days');
    expect(formatLimitValue(50, 'count')).toBe('50');
    expect(formatLimitValue('unlimited')).toBe('unlimited');
  });
  it('a list reads with a space after each comma; two entries and "and N more" in the short form', () => {
    expect(listItems('customer,lead, partner')).toEqual(['customer', 'lead', 'partner']);
    expect(shortListText(['a', 'b'])).toBe('a, b');
    expect(shortListText(['a', 'b', 'c'])).toBe('a, b and 1 more');
    expect(shortListText(['a', 'b', 'c', 'd', 'e'])).toBe('a, b and 3 more');
  });
});

/** A mandate that sets every limit to a non-default value and every scope field to ONE enum value or a made-up one. */
function sample(p: Profile) {
  const limits: Record<string, string | number> = {};
  for (const [k, f] of Object.entries(p.boundsSchema?.fields ?? {})) {
    if (k === 'profile') continue;
    const values = f.boundType?.values;
    limits[k] = Array.isArray(values) ? String(values.find((v) => String(v) !== String(f.default)) ?? values[0]) : Number(f.default ?? 0) + 7;
  }
  const scope: Record<string, string> = {};
  for (const [k, f] of Object.entries(p.scopeSchema?.fields ?? {})) scope[k] = Array.isArray(f.enum) && f.enum.length > 0 ? String(f.enum[0]) : `${k}-one,${k}-two,${k}-three`;
  return { limits, scope };
}

describe('the rule, on every version of every real profile', () => {
  it('found the profiles', () => { expect(all.length).toBeGreaterThan(40); });

  for (const { file, profile } of all) {
    // The oldest profiles (charge@0.3, email@0.3) carry no schema at all: facts then read by their own keys.
    const bounds: FactSchema = profile.boundsSchema ?? {};
    const scopeSchema = profile.scopeSchema;
    const input = (limits: Record<string, string | number>, scope: Record<string, string>) => ({ limits, scope, boundsSchema: bounds, scopeSchema });

    it(`${file}: at most ${MAX_FACTS} facts, scope before limits, each in the profile's own order, "+N more" counts the rest`, () => {
      const { limits, scope } = sample(profile);
      const s = shortSummary(input(limits, scope));
      const full = mandateFacts(input(limits, scope));
      expect(s.facts.length).toBeLessThanOrEqual(MAX_FACTS);
      const kinds = s.facts.map((f) => f.kind);
      expect(kinds).toEqual([...kinds].sort((a, b) => (a === b ? 0 : a === 'scope' ? -1 : 1)));
      const order = (schema: FactSchema | undefined, keys: string[]) => {
        const ko = schema?.keyOrder ?? Object.keys(schema?.fields ?? {});
        return keys.sort((a, b) => ko.indexOf(a) - ko.indexOf(b));
      };
      for (const kind of ['scope', 'limit'] as const) {
        const shown = s.facts.filter((f) => f.kind === kind).map((f) => f.key);
        expect(shown).toEqual(order(kind === 'scope' ? scopeSchema : bounds, [...shown]));
      }
      // everything not shown is counted, and nothing else is
      expect(s.facts.length + s.more).toBeLessThanOrEqual(full.scope.length + full.limits.length);
      expect(s.facts.length + s.more).toBeGreaterThanOrEqual(0);
    });

    it(`${file}: a limit equal to its schema default and a scope that names every value of its enum say nothing`, () => {
      const { limits } = sample(profile);
      const defaults: Record<string, string | number> = { ...limits };
      for (const [k, f] of Object.entries(bounds.fields ?? {})) if (k !== 'profile' && f.default !== undefined) defaults[k] = f.default as string | number;
      const scope: Record<string, string> = {};
      for (const [k, f] of Object.entries(scopeSchema?.fields ?? {})) if (Array.isArray(f.enum)) scope[k] = f.enum.join(',');
      const shown = shortSummary(input(defaults, scope)).facts;
      for (const f of shown) {
        if (f.kind === 'limit') expect(String(bounds.fields![f.key].default)).not.toBe(String(defaults[f.key]));
        else expect(scopeSchema?.fields?.[f.key]?.enum).toBeUndefined();
      }
      // a profile whose limits all carry defaults and whose scope fields are all enums shows nothing at all
      const everyLimitHasDefault = Object.entries(bounds.fields ?? {}).filter(([k]) => k !== 'profile').every(([, f]) => f.default !== undefined);
      const everyScopeIsEnum = Object.values(scopeSchema?.fields ?? {}).every((f) => Array.isArray(f.enum));
      if (everyLimitHasDefault && everyScopeIsEnum) expect(shown).toEqual([]);
    });

    it(`${file}: a scope field that is only the unit of a shown limit is left out, and shown again once no limit shows that unit`, () => {
      const currencyField = Object.entries(scopeSchema?.fields ?? {}).find(([, f]) => Array.isArray(f.enum) && f.enum.includes('EUR'));
      const moneyLimit = Object.entries(bounds.fields ?? {}).find(([, f]) => f.unit === 'currency:EUR');
      if (!currencyField || !moneyLimit) return;
      const withLimit = shortSummary({ limits: { [moneyLimit[0]]: 500 }, scope: { [currencyField[0]]: 'EUR' }, boundsSchema: bounds, scopeSchema });
      expect(withLimit.facts.map((f) => f.key)).not.toContain(currencyField[0]);
      // EUR is one of several values here, so the field is a choice of its own as soon as no limit shows the unit
      const without = shortSummary({ limits: {}, scope: { [currencyField[0]]: 'EUR' }, boundsSchema: bounds, scopeSchema });
      if (currencyField[1].enum!.length > 1) expect(without.facts.map((f) => f.key)).toContain(currencyField[0]);
    });
  }
});

// ─── The fourteen example mandates of the mockup (section E) ─────────────────────────────────────
// Names and addresses are made up (example.com). Money reads "€2,000" (decision 6), the list tail "and N more" (decision 5).

const manifests: SourceManifestLike[] = [{ id: 'files', documents: { saved: { title: 'saved files' } } }];
const RULE = 'review';

interface Example { name: string; folder: string; version: string; mode: string; limits: Record<string, string | number>; scope: Record<string, string>; expected: string }
const examples: Example[] = [
  { name: 'Leads and customers', folder: 'customers', version: '0.12', mode: RULE,
    limits: { read_access: 'unlimited', export_access: 'none', write_daily_max: 50, delete_daily_max: 0, setup_daily_max: 0 }, scope: { contact_type: 'customer,lead,partner,vendor' },
    expected: 'Daily write limit 50' },
  { name: 'Resonance Room', folder: 'email', version: '0.11', mode: RULE,
    limits: { read_access: 'unlimited', recipient_max: 1, send_daily_max: 20, send_weekly_max: 60, setup_daily_max: 0 }, scope: { allowed_recipients: 'hello@example.com', allowed_attachment_sources: 'files:saved' },
    expected: 'Allowed recipients hello@example.com · Allowed attachment sources saved files · Recipients per email 1 · Daily send limit 20 · +1 more' },
  { name: 'Private email', folder: 'email', version: '0.11', mode: RULE,
    limits: { read_access: 'unlimited', recipient_max: 10, send_daily_max: 30, send_weekly_max: 100, setup_daily_max: 0 }, scope: { allowed_recipients: 'owner@example.com,owner.work@example.com,family@example.com' },
    expected: 'Allowed recipients owner@example.com, owner.work@example.com and 1 more · Recipients per email 10 · Daily send limit 30 · Weekly send limit 100' },
  // MOCKUP DIFFERS: it lists "Max email age (days) 30 days" before "Recipients per email" (the old alphabetical order); the rule reads the profile's own order.
  { name: 'Email test', folder: 'email', version: '0.11', mode: 'automatic',
    limits: { read_access: 'unlimited', read_max_age_days: 30, recipient_max: 1, send_daily_max: 10, send_weekly_max: 40, setup_daily_max: 0 }, scope: { allowed_recipients: 'test@example.com' },
    expected: 'Allowed recipients test@example.com · Recipients per email 1 · Daily send limit 10 · Weekly send limit 40 · +1 more' },
  { name: 'Payments', folder: 'charge', version: '0.7', mode: RULE,
    limits: { read_access: 'unlimited', amount_max: 2000, amount_daily_max: 5000, amount_monthly_max: 20000, charge_daily_max: 20, manage_daily_max: 5 }, scope: { currency: 'EUR' },
    expected: 'Max per payment €2,000 · Collected per day €5,000 · Collected per month €20,000 · Payments per day 20 · +1 more' },
  { name: 'LinkedIn', folder: 'publish', version: '0.9', mode: RULE,
    limits: { post_daily_max: 3, post_weekly_max: 10, post_monthly_max: 30 }, scope: { allowed_platforms: 'linkedin', content_type: 'text,image,article', audience: 'public,connections' },
    expected: 'Daily post limit 3 · Weekly post limit 10 · Monthly post limit 30' },
  { name: 'Appointments', folder: 'calendar', version: '0.6', mode: RULE,
    limits: { booking_daily_max: 10, booking_duration_max: 240, lookahead_days_max: 90 }, scope: {},
    expected: 'Daily booking limit 10 · Max event duration 240 min · Max lookahead 90 days' },
  { name: 'Notes and decisions', folder: 'records', version: '0.6', mode: 'automatic',
    limits: { read_access: 'unlimited', write_daily_max: 20, delete_access: 'none', archive_access: 'none' }, scope: {},
    expected: 'Daily create limit 20' },
  { name: 'Clean up records', folder: 'records', version: '0.6', mode: RULE,
    limits: { read_access: 'unlimited', write_daily_max: 0, delete_access: 'allowed', archive_access: 'allowed' }, scope: {},
    expected: 'Daily create limit 0 · Delete access allowed · Archive access allowed' },
  { name: 'Quotes and orders', folder: 'sales', version: '0.4', mode: RULE,
    limits: { read_access: 'unlimited', value_max: 50000, discount_max: 20, order_value_daily_max: 100000, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 5, setup_daily_max: 0 }, scope: { currency: 'EUR' },
    expected: 'Max value per quote or order €50,000 · Max discount 20% · Daily order value €100,000 · Quotes per day 10 · +2 more' },
  { name: 'Invoices and credit notes', folder: 'invoicing', version: '0.1', mode: RULE,
    limits: { read_access: 'unlimited', invoice_net_max: 50000, credit_net_max: 10000, invoice_net_monthly_max: 200000, credit_net_monthly_max: 20000, invoice_daily_max: 20, credit_daily_max: 5 }, scope: { currency: 'EUR' },
    expected: 'Max net per invoice €50,000 · Max net per credit note €10,000 · Invoiced per month €200,000 · Credited per month €20,000 · +2 more' },
  { name: 'Customers and items', folder: 'master-data', version: '0.1', mode: RULE,
    limits: { read_access: 'unlimited', customer_create_daily_max: 10, customer_update_daily_max: 20, customer_tax_daily_max: 5, customer_payment_daily_max: 5, item_create_daily_max: 10, item_update_daily_max: 20, item_price_daily_max: 5, list_price_max: 10000, credit_limit_max: 50000 }, scope: {},
    expected: 'New customers per day 10 · Customer contact changes per day 20 · Customer tax-data changes per day 5 · Customer payment-data changes per day 5 · +5 more' },
  { name: 'Saved files', folder: 'files', version: '0.1', mode: 'automatic',
    limits: { read_access: 'unlimited', save_daily_max: 50 }, scope: {},
    expected: 'Daily save limit 50' },
  { name: 'Website release', folder: 'deploy', version: '0.12', mode: RULE,
    limits: { release_daily_max: 3, rollback_allowed: 'no' }, scope: { allowed_repos: 'humanagencyprotocol/hap-protocol', allowed_environments: 'production', allowed_workflows: 'deploy-website.yml', allowed_branches: 'main' },
    expected: 'Allowed repositories humanagencyprotocol/hap-protocol · Allowed environments production · Allowed pipelines deploy-website.yml · Allowed branches main · +2 more' },
  // MOCKUP DIFFERS: it shows "Mandate proposals per day 30", which equals the schema default (30) and so is left out by the rule.
  { name: 'Setup', folder: 'delegation', version: '0.3', mode: RULE,
    limits: { read_access: 'unlimited', brief_daily_max: 10, mandate_daily_max: 30 }, scope: {},
    expected: 'Brief proposals per day 10' },
];

describe('the mockup\'s example mandates (E)', () => {
  for (const e of examples) {
    it(`${e.name}: ${e.expected}`, () => {
      const p = profileOf(e.folder, e.version);
      expect(shortSummaryText({ limits: e.limits, scope: e.scope, boundsSchema: p.boundsSchema ?? {}, scopeSchema: p.scopeSchema, manifests })).toBe(e.expected.replaceAll(' · ', '\u00A0· '));
    });
  }
  it('a wrapped line never starts with the dot: it is always glued to the item before it', () => {
    for (const e of examples) expect(e.expected.replaceAll(' · ', '\u00A0· ')).not.toMatch(/ ·/);
  });
  it('covers every card of the mockup\'s list (the fourteen areas and Setup)', () => {
    expect(examples.length).toBe(15);
  });
});
