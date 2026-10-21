/**
 * D1 — manifest-declared checks (checks.ts), pure evaluation over bound args
 * plus preview-read sections. ERP local-production contract §7.2 / §8 Part D.
 */
import { describe, it, expect } from 'vitest';
import { evaluateChecks } from '../src/lib/checks';
import type { PreviewReadSection } from '../src/lib/preview';
import type { CheckDeclaration, PreviewReadConfig } from '../src/lib/tool-gating-types';

const ok = (structured: Record<string, unknown>) => ({ status: 'ok' as const, body: { structured } });

const VAT_READ: PreviewReadConfig[] = [{ tool: 'check_vat_id', args: { uid: 'uid' }, attach: 'uid', when: 'uid' }];
const VIES: CheckDeclaration = {
  key: 'vies', label: 'VAT ID confirmed', when: 'uid', path: 'uid.vies.status',
  pass: ['valid'], fail: ['invalid'], notChecked: ['not_checked'], missing: 'not_checked',
  detail: '[checked {uid.vies.checked_at|date}][ — {uid.vies.reason}]',
};
const vatSections = (vies: Record<string, unknown>): PreviewReadSection[] =>
  [{ tool: 'check_vat_id', attach: 'uid', result: ok({ format: 'ok', vies }) }];

describe('value-list checks', () => {
  it('pass / fail / not_checked from the read, with detail', () => {
    const args = { uid: 'ATU1' };
    expect(evaluateChecks([VIES], { args, declaration: VAT_READ, sections: vatSections({ status: 'valid', checked_at: '2026-10-21T09:00:00Z', reason: null }) }))
      .toEqual([{ key: 'vies', label: 'VAT ID confirmed', status: 'pass', value: 'valid', detail: 'checked 2026-10-21' }]);
    expect(evaluateChecks([VIES], { args, declaration: VAT_READ, sections: vatSections({ status: 'invalid' }) })[0].status).toBe('fail');
    const nc = evaluateChecks([VIES], { args, declaration: VAT_READ, sections: vatSections({ status: 'not_checked', reason: 'VIES unreachable (timeout after 8 s)' }) });
    expect(nc[0]).toMatchObject({ status: 'not_checked', detail: 'VIES unreachable (timeout after 8 s)' });
  });

  it('a value no list names is not_checked "unexpected value" — never a silent pass', () => {
    const r = evaluateChecks([VIES], { args: { uid: 'ATU1' }, declaration: VAT_READ, sections: vatSections({ status: 'maybe' }) });
    expect(r[0]).toMatchObject({ status: 'not_checked', reason: 'unexpected value maybe' });
  });

  it('`when` absent → no line at all', () => {
    expect(evaluateChecks([VIES], { args: {}, declaration: VAT_READ, sections: [{ tool: 'check_vat_id', attach: 'uid', result: { status: 'none', reason: 'no_target' } }] })).toEqual([]);
  });

  it('read unavailable → missing: "not_checked" gives a line, default "skip" gives none', () => {
    const sections: PreviewReadSection[] = [{ tool: 'check_vat_id', attach: 'uid', result: { status: 'unavailable', reason: 'timeout' } }];
    expect(evaluateChecks([VIES], { args: { uid: 'ATU1' }, declaration: VAT_READ, sections })[0])
      .toMatchObject({ status: 'not_checked', reason: 'no answer from the connector' });
    expect(evaluateChecks([{ ...VIES, missing: undefined }], { args: { uid: 'ATU1' }, declaration: VAT_READ, sections })).toEqual([]);
  });

  it('an AI-supplied argument can never satisfy a check that reads a preview path', () => {
    // The AI sends uid as an object carrying a "valid" answer; the read failed.
    const args = { uid: { vies: { status: 'valid' } } };
    const sections: PreviewReadSection[] = [{ tool: 'check_vat_id', attach: 'uid', result: { status: 'unavailable', reason: 'connector_error' } }];
    expect(evaluateChecks([VIES], { args, declaration: VAT_READ, sections })[0].status).toBe('not_checked');
    // …and with no sections at all (the read never ran).
    expect(evaluateChecks([VIES], { args, declaration: VAT_READ })[0].status).toBe('not_checked');
  });

  it('null and booleans match as values', () => {
    const decl: CheckDeclaration = { key: 'd', label: 'No duplicate', path: 'uid.duplicate', pass: [false], fail: [true] };
    const s = (v: unknown): PreviewReadSection[] => [{ tool: 't', attach: 'uid', result: ok({ duplicate: v }) }];
    expect(evaluateChecks([decl], { args: { uid: 'x' }, declaration: VAT_READ, sections: s(false) })[0].status).toBe('pass');
    expect(evaluateChecks([decl], { args: { uid: 'x' }, declaration: VAT_READ, sections: s(true) })[0].status).toBe('fail');
    const nul: CheckDeclaration = { key: 'n', label: 'n', path: 'uid.duplicate', notChecked: [null] };
    expect(evaluateChecks([nul], { args: { uid: 'x' }, declaration: VAT_READ, sections: s(null) })[0].status).toBe('not_checked');
  });
});

describe('compare checks', () => {
  const PREVIEW: PreviewReadConfig[] = [{ tool: 'preview_change', args: { id: 'id' }, attach: 'id' }];
  const section = (s: Record<string, unknown>): PreviewReadSection[] => [{ tool: 'preview_change', attach: 'id', result: ok(s) }];

  it('eq with onTrue/onFalse, and the detail', () => {
    const decl: CheckDeclaration = {
      key: 'tax-mode', label: 'Tax treatment', path: 'id.tax_mode.after',
      compare: { op: 'eq', to: 'id.tax_mode.now' }, onTrue: 'pass', onFalse: 'notice',
      detail: '{id.tax_mode.now} → {id.tax_mode.after}',
    };
    const same = evaluateChecks([decl], { args: { id: 'c1' }, declaration: PREVIEW, sections: section({ tax_mode: { now: 'normal', after: 'normal' } }) });
    expect(same[0].status).toBe('pass');
    const changed = evaluateChecks([decl], { args: { id: 'c1' }, declaration: PREVIEW, sections: section({ tax_mode: { now: 'normal', after: 'reverse_charge' } }) });
    expect(changed[0]).toMatchObject({ status: 'notice', detail: 'normal → reverse_charge' });
  });

  it('gt against a number literal; `when` false (not merely present) → no line', () => {
    const decl: CheckDeclaration = {
      key: 'already', label: 'Already issued', when: 'id.uid_or_country_changed', path: 'id.issued_documents.invoices',
      compare: { op: 'gt', to: 0 }, onTrue: 'notice', onFalse: 'pass',
      detail: '{id.issued_documents.invoices} invoices, {id.issued_documents.credit_notes} credit notes',
    };
    const docs = { invoices: 4, credit_notes: 1 };
    expect(evaluateChecks([decl], { args: { id: 'c1' }, declaration: PREVIEW, sections: section({ uid_or_country_changed: true, issued_documents: docs }) })[0])
      .toMatchObject({ status: 'notice', detail: '4 invoices, 1 credit notes' });
    expect(evaluateChecks([decl], { args: { id: 'c1' }, declaration: PREVIEW, sections: section({ uid_or_country_changed: false, issued_documents: docs }) })).toEqual([]);
    expect(evaluateChecks([decl], { args: { id: 'c1' }, declaration: PREVIEW, sections: section({ uid_or_country_changed: true, issued_documents: { invoices: 0, credit_notes: 0 } }) })[0].status).toBe('pass');
  });

  it('gt on a non-number is not_checked, never a pass', () => {
    const decl: CheckDeclaration = { key: 'g', label: 'g', path: 'id.n', compare: { op: 'gt', to: 0 } };
    expect(evaluateChecks([decl], { args: { id: 'c1' }, declaration: PREVIEW, sections: section({ n: 'lots' }) })[0]).toMatchObject({ status: 'not_checked' });
  });
});

describe('forEach checks', () => {
  const PREVIEW: PreviewReadConfig[] = [{ tool: 'get_item', forEach: 'lines', args: { id: 'item_id' }, attach: 'item', when: 'item_id' }];
  const LIST_PRICE: CheckDeclaration = {
    key: 'list-price', label: 'Line price = list price', forEach: 'lines', when: 'lines[].item_id',
    path: 'lines[].unit_price', compare: { op: 'eq', to: 'lines[].item.list_price' }, onTrue: 'pass', onFalse: 'notice',
    detail: 'line {#}: {lines[].unit_price|money} — list price {lines[].item.list_price|money}',
  };

  it('one line per element with an item, positions are the line numbers, money uses the currency arg', () => {
    const args = {
      currency: 'EUR',
      lines: [
        { item_id: 'i1', unit_price: 120 },
        { description: 'free text, no item', unit_price: 50 },
        { item_id: 'i2', unit_price: 95 },
      ],
    };
    const sections: PreviewReadSection[] = [{
      tool: 'get_item', forEach: 'lines', attach: 'item',
      elements: [ok({ list_price: 120 }), { status: 'none', reason: 'no_target' }, ok({ list_price: 110 })],
    }];
    expect(evaluateChecks([LIST_PRICE], { args, declaration: PREVIEW, sections })).toEqual([
      { key: 'list-price', label: 'Line price = list price', status: 'pass', index: 1, value: 120, detail: 'line 1: 120.00 EUR — list price 120.00 EUR' },
      { key: 'list-price', label: 'Line price = list price', status: 'notice', index: 3, value: 95, detail: 'line 3: 95.00 EUR — list price 110.00 EUR' },
    ]);
  });

  it('an element-level `item` the AI sends is never read in place of the item read', () => {
    const args = { lines: [{ item_id: 'i1', unit_price: 95, item: { list_price: 95 } }] };
    const sections: PreviewReadSection[] = [{ tool: 'get_item', forEach: 'lines', attach: 'item', elements: [ok({ list_price: 110 })] }];
    expect(evaluateChecks([LIST_PRICE], { args, declaration: PREVIEW, sections })[0].status).toBe('notice');
    // Read failed → missing (skip by default): no line, and certainly no pass.
    const failed: PreviewReadSection[] = [{ tool: 'get_item', forEach: 'lines', attach: 'item', elements: [{ status: 'unavailable', reason: 'timeout' }] }];
    expect(evaluateChecks([LIST_PRICE], { args, declaration: PREVIEW, sections: failed })).toEqual([]);
  });
});
