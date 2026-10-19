/**
 * The approval card's and the ticket's summary rows for an argument that is
 * not a plain string or number — an invoice's `service_period` (one record)
 * and `lines` (a list of records). They were shown as "—" although the value
 * is there and sealed (Andreas, 2026-10-18, ticket of TEST-2026-0002).
 */
import { describe, it, expect } from 'vitest';
import { buildCreationView } from './preview-render';

const ARGS = {
  customer_id: 'test-andreas',
  number: 'TEST-2026-0002',
  document_date: '2026-10-18',
  service_period: { from: '2026-10-18', to: '2026-10-18' },
  lines: [{ description: 'Testleistung', qty: 1, unit_price: 1, vat_rate: 20 }],
  net_total: 1,
  currency: 'EUR',
  tags: ['a', 'b'],
};

describe('buildCreationView — nested argument values', () => {
  const view = buildCreationView(ARGS, [], { labels: { service_period: 'Service period' } } as never);
  const row = (key: string) => view.rows.find((r) => r.key === key)!;

  it('one record → one compact line, labelled by its keys', () => {
    const r = row('service_period');
    expect(r.kind).toBe('scalar');
    expect(r.kind === 'scalar' && r.value).toBe('From: 2026-10-18 · To: 2026-10-18');
  });

  it('a list of records → a table with one row per record', () => {
    const r = row('lines');
    expect(r.kind).toBe('table');
    if (r.kind !== 'table') return;
    expect(r.table.columns.map((c) => c.key)).toEqual(['description', 'qty', 'unit_price', 'vat_rate']);
    expect(r.table.rows[0].cells.map((c) => c.value)).toEqual(['Testleistung', '1', '1', '20']);
  });

  it('a list of plain values → comma-joined', () => {
    const r = row('tags');
    expect(r.kind === 'scalar' && r.value).toBe('a, b');
  });

  it('plain values are unchanged', () => {
    const r = row('number');
    expect(r.kind === 'scalar' && r.value).toBe('TEST-2026-0002');
  });
});

describe('nestedValueView — the ticket\'s "What was sent" uses the same rule', () => {
  it('sealed attachment fingerprints → a table, not JSON', async () => {
    const { nestedValueView } = await import('./preview-render');
    const v = nestedValueView([{ filename: 'TEST-2026-0002.pdf', sha256: '0202ae29' }]);
    expect(v && 'table' in v && v.table.columns.map((c) => c.label)).toEqual(['Filename', 'Sha256']);
  });
  it('plain values → null (shown as themselves)', async () => {
    const { nestedValueView } = await import('./preview-render');
    expect(nestedValueView('x')).toBeNull();
    expect(nestedValueView(['a', 'b'])).toBeNull();
  });
});

describe('lists inside a record (load_simulation package — Rehearsal 2026-10-19)', () => {
  it('a list of records inside a record shows its count, never "—"', async () => {
    const { nestedValueView } = await import('./preview-render');
    const v = nestedValueView({ name: 'Muster', cases: [{ id: 'c1' }, { id: 'c2' }], customers: [{ id: 'x' }], tags: ['a', 'b'], empty: [] });
    expect(v && 'text' in v && v.text).toBe('Name: Muster · Cases: 2 entries · Customers: 1 entry · Tags: a, b · Empty: —');
  });
});
