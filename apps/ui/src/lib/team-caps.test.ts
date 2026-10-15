import { describe, it, expect } from 'vitest';
import { storedCapKind, effectiveCapKind, enumExceedsCap, isCapped, capViolation, findAboveCapViolation, type CapFieldShape } from './team-caps';
import type { ProfileConfig } from './sp-client';

describe('storedCapKind', () => {
  it('reads the stored kind from capKinds when present', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { x: 5 }, capKinds: { x: 'hard' } };
    expect(storedCapKind(config, 'x')).toBe('hard');
  });

  it('defaults to "approval" when approvers exist but capKinds carries no entry (pre-TR5 AS)', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { x: 5 } };
    expect(storedCapKind(config, 'x')).toBe('approval');
  });

  it('defaults to "hard" when there are no approvers at all', () => {
    const config: ProfileConfig = { approvers: [], caps: { x: 5 } };
    expect(storedCapKind(config, 'x')).toBe('hard');
  });
});

describe('effectiveCapKind', () => {
  const approverConfig: ProfileConfig = { approvers: ['a'], caps: { x: 5 }, capKinds: { x: 'approval' } };

  it('returns the stored kind when no override applies', () => {
    expect(effectiveCapKind(approverConfig, { boundType: { kind: 'per_transaction' } }, 'x')).toBe('approval');
  });

  it('forces hard when there are no approvers, regardless of stored kind', () => {
    const noApprovers: ProfileConfig = { approvers: [], caps: { x: 5 }, capKinds: { x: 'approval' } };
    expect(effectiveCapKind(noApprovers, { boundType: { kind: 'per_transaction' } }, 'x')).toBe('hard');
  });

  it('forces hard for a gatekeeper-enforced (read limit) field', () => {
    expect(effectiveCapKind(approverConfig, { enforcedBy: 'gatekeeper', boundType: { kind: 'per_transaction' } }, 'x')).toBe('hard');
  });

  it('forces hard for an enum (capability switch) field', () => {
    expect(effectiveCapKind(approverConfig, { boundType: { kind: 'enum', values: ['unlimited', 'none'] } }, 'x')).toBe('hard');
  });

  it('undefined fieldDef never crashes and falls through to the stored kind', () => {
    expect(effectiveCapKind(approverConfig, undefined, 'x')).toBe('approval');
  });
});

describe('enumExceedsCap', () => {
  const values = ['unlimited', 'none'] as const;

  it('a value later in the order (more restrictive than the cap) does not exceed', () => {
    expect(enumExceedsCap(values, 'none', 'none')).toBe(false);
  });

  it('a value earlier in the order (more permissive than the cap) exceeds', () => {
    expect(enumExceedsCap(values, 'none', 'unlimited')).toBe(true);
  });

  it('capped at the most permissive value: nothing exceeds', () => {
    expect(enumExceedsCap(values, 'unlimited', 'none')).toBe(false);
    expect(enumExceedsCap(values, 'unlimited', 'unlimited')).toBe(false);
  });

  it('an unknown value on either side is never flagged (not this function\'s job to validate)', () => {
    expect(enumExceedsCap(values, 'bogus', 'unlimited')).toBe(false);
    expect(enumExceedsCap(values, 'none', 'bogus')).toBe(false);
  });
});

describe('isCapped', () => {
  it('true only when the field has an entry in caps', () => {
    expect(isCapped({ caps: { x: 5 } }, 'x')).toBe(true);
    expect(isCapped({ caps: { x: 5 } }, 'y')).toBe(false);
    expect(isCapped({}, 'x')).toBe(false);
  });
});

describe('capViolation', () => {
  it('returns null when the field carries no cap', () => {
    const config: ProfileConfig = { approvers: ['a'] };
    expect(capViolation(config, 'x', undefined, 100)).toBeNull();
  });

  it('returns null when requested is within the numeric cap', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { x: 50 }, capKinds: { x: 'approval' } };
    expect(capViolation(config, 'x', { boundType: { kind: 'cumulative_count' } }, 50)).toBeNull();
    expect(capViolation(config, 'x', { boundType: { kind: 'cumulative_count' } }, 30)).toBeNull();
  });

  it('returns the cap + effective kind when requested exceeds a numeric cap', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { x: 50 }, capKinds: { x: 'approval' } };
    expect(capViolation(config, 'x', { boundType: { kind: 'cumulative_count' } }, 75)).toEqual({ cap: 50, kind: 'approval' });
  });

  it('a numeric cap with no approvers is reported as hard even though it was saved as approval', () => {
    const config: ProfileConfig = { approvers: [], caps: { x: 50 }, capKinds: { x: 'approval' } };
    expect(capViolation(config, 'x', { boundType: { kind: 'cumulative_count' } }, 75)).toEqual({ cap: 50, kind: 'hard' });
  });

  it('an enum cap at "none" exceeded by "unlimited" is reported, always hard', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { read_access: 'none' }, capKinds: { read_access: 'approval' } };
    const fieldDef = { boundType: { kind: 'enum' as const, values: ['unlimited', 'none'] } };
    expect(capViolation(config, 'read_access', fieldDef, 'unlimited')).toEqual({ cap: 'none', kind: 'hard' });
  });

  it('a read-limit (enforcedBy: gatekeeper) numeric cap is always hard even with approvers + stored approval kind', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { read_max_age_days: 30 }, capKinds: { read_max_age_days: 'approval' } };
    const fieldDef = { enforcedBy: 'gatekeeper', boundType: { kind: 'per_transaction' as const } };
    expect(capViolation(config, 'read_max_age_days', fieldDef, 60)).toEqual({ cap: 30, kind: 'hard' });
  });
});

describe('findAboveCapViolation', () => {
  const fields: Record<string, CapFieldShape> = {
    amount_max: { displayName: 'Amount per transaction', boundType: { kind: 'per_transaction', of: 'amount' } },
    send_daily_max: { displayName: 'Daily send limit', boundType: { kind: 'cumulative_count' } },
    recipient_max: { displayName: 'Recipients per email', boundType: { kind: 'per_transaction', of: 'recipient_count' } },
  };

  it('returns null when no approval-kind cap is configured at all', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { recipient_max: 5 }, capKinds: { recipient_max: 'hard' } };
    expect(findAboveCapViolation({}, config, fields)).toBeNull();
  });

  it('matches by executionContext VALUE when the cap field has an `of` carrying one (exact, real number)', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { amount_max: 100 }, capKinds: { amount_max: 'approval' } };
    const reason = findAboveCapViolation({ amount: 150 }, config, fields);
    expect(reason).toEqual({ field: 'amount_max', fieldLabel: 'Amount per transaction', cap: 100, value: 150 });
  });

  it('a cumulative_count cap (no `of`, no wire value) with exactly one approval-kind cap is still named, without a fabricated value', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { send_daily_max: 50 }, capKinds: { send_daily_max: 'approval' } };
    const reason = findAboveCapViolation({}, config, fields);
    expect(reason).toEqual({ field: 'send_daily_max', fieldLabel: 'Daily send limit', cap: 50 });
    expect(reason?.value).toBeUndefined();
  });

  it('several approval-kind caps with no executionContext match: returns null rather than guess', () => {
    const config: ProfileConfig = {
      approvers: ['a'],
      caps: { send_daily_max: 50, recipient_max: 5 },
      capKinds: { send_daily_max: 'approval', recipient_max: 'approval' },
    };
    expect(findAboveCapViolation({}, config, fields)).toBeNull();
  });

  it('several approval-kind caps, but one matches the executionContext exactly: that one is named', () => {
    const config: ProfileConfig = {
      approvers: ['a'],
      caps: { send_daily_max: 50, recipient_max: 5 },
      capKinds: { send_daily_max: 'approval', recipient_max: 'approval' },
    };
    const reason = findAboveCapViolation({ recipient_count: 8 }, config, fields);
    expect(reason).toEqual({ field: 'recipient_max', fieldLabel: 'Recipients per email', cap: 5, value: 8 });
  });

  it('a value within the cap on the matching field is not reported as the (wrong) match', () => {
    const config: ProfileConfig = {
      approvers: ['a'],
      caps: { send_daily_max: 50, amount_max: 100 },
      capKinds: { send_daily_max: 'approval', amount_max: 'approval' },
    };
    // amount (80) is within its cap (100) — no executionContext match, and
    // with TWO approval-kind caps configured, nothing is named.
    expect(findAboveCapViolation({ amount: 80 }, config, fields)).toBeNull();
  });
});
