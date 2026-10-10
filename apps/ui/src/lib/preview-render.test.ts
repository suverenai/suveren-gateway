/**
 * preview-render — the system's "before it runs" read, made readable.
 *
 * Pins: schema titles become labels in the schema's OWN property order (not
 * the result's order); nested arrays/objects become compact rows, never raw
 * JSON; a third-party server's text-only JSON answer is treated as
 * structured; genuinely plain text is shown as text; "All fields (n)" folds
 * the complete field list but a value's own content never does.
 *
 * Real-world follow-up (2026-10-10): a real erp get_quote answer has 15
 * fields. "First 6 in schema order" buried the ones that matter (lines, net
 * total) under "All fields" while surfacing id/status/currency, and the
 * stale-version compare showed the SAME first-6 on both sides — identical,
 * because the actual change (the lines) was never in view. Fixed by:
 *  (a) an optional manifest `fields` allow-list, shown first regardless of
 *      value;
 *  (b) without one, every field that HAS a value, no fixed count;
 *  (c) the stale compare shows ONLY what differs, not a field slice.
 */
import { describe, it, expect } from 'vitest';
import { renderPreviewBody, parseJsonObject, allPreviewFields, diffPreviewBodies } from './preview-render';
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

  it('ignores an empty structured object and falls through to text', () => {
    const r = renderPreviewBody({ structured: {}, text: 'fallback text' });
    expect(r.kind).toBe('text');
    expect(r.text).toBe('fallback text');
  });
});

describe('renderPreviewBody — nested schema narrows array-item / object fields (2026-10-10 follow-up)', () => {
  it('an array field with declared items.properties shows ONLY those properties, in declared order, titled', () => {
    const body: PreviewBody = {
      structured: {
        lines: [
          { id: '9c3c...', quote_id: '994a...', item_id: 'item-1', qty: 4, sku: 'CH-120' },
        ],
      },
      outputSchema: {
        properties: {
          lines: {
            items: {
              properties: {
                qty: { title: 'Qty' },
                sku: { title: 'SKU' },
              },
            },
          },
        },
      },
    };
    const r = renderPreviewBody(body);
    expect(r.fields[0].lines![0]).toBe('Qty: 4 · SKU: CH-120');
    expect(r.fields[0].lines![0]).not.toContain('9c3c');
    expect(r.fields[0].lines![0]).not.toContain('994a');
    expect(r.fields[0].lines![0]).not.toContain('item-1');
  });

  it('a nested object field with declared properties shows ONLY those, titled, in declared order', () => {
    const body: PreviewBody = {
      structured: { customer: { id: 'cust-internal-1', name: 'Hofer', crm_sync_token: 'xyz' } },
      outputSchema: { properties: { customer: { properties: { name: { title: 'Customer' } } } } },
    };
    const r = renderPreviewBody(body);
    expect(r.fields[0].value).toBe('Customer: Hofer');
    expect(r.fields[0].value).not.toContain('cust-internal-1');
    expect(r.fields[0].value).not.toContain('xyz');
  });

  it('without a declared schema for that field, every one of the object\'s own keys still shows (today\'s behaviour)', () => {
    const body: PreviewBody = {
      structured: { customer: { id: 'cust-1', name: 'Hofer' } },
      outputSchema: { properties: {} }, // schema present, but says nothing about `customer`
    };
    const r = renderPreviewBody(body);
    expect(r.fields[0].value).toBe('Id: cust-1 · Name: Hofer');
  });

  it('without ANY schema at all, every key still shows (today\'s behaviour, unchanged)', () => {
    const body: PreviewBody = { structured: { customer: { id: 'cust-1', name: 'Hofer' } } };
    const r = renderPreviewBody(body);
    expect(r.fields[0].value).toBe('Id: cust-1 · Name: Hofer');
  });

  it('a declared property absent from the item is simply skipped, never invented', () => {
    const body: PreviewBody = {
      structured: { lines: [{ qty: 4 }] },
      outputSchema: { properties: { lines: { items: { properties: { qty: { title: 'Qty' }, sku: { title: 'SKU' } } } } } },
    };
    const r = renderPreviewBody(body);
    expect(r.fields[0].lines![0]).toBe('Qty: 4');
  });

  it('nested narrowing recurses — an object inside a declared array item is itself narrowed', () => {
    const body: PreviewBody = {
      structured: { lines: [{ qty: 4, product: { sku: 'CH-120', internal_cost: 42 } }] },
      outputSchema: {
        properties: {
          lines: {
            items: {
              properties: {
                qty: { title: 'Qty' },
                product: { properties: { sku: { title: 'SKU' } } },
              },
            },
          },
        },
      },
    };
    const r = renderPreviewBody(body);
    expect(r.fields[0].lines![0]).toBe('Qty: 4 · Product: SKU: CH-120');
    expect(r.fields[0].lines![0]).not.toContain('internal_cost');
    expect(r.fields[0].lines![0]).not.toContain('42');
  });

  it('applies the same narrowing inside the stale diff', () => {
    const schema = { properties: { lines: { items: { properties: { qty: { title: 'Qty' }, sku: { title: 'SKU' } } } } } };
    const approved: PreviewBody = { structured: { lines: [{ id: 'row-1', qty: 4, sku: 'CH-120' }] }, outputSchema: schema };
    const current: PreviewBody = { structured: { lines: [{ id: 'row-2', qty: 2, sku: 'HP-40' }] }, outputSchema: schema };
    const diff = diffPreviewBodies(approved, current);
    expect(diff.approved.fields[0].lines![0]).toBe('Qty: 4 · SKU: CH-120');
    expect(diff.current.fields[0].lines![0]).toBe('Qty: 2 · SKU: HP-40');
    expect(diff.approved.fields[0].lines![0]).not.toContain('row-1');
  });
});

describe('renderPreviewBody — numbers: rounded display, exact value on hover (2026-10-10 follow-up)', () => {
  it('rounds a non-integer to at most 2 decimals, no trailing zeros, and carries the exact value as a title', () => {
    const r = renderPreviewBody({ structured: { amount: 44.44444444444444 } });
    expect(r.fields[0].value).toBe('44.44');
    expect(r.fields[0].valueTitle).toBe('44.44444444444444');
  });

  it('never touches an integer — no title either, since nothing was rounded', () => {
    const r = renderPreviewBody({ structured: { count: 480 } });
    expect(r.fields[0].value).toBe('480');
    expect(r.fields[0].valueTitle).toBeUndefined();
  });

  it('never touches a string that merely looks numeric', () => {
    const r = renderPreviewBody({ structured: { id: '44.44444444444444' } });
    expect(r.fields[0].value).toBe('44.44444444444444');
    expect(r.fields[0].valueTitle).toBeUndefined();
  });

  it('a number that happens to round to a whole value drops its decimals, same as any number', () => {
    const r = renderPreviewBody({ structured: { amount: 44.001 } });
    expect(r.fields[0].value).toBe('44');
    expect(r.fields[0].valueTitle).toBe('44.001');
  });

  it('rounds a number inside a compact object line, title carries the exact line', () => {
    const body: PreviewBody = { structured: { totals: { net: 44.44444444444444, qty: 4 } } };
    const r = renderPreviewBody(body);
    expect(r.fields[0].value).toBe('Net: 44.44 · Qty: 4');
    expect(r.fields[0].valueTitle).toBe('Net: 44.44444444444444 · Qty: 4');
  });

  it('rounds numbers inside array-item lines, with a per-line title only where it changed something', () => {
    const body: PreviewBody = {
      structured: { lines: [{ qty: 4, unit_price: 33.333333 }, { qty: 1, unit_price: 480 }] },
    };
    const r = renderPreviewBody(body);
    expect(r.fields[0].lines).toEqual(['Qty: 4 · Unit price: 33.33', 'Qty: 1 · Unit price: 480']);
    expect(r.fields[0].lineTitles![0]).toBe('Qty: 4 · Unit price: 33.333333');
    expect(r.fields[0].lineTitles![1]).toBeUndefined();
  });

  it('rounds numbers inside a scalar array, title carries the exact list', () => {
    const r = renderPreviewBody({ structured: { amounts: [1.005, 2, 3.14159] } });
    expect(r.fields[0].value).toBe('1, 2, 3.14');
    expect(r.fields[0].valueTitle).toBe('1.005, 2, 3.14159');
  });
});

describe('renderPreviewBody — without declared fields: every field WITH a value, no fixed count', () => {
  it('a 15-field answer shows every field that has a value — not a fixed 6', () => {
    const structured = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, i]));
    const r = renderPreviewBody({ structured });
    expect(r.fields).toHaveLength(15);
    expect(r.moreFields).toHaveLength(0);
    expect(r.totalFields).toBe(15);
  });

  it('skips null, "", and [] — but keeps them counted and reachable under "All fields"', () => {
    const body: PreviewBody = {
      structured: { id: 'Q1', notes: null, tags: [], label: '', net_total: 480 },
    };
    const r = renderPreviewBody(body);
    expect(r.fields.map((f) => f.key)).toEqual(['id', 'net_total']);
    expect(r.moreFields.map((f) => f.key)).toEqual(['notes', 'tags', 'label']);
    expect(r.totalFields).toBe(5);
    // Still rendered with the honest em-dash once reached, never "null".
    expect(r.moreFields.find((f) => f.key === 'notes')!.value).toBe('—');
  });

  it('0 and false are real values, not skipped like null/""/[]', () => {
    const body: PreviewBody = { structured: { discount_pct: 0, sent: false } };
    const r = renderPreviewBody(body);
    expect(r.fields.map((f) => f.key)).toEqual(['discount_pct', 'sent']);
    expect(r.moreFields).toEqual([]);
  });

  it('a nested object is always "has a value" (not checked for its own emptiness)', () => {
    const body: PreviewBody = { structured: { customer: {} } };
    const r = renderPreviewBody(body);
    expect(r.fields.map((f) => f.key)).toEqual(['customer']);
  });
});

describe('renderPreviewBody — with a declared `fields` allow-list', () => {
  const GET_QUOTE_15_FIELDS: PreviewBody = {
    structured: {
      id: 'q-internal-1', number: 'Q-0001', customer_id: 'cust-1', status: 'draft',
      currency: 'EUR', discount_pct: 0, net_total: 480, valid_until: '2026-11-08',
      notes: null, created_at: '2026-10-09', updated_at: '2026-10-09', sent_at: null,
      revision: 1, lines: [{ qty: 4, sku: 'CH-120' }], extra_field_no_one_declared: 'x',
    },
  };
  const FIELDS = ['number', 'revision', 'status', 'customer_id', 'lines', 'net_total', 'discount_pct', 'valid_until'];

  it('shows exactly the declared fields, in that order, regardless of value', () => {
    const r = renderPreviewBody(GET_QUOTE_15_FIELDS, { fields: FIELDS });
    expect(r.fields.map((f) => f.key)).toEqual(FIELDS);
    expect(r.totalFields).toBe(15);
    expect(r.moreFields).toHaveLength(15 - FIELDS.length);
  });

  it('the fields that matter (lines, net total) are no longer buried under "All fields"', () => {
    const r = renderPreviewBody(GET_QUOTE_15_FIELDS, { fields: FIELDS });
    expect(r.fields.map((f) => f.key)).toContain('lines');
    expect(r.fields.map((f) => f.key)).toContain('net_total');
    expect(r.moreFields.map((f) => f.key)).not.toContain('lines');
  });

  it('a declared field absent from the result is simply skipped, never invented', () => {
    const r = renderPreviewBody({ structured: { number: 'Q-0001' } }, { fields: ['number', 'does_not_exist'] });
    expect(r.fields.map((f) => f.key)).toEqual(['number']);
  });

  it('an empty `fields` array falls back to the no-declaration (has-a-value) behaviour', () => {
    const r = renderPreviewBody({ structured: { a: 1, b: null } }, { fields: [] });
    expect(r.fields.map((f) => f.key)).toEqual(['a']);
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

describe('allPreviewFields', () => {
  it('every top-level field, in schema order, no folding and no value-based filtering', () => {
    const body: PreviewBody = {
      structured: { b: 1, a: null },
      outputSchema: { properties: { a: { title: 'A' }, b: { title: 'B' } } },
    };
    const rows = allPreviewFields(body);
    expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('empty for a non-object (text-only) body', () => {
    expect(allPreviewFields({ text: 'plain prose' })).toEqual([]);
  });

  it('empty for an undefined body', () => {
    expect(allPreviewFields(undefined)).toEqual([]);
  });
});

describe('diffPreviewBodies — the stale-version compare shows ONLY what differs', () => {
  const approved: PreviewBody = {
    structured: {
      id: 'q-1', number: 'Q-0001', revision: 1, status: 'draft',
      net_total: 480, lines: [{ qty: 4, sku: 'CH-120' }],
    },
  };

  it('a field that actually changed (lines) is in the diff; unchanged fields (id, number, status) are not', () => {
    const current: PreviewBody = {
      structured: {
        id: 'q-1', number: 'Q-0001', revision: 2, status: 'draft',
        net_total: 480, lines: [{ qty: 2, sku: 'HP-40' }],
      },
    };
    const diff = diffPreviewBodies(approved, current, { excludeKey: 'revision' });
    expect(diff.unchanged).toBe(false);
    expect(diff.approved.fields.map((f) => f.key)).toEqual(['lines']);
    expect(diff.current.fields.map((f) => f.key)).toEqual(['lines']);
    expect(diff.approved.fields[0].lines![0]).toContain('CH-120');
    expect(diff.current.fields[0].lines![0]).toContain('HP-40');
  });

  it('the excluded (version) field itself is never listed as a difference', () => {
    const current: PreviewBody = { structured: { ...approved.structured, revision: 2 } };
    const diff = diffPreviewBodies(approved, current, { excludeKey: 'revision' });
    expect(diff.approved.fields.map((f) => f.key)).not.toContain('revision');
    expect(diff.current.fields.map((f) => f.key)).not.toContain('revision');
  });

  it('"unchanged" when nothing differs besides the excluded field', () => {
    const current: PreviewBody = { structured: { ...approved.structured, revision: 2 } };
    const diff = diffPreviewBodies(approved, current, { excludeKey: 'revision' });
    expect(diff.unchanged).toBe(true);
    expect(diff.approved.fields).toEqual([]);
    expect(diff.current.fields).toEqual([]);
  });

  it('a field present on only one side counts as a difference', () => {
    const current: PreviewBody = { structured: { id: 'q-1', number: 'Q-0001', revision: 2, new_field: 'surprise' } };
    const diff = diffPreviewBodies(
      { structured: { id: 'q-1', number: 'Q-0001', revision: 1 } },
      current,
      { excludeKey: 'revision' },
    );
    expect(diff.unchanged).toBe(false);
    expect(diff.current.fields.map((f) => f.key)).toContain('new_field');
  });

  it('respects a declared field order for the diff rows', () => {
    const current: PreviewBody = {
      structured: { ...approved.structured, revision: 2, status: 'sent', lines: [{ qty: 2, sku: 'HP-40' }] },
    };
    const diff = diffPreviewBodies(approved, current, {
      excludeKey: 'revision',
      fields: ['status', 'lines', 'net_total'],
    });
    expect(diff.approved.fields.map((f) => f.key)).toEqual(['status', 'lines']);
  });

  it('free-text (non-structured) bodies: identical text is "unchanged"', () => {
    const diff = diffPreviewBodies({ text: 'same answer' }, { text: 'same answer' });
    expect(diff.unchanged).toBe(true);
  });

  it('free-text bodies: different text shows both in full, never a field diff', () => {
    const diff = diffPreviewBodies({ text: 'old answer' }, { text: 'new answer' });
    expect(diff.unchanged).toBe(false);
    expect(diff.approved.text).toBe('old answer');
    expect(diff.current.text).toBe('new answer');
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
