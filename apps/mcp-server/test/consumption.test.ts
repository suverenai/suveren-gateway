import { describe, it, expect, vi } from 'vitest';
import { getConsumptionState, formatConsumptionCompact, formatConsumptionFull, type ConsumptionEntry } from '../src/lib/consumption';
import type { EnrichedAuthorization } from '../src/lib/shared-state';
import type { ExecutionLog } from '../src/lib/execution-log';
import type { AgentProfile } from '@hap/core';

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockAuth(overrides: Partial<EnrichedAuthorization> = {}): EnrichedAuthorization {
  const now = Math.floor(Date.now() / 1000);
  return {
    frameHash: 'sha256:abc',
    profileId: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
    path: 'charge-routine',
    frame: {
      profile: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
      path: 'charge-routine',
      amount_max: 100,
      amount_daily_max: 500,
      amount_monthly_max: 5000,
      transaction_count_daily_max: 20,
    },
    attestations: [{ domain: 'finance', blob: 'blob', expiresAt: now + 3600 }],
    requiredDomains: ['finance'],
    attestedDomains: ['finance'],
    deferredCommitmentDomains: [],
    complete: true,
    gateContent: null,
    ...overrides,
  };
}

/**
 * v0.4 charge-like profile with explicit boundType on every bound.
 * The profile no longer mirrors its cumulative bounds through the
 * execution context schema — the bounds themselves carry the
 * enforcement semantics.
 */
function mockChargeProfile(): AgentProfile {
  return {
    id: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
    version: '0.4',
    description: 'Financial authority',
    boundsSchema: {
      keyOrder: ['profile', 'amount_max', 'amount_daily_max', 'amount_monthly_max', 'transaction_count_daily_max'],
      fields: {
        profile: { type: 'string', required: true },
        amount_max: {
          type: 'number',
          required: true,
          description: 'Maximum amount per transaction',
          boundType: { kind: 'per_transaction', of: 'amount' },
        },
        amount_daily_max: {
          type: 'number',
          required: true,
          description: 'Running daily charge total',
          boundType: { kind: 'cumulative_sum', of: 'amount', window: 'daily' },
        },
        amount_monthly_max: {
          type: 'number',
          required: true,
          description: 'Running monthly charge total',
          boundType: { kind: 'cumulative_sum', of: 'amount', window: 'monthly' },
        },
        transaction_count_daily_max: {
          type: 'number',
          required: true,
          description: 'Running daily transaction count',
          boundType: { kind: 'cumulative_count', window: 'daily' },
        },
      },
    },
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 86400, max: 86400 },
    retention_minimum: 7776000,
  };
}

function mockLog(returnValues: Record<string, number> = {}): ExecutionLog {
  return {
    sumByWindow: vi.fn().mockImplementation(
      (_profileId: string, _path: string, field: string, _window: string) => {
        return returnValues[field] ?? 0;
      },
    ),
    record: vi.fn(),
    getAll: () => [],
    size: 0,
  } as unknown as ExecutionLog;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('getConsumptionState (v0.4 bound-driven)', () => {
  it('returns entries for each cumulative bound with limits from the authorization frame', () => {
    const auth = mockAuth();
    const profile = mockChargeProfile();
    const log = mockLog({ amount: 234.5, _count: 8 });

    const entries = getConsumptionState(auth, log, profile);

    // 3 cumulative bounds: amount_daily_max, amount_monthly_max, transaction_count_daily_max
    // The per_transaction amount_max is not a cumulative bound and is skipped.
    expect(entries).toHaveLength(3);

    const byField = Object.fromEntries(entries.map(e => [e.field, e]));

    expect(byField.amount_daily_max).toMatchObject({
      field: 'amount_daily_max',
      current: 234.5,
      limit: 500,
      window: 'daily',
      kind: 'sum',
      of: 'amount',
    });
    expect(byField.amount_monthly_max).toMatchObject({
      field: 'amount_monthly_max',
      current: 234.5,
      limit: 5000,
      window: 'monthly',
      kind: 'sum',
      of: 'amount',
    });
    expect(byField.transaction_count_daily_max).toMatchObject({
      field: 'transaction_count_daily_max',
      current: 8,
      limit: 20,
      window: 'daily',
      kind: 'count',
    });
  });

  it('returns empty array for undefined profile', () => {
    const entries = getConsumptionState(mockAuth(), mockLog(), undefined);
    expect(entries).toEqual([]);
  });

  it('returns empty array for profile with no boundsSchema', () => {
    const profile = {
      ...mockChargeProfile(),
      boundsSchema: undefined,
    } as unknown as AgentProfile;
    const entries = getConsumptionState(mockAuth(), mockLog(), profile);
    expect(entries).toEqual([]);
  });

  it('sets limit to null when the authorization frame has no value for a cumulative bound', () => {
    const auth = mockAuth({
      frame: {
        profile: 'github.com/humanagencyprotocol/hap-profiles/charge@0.4',
        path: 'charge-routine',
        amount_max: 100,
        // amount_daily_max intentionally omitted
      },
    });
    const profile = mockChargeProfile();
    const log = mockLog({ amount: 50 });

    const entries = getConsumptionState(auth, log, profile);
    const dailyEntry = entries.find(e => e.field === 'amount_daily_max');
    expect(dailyEntry?.limit).toBeNull();
    expect(dailyEntry?.current).toBe(50);
  });

  it('works with non-standard bound field names (no _max suffix parsing)', () => {
    // Records-style profile where the bound name doesn't follow the
    // amount_*_max convention. Pre-v0.4 code would strip "_max" and
    // guess at execution-context field names, which broke for this
    // kind of naming. The boundType-driven approach doesn't care.
    const profile: AgentProfile = {
      id: 'test/records@0.4',
      version: '0.4',
      description: 'Records',
      boundsSchema: {
        keyOrder: ['profile', 'write_daily_max'],
        fields: {
          profile: { type: 'string', required: true },
          write_daily_max: {
            type: 'number',
            required: true,
            description: 'Daily writes',
            boundType: { kind: 'cumulative_count', window: 'daily' },
          },
        },
      },
      executionContextSchema: { fields: {} },
      requiredGates: [],
      ttl: { default: 86400, max: 86400 },
      retention_minimum: 7776000,
    };
    const auth = mockAuth({
      profileId: 'test/records@0.4',
      frame: { profile: 'test/records@0.4', write_daily_max: 5 },
    });
    const log = mockLog({ _count: 3 });

    const entries = getConsumptionState(auth, log, profile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      field: 'write_daily_max',
      current: 3,
      limit: 5,
      kind: 'count',
    });
  });
});

describe('formatConsumptionCompact (v0.4 kind-driven)', () => {
  it('formats a mix of sum and count entries with currency prefix for amount sums', () => {
    const entries: ConsumptionEntry[] = [
      {
        label: 'Running daily charge total',
        current: 234,
        limit: 500,
        window: 'daily',
        field: 'amount_daily_max',
        kind: 'sum',
        of: 'amount',
        currency: 'EUR',
      },
      {
        label: 'Running monthly charge total',
        current: 1280,
        limit: 5000,
        window: 'monthly',
        field: 'amount_monthly_max',
        kind: 'sum',
        of: 'amount',
        currency: 'EUR',
      },
      {
        label: 'Running daily transaction count',
        current: 8,
        limit: 20,
        window: 'daily',
        field: 'transaction_count_daily_max',
        kind: 'count',
      },
    ];

    const result = formatConsumptionCompact(entries);
    expect(result).toBe('234.00 EUR/500.00 EUR daily, 1280.00 EUR/5000.00 EUR monthly, 8/20 daily');
  });

  it('a sum without a known currency shows no currency — none is guessed', () => {
    const entries: ConsumptionEntry[] = [
      {
        label: 'Running daily spend',
        current: 42,
        limit: 100,
        window: 'daily',
        field: 'spend_daily_max',
        kind: 'sum',
        of: 'spend',
      },
    ];
    expect(formatConsumptionCompact(entries)).toBe('42/100 daily');
  });

  it('omits currency prefix for non-currency sums', () => {
    const entries: ConsumptionEntry[] = [
      {
        label: 'Running daily tokens',
        current: 1500,
        limit: 10000,
        window: 'daily',
        field: 'tokens_daily_max',
        kind: 'sum',
        of: 'tokens',
      },
    ];
    expect(formatConsumptionCompact(entries)).toBe('1500/10000 daily');
  });

  it('returns empty string for no entries', () => {
    expect(formatConsumptionCompact([])).toBe('');
  });

  it('skips entries with null limit', () => {
    const entries: ConsumptionEntry[] = [
      {
        label: 'Some field',
        current: 10,
        limit: null,
        window: 'daily',
        field: 'amount_daily_max',
        kind: 'sum',
        of: 'amount',
      },
    ];
    expect(formatConsumptionCompact(entries)).toBe('');
  });
});

describe('money sums: currency and float noise (2026-10-17: "$0.30000000000000004/$100" on an EUR mandate)', () => {
  const euro = (current: number, limit: number): ConsumptionEntry => ({
    label: 'Monthly charge limit', current, limit, window: 'monthly',
    field: 'amount_monthly_max', kind: 'sum', of: 'amount', currency: 'EUR',
  });

  it('three 0.10 charges read 0.30 EUR, never a float tail or a dollar sign', () => {
    const entries = [euro(0.1 + 0.1 + 0.1, 100)];
    expect(formatConsumptionCompact(entries)).toBe('0.30 EUR/100.00 EUR monthly');
    expect(formatConsumptionFull(entries)).toContain('0.30 EUR / 100.00 EUR');
  });

  it('a non-money sum loses the float tail too', () => {
    const e: ConsumptionEntry = { ...euro(0.1 + 0.2, 10), currency: undefined };
    expect(formatConsumptionCompact([e])).toBe('0.3/10 monthly');
  });

  it("the currency comes from the mandate's own currency first, else the bound's declared unit", () => {
    const log = { sumByWindow: vi.fn().mockReturnValue(0.1 + 0.2) } as unknown as ExecutionLog;
    const profile = mockChargeProfile();
    (profile.boundsSchema!.fields.amount_monthly_max as { unit?: string }).unit = 'currency:EUR';

    const fromUnit = getConsumptionState(mockAuth(), log, profile).find(e => e.field === 'amount_monthly_max');
    expect(fromUnit?.currency).toBe('EUR');

    const auth = mockAuth();
    auth.frame = { ...auth.frame, currency: 'CHF' };
    const fromMandate = getConsumptionState(auth, log, profile).find(e => e.field === 'amount_monthly_max');
    expect(fromMandate?.currency).toBe('CHF');
    expect(formatConsumptionCompact([fromMandate!])).toBe('0.30 CHF/5000.00 CHF monthly');

    const count = getConsumptionState(auth, log, profile).find(e => e.kind === 'count');
    expect(count?.currency).toBeUndefined();
  });

  it('no mandate currency and no unit: no currency at all', () => {
    const log = { sumByWindow: vi.fn().mockReturnValue(5) } as unknown as ExecutionLog;
    const e = getConsumptionState(mockAuth(), log, mockChargeProfile()).find(x => x.field === 'amount_daily_max');
    expect(e?.currency).toBeUndefined();
  });
});

describe('formatConsumptionFull', () => {
  it('formats entries with aligned labels and concrete limits', () => {
    const entries: ConsumptionEntry[] = [
      {
        label: 'Running daily charge total',
        current: 234,
        limit: 500,
        window: 'daily',
        field: 'amount_daily_max',
        kind: 'sum',
        of: 'amount',
      },
      {
        label: 'Running daily transaction count',
        current: 8,
        limit: 20,
        window: 'daily',
        field: 'transaction_count_daily_max',
        kind: 'count',
      },
    ];

    const result = formatConsumptionFull(entries);
    expect(result).toContain('Running daily charge total:');
    expect(result).toContain('234 / 500');
    expect(result).toContain('Running daily transaction count:');
    expect(result).toContain('8 / 20');
  });

  it('shows unlimited for null limits', () => {
    const entries: ConsumptionEntry[] = [
      {
        label: 'Some field',
        current: 10,
        limit: null,
        window: 'daily',
        field: 'foo_daily_max',
        kind: 'count',
      },
    ];
    const result = formatConsumptionFull(entries);
    expect(result).toContain('10 / unlimited');
  });

  it('returns empty string for no entries', () => {
    expect(formatConsumptionFull([])).toBe('');
  });
});
