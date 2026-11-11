/**
 * Walkthrough 2026-11-11: ChatGPT proposed a CRM mandate with read access none and could not
 * check its own update afterwards. A create_mandate proposal that leaves out the target
 * profile's read switch gets the profile's declared default before anything else sees the
 * arguments (so the approval card shows it); a value the AI set is never changed.
 * Driven by the profile: a made-up profile with its own field name, plus the real ones.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerProfile } from '@hap/core';
import { setupBuiltin, withReadDefaults } from '../setup';
import type { BuiltinDeps } from '../index';
import { loadProfiles } from '../../profile-loader';

const MADE_UP = {
  id: 'example.org/test/hap-profiles/ledgerbook@0.1',
  version: '0.1',
  boundsSchema: {
    actionTypes: ['write'],
    keyOrder: ['profile', 'may_look', 'may_dump', 'write_daily_max'],
    fields: {
      profile: { type: 'string', required: true },
      may_look: { type: 'string', required: true, default: 'unlimited', boundType: { kind: 'enum', values: ['unlimited', 'none'] } },
      may_dump: { type: 'string', required: true, default: 'none', boundType: { kind: 'enum', values: ['allowed', 'none'] } },
      write_daily_max: { type: 'number', required: true, boundType: { kind: 'cumulative_count', window: 'daily' }, appliesTo: ['write'] },
    },
  },
  scopeSchema: { keyOrder: [], fields: {} },
  requiredGates: [],
  ttl: { default: 3600, max: 86400 },
  retention_minimum: 1,
};

beforeAll(() => {
  loadProfiles();
  registerProfile(MADE_UP.id, MADE_UP as never);
});

describe('create_mandate fills a missing read switch with the profile default', () => {
  it('a made-up profile: the read switch is filled, the other enum and numbers are not', () => {
    const out = withReadDefaults({ profile: 'ledgerbook', limits: { write_daily_max: 3 } });
    expect(out.limits).toEqual({ write_daily_max: 3, may_look: 'unlimited' });
  });

  it('a value the AI set, none included, stays as it is', () => {
    expect(withReadDefaults({ profile: 'ledgerbook', limits: { may_look: 'none', write_daily_max: 3 } }).limits)
      .toEqual({ may_look: 'none', write_daily_max: 3 });
  });

  it('the real customers profile: read_access becomes its default', () => {
    const out = withReadDefaults({ profile: 'customers', limits: { write_daily_max: 5 } });
    expect((out.limits as Record<string, unknown>).read_access).toBe('unlimited');
    expect((out.limits as Record<string, unknown>).export_access).toBeUndefined();
  });

  it('runs as the tool\'s prepare step, before the gate and the card', async () => {
    const tool = setupBuiltin({} as BuiltinDeps).tools.find(t => t.name === 'create_mandate')!;
    const prepared = await tool.prepare!({ profile: 'customers', limits: {}, intent: 'x', mode: 'review' });
    expect('args' in prepared && (prepared.args.limits as Record<string, unknown>).read_access).toBe('unlimited');
  });

  it('an unknown profile or no limits object is left alone', () => {
    expect(withReadDefaults({ profile: 'nope', limits: { a: 1 } })).toEqual({ profile: 'nope', limits: { a: 1 } });
    expect(withReadDefaults({ profile: 'customers' })).toEqual({ profile: 'customers' });
  });
});
