/**
 * UI spec §15.2 — `findSealedAttachment`: looks up a sealed attachment's
 * own connector/kind/id by its SEALED sha256 on a proposal/ticket's own
 * resolved toolArgs. Never trusts a caller-supplied connector/kind/id —
 * see attachment-preview-types.ts's module doc comment.
 */
import { describe, it, expect } from 'vitest';
import { findSealedAttachment, ATTACHMENTS_SEALED_META_KEY } from '../lib/attachment-preview-types';

const SHA = 'a'.repeat(64);
const ATTACHMENT = { connector: 'erp', kind: 'invoice-pdf', id: 'inv-1', filename: 'x.pdf', contentType: 'application/pdf', sha256: SHA, bytes: 100 };

describe('findSealedAttachment', () => {
  it('finds the matching sealed attachment by its sha256', () => {
    const toolArgs = { [ATTACHMENTS_SEALED_META_KEY]: { attachments: [ATTACHMENT], inserts: [] } };
    expect(findSealedAttachment(toolArgs, SHA)).toEqual({ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1', sha256: SHA });
  });

  it('null when no attachment has that sha256', () => {
    const toolArgs = { [ATTACHMENTS_SEALED_META_KEY]: { attachments: [ATTACHMENT], inserts: [] } };
    expect(findSealedAttachment(toolArgs, 'b'.repeat(64))).toBeNull();
  });

  it('null when there is no sealed meta at all', () => {
    expect(findSealedAttachment({ to: ['a@x.com'] }, SHA)).toBeNull();
    expect(findSealedAttachment(null, SHA)).toBeNull();
    expect(findSealedAttachment(undefined, SHA)).toBeNull();
  });

  it('null on a malformed sealed meta — never throws', () => {
    expect(findSealedAttachment({ [ATTACHMENTS_SEALED_META_KEY]: 'oops' }, SHA)).toBeNull();
    expect(findSealedAttachment({ [ATTACHMENTS_SEALED_META_KEY]: { attachments: 'oops' } }, SHA)).toBeNull();
    expect(findSealedAttachment({ [ATTACHMENTS_SEALED_META_KEY]: { attachments: [{ connector: 'erp' }] } }, SHA)).toBeNull();
  });
});
