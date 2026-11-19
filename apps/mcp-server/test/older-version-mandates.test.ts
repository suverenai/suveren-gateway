/**
 * DEC-77: new mandates are only given on the newest shipped version of an area
 * (the control plane's ceremony refuses older ones — apps/control-plane mandate-ceremony.test.ts),
 * but a mandate already given on an OLDER shipped version keeps verifying until it ends.
 * That is what this file holds the Gatekeeper to, with the REAL hap-core `verify` on really
 * signed mandates and the real shipped profiles (it fails, never skips, without them):
 *
 * - a mandate on an older shipped version is approved against that version's own profile;
 * - the profile it was signed under is the one that counts: a mandate whose profile_hash is the
 *   NEWEST version's (or any other profile's) is refused — an Authority Server cannot swap the
 *   profile under a mandate;
 * - the tool-proxy's family match still selects a mandate by area, whatever its version.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import {
  getAllProfiles, clearProfiles, verify, signMandate, encodeMandateBlob, computeBoundsHash, computeScopeHash, computeProfileHash,
  type AgentProfile,
} from '@hap/core';
import { loadProfiles } from '../src/lib/profile-loader';
import { profileMatches } from '../src/lib/tool-proxy';
import { testReceiptKeypair } from './helpers/real-receipt';

const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const kp = testReceiptKeypair();
const OWNER = 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw';

type Field = { required?: boolean; enum?: string[]; format?: string; constraint?: { enforceable?: string[]; requiredFor?: string[]; type?: string } };
type Profile = AgentProfile & { scopeSchema?: { fields: Record<string, Field> } };

beforeAll(() => { loadProfiles(PROFILES_DIR); });
afterAll(() => clearProfiles());

const familyOf = (id: string) => id.replace(/@.*$/, '');
const versionOf = (id: string) => id.split('@')[1] ?? '';

/** [older, newest] for every area that ships more than one version. */
function olderAndNewest(): Array<{ older: Profile; newest: Profile }> {
  const byFamily = new Map<string, Profile[]>();
  const seen = new Set<string>();
  for (const p of getAllProfiles() as Profile[]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    byFamily.set(familyOf(p.id), [...(byFamily.get(familyOf(p.id)) ?? []), p]);
  }
  const out: Array<{ older: Profile; newest: Profile }> = [];
  for (const versions of byFamily.values()) {
    versions.sort((a, b) => versionOf(b.id).localeCompare(versionOf(a.id), undefined, { numeric: true }));
    for (const older of versions.slice(1)) out.push({ older, newest: versions[0] });
  }
  return out;
}

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

/** A mandate under `p` (its profile_hash is `hashOf`, default p's own) and a call it should allow. */
async function attempt(p: Profile, hashOf: Profile = p): Promise<boolean | 'unsignable'> {
  const scope: Record<string, string> = {};
  const execution: Record<string, string | number> = {};
  for (const [k, d] of Object.entries(p.scopeSchema?.fields ?? {})) {
    if (d.required || d.constraint?.requiredFor?.length) { const v = d.enum?.[0] ?? 'probe'; scope[k] = v; execution[k] = v; }
  }
  for (const [k, d] of Object.entries((p as { executionContextSchema?: { fields?: Record<string, { constraint?: { type?: string }; required?: boolean }> } }).executionContextSchema?.fields ?? {})) {
    if (execution[k] === undefined && d.constraint?.type === 'number') execution[k] = 1;
  }
  const actionType = p.boundsSchema?.actionTypes?.[0];
  if (actionType) execution.action_type = actionType;
  const bounds = wideBounds(p);
  let scopeHash: string;
  try { scopeHash = computeScopeHash(scope as never, p); } catch { return 'unsignable'; }
  const now = Math.floor(Date.now() / 1000);
  const blob = await signMandate({
    mandate_id: `older-${p.id}`, version: '0.7', profile_id: p.id,
    bounds_hash: computeBoundsHash(bounds as never, p), scope_hash: scopeHash,
    execution_context_hash: 'sha256:' + 'c'.repeat(64), profile_hash: computeProfileHash(hashOf),
    issuer: kp.issuer, mandate_owners: [{ did: OWNER }], gate_content_hashes: { intent: 'sha256:' + '4'.repeat(64) },
    commitment_mode: 'automatic', issued_at: now, expires_at: now + 3600,
  } as never, kp.privateKeyRaw);
  const result = await verify({ bounds: bounds as never, mandates: [encodeMandateBlob(blob as never)], execution, scope: scope as never }, { trustedIssuers: [kp.issuer] });
  return result.approved;
}

describe('mandates on an older shipped version keep verifying', () => {
  it('the shipped catalog has areas with several versions to test against', () => {
    expect(olderAndNewest().length, `no area with several versions in ${PROFILES_DIR}`).toBeGreaterThan(5);
  });

  it('a mandate on an older version is approved against that version\'s own profile (at least one area is probe-able, and every probe-able one passes)', async () => {
    const approved: string[] = [];
    for (const { older } of olderAndNewest()) {
      const r = await attempt(older);
      if (r === true) approved.push(older.id);
    }
    expect(approved.length, 'no older version could be probed — the probe is broken').toBeGreaterThan(3);
  });

  it('the profile the mandate was signed under counts: the newest version\'s hash on an older mandate is refused', async () => {
    let checked = 0;
    for (const { older, newest } of olderAndNewest()) {
      if ((await attempt(older)) !== true) continue; // only where the control above passes
      if (computeProfileHash(older) === computeProfileHash(newest)) continue;
      expect(await attempt(older, newest), `${older.id} accepted with the hash of ${newest.id}`).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });
});

describe('the tool-proxy selects a mandate by area, whatever its version', () => {
  it('profileMatches', () => {
    expect(profileMatches('github.com/humanagencyprotocol/hap-profiles/email@0.7', 'email')).toBe(true);
    expect(profileMatches('github.com/humanagencyprotocol/hap-profiles/email@0.10', 'email')).toBe(true);
    expect(profileMatches('github.com/humanagencyprotocol/hap-profiles/email@0.7', 'sales')).toBe(false);
  });
});
