import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import type { ProfileSummary } from './sp-client';
import {
  profileShortName,
  profileVersion,
  isNewerVersion,
  newestProfileOf,
  carryParamsForward,
  carryBoundsForward,
  carryContextForward,
} from './profile-upgrade';

describe('profileShortName / profileVersion', () => {
  it('splits id and version off a full profile id', () => {
    expect(profileShortName('github.com/humanagencyprotocol/hap-profiles/delegation@0.1')).toBe('delegation');
    expect(profileVersion('github.com/humanagencyprotocol/hap-profiles/delegation@0.1')).toBe('0.1');
  });
  it('is stable for an id that already has no path', () => {
    expect(profileShortName('delegation@0.1')).toBe('delegation');
  });
  it('version is empty when the id carries none', () => {
    expect(profileVersion('delegation')).toBe('');
  });
});

describe('isNewerVersion', () => {
  it('compares numerically, not lexically — 0.10 beats 0.9', () => {
    expect(isNewerVersion('delegation@0.10', 'delegation@0.9')).toBe(true);
    expect(isNewerVersion('delegation@0.9', 'delegation@0.10')).toBe(false);
  });
  it('is false for an equal version', () => {
    expect(isNewerVersion('email@0.8', 'email@0.8')).toBe(false);
  });
});

describe('newestProfileOf', () => {
  const catalog: ProfileSummary[] = [
    { id: 'github.com/humanagencyprotocol/hap-profiles/delegation@0.1', version: '0.1', description: '', paths: [] },
    { id: 'github.com/humanagencyprotocol/hap-profiles/delegation@0.2', version: '0.2', description: '', paths: [] },
    { id: 'github.com/humanagencyprotocol/hap-profiles/delegation@0.3', version: '0.3', description: '', paths: [] },
    { id: 'github.com/humanagencyprotocol/hap-profiles/email@0.8', version: '0.8', description: '', paths: [] },
  ];

  it('finds the newest version sharing the short name, even when the input id is an old version', () => {
    const newest = newestProfileOf('github.com/humanagencyprotocol/hap-profiles/delegation@0.1', catalog);
    expect(newest?.id).toBe('github.com/humanagencyprotocol/hap-profiles/delegation@0.3');
  });

  it('returns the same entry when the input id is already the newest', () => {
    const newest = newestProfileOf('github.com/humanagencyprotocol/hap-profiles/email@0.8', catalog);
    expect(newest?.id).toBe('github.com/humanagencyprotocol/hap-profiles/email@0.8');
  });

  it('is undefined when the catalog has no matching short name', () => {
    expect(newestProfileOf('unknown-profile@0.1', catalog)).toBeUndefined();
  });
});

describe('carryParamsForward — the version-upgrade field carry-over/drop/default rule', () => {
  it('keeps a value for a field the new schema still declares', () => {
    const schema = { keyOrder: ['profile', 'recipient_max'], fields: { recipient_max: {} } };
    const result = carryParamsForward({ recipient_max: 5 }, schema);
    expect(result).toEqual({ recipient_max: 5 });
  });

  it('drops a value for a field the new schema no longer declares (email@0.8 removed read_daily_max)', () => {
    const newSchema = {
      keyOrder: ['profile', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_access', 'setup_daily_max'],
      fields: {
        recipient_max: {}, send_daily_max: {}, read_max_age_days: {}, read_access: {}, setup_daily_max: {},
      },
    };
    const oldValues = { recipient_max: 10, send_daily_max: 50, read_daily_max: 20, read_max_age_days: 30 };
    const result = carryParamsForward(oldValues, newSchema);
    expect(result).toEqual({ recipient_max: 10, send_daily_max: 50, read_max_age_days: 30 });
    expect(result).not.toHaveProperty('read_daily_max');
  });

  it("seeds a field new in this version from the schema's own default", () => {
    const newSchema = {
      keyOrder: ['profile', 'brief_daily_max'],
      fields: { brief_daily_max: { default: 0 } },
    };
    const result = carryParamsForward({}, newSchema);
    expect(result).toEqual({ brief_daily_max: 0 });
  });

  it('a carried-over value wins over the default for the same field', () => {
    const newSchema = {
      keyOrder: ['profile', 'brief_daily_max'],
      fields: { brief_daily_max: { default: 0 } },
    };
    const result = carryParamsForward({ brief_daily_max: 3 }, newSchema);
    expect(result).toEqual({ brief_daily_max: 3 });
  });

  it('always excludes profile and path, whatever the old values carried', () => {
    const newSchema = { keyOrder: ['profile', 'path', 'recipient_max'], fields: { recipient_max: {} } };
    const result = carryParamsForward({ profile: 'x', path: 'y', recipient_max: 1 }, newSchema);
    expect(result).toEqual({ recipient_max: 1 });
  });

  it('an undeclared default (no default, no old value) leaves the field absent, not zero', () => {
    const newSchema = { keyOrder: ['profile', 'send_daily_max'], fields: { send_daily_max: {} } };
    const result = carryParamsForward({}, newSchema);
    expect(result).toEqual({});
  });

  it('returns {} when the new profile declares no schema at all', () => {
    expect(carryParamsForward({ a: 1 }, undefined)).toEqual({});
  });
});

describe('carryBoundsForward / carryContextForward — wired to AgentProfile.boundsSchema/scopeSchema', () => {
  const newProfile = {
    id: 'github.com/humanagencyprotocol/hap-profiles/email@0.8',
    version: '0.8',
    description: '',
    boundsSchema: {
      keyOrder: ['profile', 'recipient_max', 'send_daily_max', 'read_max_age_days', 'read_access', 'setup_daily_max'],
      fields: {
        recipient_max: {}, send_daily_max: {}, read_max_age_days: {}, read_access: { default: 'unlimited' }, setup_daily_max: { default: 0 },
      },
    },
    scopeSchema: {
      keyOrder: ['counterparty'],
      fields: { counterparty: {} },
    },
    executionContextSchema: { fields: {} },
  } as unknown as AgentProfile;

  it('carries bounds forward, dropping the retired field and defaulting new ones', () => {
    const oldBounds = { recipient_max: 10, send_daily_max: 50, read_daily_max: 20, read_max_age_days: 30 };
    const result = carryBoundsForward(oldBounds, newProfile);
    expect(result).toEqual({
      recipient_max: 10,
      send_daily_max: 50,
      read_max_age_days: 30,
      read_access: 'unlimited',
      setup_daily_max: 0,
    });
  });

  it('carries scope forward using scopeSchema', () => {
    const result = carryContextForward({ counterparty: 'acme.example' }, newProfile);
    expect(result).toEqual({ counterparty: 'acme.example' });
  });
});
