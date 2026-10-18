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
import { isAttachmentSourceAllowed, ATTACHMENT_SOURCES_FIELD } from '../src/lib/attachment-policy';

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
