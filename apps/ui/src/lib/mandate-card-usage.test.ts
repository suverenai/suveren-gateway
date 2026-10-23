import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import type { ExecutionReceipt } from './sp-client';
import { coversToday, ticketsUnder, usedToday } from './mandate-card-usage';

const NOW = new Date('2026-10-23T12:00:00').getTime();
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

const PROFILE = {
  boundsSchema: {
    keyOrder: [],
    fields: {
      quotes_daily_max: { type: 'number', boundType: { kind: 'cumulative_count', window: 'daily' } },
      max_value: { type: 'number', boundType: { kind: 'per_transaction', of: 'amount' } },
    },
  },
} as unknown as AgentProfile;

const BOUNDS = { quotes_daily_max: 5, max_value: 3000 };

const ticket = (over: Partial<ExecutionReceipt>): ExecutionReceipt => ({
  id: 't', authorizationId: 'a1', profileId: 'sales@0.4', action: 'erp__create_quote',
  timestamp: sec('2026-10-23T09:00:00'), cumulativeState: { daily: { count: 2, amount: 0 } },
  ...over,
} as unknown as ExecutionReceipt);

describe('coversToday', () => {
  it('is true when the page is not full', () => {
    expect(coversToday([ticket({})], NOW, 200)).toBe(true);
  });
  it('is false when a full page is entirely today', () => {
    expect(coversToday([ticket({ id: 'a' }), ticket({ id: 'b' })], NOW, 2)).toBe(false);
  });
  it('is true when a full page reaches back before today', () => {
    expect(coversToday([ticket({}), ticket({ timestamp: sec('2026-10-20T09:00:00') })], NOW, 2)).toBe(true);
  });
});

describe('ticketsUnder', () => {
  it('keeps only this mandate, newest first', () => {
    const out = ticketsUnder([
      ticket({ id: 'old', timestamp: 10 }), ticket({ id: 'other', authorizationId: 'a2' }), ticket({ id: 'new', timestamp: 20 }),
    ], 'a1');
    expect(out.map(r => r.id)).toEqual(['new', 'old']);
  });
});

describe('usedToday', () => {
  it('reads the running figure from the newest ticket today, on the bound that governs it', () => {
    const out = usedToday({ receipts: [ticket({})], coversToday: true, authorizationId: 'a1', bounds: BOUNDS, profile: PROFILE, nowMs: NOW });
    expect(out).toEqual({ quotes_daily_max: '2 used today' });
  });
  it('says 0 used only when no ticket today AND the read covers today', () => {
    const none = { receipts: [], authorizationId: 'a1', bounds: BOUNDS, profile: PROFILE, nowMs: NOW };
    expect(usedToday({ ...none, coversToday: true })).toEqual({ quotes_daily_max: '0 used today' });
    expect(usedToday({ ...none, coversToday: false })).toEqual({});
  });
  it('shows nothing without bounds', () => {
    expect(usedToday({ receipts: [], coversToday: true, authorizationId: 'a1', bounds: undefined, profile: PROFILE, nowMs: NOW })).toEqual({});
  });
});
