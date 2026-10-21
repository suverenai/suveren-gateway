import { describe, it, expect } from 'vitest';
import { buildCreationView } from './preview-render';
import type { PreviewReadSection, ToolDisplayHints } from './sp-client';

const ok = (structured: Record<string, unknown>) => ({ status: 'ok' as const, body: { structured } });

describe('display-only read → its own "From <label> — checked <time>" box', () => {
  const hints: ToolDisplayHints = {
    labels: { uid: 'VAT ID', 'uid.vies.name': 'Name at VIES', 'uid.vies.request_id': 'Consultation no.' },
    hidden: ['uid.vies.status'],
  };
  const vies: PreviewReadSection = {
    tool: 'check_vat_id', attach: 'uid', displayOnly: true, label: 'EU VIES',
    result: ok({ vies: { status: 'valid', name: 'STEINER GMBH', request_id: 'WAPI1' } }),
  };
  const dups: PreviewReadSection = { tool: 'check_customer_duplicates', as: 'duplicates', result: ok({ vat_duplicate_of: null }) };

  it('is a system box with the labelled fields, never merged into the sealed uid row; an `as` read is not shown', () => {
    const v = buildCreationView({ name: 'Steiner', uid: 'ATU12345678' }, [vies, dups], hints, { readAt: Date.UTC(2026, 9, 21, 9, 15) });
    expect(v.rows.find((r) => r.key === 'uid')).toMatchObject({ kind: 'scalar', value: 'ATU12345678' });
    expect(v.sections).toEqual([]);
    expect(v.systemBoxes).toHaveLength(1);
    expect(v.systemBoxes[0].heading).toMatch(/^From EU VIES — checked /);
    expect(v.systemBoxes[0].rows).toEqual([
      { key: 'uid.vies.name', label: 'Name at VIES', value: 'STEINER GMBH' },
      { key: 'uid.vies.request_id', label: 'Consultation no.', value: 'WAPI1' },
    ]);
  });

  it('no box when the read did not answer', () => {
    const v = buildCreationView({ uid: 'X' }, [{ ...vies, result: { status: 'unavailable', reason: 'timeout' } }], hints);
    expect(v.systemBoxes).toEqual([]);
  });
});

describe('display.compare → one Now / New table', () => {
  it('lists the compared args with the attached current values, at the first one\'s place', () => {
    const hints: ToolDisplayHints = {
      order: ['id', 'name', 'address_lines', 'country', 'uid'],
      labels: { id: 'Customer', name: 'Name', address_lines: 'Address', country: 'Country', uid: 'VAT ID' },
      compare: { name: 'id.current.name', address_lines: 'id.current.address_lines', country: 'id.current.country', uid: 'id.current.uid' },
      hidden: ['id.current'],
    };
    const change: PreviewReadSection = { tool: 'preview_customer_change', attach: 'id',
      result: ok({ name: 'Steiner GmbH', current: { name: 'Steiner GmbH', address_lines: ['Hauptstr. 12', '9800 Spittal'], country: 'AT', uid: 'ATU1' } }) };
    const v = buildCreationView(
      { id: 'c1', name: 'Steiner GmbH', address_lines: ['Industriestr. 4', '83395 Freilassing'], country: 'DE', uid: 'DE1' },
      [change], hints);
    expect(v.rows.map((r) => r.kind)).toEqual(['identity', 'compare']);
    const cmp = v.rows[1] as Extract<typeof v.rows[number], { kind: 'compare' }>;
    expect(cmp.lines).toEqual([
      { key: 'name', label: 'Name', now: 'Steiner GmbH', next: 'Steiner GmbH' },
      { key: 'address_lines', label: 'Address', now: 'Hauptstr. 12, 9800 Spittal', next: 'Industriestr. 4, 83395 Freilassing' },
      { key: 'country', label: 'Country', now: 'AT', next: 'DE' },
      { key: 'uid', label: 'VAT ID', now: 'ATU1', next: 'DE1' },
    ]);
  });
});

describe('a forEach line whose read did not run (no item linked)', () => {
  it('shows an empty item cell, not "Nothing to read."', () => {
    const items: PreviewReadSection = { tool: 'get_item', forEach: 'lines', attach: 'item', sourceArg: 'item_id',
      elements: [{ status: 'ok', body: { structured: { id: 'i1', name: 'Beratung' } } }, { status: 'none', reason: 'no_target' }] };
    const v = buildCreationView({ lines: [{ item_id: 'i1', qty: 1 }, { description: 'Fahrt', qty: 1 }] }, [items], undefined);
    const table = (v.rows[0] as Extract<typeof v.rows[number], { kind: 'table' }>).table;
    expect(table.rows[1].cells[0].value).toBe('');
    expect(table.rows[0].cells[0].value).toBe('Beratung (i1)');
  });
});

describe('display.names — a record whose name is nested in the read', () => {
  it('names the identity from the declared path; hidden fields and args stay out', () => {
    const section: PreviewReadSection = { tool: 'preview_customer_change', attach: 'id',
      result: ok({ current: { name: 'Steiner Landtechnik GmbH', revision: 3 }, open_quotes: 1, revision: 3 }) };
    const v = buildCreationView({ id: 'c-uuid-1', revision: 3, name: 'Steiner' }, [section],
      { names: { id: 'current.name' }, hidden: ['revision', 'id.current', 'id.open_quotes', 'id.revision'] });
    const id = v.rows.find((r) => r.key === 'id') as Extract<typeof v.rows[number], { kind: 'identity' }>;
    expect(id.identity.name).toBe('Steiner Landtechnik GmbH');
    expect(id.identity.context).toEqual([]);
    expect(v.rows.some((r) => r.key === 'revision')).toBe(false);
  });
});

describe('free-text lines only (no line links an item)', () => {
  it('has no Item column at all', () => {
    const items: PreviewReadSection = { tool: 'get_item', forEach: 'lines', attach: 'item', sourceArg: 'item_id',
      elements: [{ status: 'none', reason: 'no_target' }, { status: 'none', reason: 'no_target' }] };
    const v = buildCreationView({ lines: [{ description: 'Beratung', qty: 1 }, { description: 'Fahrt', qty: 1, unit: 'km' }] }, [items], undefined);
    const table = (v.rows[0] as Extract<typeof v.rows[number], { kind: 'table' }>).table;
    expect(table.columns.map((c) => c.label)).toEqual(['Description', 'Qty', 'Unit']);
    expect(table.rows[0].cells.map((c) => c.value)).toEqual(['Beratung', '1', '']);
  });
});

describe('linked record context: declared fields, no empty values, readable timestamps', () => {
  it('shows only the declared fields (dotted allowed) of a quote, named by display.names', () => {
    const quote: PreviewReadSection = { tool: 'get_quote', attach: 'quote_id', fields: ['revision', 'customer.name'],
      result: ok({ id: 'q-uuid', number: 'A-2026-031', revision: 2, customer_id: 'c-uuid', ticket_id: 't-1', customer: { name: 'Steiner GmbH', revision: 3 } }) };
    const v = buildCreationView({ quote_id: 'q-uuid' }, [quote], { names: { quote_id: 'number' }, labels: { 'quote_id.customer.name': 'Customer on the quote' } });
    const id = v.rows[0] as Extract<typeof v.rows[number], { kind: 'identity' }>;
    expect(id.identity.name).toBe('A-2026-031');
    expect(id.identity.context.map((c) => [c.label, c.value])).toEqual([['Revision', '2'], ['Customer on the quote', 'Steiner GmbH']]);
  });

  it('leaves out empty fields and formats ISO timestamps', () => {
    const customer: PreviewReadSection = { tool: 'get_customer', attach: 'customer_id',
      result: ok({ id: 'c1', name: 'Steiner GmbH', crm_contact_id: null, email: '', created_at: '2026-10-20T08:00:00Z' }) };
    const v = buildCreationView({ customer_id: 'c1' }, [customer], undefined);
    const ctx = (v.rows[0] as Extract<typeof v.rows[number], { kind: 'identity' }>).identity.context;
    expect(ctx.map((c) => c.key)).toEqual(['created_at']);
    expect(ctx[0].value).not.toMatch(/T08:00/);
    expect(ctx[0].value).toMatch(/2026/);
  });
});
