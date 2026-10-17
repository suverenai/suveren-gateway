/**
 * UI spec §13.4 + §14 — ticket headline source, the two "What was sent"
 * levels and their edge cases, the "in the ticket" tag, hidden keys, and the
 * Result layout. Pure logic behind components/TicketWhatWasDone.tsx and
 * TicketHeadline.tsx.
 */
import { describe, it, expect } from 'vitest';
import type { IntegrationManifest } from './sp-client';
import type { ToolDisplay } from './approval-view';
import { ticketHeadline, sentView, unsealedExtras, sentRows, inTicket, resultBody } from './ticket-what-was-done';

const manifests = [
  { id: 'crm', name: 'CRM', toolGating: { overrides: { create_contact: { summary: 'Create contact {name}[ ({company})]', actionLabel: 'Contact created' } } } },
  { id: 'mollie', name: 'Mollie', toolGating: { overrides: { CreatePaymentLink: { summary: 'Payment link of {amount|money}: {description}', display: { currencyField: 'currency' } } } } },
] as unknown as IntegrationManifest[];

describe('ticketHeadline — which values the sentence is built from', () => {
  it('automatic: from what this gateway sent', () => {
    expect(ticketHeadline({
      tool: 'crm__create_contact', manifests, label: 'Contact created', approved: false,
      sentArgs: { name: 'Anna Auto', company: 'Drautal Maschinenbau' },
    })).toBe('Create contact Anna Auto (Drautal Maschinenbau)');
  });

  it('approved: from the proposal the approver saw — never from the sent copy', () => {
    expect(ticketHeadline({
      tool: 'crm__create_contact', manifests, label: 'Contact created', approved: true,
      proposalArgs: { name: 'Approved Name' }, sentArgs: { name: 'Other' },
    })).toBe('Create contact Approved Name');
  });

  it('automatic never borrows proposal args', () => {
    expect(ticketHeadline({
      tool: 'crm__create_contact', manifests, label: 'Contact created', approved: false,
      proposalArgs: { name: 'X' }, sentArgs: null,
    })).toBe('Contact created');
  });

  it('falls back to the past-tense label: nothing kept (older ticket), no template, or a value missing', () => {
    expect(ticketHeadline({ tool: 'crm__create_contact', manifests, label: 'Contact created', approved: false, sentArgs: null })).toBe('Contact created');
    expect(ticketHeadline({ tool: 'crm__delete_contact', manifests, label: 'Contact deleted', approved: false, sentArgs: { id: 'c-1' } })).toBe('Contact deleted');
    expect(ticketHeadline({ tool: 'crm__create_contact', manifests, label: 'Contact created', approved: false, sentArgs: { company: 'only' } })).toBe('Contact created');
  });
});

describe('sentView — level choice', () => {
  const base = { offDevice: false, hasHashToCheck: false, hashVerified: null };

  it('off-device wins over everything', () => {
    expect(sentView({ ...base, offDevice: true, sentArgs: { a: 1 } })).toEqual({ level: 'off-device' });
  });

  it('sealed: a signed fingerprint and the bound content to check it — check ok', () => {
    const v = sentView({ ...base, hasHashToCheck: true, hashVerified: true, boundContent: { name: 'Anna' }, sentArgs: { name: 'Anna' }, sentArgsCheck: 'match' });
    expect(v).toMatchObject({ level: 'sealed', check: 'ok', bound: { name: 'Anna' }, extras: null, argsCheck: 'match' });
  });

  it('sealed, local copy changed: check failed (the only red)', () => {
    expect(sentView({ ...base, hasHashToCheck: true, hashVerified: false, boundContent: { name: 'J. Kraus' } }))
      .toMatchObject({ level: 'sealed', check: 'failed' });
  });

  it('recorded: no fingerprint (e.g. a payment link) — the gateway\'s own copy, its journal check passed through', () => {
    expect(sentView({ ...base, sentArgs: { amount: '0.10' }, sentArgsCheck: 'match' }))
      .toEqual({ level: 'recorded', content: { amount: '0.10' }, check: 'match' });
    expect(sentView({ ...base, sentArgs: { amount: '0.10' }, sentArgsCheck: 'mismatch' }))
      .toMatchObject({ level: 'recorded', check: 'mismatch' });
  });

  it('recorded: an older control plane sends no check → unchecked, never match', () => {
    expect(sentView({ ...base, sentArgs: { amount: '0.10' } })).toMatchObject({ level: 'recorded', check: 'unchecked' });
  });

  it('approved ticket: the archived proposal args are what was sent', () => {
    expect(sentView({ ...base, proposalArgs: { name: 'B' }, sentArgsCheck: 'match' }))
      .toEqual({ level: 'recorded', content: { name: 'B' }, check: 'match' });
  });

  it('a ticket with a fingerprint but no local bound content is NOT sealed — recorded at most', () => {
    expect(sentView({ ...base, hasHashToCheck: true, hashVerified: null, sentArgs: { name: 'A' }, sentArgsCheck: 'match' }))
      .toMatchObject({ level: 'recorded' });
  });

  it('bound content without a fingerprint to check: recorded and unchecked, never sealed', () => {
    expect(sentView({ ...base, boundContent: { name: 'A' } })).toEqual({ level: 'recorded', content: { name: 'A' }, check: 'unchecked' });
  });

  it('not kept: older than this release, or too large to keep', () => {
    expect(sentView({ ...base })).toEqual({ level: 'not-kept', reason: 'older' });
    expect(sentView({ ...base, sentArgsOmitted: 'too_large' })).toEqual({ level: 'not-kept', reason: 'too_large' });
  });
});

describe('unsealedExtras — sent values the binding does not cover', () => {
  it('object binding: keys outside it (an email\'s bcc)', () => {
    expect(unsealedExtras({ to: ['a@x'], subject: 'Hi' }, { to: ['a@x'], subject: 'Hi', bcc: ['b@x'] })).toEqual({ bcc: ['b@x'] });
  });
  it('text binding: everything but the bound string', () => {
    expect(unsealedExtras('Hello', { body: 'Hello', to: 'a@x' })).toEqual({ to: 'a@x' });
  });
  it('null when everything is sealed', () => {
    expect(unsealedExtras({ name: 'A' }, { name: 'A' })).toBeNull();
  });
});

describe('sentRows — manifest labels/order, hidden keys, "in the ticket"', () => {
  const display: ToolDisplay = {
    approvalView: { amount: { label: 'Amount', kind: 'money', currencyArg: 'currency' }, description: { label: 'Description' } },
    inputSchema: { properties: { amount: {}, currency: {}, description: {}, reusable: {}, testmode: {} } },
    executionMapping: { amount: 'amount' },
  };

  it('labels and order from the approval view, as on the approval card', () => {
    const rows = sentRows({ testmode: true, description: 'Suveren test charge', amount: '0.10', currency: 'EUR' }, display, {});
    expect(rows.map((r) => r.label)).toEqual(['Amount', 'Description', 'Currency', 'Testmode']);
  });

  it('hides the same keys as the approval card (_source, ticket_id, secrets)', () => {
    const rows = sentRows({ amount: '0.10', _source: { id: 'm-1' }, ticket_id: 't', apiKey: 'k', _imagePreview: 'data:' }, display, {});
    expect(rows.map((r) => r.key)).toEqual(['amount']);
  });

  it('tags a value the signed ticket also carries — "0.10" sent, 0.1 signed', () => {
    const rows = sentRows({ amount: '0.10', description: 'x' }, display, { amount: 0.1, action_type: 'charge' });
    expect(rows.find((r) => r.key === 'amount')?.inTicket).toBe(true);
    expect(rows.find((r) => r.key === 'description')?.inTicket).toBe(false);
  });

  it('no tag when the signed value differs, or the field is not in the ticket', () => {
    expect(sentRows({ amount: '0.20' }, display, { amount: 0.1 })[0].inTicket).toBe(false);
    expect(sentRows({ amount: '0.10' }, display, {})[0].inTicket).toBe(false);
    expect(sentRows({ amount: '0.10' }, { ...display, executionMapping: undefined }, { amount: 0.1 })[0].inTicket).toBe(false);
  });
});

describe('inTicket — mapping kinds', () => {
  it('divisor: cents sent, EUR signed', () => {
    expect(inTicket(1000, { field: 'amount', divisor: 100 }, { amount: 10 })).toBe(true);
    expect(inTicket(1000, { field: 'amount', divisor: 100 }, { amount: 11 })).toBe(false);
  });
  it('join: the list itself is in the ticket', () => {
    expect(inTicket(['a@x', 'b@y'], { field: 'recipients', transform: 'join' }, { recipients: 'a@x,b@y' })).toBe(true);
  });
  it('length / join_domains carry a derivative, not the value — no tag', () => {
    expect(inTicket(['a@x'], { field: 'recipient_count', transform: 'length' }, { recipient_count: 1 })).toBe(false);
    expect(inTicket(['a@x'], { field: 'domains', transform: 'join_domains' }, { domains: 'x' })).toBe(false);
  });
  it('array mapping: any entry carrying the value', () => {
    expect(inTicket(['a@x'], [{ field: 'recipient_count', transform: 'length' }, { field: 'recipients', transform: 'join' }], { recipient_count: 1, recipients: 'a@x' })).toBe(true);
  });
  it('booleans are not coerced to numbers', () => {
    expect(inTicket(true, 'flag', { flag: 1 })).toBe(false);
    expect(inTicket(true, 'flag', { flag: 'true' })).toBe(true);
  });
});

describe('resultBody — what the tool answered', () => {
  it('structuredContent fields as rows', () => {
    expect(resultBody({ ok: true, text: 'ok', structuredContent: { id: 'pl_1', checkoutUrl: 'https://x' } })).toEqual({
      kind: 'rows',
      rows: [{ key: 'id', label: 'Id', value: 'pl_1' }, { key: 'checkoutUrl', label: 'Checkout url', value: 'https://x' }],
    });
  });
  it('a JSON-object text as rows of the same values', () => {
    expect(resultBody({ ok: true, text: '{"id":"c-1042","tags":["a"]}' })).toEqual({
      kind: 'rows',
      rows: [{ key: 'id', label: 'Id', value: 'c-1042' }, { key: 'tags', label: 'Tags', value: '["a"]' }],
    });
  });
  it('otherwise the text as it came', () => {
    expect(resultBody({ ok: false, text: 'Duplicate contact' })).toEqual({ kind: 'text', text: 'Duplicate contact' });
    expect(resultBody({ ok: true, text: '{not json' })).toEqual({ kind: 'text', text: '{not json' });
  });
});

describe('resultBody — only what the answer adds', () => {
  it('leaves out empty values and echoes of what was sent', () => {
    const body = resultBody(
      { ok: true, text: JSON.stringify({ id: 'c-1', name: 'Anna Auto', email: 'a@x.de', phone: null, company: '', tags: [], stage: 'new' }) },
      { name: 'Anna Auto', email: 'a@x.de', type: 'customer' },
    );
    expect(body).toEqual({ kind: 'rows', rows: [
      { key: 'id', label: expect.any(String), value: 'c-1' },
      { key: 'stage', label: expect.any(String), value: 'new' },
    ] });
  });
  it('a changed value is kept even under a sent field name', () => {
    const body = resultBody({ ok: true, text: '{"name":"Anna AUTO"}' }, { name: 'Anna Auto' });
    expect(body.kind === 'rows' && body.rows.map(r => r.value)).toEqual(['Anna AUTO']);
  });
});
