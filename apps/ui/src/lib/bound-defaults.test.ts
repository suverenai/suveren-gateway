import { describe, it, expect } from 'vitest';
import type { ProfileBoundsField } from '@hap/core';
import { minForBound, seedForBound, numericBoundValue } from './bound-defaults';

/**
 * A fresh email mandate used to submit recipient_max = 0 (empty input → 0),
 * which the gatekeeper reads as "no email may have a recipient" — every send
 * refused. The floor is derived from the schema shape, not the field name.
 */
const recipientMax = {
  type: 'number', required: false, unit: 'count',
  boundType: { kind: 'per_transaction', of: 'recipient_count' },
} as unknown as ProfileBoundsField;

const sendDailyMax = {
  type: 'number', required: false, unit: 'count',
  boundType: { kind: 'cumulative_count', window: 'day' },
} as unknown as ProfileBoundsField;

const amountMax = {
  type: 'number', required: true, unit: 'currency:EUR',
  boundType: { kind: 'per_transaction', of: 'amount' },
} as unknown as ProfileBoundsField;

const readMaxAgeDays = {
  type: 'number', required: false, unit: 'days',
  boundType: { kind: 'per_transaction', of: 'age_days' },
} as unknown as ProfileBoundsField;

describe('minForBound', () => {
  it('floors a per-transaction count at 1 — a zero-item transaction cannot exist', () => {
    expect(minForBound(recipientMax)).toBe(1);
  });
  it('leaves cumulative counts and non-count per-transaction bounds at 0', () => {
    expect(minForBound(sendDailyMax)).toBe(0);
    expect(minForBound(amountMax)).toBe(0);
    expect(minForBound(readMaxAgeDays)).toBe(0); // 0 days = today only, legitimate
  });
});

describe('seedForBound', () => {
  it('starts a floor-1 field at 1 when nothing is prefilled', () => {
    expect(seedForBound(recipientMax, undefined)).toBe('1');
  });
  it('keeps other fields empty as before', () => {
    expect(seedForBound(sendDailyMax, undefined)).toBe('');
    expect(seedForBound(amountMax, undefined)).toBe('');
  });
  it('shows a prefilled value unchanged — including a stored 0 — because it is the stored truth', () => {
    expect(seedForBound(recipientMax, 5)).toBe('5');
    expect(seedForBound(recipientMax, 0)).toBe('0');
    expect(seedForBound(sendDailyMax, 20)).toBe('20');
  });
});

describe('numericBoundValue', () => {
  it('never submits 0 for a floor-1 field', () => {
    expect(numericBoundValue(recipientMax, '')).toBe(1);
    expect(numericBoundValue(recipientMax, '0')).toBe(1);
    expect(numericBoundValue(recipientMax, '3')).toBe(3);
  });
  it('keeps the old empty → 0 behaviour for everything else', () => {
    expect(numericBoundValue(sendDailyMax, '')).toBe(0);
    expect(numericBoundValue(amountMax, '250')).toBe(250);
  });
});
