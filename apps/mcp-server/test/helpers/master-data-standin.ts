/**
 * TEMPORARY — erp.json maps its customer and catalogue writes to the
 * `master-data` area (ERP local-production contract §12 D4). The real profile
 * (github.com/humanagencyprotocol/hap-profiles/master-data@0.1) is being
 * written in hap-profiles and is not on `main` yet, and a manifest whose
 * override names an unknown profile is refused at load
 * (`invalidManifestOverrideProfilesReason`). Tests that load the REAL
 * profiles call this right after `loadProfiles`: it registers the fixture
 * copy ONLY when the real profile is absent, so the moment the real one is on
 * main it is the one under test. The fixture is a byte copy of
 * master-data/0.1.profile.json from hap-profiles PR #20 (commit 006cd25).
 *
 * Delete this helper and test/fixtures/master-data-standin/ once
 * master-data@0.1 is merged in hap-profiles.
 */
import { join } from 'node:path';
import { getProfile } from '@hap/core';
import { loadProfiles } from '../../src/lib/profile-loader';

export function ensureMasterDataProfile(): void {
  if (getProfile('master-data')) return;
  loadProfiles(join(import.meta.dirname, '..', 'fixtures', 'master-data-standin'));
}
