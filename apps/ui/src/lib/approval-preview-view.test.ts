/**
 * Approval card states (AU5) — every fallback must keep its copy honest and
 * never imply the bound values or the Approve/Reject buttons are gone (the
 * component enforces that separately; this module just must never say
 * anything that would contradict it).
 */
import { describe, it, expect } from 'vitest';
import { previewBoxView, outcomeBoxView } from './approval-preview-view';
import type { OutcomeResponse, PreviewResponse } from './sp-client';

describe('previewBoxView', () => {
  it('none: says no preview was declared, names the system', () => {
    const v = previewBoxView({ status: 'none' }, 'Mollie');
    expect(v.note).toBe('No preview declared for this tool — showing exactly what will be sent to Mollie.');
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
    expect(v.stale!.approvedRendered.fields[0].value).toBe('480');
    expect(v.stale!.currentRendered.fields[0].value).toBe('999');
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
