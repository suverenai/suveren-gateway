import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import { argRows, profileFieldLines, humanizeKey } from './approval-view';

/**
 * The approval screen showed raw `key: value` pairs (JSON for objects) for every
 * tool. A person approving a mandate proposal saw `{"value_max":1000,...}`. Now
 * every tool is labelled and formatted generically, and a tool may declare
 * display kinds — e.g. "limits of the profile in `profile`" — from a fixed set.
 */
const PROFILE = {
  id: 'p/sales@0.3', version: '0.3',
  boundsSchema: {
    keyOrder: ['profile', 'read_access', 'value_max', 'discount_max'],
    fields: {
      profile: { type: 'string' },
      read_access: { type: 'string', displayName: 'Read access' },
      value_max: { type: 'number', displayName: 'Max value per quote or order', unit: 'currency:EUR', description: 'Net total' },
      discount_max: { type: 'number', displayName: 'Max discount', unit: 'percent' },
    },
  },
  scopeSchema: { keyOrder: ['currency'], fields: { currency: { type: 'string', displayName: 'Currency' } } },
} as unknown as AgentProfile;

describe('argRows — every tool, no declaration', () => {
  it('labels from the key, hint from the schema, kind from the value; hides the ticket reference', () => {
    const rows = argRows(
      { to: ['a@x.example', 'b@x.example'], subject: 'Hi', body: 'Line 1\nLine 2', ticket_id: 'r1', meta: { a: 1 } },
      { inputSchema: { properties: { subject: { description: 'Subject line' }, to: {}, body: {} } } },
    );
    expect(rows.map((r) => [r.key, r.label, r.kind])).toEqual([
      ['subject', 'Subject', 'text'],
      ['to', 'To', 'list'],
      ['body', 'Body', 'markdown'],
      ['meta', 'Meta', 'object'],
    ]);
    expect(rows[0].hint).toBe('Subject line');
  });

  it('works without any display info at all', () => {
    expect(argRows({ durationHours: 24 })).toEqual([{ key: 'durationHours', label: 'Duration hours', kind: 'text', value: 24, hint: undefined }]);
  });
});

describe('argRows — declared approvalView', () => {
  it('uses declared labels, order and kinds; profile kinds take the profile from another argument', () => {
    const rows = argRows(
      { profile: 'sales', limits: { value_max: 1000 }, scope: { currency: 'EUR' }, intent: 'Why', mode: 'automatic', amount: 50, cur: 'EUR' },
      { approvalView: {
        profile: { label: 'Profile', kind: 'profile' },
        limits: { label: 'Limits', kind: 'profile-limits', profileArg: 'profile' },
        scope: { label: 'Scope', kind: 'profile-scope', profileArg: 'profile' },
        intent: { label: 'Intent', kind: 'markdown' },
        amount: { kind: 'money', currencyArg: 'cur' },
      } },
    );
    expect(rows.slice(0, 5).map((r) => [r.key, r.label, r.kind, r.profileRef ?? r.currency])).toEqual([
      ['profile', 'Profile', 'profile', 'sales'],
      ['limits', 'Limits', 'profile-limits', 'sales'],
      ['scope', 'Scope', 'profile-scope', 'sales'],
      ['intent', 'Intent', 'markdown', undefined],
      ['amount', 'Amount', 'money', 'EUR'],
    ]);
  });
});

describe('profileFieldLines — limits and scope the way the mandate screen names them', () => {
  it('display names and units from the profile, in its order', () => {
    expect(profileFieldLines({ discount_max: 10, value_max: 1000, read_access: 'unlimited', profile: 'x' }, PROFILE, 'limits')).toEqual([
      { key: 'read_access', label: 'Read access', value: 'unlimited', hint: undefined, unknown: false },
      { key: 'value_max', label: 'Max value per quote or order', value: '1000 EUR', hint: 'Net total', unknown: false },
      { key: 'discount_max', label: 'Max discount', value: '10 %', hint: undefined, unknown: false },
    ]);
    expect(profileFieldLines({ currency: 'EUR' }, PROFILE, 'scope')).toEqual([
      { key: 'currency', label: 'Currency', value: 'EUR', hint: undefined, unknown: false },
    ]);
  });

  it('a field the profile does not define is shown and flagged, never hidden', () => {
    expect(profileFieldLines({ bogus_max: 5 }, PROFILE, 'limits')).toEqual([
      { key: 'bogus_max', label: 'Bogus max', value: '5', hint: undefined, unknown: true },
    ]);
  });

  it('without the profile (not loaded / unknown): labels from the keys', () => {
    expect(profileFieldLines({ value_max: 1000 }, null, 'limits')[0]).toMatchObject({ label: 'Value max', value: '1000', unknown: undefined });
  });

  it('humanizeKey', () => {
    expect(humanizeKey('duration_hours')).toBe('Duration hours');
    expect(humanizeKey('inReplyTo')).toBe('In reply to');
  });
});
