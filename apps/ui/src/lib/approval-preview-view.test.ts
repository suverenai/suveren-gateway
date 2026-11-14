/**
 * Approval card states (AU5) — every fallback must keep its copy honest and
 * never imply the bound values or the Approve/Reject buttons are gone (the
 * component enforces that separately; this module just must never say
 * anything that would contradict it).
 */
import { describe, it, expect } from 'vitest';
import { previewBoxView, outcomeBoxView, boundValuesOpen, sealedTileHeading } from './approval-preview-view';
import type { OutcomeResponse, PreviewResponse } from './sp-client';

describe('previewBoxView', () => {
  it('none: says no preview was declared, names the system', () => {
    const v = previewBoxView({ status: 'none' }, 'Mollie');
    expect(v.note).toBe('No preview declared for this tool — showing exactly what will be sent to Mollie.');
    expect(v.rendered).toBeUndefined();
  });

  it('none/no_target: says the action names no existing record — never "No preview declared"', () => {
    const v = previewBoxView({ status: 'none', reason: 'no_target' }, 'CRM');
    expect(v.note).toBe('This action does not refer to an existing record — nothing to read beforehand. Showing exactly what will be sent to CRM.');
    expect(v.heading).not.toMatch(/no preview declared/i);
    expect(v.rendered).toBeUndefined();
  });

  it('unavailable/no_connector: "on this gateway" (decision 3)', () => {
    const v = previewBoxView({ status: 'unavailable', reason: 'no_connector' }, 'ERP');
    expect(v.note).toBe('Preview not available on this gateway.');
  });

  it('unavailable/connector_error without a message', () => {
    const v = previewBoxView({ status: 'unavailable', reason: 'connector_error' }, 'ERP');
    expect(v.note).toBe('Preview not available.');
  });

  it('unavailable/timeout with a message from the connector', () => {
    const v = previewBoxView({ status: 'unavailable', reason: 'timeout', message: 'slow' }, 'ERP');
    expect(v.note).toBe('Preview not available — slow');
  });

  it('not_found: "Not found in your system" (decision 3)', () => {
    const v = previewBoxView({ status: 'not_found' }, 'ERP');
    expect(v.note).toBe('Not found in your system.');
  });

  it('not_found with a message appends it', () => {
    const v = previewBoxView({ status: 'not_found', message: 'no such quote' }, 'ERP');
    expect(v.note).toBe('Not found in your system — no such quote');
  });

  it('caps a connector message at 500 chars', () => {
    const long = 'x'.repeat(600);
    const v = previewBoxView({ status: 'unavailable', reason: 'connector_error', message: long }, 'ERP');
    expect(v.note.length).toBeLessThan(540);
    expect(v.note.endsWith('…')).toBe(true);
  });

  it('ok without a version: renders the body, names the read tool, no version note', () => {
    const resp: PreviewResponse = {
      status: 'ok',
      integration: 'erp',
      tool: 'get_quote',
      readAt: 1,
      body: { structured: { total: 480 } },
    };
    const v = previewBoxView(resp, 'ERP');
    expect(v.heading).toBe('From ERP, before it runs');
    expect(v.note).toBe('Read by the gateway with get_quote when you opened this card — the AI is not involved.');
    expect(v.rendered?.kind).toBe('structured');
    expect(v.versionNote).toBeUndefined();
    expect(v.stale).toBeUndefined();
  });

  it('ok with a current (non-stale) version: adds the version note, no stale box', () => {
    const resp: PreviewResponse = {
      status: 'ok',
      integration: 'erp',
      tool: 'get_quote',
      readAt: 1,
      body: { structured: { total: 480 } },
      version: { field: 'revision', approved: 1, current: 1, stale: false },
    };
    const v = previewBoxView(resp, 'ERP');
    expect(v.versionNote).toBe('You approve revision 1; if it changes, ERP refuses it.');
    expect(v.stale).toBeUndefined();
  });

  it('ok with a stale version: builds the side-by-side compare from both bodies', () => {
    const resp: PreviewResponse = {
      status: 'ok',
      integration: 'erp',
      tool: 'get_quote',
      readAt: 1,
      body: { structured: { total: 480 } },
      version: {
        field: 'revision',
        approved: 1,
        current: 2,
        stale: true,
        currentBody: { structured: { total: 999 } },
      },
    };
    const v = previewBoxView(resp, 'ERP');
    expect(v.stale).toBeDefined();
    expect(v.stale!.heading).toBe('A newer revision exists (2)');
    expect(v.stale!.approvedLabel).toBe('Revision 1');
    expect(v.stale!.currentLabel).toBe('Revision 2');
    expect(v.stale!.approvedRendered!.fields[0].value).toBe('480');
    expect(v.stale!.currentRendered!.fields[0].value).toBe('999');
    expect(v.stale!.unchangedNote).toBeUndefined();
  });

  it('ok with a stale version but no OTHER field differs: "No visible change in the fields" instead of two empty columns', () => {
    const resp: PreviewResponse = {
      status: 'ok',
      integration: 'erp',
      tool: 'get_quote',
      readAt: 1,
      body: { structured: { total: 480, revision: 1 } },
      version: {
        field: 'revision',
        approved: 1,
        current: 2,
        stale: true,
        currentBody: { structured: { total: 480, revision: 2 } },
      },
    };
    const v = previewBoxView(resp, 'ERP');
    expect(v.stale!.unchangedNote).toBe('No visible change in the fields.');
    expect(v.stale!.approvedRendered).toBeUndefined();
    expect(v.stale!.currentRendered).toBeUndefined();
  });

  it('a real 15-field get_quote: the declared `fields` (manifest) decide what is shown first, and stale compares only what differs', () => {
    const FIELDS = ['number', 'revision', 'status', 'lines', 'net_total'];
    const approvedBody = {
      structured: { id: 'q-1', number: 'Q-0001', revision: 1, status: 'draft', net_total: 480, lines: [{ qty: 4 }], extra: 'x' },
    };
    const currentBody = {
      structured: { id: 'q-1', number: 'Q-0001', revision: 2, status: 'draft', net_total: 480, lines: [{ qty: 2 }], extra: 'x' },
    };
    const resp: PreviewResponse = {
      status: 'ok', integration: 'erp', tool: 'get_quote', readAt: 1,
      body: approvedBody, fields: FIELDS,
      version: { field: 'revision', approved: 1, current: 2, stale: true, currentBody },
    };
    const v = previewBoxView(resp, 'ERP');
    // Main render: declared fields first, in order.
    expect(v.rendered?.fields.map((f) => f.key)).toEqual(FIELDS);
    // Stale compare: only `lines` actually differs (revision excluded).
    expect(v.stale!.approvedRendered!.fields.map((f) => f.key)).toEqual(['lines']);
    expect(v.stale!.currentRendered!.fields.map((f) => f.key)).toEqual(['lines']);
  });
});

describe('outcomeBoxView', () => {
  const base: OutcomeResponse = { state: 'none' };

  it('none: nothing to show', () => {
    expect(outcomeBoxView(base, 'ERP')).toBeNull();
  });

  it('intent: nothing to show (still mid-flight)', () => {
    expect(outcomeBoxView({ state: 'intent' }, 'ERP')).toBeNull();
  });

  it('done: nothing to show — the normal executed state speaks for itself', () => {
    expect(outcomeBoxView({ state: 'done' }, 'ERP')).toBeNull();
  });

  it('failed/refused without detail', () => {
    const v = outcomeBoxView({ state: 'failed', outcome: 'refused' }, 'ERP');
    expect(v).toEqual({
      heading: 'Refused by ERP',
      note: 'ERP refused it — nothing was done. Ask the AI to request it again.',
    });
  });

  it('failed/refused with the connector\'s own detail text', () => {
    const v = outcomeBoxView({ state: 'failed', outcome: 'refused', detail: 'quote is at revision 2' }, 'ERP');
    expect(v!.note).toBe('ERP refused it: quote is at revision 2 — nothing was done. Ask the AI to request it again.');
  });

  it('failed/changed: never says "Review revision 2" — asks the AI to request it again', () => {
    const v = outcomeBoxView({ state: 'failed', outcome: 'changed' }, 'ERP');
    expect(v!.heading).toBe('Changed since your approval');
    expect(v!.note).toContain('Ask the AI to request it again');
    expect(v!.note).not.toMatch(/review/i);
  });

  it('caps the connector detail at 500 chars', () => {
    const long = 'y'.repeat(600);
    const v = outcomeBoxView({ state: 'failed', outcome: 'refused', detail: long }, 'ERP');
    expect(v!.note.length).toBeLessThan(580);
  });
});

describe('previewBoxView — AU8 several reads ("reads" in the response)', () => {
  const readsResp: PreviewResponse = {
    status: 'ok', integration: 'erp', readAt: new Date('2026-10-13T10:42:00').getTime(),
    reads: [{ tool: 'get_customer', attach: 'customer_id', result: { status: 'ok', body: { text: '{"id":"cust-1","name":"X"}' } } }],
  };

  it('a different heading than the single-read box, and builds a `creation` view instead of `rendered`', () => {
    const v = previewBoxView(readsResp, 'ERP', { customer_id: 'cust-1' });
    expect(v.heading).toBe('What will be created in ERP');
    expect(v.creation).toBeDefined();
    expect(v.rendered).toBeUndefined();
  });

  it('the note says when the context was read, not which single tool (there may be several)', () => {
    const v = previewBoxView(readsResp, 'ERP', { customer_id: 'cust-1' });
    expect(v.note).toMatch(/read at \d{1,2}:\d{2}/i);
    expect(v.note).toContain('not by the AI');
  });

  it('no "read by the gateway" note when the box shows only the sealed proposal (nothing was read into it)', () => {
    const onlyDisplayOnly: PreviewResponse = { status: 'ok', integration: 'erp', readAt: 0,
      reads: [{ tool: 'check_vat_id', attach: 'uid', displayOnly: true, result: { status: 'ok', body: { structured: { format: 'ok' } } } },
              { tool: 'dups', as: 'duplicates', result: { status: 'ok', body: { structured: { vat_duplicate_of: null } } } }] };
    const v = previewBoxView(onlyDisplayOnly, 'ERP', { name: 'Steiner GmbH', uid: 'ATU1' });
    expect(v.note).toBe('');
    // …and an attach that did not resolve is no gateway value either.
    const unresolved: PreviewResponse = { ...readsResp, reads: [{ tool: 'get_customer', attach: 'customer_id', result: { status: 'not_found' } }] };
    expect(previewBoxView(unresolved, 'ERP', { customer_id: 'x' }).note).toBe('');
  });

  it('heading verb from the manifest: "changed" for an update', () => {
    const v = previewBoxView({ ...readsResp, display: { verb: 'changed' } } as PreviewResponse, 'ERP', { customer_id: 'cust-1' });
    expect(v.heading).toBe('What will be changed in ERP');
  });

  it('works with no toolArgs at all (defensive — the creation view just has nothing to merge)', () => {
    expect(() => previewBoxView(readsResp, 'ERP')).not.toThrow();
  });
});

describe('boundValuesOpen — the bound values are the content when nothing else shows it', () => {
  it('open when no preview is declared, unavailable or not found', async () => {
    const { boundValuesOpen } = await import('./approval-preview-view');
    for (const tone of ['none', 'unavailable', 'not_found']) expect(boundValuesOpen(tone)).toBe(true);
  });
  it('folded while a working preview shows the record (ok, stale) or while still loading', async () => {
    const { boundValuesOpen } = await import('./approval-preview-view');
    for (const tone of ['ok', 'stale', 'loading', null]) expect(boundValuesOpen(tone)).toBe(false);
  });
});

describe('a refused read', () => {
  it('single read: "Refused by <system>" with the connector\'s words', () => {
    const v = previewBoxView({ status: 'refused', message: 'Refused: outside the EU.' }, 'ERP');
    expect(v.heading).toBe('Refused by ERP');
    expect(v.note).toBe('Refused: outside the EU.');
  });
  it('one of several reads: its section says the refusal, not "Not found"', async () => {
    const { buildOwnSection } = await import('./preview-render');
    expect(buildOwnSection({ tool: 'preview_invoice', result: { status: 'refused', message: 'Refused: outside the EU.' } })?.note).toBe('Refused: outside the EU.');
  });
});

// Walkthrough 2026-11-11: an update's card listed the contact as it is ("Name:
// Andreas", revision 1, every field) under "Runs exactly as shown" — the change
// to "Andreas Schadauer" was nowhere to be seen.
describe('an update shows its change, old → new', () => {
  const contact: PreviewResponse = {
    status: 'ok', integration: 'crm', tool: 'get_contact', readAt: 1, target: true,
    body: { structured: { id: 'c-1', name: 'Andreas', company: 'Sublin', email: 'a@x.at', revision: 1 } },
    fields: ['name', 'company', 'email', 'revision'],
    version: { field: 'revision', approved: 1, current: 1, stale: false },
  };
  const args = { id: 'c-1', revision: 1, name: 'Andreas Schadauer', contact_type: 'customer', ticket_id: 't' };

  it('the changed field is now → new; unchanged fields are folded apart; the record itself is not shown as what runs', () => {
    const v = previewBoxView(contact, 'CRM', args);
    expect(v.heading).toBe('What will be changed in CRM');
    expect(v.rendered).toBeUndefined();
    expect(v.change?.lines).toEqual([{ key: 'name', label: 'Name', now: 'Andreas', next: 'Andreas Schadauer' }]);
    expect(v.change?.unchanged.fields.map((f) => f.key)).toEqual(['company', 'email', 'revision']);
    // Bound, but not a field of the record: sent as it is. The gateway's own ticket_id never shows.
    expect(v.change?.also).toEqual([{ key: 'contact_type', label: 'Contact type', value: 'customer' }]);
    expect(v.versionNote).toBe('You approve revision 1; if it changes, CRM refuses it.');
  });

  it('a read that is not the changed record (no target) stays the record, and the bound values open beside it', () => {
    const { target: _t, ...linked } = contact as Extract<PreviewResponse, { tool: string }>;
    const v = previewBoxView(linked as PreviewResponse, 'CRM', { contact_id: 'c-1', name: 'Call' });
    expect(v.change).toBeUndefined();
    expect(v.rendered?.kind).toBe('structured');
    expect(boundValuesOpen('ok', v)).toBe(true);
  });

  it('nothing changes (archive by id + revision): the record, with the bound values open', () => {
    const v = previewBoxView(contact, 'CRM', { id: 'c-1', revision: 1, contact_type: 'customer' });
    expect(v.change).toBeUndefined();
    expect(v.rendered?.kind).toBe('structured');
    expect(boundValuesOpen('ok', v)).toBe(true);
  });

  it('a change view keeps the bound values folded — the table already shows them', () => {
    expect(boundValuesOpen('ok', previewBoxView(contact, 'CRM', args))).toBe(false);
  });
});

describe('the gateway\'s own description of a proposal stays what is signed', () => {
  it('a builtin describe read (describesProposal) is not context: the bound values stay folded', () => {
    const resp: PreviewResponse = { status: 'ok', integration: 'setup', tool: 'describe_mandate_proposal', readAt: 1, describesProposal: true, body: { structured: { profile: 'x' } } };
    const v = previewBoxView(resp, 'Setup', { profile: 'x' });
    expect(v.rendered?.kind).toBe('structured');
    expect(v.context).toBeUndefined();
    expect(boundValuesOpen('ok', v)).toBe(false);
  });
});

// Andreas 2026-11-11: "You approve this change" over a Now → New table, and ERP
// updates (previews that are lists of reads) get the same table.
describe('the change heading and changes in a list of reads', () => {
  const item = (target: boolean): PreviewResponse => ({
    status: 'ok', integration: 'erp', readAt: 1,
    reads: [{
      tool: 'get_item', attach: 'id', ...(target ? { target: true as const } : {}),
      result: { status: 'ok', body: { structured: { id: 'i-1', name: 'Paper', list_price: 10, vat_rate: 20, currency: 'EUR', revision: 3 } } },
    }],
    display: { verb: 'changed', money: ['list_price', 'id.list_price'], percent: ['vat_rate', 'id.vat_rate'], currencyField: 'id.currency', labels: { id: 'Item', list_price: 'List price', vat_rate: 'VAT rate' } },
  });
  const args = { id: 'i-1', revision: 3, list_price: 12, vat_rate: 20 };

  it('the versioned read is the record: List price now → new, once', () => {
    const v = previewBoxView(item(true), 'ERP', args);
    const rows = v.creation!.rows;
    const compare = rows.filter((r) => r.kind === 'compare');
    expect(compare).toHaveLength(1);
    expect((compare[0] as { lines: unknown[] }).lines).toEqual([{ key: 'list_price', label: 'List price', now: '10.00 EUR', next: '12.00 EUR' }]);
    expect(rows.some((r) => r.key === 'list_price' && r.kind === 'scalar')).toBe(false);
    // The record's own context does not repeat the changed field.
    const identity = rows.find((r) => r.kind === 'identity') as { identity: { context: Array<{ key: string }> } };
    expect(identity.identity.context.map((c) => c.key)).not.toContain('list_price');
    expect(sealedTileHeading(v, false)).toBe('You approve this change');
  });

  it('a row is labelled with the manifest\'s own label for the argument (round 3)', () => {
    const v = previewBoxView(item(true), 'ERP', { ...args, vat_rate: 10 });
    const compare = v.creation!.rows.find((r) => r.kind === 'compare') as { lines: Array<{ key: string; label: string; now: string; next: string }> };
    expect(compare.lines.find((l) => l.key === 'vat_rate')).toEqual({ key: 'vat_rate', label: 'VAT rate', now: '20 %', next: '10 %' });
  });

  // Round 4 (Andreas 2026-11-11): as calm as the CRM card.
  it('the record by its name only, then Now → New; equal values and the version are not rows', () => {
    const withVersion = { ...item(true) } as Extract<PreviewResponse, { reads: unknown }>;
    withVersion.reads = [{ ...withVersion.reads[0], versionArg: 'revision', version: { field: 'revision', approved: 3, current: 3, stale: false } }];
    const v = previewBoxView(withVersion as PreviewResponse, 'ERP', args);
    const rows = v.creation!.rows;
    expect(rows.map((r) => r.kind)).toEqual(['identity', 'compare']);
    const identity = (rows[0] as { identity: { name?: string; nameOnly?: boolean; context: unknown[] } }).identity;
    expect(identity).toMatchObject({ name: 'Paper', nameOnly: true, context: [] });
    // VAT 20 → 20 is unchanged: folded with the record's other fields, not a row.
    const unchanged = v.creation!.unchanged!;
    expect([...unchanged.fields, ...unchanged.moreFields].map((f) => f.key)).toEqual(expect.arrayContaining(['vat_rate', 'name', 'currency', 'revision']));
    expect([...unchanged.fields, ...unchanged.moreFields].map((f) => f.key)).not.toContain('list_price');
    expect(v.versionNote).toBe('You approve revision 3; if it changes, ERP refuses it.');
  });

  it('a bound value the record does not carry is still a row, after the change', () => {
    const v = previewBoxView(item(true), 'ERP', { ...args, note: 'Spring prices' });
    expect(v.creation!.rows.map((r) => `${r.kind}:${r.key}`)).toEqual(['identity:id', 'compare:compare', 'scalar:note']);
  });

  it('without a version on the read nothing is shown as a change', () => {
    const v = previewBoxView(item(false), 'ERP', args);
    expect(v.creation!.rows.some((r) => r.kind === 'compare')).toBe(false);
    expect(sealedTileHeading(v, false)).toBe('Runs exactly as shown');
  });

  it('a manifest that declares display.compare keeps its own rows; the change is not shown twice', () => {
    const resp = item(true) as Extract<PreviewResponse, { reads: unknown }>;
    const declared = { ...resp, display: { ...resp.display, compare: { vat_rate: 'id.vat_rate' } } } as PreviewResponse;
    const rows = previewBoxView(declared, 'ERP', args).creation!.rows;
    const compare = rows.filter((r) => r.kind === 'compare') as Array<{ lines: Array<{ key: string }> }>;
    expect(compare).toHaveLength(1);
    expect(compare[0].lines.map((l) => l.key)).toEqual(['vat_rate']);
  });

  it('a single read shown as a change gets the change heading; a record or a mandate keeps its own', () => {
    const crm: PreviewResponse = {
      status: 'ok', integration: 'crm', tool: 'get_contact', readAt: 1, target: true,
      body: { structured: { id: 'c-1', name: 'Andreas', revision: 1 } },
    };
    expect(sealedTileHeading(previewBoxView(crm, 'CRM', { id: 'c-1', revision: 1, name: 'Andreas Schadauer' }), false)).toBe('You approve this change');
    expect(sealedTileHeading(previewBoxView(crm, 'CRM', { id: 'c-1', revision: 1 }), false)).toBe('Runs exactly as shown');
    expect(sealedTileHeading(undefined, true)).toBe('You sign this');
  });
});
