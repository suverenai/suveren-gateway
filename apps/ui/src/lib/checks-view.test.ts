import { describe, it, expect } from 'vitest';
import { checkLines, checkLineText } from './checks-view';

describe('checkLines — one line per check, four states (UI spec §4.2.2)', () => {
  const lines = checkLines(
    [{ key: 'net', label: 'Net per invoice', ok: true, valueText: '€1,240.00', limitText: '€10,000.00' }],
    [
      { key: 'vies', label: 'VAT ID confirmed by VIES', status: 'pass', detail: 'checked 2026-10-21' },
      { key: 'vies2', label: 'VAT ID confirmed by VIES', status: 'not_checked', detail: 'VIES unreachable' },
      { key: 'list-price', label: 'Price vs. list', status: 'notice', index: 1, detail: 'line 1: 95.00 EUR, list price 120.00 EUR' },
      { key: 'dup', label: 'No other customer with this VAT ID', status: 'fail', detail: 'already customer c-17' },
    ],
  );

  it('limits first, then the manifest checks, each keyed apart (forEach lines by index)', () => {
    expect(lines.map((l) => l.key)).toEqual(['limit:net', 'check:vies', 'check:vies2', 'check:list-price:1', 'check:dup']);
  });

  it('words each state', () => {
    expect(lines.map(checkLineText)).toEqual([
      'Net per invoice — €1,240.00 — your limit €10,000.00',
      'VAT ID confirmed by VIES — checked 2026-10-21',
      'VAT ID confirmed by VIES: not checked — VIES unreachable',
      'Price vs. list: line 1: 95.00 EUR, list price 120.00 EUR',
      'No other customer with this VAT ID: already customer c-17',
    ]);
  });

  it('a limit over its value is a fail; a not_checked with only a reason shows the reason', () => {
    const [l, c] = checkLines(
      [{ key: 'x', label: 'Max', ok: false, valueText: '12', limitText: '10' }],
      [{ key: 'r', label: 'R', status: 'not_checked', reason: 'no answer from the connector' }],
    );
    expect(l.status).toBe('fail');
    expect(checkLineText(c)).toBe('R: not checked — no answer from the connector');
  });
});
