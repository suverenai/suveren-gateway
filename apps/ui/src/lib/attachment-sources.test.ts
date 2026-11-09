import { describe, it, expect } from 'vitest';
import {
  attachmentSourceGroups, attachmentSourceLabel, formatAttachmentSources, isAiSuppliedFileName,
  isAttachmentSourceField, joinSources, parseSources, sourceTitle, type SourceManifestLike,
} from './attachment-sources';
import { formatScopeFieldValue } from './scope-labels';
import { profileFieldLines } from './approval-view';
import type { AgentProfile } from '@hap/core';

// Manifest shapes as in the contract: ERP-style archive kinds and a "file" kind with aiSupplied.
const ERP: SourceManifestLike = { id: 'erp', name: 'ERP', documents: {
  'invoice-pdf': { label: 'issued invoice {id}', title: 'Issued invoices', description: 'Finished invoices from the ERP archive' },
  'credit-note-pdf': { label: 'issued credit note {id}' },
} };
const DOCS: SourceManifestLike = { id: 'documents', name: 'Documents', documents: {
  file: { label: 'saved document {id}', aiSupplied: true },
} };
const NO_DOCS: SourceManifestLike = { id: 'crm', name: 'CRM' };

describe('attachment sources', () => {
  it('recognises the field by its format only', () => {
    expect(isAttachmentSourceField({ format: 'connector:kind' })).toBe(true);
    expect(isAttachmentSourceField({ format: 'email' })).toBe(false);
    expect(isAttachmentSourceField(undefined)).toBe(false);
  });

  it('keeps the stored value a comma-separated string', () => {
    expect(parseSources(' erp:invoice-pdf, documents:file ,')).toEqual(['erp:invoice-pdf', 'documents:file']);
    expect(joinSources(['a:b', 'c:d'])).toBe('a:b,c:d');
    expect(joinSources([])).toBe('');
    expect(parseSources(undefined)).toEqual([]);
  });

  it('builds one group per manifest with documents, from the manifests alone', () => {
    const g = attachmentSourceGroups([ERP, NO_DOCS, DOCS], new Set(['erp', 'documents']));
    expect(g.map((x) => x.connectorId)).toEqual(['erp', 'documents']);
    expect(g[0].options.map((o) => o.key)).toEqual(['erp:invoice-pdf', 'erp:credit-note-pdf']);
    expect(g[0].options[0]).toMatchObject({ title: 'Issued invoices', description: 'Finished invoices from the ERP archive' });
    expect(g[0].options[1].title).toBe('Issued credit note'); // derived from the label template
    expect(g[1].options[0]).toMatchObject({ key: 'documents:file', title: 'Saved document' });
  });

  it('marks a connector that is not set up, and never disables on unknown status', () => {
    expect(attachmentSourceGroups([ERP, DOCS], new Set(['erp'])).map((x) => x.setUp)).toEqual([true, false]);
    expect(attachmentSourceGroups([ERP, DOCS], null).map((x) => x.setUp)).toEqual([true, true]);
  });

  it('a new connector appears with no code change', () => {
    const NEW: SourceManifestLike = { id: 'anything', name: 'Anything', documents: { 'some-kind': { label: 'thing {id}' } } };
    expect(attachmentSourceGroups([NEW], new Set(['anything']))[0].options[0]).toMatchObject({ key: 'anything:some-kind', title: 'Thing' });
  });

  it('title falls back to the kind', () => {
    expect(sourceTitle('x-kind', undefined)).toBe('X-kind');
    expect(sourceTitle('k', { label: '{id}' })).toBe('K');
  });

  it('reads sources readably, unknown ones as stored', () => {
    expect(attachmentSourceLabel([ERP, DOCS], 'documents:file')).toBe('Saved document');
    expect(attachmentSourceLabel([ERP], 'gone:thing')).toBe('gone:thing');
    expect(formatAttachmentSources('erp:invoice-pdf,documents:file', [ERP, DOCS])).toBe('Issued invoices, Saved document');
    expect(formatAttachmentSources('', [ERP])).toBe('');
  });

  it('aiSupplied comes from the manifest flag, not from a name', () => {
    expect(isAiSuppliedFileName([ERP, DOCS], 'documents', 'file')).toBe(true);
    expect(isAiSuppliedFileName([ERP, DOCS], 'erp', 'invoice-pdf')).toBe(false);
    expect(isAiSuppliedFileName([ERP], 'documents', 'file')).toBe(false);
    expect(isAiSuppliedFileName(undefined, 'documents', 'file')).toBe(false);
  });

  it('scope displays show the sources readably; other fields are unchanged', () => {
    const field = { format: 'connector:kind' };
    expect(formatScopeFieldValue('allowed_attachment_sources', 'erp:invoice-pdf,documents:file', field, [ERP, DOCS])).toBe('Issued invoices, Saved document');
    expect(formatScopeFieldValue('allowed_attachment_sources', '', field, [ERP])).toBe('None: text only');
    expect(formatScopeFieldValue('allowed_recipients', 'a@b.com, c@d.com', { format: 'email' }, [ERP])).toBe('a@b.com, c@d.com');
  });

  it('the approval card scope lines show the sources readably', () => {
    const profile = { scopeSchema: { keyOrder: ['allowed_attachment_sources'], fields: {
      allowed_attachment_sources: { displayName: 'Allowed attachment sources', format: 'connector:kind' },
    } } } as unknown as AgentProfile;
    const lines = profileFieldLines({ allowed_attachment_sources: 'documents:file' }, profile, 'scope', [DOCS]);
    expect(lines[0].value).toBe('Saved document');
  });
});
