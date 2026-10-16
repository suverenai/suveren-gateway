/**
 * `_source` (the AI's link to the request, AU10) is stripped by the gateway
 * before execution — it is never sent, so it must never appear among the
 * values shown as "What will be sent" / "What will be created", in either
 * render path. Same for the ticket reference.
 */
import { describe, it, expect } from 'vitest';
import { argRows } from './approval-view';
import { buildCreationView } from './preview-render';

const args = {
  to: ['m.huber@drautal-antriebe.example'],
  subject: 'AW: Bestellung',
  in_reply_to: 'eabaaf3c-03df',
  _source: { connector: 'mail', kind: 'message', id: 'eabaaf3c-03df' },
  ticket_id: 'tkt_1',
};

describe('values never sent are never shown as sent', () => {
  it('argRows (the plain "What will be sent" path) omits _source and ticket_id', () => {
    const keys = argRows(args).map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['to', 'subject', 'in_reply_to']));
    expect(keys).not.toContain('_source');
    expect(keys).not.toContain('ticket_id');
  });

  it('buildCreationView (the "What will be created" path) omits _source and ticket_id', () => {
    const view = buildCreationView(args, [], undefined);
    const keys = view.rows.map((r) => r.key);
    expect(keys).not.toContain('_source');
    expect(keys).not.toContain('ticket_id');
    expect(keys).toContain('subject');
  });
});
