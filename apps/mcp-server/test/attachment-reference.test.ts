/**
 * attachment-reference.ts — shape validation for `{connector, kind, id}` /
 * `{placeholder, connector, kind, id}` references, and the AI-facing schema
 * override that narrows an `attachments`/`insert` argument to those shapes.
 */
import { describe, it, expect } from 'vitest';
import {
  validateDocumentReferences,
  validateInsertReferences,
  withAttachmentAndInsertSchema,
  ATTACHMENT_REFERENCE_SCHEMA,
} from '../src/lib/attachment-reference';

describe('validateDocumentReferences', () => {
  it('accepts a well-formed array of references', () => {
    const result = validateDocumentReferences([{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.refs).toEqual([{ connector: 'erp', kind: 'invoice-pdf', id: 'inv-1' }]);
  });

  it('treats an absent argument as zero references (not an error)', () => {
    const result = validateDocumentReferences(undefined);
    expect(result).toEqual({ ok: true, refs: [] });
  });

  it('refuses a non-array value', () => {
    const result = validateDocumentReferences({ connector: 'erp' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_AN_ARRAY');
  });

  it('refuses an item carrying file bytes instead of a reference', () => {
    const result = validateDocumentReferences([
      { connector: 'erp', kind: 'invoice-pdf', id: 'inv-1', contentBase64: 'AAAA' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('EXTRA_FIELD');
      expect((result.error as { field: string }).field).toBe('contentBase64');
    }
  });

  it('refuses an item missing a required field', () => {
    const result = validateDocumentReferences([{ connector: 'erp', kind: 'invoice-pdf' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MISSING_FIELD');
  });
});

describe('validateInsertReferences', () => {
  it('accepts a well-formed insert reference', () => {
    const result = validateInsertReferences([{ placeholder: '{{x}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1' }]);
    expect(result.ok).toBe(true);
  });

  it('refuses a raw MIME-like blob masquerading as a reference', () => {
    const result = validateInsertReferences([{ placeholder: '{{x}}', connector: 'mollie', kind: 'payment-link', id: 'pl_1', raw: 'abc' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EXTRA_FIELD');
  });
});

describe('withAttachmentAndInsertSchema', () => {
  it('is a no-op when the tool declares neither attachmentsArg nor insertFields', () => {
    const schema = { type: 'object', properties: { to: { type: 'array' } } };
    expect(withAttachmentAndInsertSchema(schema, undefined)).toBe(schema);
    expect(withAttachmentAndInsertSchema(schema, {})).toBe(schema);
  });

  it('adds a reference-only attachments property', () => {
    const schema = { type: 'object', properties: { to: { type: 'array' } } };
    const out = withAttachmentAndInsertSchema(schema, { attachmentsArg: 'attachments' });
    const props = out.properties as Record<string, unknown>;
    expect(props.attachments).toEqual({
      type: 'array',
      description: 'Attachments by reference only — see items.',
      items: ATTACHMENT_REFERENCE_SCHEMA,
    });
    // The item schema never offers a bytes field.
    expect(Object.keys(ATTACHMENT_REFERENCE_SCHEMA.properties)).toEqual(['connector', 'kind', 'id']);
    expect(ATTACHMENT_REFERENCE_SCHEMA.additionalProperties).toBe(false);
  });

  it('adds an insert property when insertFields is declared', () => {
    const schema = { type: 'object', properties: {} };
    const out = withAttachmentAndInsertSchema(schema, { insertFields: ['body'] });
    const props = out.properties as Record<string, unknown>;
    expect(props.insert).toBeDefined();
    expect(props.attachments).toBeUndefined();
  });
});
