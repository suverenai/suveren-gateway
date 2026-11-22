import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { TicketWhatWasDone } from './TicketWhatWasDone';
import type { ExecutionReceipt } from '../lib/sp-client';

// DEC-98/DEC-100 (the picker needs the signed-in app around it; the e2e skeleton journey covers it): before their data is in, these parts are greyed out at their real place, never a "Loading…" line.
describe('first render while loading: a skeleton, not "Loading…"', () => {
  it('a ticket\'s "what was done" panel', () => {
    const receipt = { id: 'r1', tool: 'records__create_record', timestamp: Date.now() } as unknown as ExecutionReceipt;
    const html = renderToString(<TicketWhatWasDone receipt={receipt} manifests={{}} />);
    expect(html).toContain('data-bound="loading"');
    expect(html).toContain('skeleton');
    expect(html).not.toMatch(/Loading(…|\.\.\.)</);
  });
});
