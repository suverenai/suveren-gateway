import { describe, it, expect } from 'vitest';
import { isDocumentPreviewBody, shortFingerprint, documentDataUrl, pageCountLabel } from './document-preview';

const VALID = {
  filename: 'invoice-2026-0003.pdf',
  contentType: 'application/pdf',
  contentBase64: 'JVBERi0xLjQK',
  sha256: 'a41f00000000000000000000000000000000000000000000000000009c2e',
  pages: 1,
};

describe('isDocumentPreviewBody', () => {
  it('accepts a well-formed document body, pages included', () => {
    expect(isDocumentPreviewBody(VALID)).toBe(true);
  });

  it('accepts a document body with no pages (get_document has none)', () => {
    const { pages, ...rest } = VALID;
    expect(isDocumentPreviewBody(rest)).toBe(true);
  });

  it('rejects null/non-object', () => {
    expect(isDocumentPreviewBody(null)).toBe(false);
    expect(isDocumentPreviewBody('x')).toBe(false);
    expect(isDocumentPreviewBody(42)).toBe(false);
  });

  it('rejects a missing required field', () => {
    for (const key of ['filename', 'contentType', 'contentBase64', 'sha256'] as const) {
      const { [key]: _omit, ...rest } = VALID;
      expect(isDocumentPreviewBody(rest), key).toBe(false);
    }
  });

  it('rejects an empty-string required field', () => {
    expect(isDocumentPreviewBody({ ...VALID, filename: '' })).toBe(false);
  });

  it('rejects a non-numeric pages', () => {
    expect(isDocumentPreviewBody({ ...VALID, pages: '1' })).toBe(false);
  });

  it('accepts extra fields it does not know about', () => {
    expect(isDocumentPreviewBody({ ...VALID, archivePath: '/secret' })).toBe(true);
  });
});

describe('shortFingerprint', () => {
  it('shows first 4 … last 4 of a long hash', () => {
    expect(shortFingerprint('a41f00000000000000000000000000000000000000000000000000009c2e')).toBe('a41f…9c2e');
  });

  it('returns a short hash unabridged', () => {
    expect(shortFingerprint('abc123')).toBe('abc123');
  });

  it('boundary at exactly 9 characters — unabridged', () => {
    expect(shortFingerprint('123456789')).toBe('123456789');
  });

  it('boundary at 10 characters — abridged', () => {
    expect(shortFingerprint('1234567890')).toBe('1234…7890');
  });
});

describe('documentDataUrl', () => {
  it('builds a data: URL from contentType + contentBase64', () => {
    expect(documentDataUrl({ contentType: 'application/pdf', contentBase64: 'AA==' }))
      .toBe('data:application/pdf;base64,AA==');
  });
});

describe('pageCountLabel', () => {
  it('singular at exactly 1', () => {
    expect(pageCountLabel(1)).toBe('1 page');
  });

  it('plural otherwise', () => {
    expect(pageCountLabel(2)).toBe('2 pages');
    expect(pageCountLabel(0)).toBe('0 pages');
  });

  it('undefined when no page count (get_document never reports one)', () => {
    expect(pageCountLabel(undefined)).toBeUndefined();
  });
});
