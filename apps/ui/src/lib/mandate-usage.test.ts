import { describe, it, expect } from 'vitest';
import { newestToday, usageLines } from './mandate-usage';
import type { ExecutionReceipt } from './sp-client';

const NOW = new Date('2026-10-22T12:00:00').getTime();
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const ticket = (o: Partial<ExecutionReceipt> & { at: string; count: number; amount?: number }) => ({
  id: 't', authorizationId: 'auth-1', profileId: 'x@1', action: 'erp__create_invoice', executionContext: {},
  cumulativeState: { daily: { count: o.count, amount: o.amount ?? 0 }, monthly: { count: o.count + 3, amount: 0 } },
  timestamp: sec(o.at), ...o,
}) as unknown as ExecutionReceipt;

describe('Covered by — usage from the newest ticket today', () => {
  it('picks the newest ticket of this mandate from today, ties broken by the running count', () => {
    const rs = [
      ticket({ at: '2026-10-22T09:00:00', count: 1 }),
      ticket({ at: '2026-10-22T10:00:00', count: 2 }),
      ticket({ at: '2026-10-22T10:00:00', count: 3 }),
      ticket({ at: '2026-10-21T23:00:00', count: 9 }),
      ticket({ at: '2026-10-22T11:00:00', count: 7, authorizationId: 'auth-2' }),
    ];
    expect(newestToday(rs, 'auth-1', NOW)?.cumulativeState.daily.count).toBe(3);
    expect(newestToday(rs, 'auth-3', NOW)).toBeNull();
  });
  it('says "none yet today" by returning null when the only tickets are old', () => {
    expect(newestToday([ticket({ at: '2026-10-20T10:00:00', count: 4 })], 'auth-1', NOW)).toBeNull();
  });
  it('reads figures as counts when no declared limit governs them', () => {
    const lines = usageLines(ticket({ at: '2026-10-22T10:00:00', count: 2 }), undefined, null);
    expect(lines).toEqual([{ label: 'today', text: '2 calls' }, { label: 'this month', text: '5 calls' }]);
  });
});
