import { describe, it, expect } from 'vitest';
import {
  extractAttachmentsSealed,
  attachmentCheckEntries,
  humanFileSize,
  ATTACHMENTS_SEALED_META_KEY,
} from './attachment-sealed';

const ATTACHMENT = {
  connector: 'erp', kind: 'invoice-pdf', id: 'inv-1',
  filename: 'Rechnung-2026-0003.pdf', contentType: 'application/pdf',
  sha256: 'a41f00000000000000000000000000000000000000000000000000009c2e', bytes: 49152,
};
const INSERT = { placeholder: '{{link}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1', value: 'https://payment-links.mollie.com/payment/x' };

describe('extractAttachmentsSealed', () => {
  it('extracts a well-formed sealed meta', () => {
    const toolArgs = { to: ['a@x.com'], [ATTACHMENTS_SEALED_META_KEY]: { attachments: [ATTACHMENT], inserts: [INSERT] } };
    expect(extractAttachmentsSealed(toolArgs)).toEqual({ attachments: [ATTACHMENT], inserts: [INSERT] });
  });

  it('returns empty arrays when the key is absent', () => {
    expect(extractAttachmentsSealed({ to: ['a@x.com'] })).toEqual({ attachments: [], inserts: [] });
  });

  it('returns empty arrays for null/undefined toolArgs — never throws', () => {
    expect(extractAttachmentsSealed(null)).toEqual({ attachments: [], inserts: [] });
    expect(extractAttachmentsSealed(undefined)).toEqual({ attachments: [], inserts: [] });
  });

  it('degrades to empty rather than rendering a malformed entry', () => {
    const toolArgs = { [ATTACHMENTS_SEALED_META_KEY]: { attachments: [{ connector: 'erp' }], inserts: 'not-an-array' } };
    expect(extractAttachmentsSealed(toolArgs)).toEqual({ attachments: [], inserts: [] });
  });

  it('never surfaces bytes — the shape has none to begin with', () => {
    const toolArgs = { [ATTACHMENTS_SEALED_META_KEY]: { attachments: [ATTACHMENT], inserts: [] } };
    expect(JSON.stringify(extractAttachmentsSealed(toolArgs))).not.toMatch(/contentBase64/);
  });
});

describe('attachmentCheckEntries', () => {
  it('adds the "attachment from an allowed source" line when an attachment is sealed', () => {
    const toolArgs = { [ATTACHMENTS_SEALED_META_KEY]: { attachments: [ATTACHMENT], inserts: [] } };
    const entries = attachmentCheckEntries(toolArgs);
    expect(entries).toEqual([{ key: 'attachment-source', label: 'attachment from an allowed source', ok: true, valueText: '', limitText: '' }]);
  });

  it('adds nothing when there are no sealed attachments (an insert-only or plain call)', () => {
    expect(attachmentCheckEntries({ [ATTACHMENTS_SEALED_META_KEY]: { attachments: [], inserts: [INSERT] } })).toEqual([]);
    expect(attachmentCheckEntries({ to: ['a@x.com'] })).toEqual([]);
    expect(attachmentCheckEntries(null)).toEqual([]);
  });
});

describe('humanFileSize', () => {
  it('bytes below 1 KB', () => {
    expect(humanFileSize(0)).toBe('0 B');
    expect(humanFileSize(512)).toBe('512 B');
  });

  it('KB range, rounded', () => {
    expect(humanFileSize(49152)).toBe('48 KB');
    expect(humanFileSize(1024)).toBe('1 KB');
  });

  it('MB range, one decimal', () => {
    expect(humanFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('non-finite/negative is shown as a dash, never a crash', () => {
    expect(humanFileSize(NaN)).toBe('—');
    expect(humanFileSize(-5)).toBe('—');
  });
});
