/**
 * attachment-policy.ts against the REAL email/0.9 profile, loaded the normal
 * way (SUVEREN_PROFILES_DIR, else the sibling hap-profiles checkout CI
 * provides). It FAILS — never skips — when email@0.9 is missing: a silent
 * skip would be a fake green.
 *
 * Proves that:
 *  - a mandate on email@0.9 that LISTS the source in its own
 *    allowed_attachment_sources scope value is allowed;
 *  - one that does not list it, or sets an empty/absent value, is refused;
 *  - a mandate on an OLDER email profile (<=0.8, no such field) is refused
 *    regardless of its context value (never declares the field at all).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { getProfile, clearProfiles } from '@hap/core';
import { loadProfiles } from '../src/lib/profile-loader';
import { isAttachmentSourceAllowed, candidatesAllowingAttachments, ATTACHMENT_SOURCES_FIELD } from '../src/lib/attachment-policy';

const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR
  ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');

beforeAll(() => {
  loadProfiles(PROFILES_DIR);
  expect(getProfile('github.com/humanagencyprotocol/hap-profiles/email@0.9'), `email@0.9 not found in ${PROFILES_DIR}`).toBeTruthy();
});

afterAll(() => clearProfiles());

describe('email@0.9 — allowed_attachment_sources (real profile)', () => {
  it('email@0.9 is loaded', () => {
    expect(true).toBe(true);
  });

  it('the short name "email" resolves to 0.9 in this test\'s own profile registry', () => {
    const profile = getProfile('email');
    expect(profile?.version).toBe('0.9');
  });

  it('declares allowed_attachment_sources in its scope schema', () => {
    const profile = getProfile('email');
    expect(profile?.scopeSchema?.fields?.[ATTACHMENT_SOURCES_FIELD]).toBeDefined();
  });

  it('allows a source the mandate explicitly lists', () => {
    const profile = getProfile('email');
    const result = isAttachmentSourceAllowed('email', profile, 'erp:invoice-pdf,erp:credit-note-pdf', { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(true);
  });

  it('refuses a source the mandate does not list', () => {
    const profile = getProfile('email');
    const result = isAttachmentSourceAllowed('email', profile, 'erp:credit-note-pdf', { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(false);
  });

  it('refuses when the mandate sets an EMPTY allowed_attachment_sources value', () => {
    const profile = getProfile('email');
    const result = isAttachmentSourceAllowed('email', profile, '', { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(false);
  });

  it('refuses when the mandate sets no value at all (undefined)', () => {
    const profile = getProfile('email');
    const result = isAttachmentSourceAllowed('email', profile, undefined, { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(false);
  });

  it('refuses regardless of context value on an OLDER (pre-0.9) email profile', () => {
    const older = getProfile('github.com/humanagencyprotocol/hap-profiles/email@0.8');
    expect(older).toBeTruthy();
    const result = isAttachmentSourceAllowed('email@0.8', older, 'erp:invoice-pdf', { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(ATTACHMENT_SOURCES_FIELD);
  });
});

describe('several email mandates: the one that allows the attachment is chosen (2026-10-18, first real invoice email)', () => {
  const P = 'github.com/humanagencyprotocol/hap-profiles';
  const old1 = { id: 'a', profileId: `${P}/email@0.8`, context: { allowed_domains: 'sublin.app' } };
  const old2 = { id: 'b', profileId: `${P}/email@0.8`, context: {} };
  const new9 = { id: 'c', profileId: `${P}/email@0.9`, context: { allowed_domains: 'sublin.app', [ATTACHMENT_SOURCES_FIELD]: 'erp:invoice-pdf' } };
  const ref = { connector: 'erp', kind: 'invoice-pdf' };

  it('two email@0.8 mandates and one email@0.9 that lists the source → only the 0.9 one remains', () => {
    const r = candidatesAllowingAttachments([old1, old2, new9], [ref], (id) => getProfile(id) as never);
    expect(r.allowed.map((c) => c.id)).toEqual(['c']);
    expect(r.refusal).toBeUndefined();
  });

  it('none allows it → empty, with a reason', () => {
    const r = candidatesAllowingAttachments([old1, old2], [ref], (id) => getProfile(id) as never);
    expect(r.allowed).toEqual([]);
    expect(r.refusal).toMatch(/allowed_attachment_sources/);
  });

  it('no attachments → every candidate stays', () => {
    expect(candidatesAllowingAttachments([old1, new9], [], (id) => getProfile(id) as never).allowed).toHaveLength(2);
  });
});

