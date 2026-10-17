import { describe, it, expect } from 'vitest';
import type { IntegrationManifest } from './sp-client';
import { renderSummary, approvalSummary, sealedSummary, summaryTemplateProblem } from './approval-summary';

const manifests = [
  {
    id: 'erp', name: 'ERP',
    toolGating: { overrides: { create_quote: { summary: 'Quote of {value|money} net[ — {discount_pct|percent} discount]', display: { currencyField: 'currency' } } } },
  },
  { id: 'crm', name: 'CRM', toolGating: { overrides: { create_contact: { summary: 'Create contact {name}[ ({company})]' } } } },
  { id: 'mail', name: 'Mail', toolGating: { overrides: { send_message: { summary: 'Email to {to|list}: {subject}' } } } },
] as unknown as IntegrationManifest[];

describe('renderSummary', () => {
  it('fills values, formats money and percent, keeps optional parts with values', () => {
    expect(renderSummary('Quote of {value|money} net[ — {discount_pct|percent} discount]', { value: 6080, discount_pct: 5, currency: 'EUR' }, { locale: 'en-GB' }))
      .toBe('Quote of €6,080.00 net — 5% discount');
  });
  it('drops an optional part whose value is empty', () => {
    expect(renderSummary('Create contact {name}[ ({company})]', { name: 'J. Kraus' })).toBe('Create contact J. Kraus');
  });
  it('first present alternative', () => {
    expect(renderSummary('Update contact {name,id}', { id: 'c-1' })).toBe('Update contact c-1');
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
    expect(approvalSummary('crm__create_contact', { name: 'J. Kraus', company: 'Bavaria' }, manifests)).toBe('Create contact J. Kraus (Bavaria)');
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
    expect(sealedSummary('crm__create_contact', { name: 'Dora Review' }, manifests)).toBe('Create contact Dora Review');
  });
  it('null without args, without a template, or with a required value missing — the ticket keeps its own label', () => {
    expect(sealedSummary('crm__create_contact', null, manifests)).toBeNull();
    expect(sealedSummary('crm__delete_contact', { name: 'x' }, manifests)).toBeNull();
    expect(sealedSummary('mail__send_message', { to: ['a@b.de'] }, manifests)).toBeNull();
  });
});
