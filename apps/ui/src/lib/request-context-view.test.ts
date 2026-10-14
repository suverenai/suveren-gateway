/**
 * AU10 — pure view-model builders for the Request + History blocks
 * (doc/au10-request-context.md §3). Asserts the contract's own exact
 * strings where it specifies them.
 */
import { describe, it, expect } from 'vitest';
import { requestBlockView, historyBlockView, splitBodyPreview } from './request-context-view';
import type { RequestResult, HistoryResult } from './sp-client';

describe('requestBlockView', () => {
  it('none — "No request linked."', () => {
    const view = requestBlockView({ status: 'none' });
    expect(view.state).toBe('none');
    expect(view.note).toContain('No request linked');
  });

  it('unreadable — names the reason', () => {
    const result: RequestResult = { status: 'unreadable', reason: 'unknown connector' };
    const view = requestBlockView(result);
    expect(view.note).toBe('Request: link not readable (unknown connector).');
  });

  it('not_found — "this message no longer exists"', () => {
    const view = requestBlockView({ status: 'not_found' });
    expect(view.note).toContain('no longer exists');
  });

  it('ok — meta line, title, attribution all present', () => {
    const result: RequestResult = {
      status: 'ok', connector: 'mail', kind: 'message', implicit: false,
      author: 'J. Kraus', at: '2026-10-14T09:55:00Z', title: 'RF 55 Stillstand', body: 'line1',
      chain: [],
    };
    const view = requestBlockView(result);
    expect(view.state).toBe('ok');
    expect(view.metaLine).toContain('from J. Kraus');
    expect(view.title).toBe('RF 55 Stillstand');
    expect(view.attribution).toBe('— from J. Kraus, not checked');
  });

  it('ok — a long body is split into a preview + "more"', () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const result: RequestResult = { status: 'ok', connector: 'mail', kind: 'message', implicit: false, body, chain: [] };
    const view = requestBlockView(result);
    expect(view.bodyFirst?.split('\n')).toHaveLength(6);
    expect(view.bodyMore).toContain('line 9');
  });

  it('a short body has no "more"', () => {
    const { first, more } = splitBodyPreview('one\ntwo');
    expect(first).toBe('one\ntwo');
    expect(more).toBeUndefined();
  });

  it('implicit (sourceFromArg) is carried through for the component to label differently', () => {
    const result: RequestResult = { status: 'ok', connector: 'mail', kind: 'message', implicit: true, chain: [] };
    expect(requestBlockView(result).implicit).toBe(true);
  });
});

describe('historyBlockView', () => {
  it('no_customer_link', () => {
    const view = historyBlockView({ status: 'no_customer_link' });
    expect(view.state).toBe('no_customer_link');
    expect(view.items).toEqual([]);
  });

  it('no_match (e.g. free-mail sender, no connector matches the key type)', () => {
    const view = historyBlockView({ status: 'no_match' });
    expect(view.state).toBe('no_match');
    expect(view.items).toEqual([]);
  });

  it('unreachable — names the connector', () => {
    const result: HistoryResult = { status: 'unreachable', connectorIds: ['crm'] };
    const view = historyBlockView(result);
    expect(view.note).toContain('crm');
    expect(view.note).toContain('not reachable');
  });

  it('ok with zero items reads as "nothing in the last few days", not an error', () => {
    const result: HistoryResult = { status: 'ok', matches: [{ connectorId: 'crm', matchedKeyType: 'email_domain', matchedKeyValue: 'x.de', items: [] }], unreachableConnectorIds: [] };
    const view = historyBlockView(result);
    expect(view.state).toBe('empty');
  });

  it('ok — items sorted newest-first across connectors, with the match note', () => {
    const result: HistoryResult = {
      status: 'ok',
      matches: [{
        connectorId: 'crm', matchedKeyType: 'email_domain', matchedKeyValue: 'bavaria-umform.de',
        items: [
          { title: 'older', at: '2026-10-10T00:00:00Z', author: 'T. Berger' },
          { title: 'newer', at: '2026-10-13T00:00:00Z', author: 'L. Leitner' },
        ],
      }],
      unreachableConnectorIds: [],
    };
    const view = historyBlockView(result);
    expect(view.state).toBe('ok');
    expect(view.items.map((i) => i.title)).toEqual(['newer', 'older']);
    expect(view.matchNotes[0]).toContain('bavaria-umform.de');
    expect(view.matchNotes[0]).toContain('matched by email domain');
  });

  it('an AI-written item gets the exact contract wording, regardless of its own author field', () => {
    const result: HistoryResult = {
      status: 'ok',
      matches: [{
        connectorId: 'crm', matchedKeyType: 'email_domain', matchedKeyValue: 'x.de',
        items: [{ title: 'Logged reply', author: 'someone else', at: '2026-10-13T14:20:00Z', aiWritten: { at: Date.parse('2026-10-13T14:20:00Z') } }],
      }],
      unreachableConnectorIds: [],
    };
    const view = historyBlockView(result);
    expect(view.items[0].aiWritten).toBe(true);
    expect(view.items[0].attribution).toContain('Written by the AI via Suveren');
    expect(view.items[0].attribution).toContain('not checked');
    expect(view.items[0].attribution).not.toContain('someone else');
  });

  it('a normal (non-AI) item is attributed to its own author, quoted "not checked"', () => {
    const result: HistoryResult = {
      status: 'ok',
      matches: [{ connectorId: 'crm', matchedKeyType: 'email_domain', matchedKeyValue: 'x.de', items: [{ title: 't', author: 'L. Leitner' }] }],
      unreachableConnectorIds: [],
    };
    const view = historyBlockView(result);
    expect(view.items[0].attribution).toBe('— from L. Leitner, not checked');
    expect(view.items[0].aiWritten).toBe(false);
  });

  it('partial reachability: ok items still render, with an unreachable note', () => {
    const result: HistoryResult = {
      status: 'ok',
      matches: [{ connectorId: 'crm', matchedKeyType: 'email_domain', matchedKeyValue: 'x.de', items: [{ title: 't' }] }],
      unreachableConnectorIds: ['other-crm'],
    };
    const view = historyBlockView(result);
    expect(view.state).toBe('ok');
    expect(view.unreachableNote).toContain('other-crm');
  });
});
