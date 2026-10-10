/**
 * preview-render — the system's "before it runs" read, made readable.
 *
 * Pins: schema titles become labels in the schema's OWN property order (not
 * the result's order); nested arrays/objects become compact rows, never raw
 * JSON; a third-party server's text-only JSON answer is treated as
 * structured; genuinely plain text is shown as text; the field list folds
 * past the limit but a value's own content never does.
 */
import { describe, it, expect } from 'vitest';
import { renderPreviewBody, parseJsonObject, DEFAULT_PREVIEW_FIELD_LIMIT } from './preview-render';
import type { PreviewBody } from './sp-client';

describe('renderPreviewBody — structured results', () => {
  it('labels fields from the schema title, in the schema\'s own property order', () => {
    const body: PreviewBody = {
      structured: { net_total: 480, quote_number: 'Q-0001' },
      outputSchema: {
        properties: {
          quote_number: { title: 'Quote number' },
          net_total: { title: 'Net total' },
        },
      },
    };
    const r = renderPreviewBody(body);
    expect(r.kind).toBe('structured');
    expect(r.fields.map((f) => f.key)).toEqual(['quote_number', 'net_total']);
    expect(r.fields[0]).toMatchObject({ label: 'Quote number', value: 'Q-0001' });
    expect(r.fields[1]).toMatchObject({ label: 'Net total', value: '480' });
  });

  it('falls back to a humanized key when the schema has no title for a field', () => {
    const body: PreviewBody = {
      structured: { discount_pct: 0 },
      outputSchema: { properties: { discount_pct: {} } },
    };
    const r = renderPreviewBody(body);
    expect(r.fields[0].label).toBe('Discount pct');
  });

  it('falls back to the structured result\'s own key order without a schema', () => {
    const body: PreviewBody = { structured: { b: 1, a: 2 } };
    const r = renderPreviewBody(body);
    expect(r.fields.map((f) => f.key)).toEqual(['b', 'a']);
    expect(r.fields.map((f) => f.label)).toEqual(['B', 'A']);
  });

  it('shows a field the schema never declared (never hidden)', () => {
    const body: PreviewBody = {
      structured: { known: 1, surprise: 2 },
      outputSchema: { properties: { known: { title: 'Known' } } },
    };
    const r = renderPreviewBody(body);
    expect(r.fields.map((f) => f.key)).toEqual(['known', 'surprise']);
    expect(r.fields[1].label).toBe('Surprise');
  });

  it('renders null/undefined as an em dash, never "null" or "undefined"', () => {
    const body: PreviewBody = { structured: { notes: null } };
    const r = renderPreviewBody(body);
    expect(r.fields[0].value).toBe('—');
  });

  it('renders a scalar array joined, never one row per primitive', () => {
    const body: PreviewBody = { structured: { tags: ['a', 'b', 'c'] } };
    const r = renderPreviewBody(body);
    expect(r.fields[0].value).toBe('a, b, c');
    expect(r.fields[0].lines).toBeUndefined();
  });

  it('renders an array of objects as compact one-line-per-item rows, never raw JSON', () => {
    const body: PreviewBody = {
      structured: {
        lines: [
          { qty: 4, sku: 'CH-120', unit_price: 120 },
          { qty: 1, sku: 'HP-40', unit_price: 480 },
        ],
      },
    };
    const r = renderPreviewBody(body);
    const row = r.fields[0];
    expect(row.value).toBeUndefined();
    expect(row.lines).toHaveLength(2);
    expect(row.lines![0]).toBe('Qty: 4 · Sku: CH-120 · Unit price: 120');
    expect(row.lines![0]).not.toMatch(/[{}[\]]/);
  });

  it('renders a nested plain object as one compact line, never raw JSON', () => {
    const body: PreviewBody = { structured: { customer: { name: 'Hofer', id: 'cust-1' } } };
    const r = renderPreviewBody(body);
    expect(r.fields[0].value).toBe('Name: Hofer · Id: cust-1');
  });

  it('folds fields past the limit into moreFields, keeping the total count', () => {
    const structured = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, i]));
    const r = renderPreviewBody({ structured });
    expect(r.fields).toHaveLength(DEFAULT_PREVIEW_FIELD_LIMIT);
    expect(r.moreFields).toHaveLength(9 - DEFAULT_PREVIEW_FIELD_LIMIT);
    expect(r.totalFields).toBe(9);
  });

  it('respects a custom limit', () => {
    const structured = { a: 1, b: 2, c: 3 };
    const r = renderPreviewBody({ structured }, 1);
    expect(r.fields).toHaveLength(1);
    expect(r.moreFields).toHaveLength(2);
  });

  it('ignores an empty structured object and falls through to text', () => {
    const r = renderPreviewBody({ structured: {}, text: 'fallback text' });
    expect(r.kind).toBe('text');
    expect(r.text).toBe('fallback text');
  });
});

describe('renderPreviewBody — text answers', () => {
  it('a text answer that parses as a JSON object is treated as structured, with humanized labels (no schema)', () => {
    const body: PreviewBody = { text: '{"quote_number":"Q-0001","net_total":480}' };
    const r = renderPreviewBody(body);
    expect(r.kind).toBe('structured');
    expect(r.fields.map((f) => f.label)).toEqual(['Quote number', 'Net total']);
  });

  it('a text answer that parses as a JSON array is left as plain text', () => {
    const r = renderPreviewBody({ text: '[1,2,3]' });
    expect(r.kind).toBe('text');
    expect(r.text).toBe('[1,2,3]');
  });

  it('a text answer that parses as a bare JSON scalar is left as plain text', () => {
    const r = renderPreviewBody({ text: '480' });
    expect(r.kind).toBe('text');
  });

  it('plain prose is shown as text, never truncated', () => {
    const long = 'Payment link created.\n'.repeat(50);
    const r = renderPreviewBody({ text: long });
    expect(r.kind).toBe('text');
    expect(r.text).toBe(long);
  });

  it('whitespace-only text is treated as empty', () => {
    const r = renderPreviewBody({ text: '   ' });
    expect(r.kind).toBe('empty');
  });
});

describe('renderPreviewBody — empty', () => {
  it('no structured and no text is empty', () => {
    const r = renderPreviewBody({});
    expect(r.kind).toBe('empty');
    expect(r.fields).toEqual([]);
  });

  it('undefined body is empty', () => {
    const r = renderPreviewBody(undefined);
    expect(r.kind).toBe('empty');
  });
});

describe('parseJsonObject', () => {
  it('returns the object for valid JSON object text', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it('returns null for an array', () => {
    expect(parseJsonObject('[1,2]')).toBeNull();
  });
  it('returns null for a scalar', () => {
    expect(parseJsonObject('"hi"')).toBeNull();
  });
  it('returns null for invalid JSON', () => {
    expect(parseJsonObject('not json')).toBeNull();
  });
});
