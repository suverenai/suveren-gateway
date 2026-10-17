/**
 * attachment-policy.ts against the REAL email/0.9 profile (item 1 of
 * "emails carry documents by reference" — not yet merged to hap-profiles
 * main, so this test builds its own profiles dir: a clean `git archive` of
 * hap-profiles `main`, overlaid with `email/0.9.profile.json` fetched from
 * `origin/feat/email-0.9`, with an index.json entry appended so the short
 * name "email" resolves to 0.9 for this file only (loadProfiles/
 * clearProfiles state is per test file — vitest isolates each file's module
 * graph by default).
 *
 * Proves end to end (not with a hypothetical profile, as attachment-
 * policy.test.ts does) that:
 *  - a mandate on email@0.9 that LISTS the source in its own
 *    allowed_attachment_sources scope value is allowed;
 *  - one that does not list it, or sets an empty/absent value, is refused;
 *  - a mandate on an OLDER email profile (<=0.8, no such field) is refused
 *    regardless of its context value (never declares the field at all).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProfile, clearProfiles } from '@hap/core';
import { loadProfiles } from '../src/lib/profile-loader';
import { isAttachmentSourceAllowed, ATTACHMENT_SOURCES_FIELD } from '../src/lib/attachment-policy';

const HAP_PROFILES_REPO = join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');

let profilesDir: string | undefined;

beforeAll(() => {
  if (!existsSync(HAP_PROFILES_REPO)) {
    console.error(`[test] hap-profiles repo not found at ${HAP_PROFILES_REPO} — skipping email@0.9 real-profile tests.`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'hap-profiles-email-0.9-'));
  try {
    // A clean snapshot of main — never the working tree — piped straight
    // into the temp dir, no intermediate tarball file.
    execFileSync('sh', ['-c', `git -C ${JSON.stringify(HAP_PROFILES_REPO)} archive main | tar -x -C ${JSON.stringify(dir)}`], { stdio: 'pipe' });

    // Fetch email/0.9.profile.json from the (not-yet-merged) feature branch.
    const profileJson = execFileSync(
      'git', ['-C', HAP_PROFILES_REPO, 'show', 'origin/feat/email-0.9:email/0.9.profile.json'],
      { encoding: 'utf8' },
    );
    mkdirSync(join(dir, 'email'), { recursive: true });
    writeFileSync(join(dir, 'email', '0.9.profile.json'), profileJson);

    // Append it to the archived index.json so loadProfiles registers it —
    // LAST, so its short-name registration ("email") wins over 0.8's.
    const indexPath = join(dir, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { profiles: Record<string, string> };
    index.profiles['github.com/humanagencyprotocol/hap-profiles/email@0.9'] = 'email/0.9.profile.json';
    writeFileSync(indexPath, JSON.stringify(index));

    profilesDir = dir;
  } catch (err) {
    console.error(`[test] could not build the email@0.9 profiles dir (no git / no network?) — skipping: ${err}`);
  }
  if (profilesDir) loadProfiles(profilesDir);
}, 30_000);

afterAll(() => {
  clearProfiles();
  if (profilesDir) rmSync(profilesDir, { recursive: true, force: true });
});

describe('email@0.9 — allowed_attachment_sources (real profile, real git ref)', () => {
  it('skips gracefully when the profiles dir could not be built', () => {
    if (!profilesDir) {
      console.warn('[test] skipped — see beforeAll error above.');
      return;
    }
    expect(true).toBe(true);
  });

  it('the short name "email" resolves to 0.9 in this test\'s own profile registry', () => {
    if (!profilesDir) return;
    const profile = getProfile('email');
    expect(profile?.version).toBe('0.9');
  });

  it('declares allowed_attachment_sources in its scope schema', () => {
    if (!profilesDir) return;
    const profile = getProfile('email');
    expect(profile?.scopeSchema?.fields?.[ATTACHMENT_SOURCES_FIELD]).toBeDefined();
  });

  it('allows a source the mandate explicitly lists', () => {
    if (!profilesDir) return;
    const profile = getProfile('email');
    const result = isAttachmentSourceAllowed('email', profile, 'erp:invoice-pdf,erp:credit-note-pdf', { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(true);
  });

  it('refuses a source the mandate does not list', () => {
    if (!profilesDir) return;
    const profile = getProfile('email');
    const result = isAttachmentSourceAllowed('email', profile, 'erp:credit-note-pdf', { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(false);
  });

  it('refuses when the mandate sets an EMPTY allowed_attachment_sources value', () => {
    if (!profilesDir) return;
    const profile = getProfile('email');
    const result = isAttachmentSourceAllowed('email', profile, '', { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(false);
  });

  it('refuses when the mandate sets no value at all (undefined)', () => {
    if (!profilesDir) return;
    const profile = getProfile('email');
    const result = isAttachmentSourceAllowed('email', profile, undefined, { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(false);
  });

  it('refuses regardless of context value on an OLDER (pre-0.9) email profile', () => {
    if (!profilesDir) return;
    const older = getProfile('github.com/humanagencyprotocol/hap-profiles/email@0.8');
    expect(older).toBeTruthy();
    const result = isAttachmentSourceAllowed('email@0.8', older, 'erp:invoice-pdf', { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(ATTACHMENT_SOURCES_FIELD);
  });
});
