import { describe, it, expect } from 'vitest';
import { fieldCapState, enumAllowedFromIndex, capUnitLabel, approverListLabel, type FieldCapState } from './BoundsEditor';
import type { ProfileConfig } from '../lib/sp-client';
import type { ProfileBoundsField } from '@hap/core';

const numberField = (extra: Partial<ProfileBoundsField> = {}): ProfileBoundsField => ({
  type: 'number',
  required: false,
  ...extra,
} as ProfileBoundsField);

const enumField = (values: readonly string[]): ProfileBoundsField => ({
  type: 'string',
  required: true,
  boundType: { kind: 'enum', values },
} as unknown as ProfileBoundsField);

describe('fieldCapState', () => {
  it('returns null when profileConfig is absent', () => {
    expect(fieldCapState('x', numberField(), '10', null)).toBeNull();
    expect(fieldCapState('x', numberField(), '10', undefined)).toBeNull();
  });

  it('returns null when the field carries no cap', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { y: 5 } };
    expect(fieldCapState('x', numberField(), '10', config)).toBeNull();
  });

  it('a numeric approval-kind cap: not violating when within it', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { x: 50 }, capKinds: { x: 'approval' } };
    const s = fieldCapState('x', numberField(), '30', config) as FieldCapState;
    expect(s.kind).toBe('approval');
    expect(s.cap).toBe(50);
    expect(s.violating).toBe(false);
  });

  it('a numeric approval-kind cap: violating when the typed value exceeds it', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { x: 50 }, capKinds: { x: 'approval' } };
    const s = fieldCapState('x', numberField(), '75', config) as FieldCapState;
    expect(s.violating).toBe(true);
  });

  it('a numeric hard cap with no approvers — kind overridden to hard regardless of stored capKinds', () => {
    const config: ProfileConfig = { approvers: [], caps: { x: 50 }, capKinds: { x: 'approval' } };
    const s = fieldCapState('x', numberField(), '75', config) as FieldCapState;
    expect(s.kind).toBe('hard');
  });

  it('a gatekeeper-enforced numeric field is always hard, even with approvers + stored "approval"', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { read_max_age_days: 30 }, capKinds: { read_max_age_days: 'approval' } };
    const s = fieldCapState('read_max_age_days', numberField({ enforcedBy: 'gatekeeper' } as Partial<ProfileBoundsField>), '60', config) as FieldCapState;
    expect(s.kind).toBe('hard');
    expect(s.violating).toBe(true);
  });

  it('an enum cap: violating when the chosen value is more permissive than the cap', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { read_access: 'none' } };
    const s = fieldCapState('read_access', enumField(['unlimited', 'none']), 'unlimited', config) as FieldCapState;
    expect(s.kind).toBe('hard'); // enum caps are always hard
    expect(s.violating).toBe(true);
  });

  it('an enum cap: not violating when the chosen value equals the cap', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { read_access: 'none' } };
    const s = fieldCapState('read_access', enumField(['unlimited', 'none']), 'none', config) as FieldCapState;
    expect(s.violating).toBe(false);
  });

  it('an empty string value is never flagged as violating', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { x: 50 }, capKinds: { x: 'approval' } };
    const s = fieldCapState('x', numberField(), '', config) as FieldCapState;
    expect(s.violating).toBe(false);
  });
});

describe('enumAllowedFromIndex', () => {
  it('returns the cap\'s index for an enum cap', () => {
    expect(enumAllowedFromIndex(enumField(['unlimited', 'none']), 'none')).toBe(1);
    expect(enumAllowedFromIndex(enumField(['unlimited', 'none']), 'unlimited')).toBe(0);
  });

  it('returns undefined for a numeric cap', () => {
    expect(enumAllowedFromIndex(numberField(), 50)).toBeUndefined();
  });

  it('returns undefined when the cap value is not in the field\'s own values', () => {
    expect(enumAllowedFromIndex(enumField(['unlimited', 'none']), 'bogus')).toBeUndefined();
  });
});

describe('capUnitLabel', () => {
  it('uses the field\'s declared unit when it has a real one', () => {
    expect(capUnitLabel('age', numberField({ unit: 'days' } as Partial<ProfileBoundsField>))).toBe('days');
  });

  it('falls back to the field\'s own human label for a count field (no real unit word)', () => {
    expect(capUnitLabel('send_daily_max', numberField({ unit: 'count', displayName: 'Daily send limit' } as Partial<ProfileBoundsField>)))
      .toBe('daily send limit');
  });
});

describe('approverListLabel', () => {
  it('prefers resolved display names when given', () => {
    expect(approverListLabel({ approvers: ['u1', 'u2'] }, ['Andreas', 'Lisa'])).toBe('Andreas or Lisa');
  });

  it('falls back to raw userIds when no names were resolved', () => {
    expect(approverListLabel({ approvers: ['u1', 'u2'] }, undefined)).toBe('u1 or u2');
  });

  it('falls back to a generic phrase when there is nothing at all', () => {
    expect(approverListLabel({ approvers: [] }, undefined)).toBe('your team\'s approvers');
  });
});
