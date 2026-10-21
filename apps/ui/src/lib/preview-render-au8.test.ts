/**
 * AU8 — several reads per preview, renderer rules (temp/briefs/au8-brief.md,
 * mockup temp/mockups/approval-card-au8-v1.html). Pure, generic — no tool
 * name ever drives a branch here.
 *
 * Bodies below use `text` only (no `structured`), matching the real
 * connectors (erp-mcp/crm-mcp only set `structuredContent` for the one tool
 * that declares an `outputSchema` — get_item/get_customer/find_contacts do
 * not), so `resolveBodyObject`/`resolveBodyArray`'s JSON-in-text fallback is
 * exactly what's exercised in production.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAttachedIdentity,
  buildForEachTable,
  buildOwnSection,
  buildCreationView,
  renderPreviewBody,
} from './preview-render';
import type { PreviewBody, PreviewReadOutcome, PreviewReadSection } from './sp-client';

function textOk(obj: unknown): PreviewReadOutcome {
  return { status: 'ok', body: { text: JSON.stringify(obj) } };
}

describe('resolveAttachedIdentity', () => {
  it('resolves name + raw id + context from a read with no schema (text-only body)', () => {
    const outcome = textOk({ id: 'cust-1', name: 'Steiner Landtechnik GmbH', credit_limit: 10000, open_balance: 1200, payment_terms: 'NET30' });
    const identity = resolveAttachedIdentity(outcome, 'cust-1');
    expect(identity.name).toBe('Steiner Landtechnik GmbH');
    expect(identity.rawId).toBe('cust-1');
    expect(identity.context.map((c) => c.key)).toEqual(['credit_limit', 'open_balance', 'payment_terms']);
    expect(identity.unresolved).toBeUndefined();
  });

  it('a number field is never mistaken for the name, even when it sorts first', () => {
    const outcome = textOk({ list_price: 38.5, name: 'Keilriemen SPB 2000', stock: 40 });
    const identity = resolveAttachedIdentity(outcome, 'item-1');
    expect(identity.name).toBe('Keilriemen SPB 2000');
  });

  it('falls back to the first STRING field when there is no name/title/label', () => {
    const outcome = textOk({ sku: 'KB-4410', list_price: 38.5 });
    const identity = resolveAttachedIdentity(outcome, 'item-1');
    expect(identity.name).toBe('KB-4410');
  });

  it('unresolved (not_found) still shows the raw bound id, with a plain note', () => {
    const identity = resolveAttachedIdentity({ status: 'not_found' }, 'cust-9');
    expect(identity.name).toBeUndefined();
    expect(identity.rawId).toBe('cust-9');
    expect(identity.unresolved).toMatch(/not found/i);
  });

  it('a missing read (no section at all) is also unresolved, never throws', () => {
    const identity = resolveAttachedIdentity(undefined, 'cust-9');
    expect(identity.unresolved).toBeDefined();
  });
});

describe('buildForEachTable', () => {
  const section: PreviewReadSection = {
    tool: 'get_item', forEach: 'lines', attach: 'item', sourceArg: 'item_id',
    elements: [textOk({ id: 'item-1', name: 'Keilriemen SPB 2000', list_price: 38.5, stock: 40 })],
  };

  it('one row per bound element; attach column first, then the element\'s other bound fields, then the attached read\'s other fields', () => {
    const table = buildForEachTable(section, [{ item_id: 'item-1', qty: 10 }], undefined, undefined);
    expect(table.columns.map((c) => c.label)).toEqual(['Item id', 'Qty', 'List price', 'Stock']);
    expect(table.rows).toHaveLength(1);
    const [identityCell, qtyCell, priceCell, stockCell] = table.rows[0].cells;
    expect(identityCell).toMatchObject({ value: 'Keilriemen SPB 2000 (item-1)', sealed: false });
    expect(qtyCell).toMatchObject({ value: '10', sealed: true });
    expect(priceCell).toMatchObject({ value: '38.5', sealed: false });
    expect(stockCell).toMatchObject({ value: '40', sealed: false });
  });

  it('applies a money display hint to the attached field (lines[].item.list_price — the attach-key segment disambiguates it from a bound element field)', () => {
    const table = buildForEachTable(section, [{ item_id: 'item-1', qty: 10 }], { money: ['lines[].item.list_price'], currencyField: 'currency' }, 'EUR');
    const priceCell = table.rows[0].cells[2];
    expect(priceCell.value).toBe('38.50 EUR');
  });

  it('a failing element read still produces a row — the identity + bound columns stay even with no attached columns at all', () => {
    const failing: PreviewReadSection = { ...section, elements: [{ status: 'not_found' }] };
    const table = buildForEachTable(failing, [{ item_id: 'item-404', qty: 1 }], undefined, undefined);
    // No element resolved, so there is nothing to derive an attached column
    // FROM — only the identity (unresolved) and the bound `qty` column show.
    expect(table.columns.map((c) => c.label)).toEqual(['Item id', 'Qty']);
    expect(table.rows[0].cells[0].value).toMatch(/item-404/);
    expect(table.rows[0].cells[1]).toMatchObject({ value: '1', sealed: true });
  });

  it('one element failing among several shows EMPTY cells for the attached columns a DIFFERENT element resolved (UI spec: no "—")', () => {
    const mixed: PreviewReadSection = {
      ...section,
      elements: [textOk({ id: 'item-1', name: 'Keilriemen SPB 2000', list_price: 38.5, stock: 40 }), { status: 'not_found' }],
    };
    const table = buildForEachTable(mixed, [{ item_id: 'item-1', qty: 10 }, { item_id: 'item-404', qty: 1 }], undefined, undefined);
    expect(table.rows[1].cells.slice(2)).toEqual([{ value: '', sealed: false }, { value: '', sealed: false }]);
  });

  it('no attach -> no identity column, only the element\'s own fields', () => {
    const noAttach: PreviewReadSection = { tool: 'get_item', forEach: 'lines', elements: [textOk({ x: 1 })] };
    const table = buildForEachTable(noAttach, [{ qty: 1 }], undefined, undefined);
    expect(table.columns.map((c) => c.label)).toEqual(['Qty']);
  });

  it('reports the overflow note when the source was capped', () => {
    const withOverflow: PreviewReadSection = { ...section, overflow: { shown: 50, total: 63 } };
    const table = buildForEachTable(withOverflow, [{ item_id: 'item-1', qty: 1 }], undefined, undefined);
    expect(table.overflowNote).toBe('13 more not shown');
  });
});

describe('buildOwnSection — a read with no attach', () => {
  it('a list result (find_contacts-shaped) renders as a table', () => {
    const section: PreviewReadSection = {
      tool: 'find_contacts',
      result: textOk([{ name: 'Hofer Agrar KG', company: 'Hofer Agrar KG', type: 'customer' }]),
    };
    const view = buildOwnSection(section)!;
    expect(view.table?.columns.map((c) => c.label)).toEqual(['Name', 'Company', 'Type']);
    expect(view.table?.rows[0].cells.map((c) => c.value)).toEqual(['Hofer Agrar KG', 'Hofer Agrar KG', 'customer']);
  });

  it('an empty list reads as "nothing found", not an empty table', () => {
    const section: PreviewReadSection = { tool: 'find_contacts', result: textOk([]) };
    expect(buildOwnSection(section)!.note).toMatch(/nothing found/i);
  });

  it('a single-object result renders as plain field rows', () => {
    const section: PreviewReadSection = { tool: 'get_customer', result: textOk({ name: 'x' }) };
    const view = buildOwnSection(section)!;
    expect(view.body?.fields.map((f) => f.key)).toEqual(['name']);
  });

  it('a failed read shows what the system answered, not "not found" (2026-10-18: company file unreadable)', () => {
    const answer = 'Company file ~/x.json: cannot be read as JSON';
    const failed: PreviewReadSection = { tool: 'preview_invoice', kind: 'document', result: { status: 'not_found', message: answer } } as PreviewReadSection;
    expect(buildOwnSection(failed)!.note).toBe(`The system answered: ${answer}`);
    const bare: PreviewReadSection = { tool: 'get_customer', result: { status: 'not_found' } };
    expect(buildOwnSection(bare)!.note).toBe('Not found in the system.');
  });

  it('an unresolved read shows a plain note, not an error dump', () => {
    const section: PreviewReadSection = { tool: 'find_contacts', result: { status: 'unavailable', reason: 'connector_error' } };
    expect(buildOwnSection(section)!.note).toMatch(/not available/i);
  });
});

describe('renderPreviewBody — an array of objects ALSO gets a real table (AU8, applies to existing single-read previews too)', () => {
  const schema = {
    properties: {
      lines: {
        title: 'Lines',
        items: { properties: { item_id: { title: 'Item ID' }, qty: { title: 'Quantity' }, list_price: { title: 'List price' } } },
      },
    },
  };

  it('a `lines`-shaped field keeps the compact `lines` rows AND gets a `table`, same row content', () => {
    const body: PreviewBody = { structured: { lines: [{ item_id: 'item-1', qty: 10, list_price: 38.5 }] }, outputSchema: schema };
    const r = renderPreviewBody(body);
    const row = r.fields.find((f) => f.key === 'lines')!;
    expect(row.lines).toEqual(['Item ID: item-1 · Quantity: 10 · List price: 38.5']); // unchanged — rowKey/diff still compares on this
    expect(row.table?.columns.map((c) => c.label)).toEqual(['Item ID', 'Quantity', 'List price']);
    expect(row.table?.rows[0].cells.map((c) => c.value)).toEqual(['item-1', '10', '38.5']);
  });

  it('no table for an array of plain scalars (DL4 behaviour unaffected)', () => {
    const body: PreviewBody = { structured: { tags: ['a', 'b'] } };
    const row = renderPreviewBody(body).fields.find((f) => f.key === 'tags')!;
    expect(row.lines).toEqual(['a', 'b']);
    expect(row.table).toBeUndefined();
  });

  it('without a declared items schema, columns come from the union of the rows\' own keys', () => {
    const body: PreviewBody = { structured: { lines: [{ a: 1, b: 2 }, { a: 3, c: 4 }] } };
    const row = renderPreviewBody(body).fields.find((f) => f.key === 'lines')!;
    expect(row.table?.columns.map((c) => c.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('buildCreationView — the combined "What will be created" view', () => {
  const sections: PreviewReadSection[] = [
    { tool: 'get_customer', attach: 'customer_id', sourceArg: 'customer_id', result: textOk({ id: 'cust-1', name: 'Steiner Landtechnik GmbH' }) },
    { tool: 'get_item', forEach: 'lines', attach: 'item', sourceArg: 'item_id', elements: [textOk({ id: 'item-1', name: 'Keilriemen SPB 2000', list_price: 38.5 })] },
  ];
  const toolArgs = { customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }], discount_pct: 0, value: 385, currency: 'EUR', notes: 'x' };
  const displayHints = { order: ['customer_id', 'lines', 'discount_pct', 'value'], money: ['value'], percent: ['discount_pct'], currencyField: 'currency' };

  it('orders rows per display.order; fields not listed (currency, notes) are appended afterward, in their own key order', () => {
    const view = buildCreationView(toolArgs, sections, displayHints);
    expect(view.rows.map((r) => r.key)).toEqual(['customer_id', 'lines', 'discount_pct', 'value', 'currency', 'notes']);
  });

  it('customer_id renders as an identity row (attached, non-forEach)', () => {
    const view = buildCreationView(toolArgs, sections, displayHints);
    const row = view.rows.find((r) => r.key === 'customer_id');
    expect(row?.kind).toBe('identity');
    if (row?.kind === 'identity') expect(row.identity.name).toBe('Steiner Landtechnik GmbH');
  });

  it('lines renders as a table (forEach)', () => {
    const view = buildCreationView(toolArgs, sections, displayHints);
    const row = view.rows.find((r) => r.key === 'lines');
    expect(row?.kind).toBe('table');
  });

  it('value is formatted as money per the display hint + currencyField', () => {
    const view = buildCreationView(toolArgs, sections, displayHints);
    const row = view.rows.find((r) => r.key === 'value');
    expect(row).toMatchObject({ kind: 'scalar', value: '385.00 EUR' });
  });

  it('discount_pct is formatted as a percent', () => {
    const view = buildCreationView(toolArgs, sections, displayHints);
    const row = view.rows.find((r) => r.key === 'discount_pct');
    expect(row).toMatchObject({ kind: 'scalar', value: '0 %' });
  });

  it('a hidden field never appears', () => {
    const view = buildCreationView(toolArgs, sections, { ...displayHints, hidden: ['notes'] });
    expect(view.rows.some((r) => r.key === 'notes')).toBe(false);
  });

  it('a read with no attach becomes its own section, not a row', () => {
    const dup: PreviewReadSection = { tool: 'find_contacts', result: textOk([{ name: 'Hofer Agrar KG' }]) };
    const view = buildCreationView(toolArgs, [...sections, dup], displayHints);
    expect(view.rows.some((r) => r.key === 'find_contacts')).toBe(false);
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].heading).toMatch(/find contacts/i);
  });

  it('with no displayHints at all, every bound field still renders plainly, in its own key order', () => {
    const view = buildCreationView({ a: 1, b: 'x' }, [], undefined);
    expect(view.rows.map((r) => r.key)).toEqual(['a', 'b']);
    expect(view.rows.every((r) => r.kind === 'scalar')).toBe(true);
  });
});

describe('display.labels — the manifest is the one place for display (2026-10-13 follow-up)', () => {
  const sections: PreviewReadSection[] = [
    { tool: 'get_customer', attach: 'customer_id', sourceArg: 'customer_id', result: textOk({ id: 'cust-1', name: 'Steiner Landtechnik GmbH', credit_limit: 10000, open_balance: 1200 }) },
    { tool: 'get_item', forEach: 'lines', attach: 'item', sourceArg: 'item_id', elements: [textOk({ id: 'item-1', name: 'Keilriemen SPB 2000', list_price: 38.5 })] },
  ];
  const toolArgs = { customer_id: 'cust-1', lines: [{ item_id: 'item-1', qty: 10 }], discount_pct: 0, value: 385, currency: 'EUR' };
  const displayHints = {
    order: ['customer_id', 'lines', 'discount_pct', 'value'],
    money: ['value', 'customer_id.credit_limit', 'customer_id.open_balance', 'lines[].item.list_price'],
    percent: ['discount_pct'],
    currencyField: 'currency',
    labels: {
      customer_id: 'Customer', discount_pct: 'Discount', value: 'Total (net)',
      'customer_id.credit_limit': 'Credit limit', 'customer_id.open_balance': 'Open balance',
      'lines[].item': 'Item', 'lines[].item.list_price': 'List price',
    },
  };

  it('a manifest label overrides the humanized key for a top-level bound field', () => {
    const view = buildCreationView(toolArgs, sections, displayHints);
    expect(view.rows.find((r) => r.key === 'customer_id')?.label).toBe('Customer');
    expect(view.rows.find((r) => r.key === 'discount_pct')?.label).toBe('Discount');
    expect(view.rows.find((r) => r.key === 'value')?.label).toBe('Total (net)');
  });

  it('a manifest label overrides the identity row\'s context field label AND formats it as money', () => {
    const view = buildCreationView(toolArgs, sections, displayHints);
    const row = view.rows.find((r) => r.key === 'customer_id');
    expect(row?.kind).toBe('identity');
    if (row?.kind !== 'identity') throw new Error('not identity');
    const credit = row.identity.context.find((c) => c.key === 'credit_limit');
    expect(credit?.label).toBe('Credit limit');
    expect(credit?.value).toBe('10,000.00 EUR');
    const balance = row.identity.context.find((c) => c.key === 'open_balance');
    expect(balance?.label).toBe('Open balance');
    expect(balance?.value).toBe('1,200.00 EUR');
  });

  it('a manifest label overrides the forEach attach identity column AND an attached field column', () => {
    const view = buildCreationView(toolArgs, sections, displayHints);
    const row = view.rows.find((r) => r.key === 'lines');
    expect(row?.kind).toBe('table');
    if (row?.kind !== 'table') throw new Error('not table');
    expect(row.table.columns.map((c) => c.label)).toContain('Item');
    expect(row.table.columns.map((c) => c.label)).toContain('List price');
    const priceCol = row.table.columns.findIndex((c) => c.label === 'List price');
    expect(row.table.rows[0].cells[priceCol].value).toBe('38.50 EUR');
  });

  it('without a manifest label, the existing schema-title-or-humanized fallback still applies', () => {
    const view = buildCreationView(toolArgs, sections, { ...displayHints, labels: {} });
    expect(view.rows.find((r) => r.key === 'customer_id')?.label).toBe('Customer id'); // humanized
  });

  it('a dotted currencyField resolves into a NON-forEach attach\'s own field', () => {
    const custSections: PreviewReadSection[] = [
      { tool: 'get_customer', attach: 'customer_id', result: textOk({ id: 'cust-1', name: 'X', credit_limit: 500 }) },
    ];
    const view = buildCreationView(
      { customer_id: 'cust-1' },
      custSections,
      { money: ['customer_id.credit_limit'], currencyField: 'customer_id.currency' },
    );
    // The attached body here has no `currency` field at all — money still
    // renders, just with no currency suffix, never a guess.
    const row = view.rows.find((r) => r.key === 'customer_id');
    if (row?.kind !== 'identity') throw new Error('not identity');
    expect(row.identity.context.find((c) => c.key === 'credit_limit')?.value).toBe('500.00');
  });
});

// UI spec §15.1 — "The PDF as it will be issued": a `kind: 'document'` read
// (tool-gating-types.ts `PreviewReadConfig.kind`) renders as a document box
// instead of a generic field table/section — generic by SHAPE, no tool name.
describe('buildOwnSection — kind: "document" (UI spec §15.1)', () => {
  const DOC_BODY = {
    filename: 'invoice-2026-0003.pdf',
    contentType: 'application/pdf',
    contentBase64: 'JVBERi0xLjQK',
    sha256: 'a41f00000000000000000000000000000000000000000000000000009c2e',
    pages: 1,
  };

  it('a well-shaped document result resolves to `document`, not `body`/`table`', () => {
    const section: PreviewReadSection = { tool: 'preview_invoice', kind: 'document', result: textOk(DOC_BODY) };
    const view = buildOwnSection(section);
    expect(view?.document).toEqual(DOC_BODY);
    expect(view?.body).toBeUndefined();
    expect(view?.table).toBeUndefined();
    expect(view?.note).toBeUndefined();
  });

  it('no connector for this read (e.g. simulation mode) — the section is absent entirely, not a note', () => {
    const section: PreviewReadSection = {
      tool: 'preview_invoice',
      kind: 'document',
      result: { status: 'unavailable', reason: 'no_connector' },
    };
    expect(buildOwnSection(section)).toBeNull();
    // buildCreationView drops it from `sections` the same way.
    const view = buildCreationView({}, [section], undefined);
    expect(view.sections).toEqual([]);
  });

  it('a different unavailable reason (a real problem) still gets a note, not silence', () => {
    const section: PreviewReadSection = {
      tool: 'preview_invoice',
      kind: 'document',
      result: { status: 'unavailable', reason: 'connector_error' },
    };
    const view = buildOwnSection(section);
    expect(view).not.toBeNull();
    expect(view?.note).toMatch(/not available/i);
    expect(view?.document).toBeUndefined();
  });

  it('a malformed answer (missing a required document field) degrades to a note, never a crash', () => {
    const section: PreviewReadSection = {
      tool: 'preview_invoice',
      kind: 'document',
      result: textOk({ filename: 'x.pdf' }), // no contentBase64/sha256/contentType
    };
    const view = buildOwnSection(section);
    expect(view?.document).toBeUndefined();
    expect(view?.note).toMatch(/could not show a preview/i);
  });

  it('not found / no target still render as an ordinary note (unchanged from a non-document read)', () => {
    const notFound: PreviewReadSection = { tool: 'preview_invoice', kind: 'document', result: { status: 'not_found' } };
    expect(buildOwnSection(notFound)?.note).toMatch(/not found/i);
    const noTarget: PreviewReadSection = { tool: 'preview_invoice', kind: 'document', result: { status: 'none', reason: 'no_target' } };
    expect(buildOwnSection(noTarget)?.note).toMatch(/nothing to read/i);
  });

  it('buildCreationView keeps a resolved document section alongside ordinary rows', () => {
    const sections: PreviewReadSection[] = [{ tool: 'preview_invoice', kind: 'document', result: textOk(DOC_BODY) }];
    const view = buildCreationView({ number: '2026-0003' }, sections, undefined);
    expect(view.rows.find((r) => r.key === 'number')).toBeTruthy();
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].document).toEqual(DOC_BODY);
  });
});
