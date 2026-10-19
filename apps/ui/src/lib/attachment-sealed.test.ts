import { describe, it, expect } from 'vitest';
import {
  extractAttachmentsSealed,
  attachmentCheckEntries,
  humanFileSize,
  documentLabel,
  attachmentSameFileCheck,
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

describe('documentLabel', () => {
  const MANIFESTS = [{ id: 'erp', documents: { 'invoice-pdf': { label: 'issued invoice {id}' }, 'credit-note-pdf': {} } }];

  it('substitutes {id} into the declared label template', () => {
    expect(documentLabel(MANIFESTS, 'erp', 'invoice-pdf', '2026-0003')).toBe('issued invoice 2026-0003');
  });

  it('substitutes every occurrence of {id}, not just the first', () => {
    const manifests = [{ id: 'erp', documents: { x: { label: '{id} ({id})' } } }];
    expect(documentLabel(manifests, 'erp', 'x', '7')).toBe('7 (7)');
  });

  it('undefined when the document kind declares no label', () => {
    expect(documentLabel(MANIFESTS, 'erp', 'credit-note-pdf', 'cn-1')).toBeUndefined();
  });

  it('undefined when the document kind is not declared at all', () => {
    expect(documentLabel(MANIFESTS, 'erp', 'not-a-kind', 'x')).toBeUndefined();
  });

  it('undefined when the connector itself is not in the manifest list', () => {
    expect(documentLabel(MANIFESTS, 'not-a-connector', 'invoice-pdf', 'x')).toBeUndefined();
  });

  it('undefined when manifests is undefined — never throws', () => {
    expect(documentLabel(undefined, 'erp', 'invoice-pdf', 'x')).toBeUndefined();
  });
});

describe('attachmentSameFileCheck', () => {
  const LABEL = 'issued invoice 2026-0003';

  it('null while the label is unknown (no document kind declared)', () => {
    expect(attachmentSameFileCheck(undefined, { status: 'ok', filename: 'x', contentType: 'application/pdf', contentBase64: '', sha256: 'a', bytes: 1 })).toBeNull();
  });

  it('null while the preview fetch is still loading or hasn\'t started', () => {
    expect(attachmentSameFileCheck(LABEL, 'loading')).toBeNull();
    expect(attachmentSameFileCheck(LABEL, undefined)).toBeNull();
  });

  it('a passing check — "same file as <label>" — when the preview matched', () => {
    expect(attachmentSameFileCheck(LABEL, { status: 'ok', filename: 'x', contentType: 'application/pdf', contentBase64: '', sha256: 'a', bytes: 1 }))
      .toEqual({ key: 'attachment-same-file', label: `same file as ${LABEL}`, ok: true, valueText: '', limitText: '' });
  });

  it('a FAILED check — the only red, bold entry — when the preview came back "changed"', () => {
    expect(attachmentSameFileCheck(LABEL, { status: 'changed', message: 'x' }))
      .toEqual({ key: 'attachment-same-file', label: 'attachment changed since it was sealed', ok: false, valueText: '', limitText: '' });
  });

  it('null for unavailable/not_found/error — nothing positive or negative to assert', () => {
    expect(attachmentSameFileCheck(LABEL, { status: 'unavailable', message: 'x' })).toBeNull();
    expect(attachmentSameFileCheck(LABEL, { status: 'not_found', message: 'x' })).toBeNull();
    expect(attachmentSameFileCheck(LABEL, { status: 'error', message: 'x' })).toBeNull();
  });
});
