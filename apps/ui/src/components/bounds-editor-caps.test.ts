import { describe, it, expect } from 'vitest';
import { fieldCapState, enumAllowedFromIndex, capUnitLabel, approverListLabel, seedBoundValue, type FieldCapState } from './BoundsEditor';
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

describe('seedBoundValue — the late-arriving-profileConfig race (real-gateway e2e, 2026-10-15)', () => {
  // GateWizardPage fetches `profile` and the team `profileConfig`
  // independently; `profile` (and so this editor's mount, and its FIRST
  // seed computation) routinely resolves before `profileConfig` does. This
  // reproduces that exact ordering as two calls: first with
  // profileConfig === null|undefined (what the initial seed sees), then
  // again with the real config once it arrives (what the re-seed effect
  // must correct it to) — without ever rendering the component.

  it('no profileConfig at all (not yet arrived): passes the raw value through unchanged', () => {
    expect(seedBoundValue('delete_daily_max', numberField(), '', null)).toBe('');
    expect(seedBoundValue('delete_daily_max', numberField(), '', undefined)).toBe('');
  });

  it('delete_daily_max — a hard numeric cap of 2: the real bug seeded "" with a disabled stepper ' +
    'stuck below the cap; once profileConfig arrives, re-seeding must land ON the cap, not stay empty', () => {
    const field = numberField({ displayName: 'Daily delete limit' } as Partial<ProfileBoundsField>);
    const noConfigYet = seedBoundValue('delete_daily_max', field, '', null);
    expect(noConfigYet).toBe(''); // what the initial (too-early) seed produced

    const config: ProfileConfig = { approvers: ['a'], caps: { delete_daily_max: 2 }, capKinds: { delete_daily_max: 'hard' } };
    const reseeded = seedBoundValue('delete_daily_max', field, noConfigYet, config);
    expect(reseeded).toBe('2');
  });

  it('read_access — a hard enum cap of "none": the real bug left the profile\'s own uncapped ' +
    'default ("unlimited") selected inside a disabled control; re-seeding must clamp it DOWN to "none"', () => {
    const field = enumField(['unlimited', 'none']);
    // The profile's own default, seeded before any team config was known —
    // exactly what email@0.8's read_access default ("unlimited") produces.
    const noConfigYet = seedBoundValue('read_access', field, 'unlimited', null);
    expect(noConfigYet).toBe('unlimited');

    const config: ProfileConfig = { approvers: ['a'], caps: { read_access: 'none' } };
    const reseeded = seedBoundValue('read_access', field, noConfigYet, config);
    expect(reseeded).toBe('none');
  });

  it('a value already compliant with the cap is left exactly as is (never bumped TO the cap, ' +
    'never changed when it is already below/at it)', () => {
    const numConfig: ProfileConfig = { approvers: ['a'], caps: { recipient_max: 5 }, capKinds: { recipient_max: 'hard' } };
    expect(seedBoundValue('recipient_max', numberField(), '3', numConfig)).toBe('3');

    const enumConfig: ProfileConfig = { approvers: ['a'], caps: { read_access: 'none' } };
    expect(seedBoundValue('read_access', enumField(['unlimited', 'none']), 'none', enumConfig)).toBe('none');
  });

  it('an "approval" (not hard) cap never clamps — above-cap is a valid, allowed choice', () => {
    const config: ProfileConfig = { approvers: ['a'], caps: { send_daily_max: 50 }, capKinds: { send_daily_max: 'approval' } };
    expect(seedBoundValue('send_daily_max', numberField(), '75', config)).toBe('75');
  });

  it('a cap with no approvers at all is forced hard regardless of stored capKinds — same real-data ' +
    'shape effectiveCapKind already covers, exercised here through the seeding path', () => {
    const config: ProfileConfig = { approvers: [], caps: { send_daily_max: 50 }, capKinds: { send_daily_max: 'approval' } };
    expect(seedBoundValue('send_daily_max', numberField(), '75', config)).toBe('50');
  });
});
