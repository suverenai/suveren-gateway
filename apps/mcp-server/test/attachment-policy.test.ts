/**
 * attachment-policy.ts — "which document sources/kinds a mandate may
 * attach" (suveren-invoicing-plan.md §6, item 4). No shipped profile
 * declares this field yet, so the safe default is a blanket refusal; this
 * is tested against both today's REAL email profile (always refuses) and a
 * hypothetical profile that DOES declare the field, to prove the mechanism
 * is generic and will activate the moment hap-profiles adds it — without
 * editing hap-profiles here.
 */
import { describe, it, expect } from 'vitest';
import { getProfile } from '@hap/core';
import {
  isAttachmentSourceAllowed,
  attachmentSourcesFieldDeclared,
  ATTACHMENT_SOURCES_FIELD,
} from '../src/lib/attachment-policy';

describe('attachmentSourcesFieldDeclared', () => {
  it('is false for the real, shipped email profile (checked against hap-profiles)', () => {
    const profile = getProfile('email');
    expect(attachmentSourcesFieldDeclared(profile as unknown as { scopeSchema?: { fields?: Record<string, unknown> } })).toBe(false);
  });

  it('is false when no profile is given at all', () => {
    expect(attachmentSourcesFieldDeclared(undefined)).toBe(false);
  });

  it('is true for a hypothetical profile that declares the field', () => {
    const hypothetical = { scopeSchema: { fields: { [ATTACHMENT_SOURCES_FIELD]: { type: 'string' } } } };
    expect(attachmentSourcesFieldDeclared(hypothetical)).toBe(true);
  });
});

describe('isAttachmentSourceAllowed', () => {
  it('refuses by default against the real email profile, regardless of the reference', () => {
    const profile = getProfile('email');
    const result = isAttachmentSourceAllowed('email', profile as unknown as { scopeSchema?: { fields?: Record<string, unknown> } }, 'erp:invoice-pdf', { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(ATTACHMENT_SOURCES_FIELD);
  });

  it('refuses when the profile declares the field but the mandate value does not list the source', () => {
    const hypothetical = { scopeSchema: { fields: { [ATTACHMENT_SOURCES_FIELD]: { type: 'string' } } } };
    const result = isAttachmentSourceAllowed('email', hypothetical, 'erp:credit-note-pdf', { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(false);
  });

  it('allows when the profile declares the field and the mandate value lists exactly this source', () => {
    const hypothetical = { scopeSchema: { fields: { [ATTACHMENT_SOURCES_FIELD]: { type: 'string' } } } };
    const result = isAttachmentSourceAllowed('email', hypothetical, 'erp:invoice-pdf, erp:credit-note-pdf', { connector: 'erp', kind: 'invoice-pdf' });
    expect(result.allowed).toBe(true);
  });
});
