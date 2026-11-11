/**
 * What an empty list allows: the change card's More/Less must say exactly what the
 * gateway enforces. For every list scope field of every shipped profile this runs
 * the REAL enforcement — hap-core's Gatekeeper `verify` on a really signed mandate,
 * plus attachment-policy.ts where tool-proxy.ts applies it — and compares it with
 * @hap/core/scope-rules (`emptyScopeMeans`) and with the tag `computeMandateDiff`
 * gives. A field nobody wrote a rule for is still covered: the loop reads the
 * profiles, not a list in this file. It FAILS, never skips, without profiles.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import {
  getAllProfiles, clearProfiles, verify, signMandate, encodeMandateBlob, computeBoundsHash, computeScopeHash, computeProfileHash,
  type AgentProfile,
} from '@hap/core';
import { computeMandateDiff, type ChangeProfile } from '@hap/core/mandate-change';
import { emptyScopeMeans, isDocumentSourcesField } from '@hap/core/scope-rules';
import { loadProfiles } from '../src/lib/profile-loader';
import { candidatesAllowingAttachments } from '../src/lib/attachment-policy';
import { testReceiptKeypair } from './helpers/real-receipt';

const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const kp = testReceiptKeypair();
const OWNER = 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw';

type Field = { required?: boolean; enum?: string[]; constraint?: { enforceable?: string[]; requiredFor?: string[] }; format?: string };
type Profile = AgentProfile & { scopeSchema?: { keyOrder?: string[]; fields: Record<string, Field> } };

beforeAll(() => { loadProfiles(PROFILES_DIR); });
afterAll(() => clearProfiles());

/** Every list (subset) scope field of every loaded profile. */
function listFields(): Array<{ profile: Profile; field: string; def: Field }> {
  const out: Array<{ profile: Profile; field: string; def: Field }> = [];
  const ids = new Set<string>();
  for (const p of getAllProfiles() as Profile[]) {
    if (ids.has(p.id)) continue;
    ids.add(p.id);
    for (const [field, def] of Object.entries(p.scopeSchema?.fields ?? {})) {
      if (def.constraint?.enforceable?.includes('subset')) out.push({ profile: p, field, def });
    }
  }
  return out;
}

/** Bounds that allow everything the profile declares: only the scope can refuse. */
function wideBounds(p: Profile): Record<string, string | number> {
  const b: Record<string, string | number> = { profile: p.id };
  for (const [key, def] of Object.entries(p.boundsSchema?.fields ?? {})) {
    if (key === 'profile') continue;
    const bt = (def as { boundType?: { kind?: string; values?: string[] } }).boundType;
    if (bt?.kind === 'enum') b[key] = bt.values?.includes('unlimited') ? 'unlimited' : bt.values?.at(-1) ?? '';
    else b[key] = 1_000_000;
  }
  return b;
}

/** A value the field accepts: an enum member, a document source, or a plain token. */
function probeValue(def: Field): string {
  if (def.enum?.length) return def.enum[0];
  if (def.format === 'connector:kind') return 'files:file';
  if (def.format === 'email') return 'probe@example.com';
  if (def.format === 'domain') return 'example.com';
  return 'probe';
}

/**
 * Does the gateway let a call carrying `value` in `field` through a mandate whose scope holds
 * `scopeValue`? 'unsignable' when no mandate can hold that scope (a required field left empty).
 */
async function enforcementAllows(p: Profile, field: string, def: Field, scopeValue: string | undefined, value: string): Promise<boolean | 'unsignable'> {
  const scope: Record<string, string> = {};
  const execution: Record<string, string | number> = {};
  // The other scope fields stay out of the way: an enum one is set to what the call carries.
  for (const [k, d] of Object.entries(p.scopeSchema?.fields ?? {})) {
    if (k === field) continue;
    if (d.constraint?.enforceable?.includes('enum') && d.enum?.length) { scope[k] = d.enum[0]; execution[k] = d.enum[0]; }
    else if (d.required) { const x = probeValue(d); scope[k] = x; execution[k] = x; }
  }
  if (scopeValue !== undefined) scope[field] = scopeValue;
  for (const [k, d] of Object.entries((p as { executionContextSchema?: { fields?: Record<string, { constraint?: { type?: string } }> } }).executionContextSchema?.fields ?? {})) {
    if (execution[k] === undefined && d.constraint?.type === 'number') execution[k] = 1;
  }
  const actionType = def.constraint?.requiredFor?.[0] ?? p.boundsSchema?.actionTypes?.[0];
  if (actionType) execution.action_type = actionType;
  execution[field] = value;

  const bounds = wideBounds(p);
  let scopeHash: string;
  try { scopeHash = computeScopeHash(scope as never, p); } catch { return 'unsignable'; }
  const now = Math.floor(Date.now() / 1000);
  const blob = await signMandate({
    mandate_id: `probe-${p.id}-${field}`, version: '0.7', profile_id: p.id,
    bounds_hash: computeBoundsHash(bounds as never, p),
    scope_hash: scopeHash,
    execution_context_hash: 'sha256:' + 'c'.repeat(64), profile_hash: computeProfileHash(p),
    issuer: kp.issuer, mandate_owners: [{ did: OWNER }], gate_content_hashes: { intent: 'sha256:' + '4'.repeat(64) },
    commitment_mode: 'automatic', issued_at: now, expires_at: now + 3600,
  } as never, kp.privateKeyRaw);
  const result = await verify({ bounds: bounds as never, mandates: [encodeMandateBlob(blob as never)], execution, scope: scope as never }, { trustedIssuers: [kp.issuer] });
  if (!result.approved) return false;
  // tool-proxy.ts narrows the mandates by their attachment sources before selection.
  if (isDocumentSourcesField(def)) {
    const [connector, kind] = value.split(':');
    const { allowed } = candidatesAllowingAttachments([{ profileId: p.id, context: scope }], [{ connector, kind }], () => p as never);
    return allowed.length > 0;
  }
  return true;
}

const side = (p: Profile, scope: Record<string, string>) => ({
  profile: p as unknown as ChangeProfile, bounds: wideBounds(p), scope, intent: 'Why.', mode: 'review', expiresAt: 1000,
});

describe('an empty list scope field allows what the gateway enforces, field by field', () => {
  it('the shipped profiles are loaded and declare list fields, among them the attachment sources', () => {
    const fields = listFields();
    expect(fields.length, `no list scope fields in ${PROFILES_DIR}`).toBeGreaterThan(5);
    expect(fields.some((f) => isDocumentSourcesField(f.def))).toBe(true);
  });

  it('for every list field: the rule, the enforcement and the change card agree', async () => {
    const seen: string[] = [];
    for (const { profile: p, field, def } of listFields()) {
      const name = `${p.id} ${field}`;
      const v = probeValue(def);
      // The probe reaches the scope check: a mandate listing the value lets the call through.
      expect(await enforcementAllows(p, field, def, v, v), `${name}: a mandate listing "${v}" is refused — the probe is broken`).toBe(true);
      // And the scope check is live: a mandate listing only another value refuses it.
      const other = def.enum ? def.enum.find((x) => x !== v) : 'zz-other-value';
      if (other) expect(await enforcementAllows(p, field, def, other, v), `${name}: another value is not refused`).toBe(false);

      const emptyResult = await enforcementAllows(p, field, def, '', v);
      const absentResult = await enforcementAllows(p, field, def, undefined, v);
      if (emptyResult === 'unsignable' && absentResult === 'unsignable') {
        // A required field: no mandate can leave it empty, so no card can show it empty.
        seen.push(`${name}=required (never empty)`);
        continue;
      }
      const emptyAllows = emptyResult === true || (emptyResult === 'unsignable' && absentResult === true);
      if (emptyResult !== 'unsignable' && absentResult !== 'unsignable') expect(absentResult, `${name}: empty and absent differ`).toBe(emptyResult);
      expect(emptyScopeMeans(def), name).toBe(emptyAllows ? 'anything' : 'nothing');

      // The card: adding the value to an empty list, and emptying a list that held it.
      const add = computeMandateDiff({ before: side(p, {}), after: side(p, { [field]: v }) }).rows.find((r) => r.field === field);
      const drop = computeMandateDiff({ before: side(p, { [field]: v }), after: side(p, {}) }).rows.find((r) => r.field === field);
      expect(add?.tag, `${name}: adding "${v}" to an empty list`).toBe(emptyAllows ? 'Less' : 'More');
      expect(drop?.tag, `${name}: emptying the list`).toBe(emptyAllows ? 'More' : 'Less');
      seen.push(`${name}=${emptyAllows ? 'anything' : 'nothing'}`);
    }
    // Print what was proven, so a reader sees every field and its rule.
    console.log(`[scope-empty-rule] ${seen.length} fields:\n  ${seen.join('\n  ')}`);
  }, 60_000);
});
