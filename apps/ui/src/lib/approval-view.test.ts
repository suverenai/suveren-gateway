import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import { argRows, profileFieldLines, humanizeKey, toolHeadline, systemDisplayName, aiTextValue } from './approval-view';
import type { IntegrationManifest } from './sp-client';

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

describe('toolHeadline — the approval card headline (AU5)', () => {
  it('splits the namespaced tool into "integration · tool"', () => {
    expect(toolHeadline('erp__send_quote')).toBe('erp · send_quote');
  });

  it('falls back to the bare name when there is no namespace separator', () => {
    expect(toolHeadline('send_quote')).toBe('send_quote');
  });
});

describe('systemDisplayName — "From <System>, before it runs" (AU5)', () => {
  const MANIFESTS = [{ id: 'erp', name: 'Our ERP' } as unknown as IntegrationManifest];

  it('uses the manifest\'s own declared name', () => {
    expect(systemDisplayName('erp', MANIFESTS)).toBe('Our ERP');
  });

  it('falls back to the uppercased integration id without a manifest', () => {
    expect(systemDisplayName('mollie', MANIFESTS)).toBe('MOLLIE');
  });

  it('falls back to "the system" when there is no integration id at all', () => {
    expect(systemDisplayName('', undefined)).toBe('the system');
  });
});

describe('aiTextValue — UI spec §15.2/§15.3 "Text — written by the AI"', () => {
  it('the declared argument\'s own string value', () => {
    expect(aiTextValue({ to: ['a@x.com'], body: 'hello' }, { aiTextArg: 'body' })).toBe('hello');
  });

  it('undefined when the tool declares no aiTextArg at all', () => {
    expect(aiTextValue({ body: 'hello' }, {})).toBeUndefined();
    expect(aiTextValue({ body: 'hello' }, undefined)).toBeUndefined();
  });

  it('undefined when the declared argument is missing or empty on this call', () => {
    expect(aiTextValue({ to: ['a@x.com'] }, { aiTextArg: 'body' })).toBeUndefined();
    expect(aiTextValue({ body: '' }, { aiTextArg: 'body' })).toBeUndefined();
  });

  it('undefined when the declared argument is not a string', () => {
    expect(aiTextValue({ body: 5 }, { aiTextArg: 'body' })).toBeUndefined();
  });
});

describe('argRows — hides the AI-authored-text argument (UI spec §15.2/§15.3)', () => {
  it('omits the declared aiTextArg from the generic rows', () => {
    const rows = argRows({ to: ['a@x.com'], subject: 'Hi', body: 'hello' }, { aiTextArg: 'body' });
    expect(rows.map((r) => r.key)).toEqual(['to', 'subject']);
  });

  it('shows every field, incl. body, when no aiTextArg is declared', () => {
    const rows = argRows({ to: ['a@x.com'], body: 'hello' }, {});
    expect(rows.map((r) => r.key)).toEqual(['to', 'body']);
  });
});
