/**
 * D6 — every SHIPPED manifest's `category:"read"` tools must reference one
 * of their profile's declared enum ("capability flag") switches, or carry an
 * explicit `readGovernance:"none"` exemption with a written reason. Same
 * pattern as `manifest-preview-shape.test.ts`: one predicate
 * (`uncoveredReadSwitchReason`, read-gate.ts) shared by the loader (refuses
 * the manifest) and this test, so the two can never disagree.
 *
 * This generalizes the gmail.json defect found 2026-10-14: list_messages/
 * get_message/list_drafts/get_draft were `category:"read"` under the email
 * profile (which declares `read_access`) but referenced NO switch at all —
 * hap-core's Gatekeeper deliberately never checks an `enum` bound itself
 * (gatekeeper.ts's 'enum' case), so nothing anywhere enforced `read_access`
 * for those four tools. The fix is a data change (gmail.json now references
 * it); this test is what stops the NEXT connector from shipping the same
 * gap, for any profile with a switch, not just email's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProfile, clearProfiles } from '@hap/core';
import { loadProfiles } from '../src/lib/profile-loader';
import { loadManifests, getAllManifests, getManifest, invalidManifestReadGateReason } from '../src/lib/manifest-loader';
import { classifyEnumSwitches, uncoveredReadSwitchReason } from '../src/lib/read-gate';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');
// Same sibling-checkout convention as deploy-profile.test.ts / content-binding-fields.test.ts:
// CI clones hap-profiles beside suveren-gateway, not inside it.
const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR
  ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');

beforeAll(() => {
  loadProfiles(PROFILES_DIR);
});
afterAll(() => clearProfiles());

describe('classifyEnumSwitches', () => {
  it('classifies email@latest\'s read_access as READ-side', () => {
    const { readSide, writeSide } = classifyEnumSwitches(getProfile('email')?.boundsSchema);
    expect(readSide).toEqual(['read_access']);
    expect(writeSide).toEqual([]);
  });

  it('classifies records@latest\'s delete_access/archive_access as WRITE-side, read_access as READ-side', () => {
    const { readSide, writeSide } = classifyEnumSwitches(getProfile('records')?.boundsSchema);
    expect(readSide).toEqual(['read_access']);
    expect(writeSide.sort()).toEqual(['archive_access', 'delete_access']);
  });

  it('classifies customers@latest\'s export_access as WRITE-side (values {allowed,none}, not {unlimited,none})', () => {
    const { readSide, writeSide } = classifyEnumSwitches(getProfile('customers')?.boundsSchema);
    expect(readSide).toEqual(['read_access']);
    expect(writeSide).toEqual(['export_access']);
  });

  it('calendar/publish/deploy declare no switch at all', () => {
    for (const name of ['calendar', 'publish', 'deploy']) {
      const { readSide, writeSide } = classifyEnumSwitches(getProfile(name)?.boundsSchema);
      expect(readSide, name).toEqual([]);
      expect(writeSide, name).toEqual([]);
    }
  });

  it('charge declares a read switch from 0.7 ("Payments": read_access), none before', () => {
    const { readSide, writeSide } = classifyEnumSwitches(getProfile('charge')?.boundsSchema);
    const v = getProfile('charge')?.version ?? '';
    const from07 = v.localeCompare('0.7', undefined, { numeric: true }) >= 0;
    expect(readSide).toEqual(from07 ? ['read_access'] : []);
    expect(writeSide).toEqual([]);
  });
});

describe('uncoveredReadSwitchReason — the shared predicate', () => {
  const email = () => getProfile('email')?.boundsSchema;

  it('null when every read tool references the switch', () => {
    expect(
      uncoveredReadSwitchReason(
        { list_messages: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' } },
        email(),
      ),
    ).toBeNull();
  });

  it('null for an explicit, reasoned exemption', () => {
    expect(
      uncoveredReadSwitchReason(
        { get_profile: { category: 'read', readGovernance: 'none', readGovernanceReason: 'own identity only' } },
        email(),
      ),
    ).toBeNull();
  });

  it('THE GMAIL DEFECT: a category:"read" tool with a `read` adapter but no boundField is caught', () => {
    expect(
      uncoveredReadSwitchReason(
        { list_messages: { category: 'read', read: { ageField: 'read_age_days' } } },
        email(),
      ),
    ).toMatch(/does not reference one via boundField/);
  });

  it('rejects an unreasoned readGovernance:"none" exemption', () => {
    expect(
      uncoveredReadSwitchReason({ x: { category: 'read', readGovernance: 'none' } }, email()),
    ).toMatch(/needs a written reason/);
  });

  it('rejects requiredValue:"none" (would invert the gate)', () => {
    expect(
      uncoveredReadSwitchReason(
        { list_messages: { category: 'read', boundField: 'read_access', requiredValue: 'none' } },
        email(),
      ),
    ).toMatch(/would invert the gate/);
  });

  it('a non-read override, or a `category:"read"` entry with no override shape, is ignored', () => {
    expect(uncoveredReadSwitchReason({ send_message: { executionMapping: {} } }, email())).toBeNull();
  });

  it('a write-side-only switch is NOT forced onto a read tool unless referenced — but a read tool MAY reference one (crm export_crm)', () => {
    const customers = getProfile('customers')?.boundsSchema;
    // export_crm is category:"read" and references export_access (WRITE-side
    // by this heuristic) — correct and must NOT be flagged.
    expect(
      uncoveredReadSwitchReason(
        {
          find_contacts: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
          export_crm: { category: 'read', boundField: 'export_access', requiredValue: 'allowed' },
        },
        customers,
      ),
    ).toBeNull();
  });

  it('no switches at all (e.g. calendar) ⇒ always null, whatever the read tools declare', () => {
    const calendar = getProfile('calendar')?.boundsSchema;
    expect(uncoveredReadSwitchReason({ list_events: { category: 'read' } }, calendar)).toBeNull();
  });
});

describe('loadManifests refuses a shipped manifest whose read tools are uncovered', () => {
  it('a category:"read" tool under a profile with a switch, declaring neither boundField nor readGovernance, refuses the WHOLE manifest', () => {
    // Reuses the exact real "email" profile already registered above —
    // proves the loader-level wiring (invalidManifestReadGateReason), not
    // just the pure predicate already covered above. Same temp-dir pattern
    // as manifest-preview-shape.test.ts's loadManifests refusal test.
    const tmp = mkdtempSync(join(tmpdir(), 'hap-bad-readgate-manifest-'));
    try {
      mkdirSync(join(tmp, 'bad'));
      writeFileSync(join(tmp, 'index.json'), JSON.stringify({ integrations: { bad: 'bad/manifest.json' } }));
      writeFileSync(
        join(tmp, 'bad/manifest.json'),
        JSON.stringify({
          id: 'bad', name: 'Bad', version: '1', profile: 'email',
          mcp: { command: 'node', args: [] },
          credentials: { fields: [], envMapping: {} },
          oauth: null,
          toolGating: {
            default: { executionMapping: {} },
            overrides: { list_messages: { category: 'read', read: { ageField: 'read_age_days' } } },
          },
        }),
      );
      const loaded = loadManifests(tmp);
      expect(loaded).toBe(0);
      expect(getManifest('bad')).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── Lint over the REAL shipped manifests — every one, with its REAL profile ──

describe('real manifests — read-gate coverage (D6)', () => {
  const index = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'index.json'), 'utf8')) as { integrations: Record<string, string> };
  const ids = Object.keys(index.integrations);

  it('finds manifests to lint (guards against a broken path)', () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it('every manifest the index lists actually loaded (none silently refused)', () => {
    loadManifests(MANIFESTS_DIR);
    for (const id of ids) {
      expect(getManifest(id), id).toBeDefined();
    }
    expect(getAllManifests().length).toBe(ids.length);
  });

  for (const id of ids) {
    it(`${id}: every category:"read" tool covers its profile's switch(es), or is exempted with a reason`, () => {
      const manifestPath = join(MANIFESTS_DIR, index.integrations[id]);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { profile: string; toolGating: { overrides?: Record<string, unknown> } };
      // Resolve the profile the SAME way the running gateway does —
      // getProfile(manifest.profile) after loadProfiles() has registered
      // every version, last-in-file-order (= latest) wins for the short name.
      expect(invalidManifestReadGateReason(manifest)).toBeNull();
    });
  }

  it('gmail.json (email): list_messages/get_message/list_drafts/get_draft/get_attachment all reference read_access — the fixed defect', () => {
    const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'gmail.json'), 'utf8')) as { toolGating: { overrides: Record<string, { boundField?: string; requiredValue?: string }> } };
    for (const tool of ['list_messages', 'get_message', 'list_drafts', 'get_draft', 'get_attachment']) {
      expect(manifest.toolGating.overrides[tool].boundField, tool).toBe('read_access');
      expect(manifest.toolGating.overrides[tool].requiredValue, tool).toBe('unlimited');
    }
  });

  it('crm.json (customers): find_contacts references read_access, export_crm references export_access (write-side, correctly NOT read_access)', () => {
    const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'crm.json'), 'utf8')) as { toolGating: { overrides: Record<string, { boundField?: string }> } };
    expect(manifest.toolGating.overrides.find_contacts.boundField).toBe('read_access');
    expect(manifest.toolGating.overrides.export_crm.boundField).toBe('export_access');
  });

  it('records.json (records): delete_record/archive_record are write overrides (not category:"read") referencing their own switches — D6 does not require them to also reference read_access', () => {
    const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'records.json'), 'utf8')) as { toolGating: { overrides: Record<string, { category?: string; boundField?: string }> } };
    expect(manifest.toolGating.overrides.delete_record.category).toBeUndefined();
    expect(manifest.toolGating.overrides.delete_record.boundField).toBe('delete_access');
    expect(manifest.toolGating.overrides.archive_record.boundField).toBe('archive_access');
  });
});
