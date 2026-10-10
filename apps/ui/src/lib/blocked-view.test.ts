import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import { blockedView, fieldLabel, kindOf, todaysCount } from './blocked-view';
import type { DenialRecord } from './sp-client';

// Pure logic only (presentation is verified in the browser layer, same
// convention as RecentBlocks.test.ts). Covers: kind resolution (incl. the
// pre-AU2 "no kind on disk" default), field-label lookup against a profile's
// own schema, the per-kind sentence/advice text, and the "today" counter the
// nav badge and the Blocked page agree on.

const EMAIL_PROFILE = {
  id: 'email@0.8',
  boundsSchema: {
    keyOrder: [],
    fields: {
      recipient_max: { type: 'number', required: false, displayName: 'Recipients per email', boundType: { kind: 'per_transaction', of: 'recipient_count' } },
    },
  },
  scopeSchema: {
    keyOrder: [],
    fields: {
      allowed_domains: { type: 'string', required: false, displayName: 'Allowed domains' },
    },
  },
} as unknown as AgentProfile;

const base = (over: Partial<DenialRecord> = {}): DenialRecord => ({
  ts: 1_700_000_000_000,
  tool: 'send_message',
  integrationId: 'gmail',
  profile: 'email@0.8',
  detail: 'fallback sentence',
  ...over,
});

describe('kindOf', () => {
  it('defaults to "read" when the on-disk record predates AU2 (no kind at all)', () => {
    expect(kindOf(base())).toBe('read');
  });
  it('reads the explicit kind otherwise', () => {
    expect(kindOf(base({ kind: 'bound' }))).toBe('bound');
  });
});

describe('fieldLabel', () => {
  it('resolves a scope field by its own key', () => {
    expect(fieldLabel(EMAIL_PROFILE, 'allowed_domains')).toBe('Allowed domains');
  });
  it('resolves a per_transaction bound by its execution field (boundType.of), not the bound key', () => {
    expect(fieldLabel(EMAIL_PROFILE, 'recipient_count')).toBe('Recipients per email');
  });
  it('falls back to the raw field name with no profile, or an unknown field', () => {
    expect(fieldLabel(undefined, 'recipient_count')).toBe('recipient_count');
    expect(fieldLabel(EMAIL_PROFILE, 'something_else')).toBe('something_else');
  });
  it('returns empty for no field at all', () => {
    expect(fieldLabel(EMAIL_PROFILE, undefined)).toBe('');
  });
});

describe('blockedView — one generic sentence per kind, never per-action advice', () => {
  it('bound: value vs limit, using the profile label', () => {
    const v = blockedView(base({ kind: 'bound', field: 'recipient_count', value: 5, limit: 3 }), EMAIL_PROFILE);
    expect(v.title).toBe('Blocked — above your limit');
    expect(v.sentence).toBe('Recipients per email 5 is above the limit 3.');
    expect(v.whatYouCanDo).toMatch(/raise the limit/);
  });

  it('scope: the value is not within the allowed set', () => {
    const v = blockedView(base({ kind: 'scope', field: 'allowed_domains', value: 'other.example' }), EMAIL_PROFILE);
    expect(v.title).toContain('scope');
    expect(v.sentence).toContain('"other.example"');
    expect(v.whatYouCanDo).toMatch(/widen the mandate/);
  });

  it('cumulative: X of Y used', () => {
    const v = blockedView(base({ kind: 'cumulative', value: 7, limit: 6, who: 'authority-server', code: 'CUMULATIVE_LIMIT_EXCEEDED' }));
    expect(v.sentence).toBe('7 of 6 used — the limit is reached.');
    expect(v.sourceLine).toContain('Authority Server');
    expect(v.sourceLine).toContain('CUMULATIVE_LIMIT_EXCEEDED');
    expect(v.whatYouCanDo).toMatch(/resets/);
  });

  it('simulation: fixed sentence, never content-derived', () => {
    const v = blockedView(base({ kind: 'simulation' }));
    expect(v.sentence).toMatch(/simulation mode/);
    expect(v.whatYouCanDo).toMatch(/Settings/);
  });

  it('not_authorized: fixed sentence', () => {
    const v = blockedView(base({ kind: 'not_authorized' }));
    expect(v.sentence).toBe('No mandate currently covers this action.');
    expect(v.whatYouCanDo).toMatch(/Grant a mandate/);
  });

  it('read (no kind on disk): falls back to the stored detail, unchanged from before AU2', () => {
    const v = blockedView(base({ detail: 'older than your 90-day read window' }));
    expect(v.title).toBe('Read blocked');
    expect(v.sentence).toBe('older than your 90-day read window');
  });

  it('never leaks the mandate title/id beyond a short reference, and never action content', () => {
    const v = blockedView(base({ kind: 'bound', value: 5, limit: 3, mandateId: 'authz_abcdef01-2345-4000-8000-000000000001' }));
    expect(v.sourceLine).not.toContain('authz_abcdef01-2345-4000-8000-000000000001'); // truncated
    expect(v.sourceLine).toContain('authz_abcdef01…'); // short reference only
  });
});

describe('todaysCount', () => {
  it('counts only records at or after local midnight', () => {
    const now = new Date(2026, 9, 9, 15, 0, 0).getTime(); // 9 Oct 2026, 15:00 local
    const todayMorning = new Date(2026, 9, 9, 0, 1, 0).getTime();
    const yesterday = new Date(2026, 9, 8, 23, 59, 0).getTime();
    expect(todaysCount([{ ts: todayMorning }, { ts: yesterday }, { ts: now }], now)).toBe(2);
  });
  it('is zero for an empty list', () => {
    expect(todaysCount([], Date.now())).toBe(0);
  });
});
