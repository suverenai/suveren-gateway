import { describe, it, expect } from 'vitest';
import type { IntegrationManifest } from './sp-client';
import { renderSummary, approvalSummary, sealedSummary, summaryTemplateProblem } from './approval-summary';

const manifests = [
  {
    id: 'erp', name: 'ERP',
    toolGating: { overrides: { create_quote: { summary: 'Quote of {value|money} net[ — {discount_pct|percent} discount]', display: { currencyField: 'currency' } } } },
  },
  { id: 'crm', name: 'CRM', toolGating: { overrides: { create_contact: { summary: 'New contact {name}[ ({company})]' } } } },
  { id: 'mail', name: 'Mail', toolGating: { overrides: { send_message: { summary: 'Email to {to|list}: {subject}' } } } },
] as unknown as IntegrationManifest[];

describe('renderSummary', () => {
  it('fills values, formats money and percent, keeps optional parts with values', () => {
    expect(renderSummary('Quote of {value|money} net[ — {discount_pct|percent} discount]', { value: 6080, discount_pct: 5, currency: 'EUR' }, { locale: 'en-GB' }))
      .toBe('Quote of 6,080.00 EUR net — 5 % discount');
  });
  it('drops an optional part whose value is empty', () => {
    expect(renderSummary('New contact {name}[ ({company})]', { name: 'J. Kraus' })).toBe('New contact J. Kraus');
  });
  it('first present alternative', () => {
    expect(renderSummary('Change contact {name,id}', { id: 'c-1' })).toBe('Change contact c-1');
  });
  it('null when a required value is missing — never half a sentence', () => {
    expect(renderSummary('Email to {to|list}: {subject}', { to: ['a@b.de'] })).toBeNull();
  });
  it('lists and shortens', () => {
    expect(renderSummary('To {to|list}', { to: ['a', 'b', 'c', 'd'] })).toBe('To a, b +2');
    expect(renderSummary('{text|short}', { text: 'x'.repeat(100) })!.length).toBe(60);
  });
});

describe('approvalSummary', () => {
  it('uses the manifest template', () => {
    expect(approvalSummary('crm__create_contact', { name: 'J. Kraus', company: 'Bavaria' }, manifests)).toBe('New contact J. Kraus (Bavaria)');
  });
  it('falls back to the action name without template, without args, or with a missing value', () => {
    expect(approvalSummary('crm__delete_contact', { id: 'x' }, manifests)).toBe('Delete contact');
    expect(approvalSummary('crm__create_contact', null, manifests)).toBe('Create contact');
    expect(approvalSummary('mail__send_message', { to: ['a@b.de'] }, manifests)).toBe('Send message');
  });
});

describe('summaryTemplateProblem', () => {
  it('accepts the grammar, rejects malformed templates', () => {
    expect(summaryTemplateProblem('Quote of {value|money}[ — {discount_pct|percent}]')).toBeNull();
    expect(summaryTemplateProblem('')).toMatch(/non-empty/);
    expect(summaryTemplateProblem('Hi {name')).toMatch(/unbalanced/);
    expect(summaryTemplateProblem('{a|bold}')).toMatch(/unknown format/);
    expect(summaryTemplateProblem('{a b}')).toMatch(/invalid field path/);
  });
});

describe('sealedSummary — a ticket headline from the approved proposal (no fallback)', () => {
  it('the same sentence the approver saw', () => {
    expect(sealedSummary('crm__create_contact', { name: 'Dora Review' }, manifests)).toBe('New contact Dora Review');
  });
  it('null without args, without a template, or with a required value missing — the ticket keeps its own label', () => {
    expect(sealedSummary('crm__create_contact', null, manifests)).toBeNull();
    expect(sealedSummary('crm__delete_contact', { name: 'x' }, manifests)).toBeNull();
    expect(sealedSummary('mail__send_message', { to: ['a@b.de'] }, manifests)).toBeNull();
  });
});

describe('{path|ref} — the record\'s name alone, never "Name (id…)"', () => {
  it('the name when the card resolved one; the id is under Technical details', () => {
    const t = 'Invoice of {net|money} to {customer_id|ref}';
    expect(renderSummary(t, { net: 10, customer_id: 'c-1007', currency: 'EUR' }, { refName: (p) => (p === 'customer_id' ? 'Steiner GmbH' : undefined) }))
      .toBe('Invoice of 10.00 EUR to Steiner GmbH');
    expect(renderSummary('Change item {id|ref}', { id: '62953e2e-41d8-4b6e-9a1f-0c5d2e8b7a64' }, { refName: () => 'Beratungsstunde' }))
      .toBe('Change item Beratungsstunde');
  });
  it('a short reference only when the record has no name', () => {
    expect(renderSummary('Invoice to {customer_id|ref}', { customer_id: 'c-1007' })).toBe('Invoice to c-1007');
    expect(renderSummary('Change item {id|ref}', { id: '62953e2e-41d8-4b6e-9a1f-0c5d2e8b7a64' })).toBe('Change item 62953e2e…');
    expect(renderSummary('Change item {id|ref}', { id: '62953e2e-41d8-4b6e-9a1f-0c5d2e8b7a64' }, { refName: () => '  ' })).toBe('Change item 62953e2e…');
  });
});

describe('{path|money} — formatted like the card\'s Now / New table', () => {
  it('takes the currency from display.currencyField in the card\'s read ("id.currency")', () => {
    expect(renderSummary('Change price of {id|ref}: {list_price|money}, VAT {vat_rate|percent}',
      { id: '62953e2e-41d8-4b6e-9a1f-0c5d2e8b7a64', list_price: 130, vat_rate: 20 },
      { currencyField: 'id.currency', refName: () => 'Beratungsstunde', attachedBody: (k) => (k === 'id' ? { name: 'Beratungsstunde', currency: 'EUR' } : undefined) }))
      .toBe('Change price of Beratungsstunde: 130.00 EUR, VAT 20 %');
  });
  it('a bound currency arg, thousands grouped, two decimals', () => {
    expect(renderSummary('Change quote: {value|money} net', { value: 1200, currency: 'EUR' })).toBe('Change quote: 1,200.00 EUR net');
  });
  it('no currency known: the amount alone, never a guessed one', () => {
    expect(renderSummary('{list_price|money}', { list_price: 130 }, { currencyField: 'id.currency' })).toBe('130.00');
  });
});
