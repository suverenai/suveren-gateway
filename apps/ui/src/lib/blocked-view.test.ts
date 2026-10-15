import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import {
  blockedView, fieldLabel, kindOf, todaysCount, unseenCount, isUnseen,
  formatBlockedWhen, sourceLineText,
} from './blocked-view';
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
    expect(sourceLineText(v.sourceLine)).toContain('Authority Server');
    expect(sourceLineText(v.sourceLine)).toContain('CUMULATIVE_LIMIT_EXCEEDED');
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
    const text = sourceLineText(v.sourceLine);
    expect(text).not.toContain('authz_abcdef01-2345-4000-8000-000000000001'); // truncated
    expect(text).toContain('authz_abcdef01…'); // short reference only
  });

  it('mandate reference: title first, id second and dimmed — never the id alone once a title is known', () => {
    const v = blockedView(base({
      kind: 'scope',
      field: 'allowed_domains',
      value: 'other.example',
      mandateTitle: 'Customer outreach',
      mandateId: 'authz_f86b3a1e-0000-4000-8000-000000000001',
    }), EMAIL_PROFILE);
    const dimParts = v.sourceLine.filter(p => p.dim);
    expect(dimParts).toHaveLength(1);
    expect(dimParts[0].text).toBe(' (authz_f86b3a1e…)');
    expect(sourceLineText(v.sourceLine)).toContain('mandate "Customer outreach" (authz_f86b3a1e…)');
  });

  it('mandate reference: falls back to the id alone (not dimmed) when no title is on record', () => {
    const v = blockedView(base({ kind: 'bound', value: 5, limit: 3, mandateId: 'authz_2dd091a4-0000-4000-8000-000000000001' }));
    expect(v.sourceLine.some(p => p.dim)).toBe(false);
    expect(sourceLineText(v.sourceLine)).toContain('mandate authz_2dd091a4…');
  });
});

describe('blockedView — mandate title resolved at DISPLAY time, not stamped on the record', () => {
  // The real shape: recordBlocked (tool-proxy.ts) never sets mandateTitle —
  // only mandateId. Every test above that passed mandateTitle by hand would
  // have missed exactly the bug this closes, so these build records the
  // way the MCP server actually does: mandateId only.
  const realRecord = (mandateId: string) => base({
    kind: 'scope',
    field: 'allowed_domains',
    value: 'partner',
    mandateId,
    // deliberately NOT setting mandateTitle — see above
  });

  it('shows the looked-up title (dimmed id alongside), with no mandateTitle on the record at all', () => {
    const id = 'authz_1e862ebb-0000-4000-8000-000000000001';
    const v = blockedView(realRecord(id), EMAIL_PROFILE, { [id]: 'Blocked e2e customer care' });
    expect(sourceLineText(v.sourceLine)).toContain('mandate "Blocked e2e customer care" (authz_1e862ebb…)');
    const dimParts = v.sourceLine.filter(p => p.dim);
    expect(dimParts).toHaveLength(1);
    expect(dimParts[0].text).toBe(' (authz_1e862ebb…)');
  });

  it('falls back to the id alone when the id has no entry in the lookup (unknown/revoked mandate)', () => {
    const id = 'authz_dead0000-0000-4000-8000-000000000001';
    const v = blockedView(realRecord(id), EMAIL_PROFILE, { 'authz_other-0000-4000-8000-000000000001': 'Some other mandate' });
    expect(v.sourceLine.some(p => p.dim)).toBe(false);
    expect(sourceLineText(v.sourceLine)).toContain(`mandate ${id.slice(0, 14)}…`);
  });

  it('falls back to the id alone when no lookup table is supplied at all', () => {
    const id = 'authz_1e862ebb-0000-4000-8000-000000000001';
    const v = blockedView(realRecord(id), EMAIL_PROFILE);
    expect(v.sourceLine.some(p => p.dim)).toBe(false);
    expect(sourceLineText(v.sourceLine)).toContain(`mandate ${id.slice(0, 14)}…`);
  });

  it('the live lookup wins over a stale/hand-set mandateTitle on the record (handles a rename)', () => {
    const id = 'authz_f86b3a1e-0000-4000-8000-000000000001';
    const v = blockedView(
      base({ kind: 'scope', mandateId: id, mandateTitle: 'Old name before rename' }),
      EMAIL_PROFILE,
      { [id]: 'Renamed mandate' },
    );
    expect(sourceLineText(v.sourceLine)).toContain('mandate "Renamed mandate"');
    expect(sourceLineText(v.sourceLine)).not.toContain('Old name before rename');
  });

  it('still falls back to the record\'s own mandateTitle when the lookup table has no entry for it', () => {
    const id = 'authz_f86b3a1e-0000-4000-8000-000000000001';
    const v = blockedView(
      base({ kind: 'scope', mandateId: id, mandateTitle: 'Legacy hand-set title' }),
      EMAIL_PROFILE,
      {},
    );
    expect(sourceLineText(v.sourceLine)).toContain('mandate "Legacy hand-set title"');
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

describe('unseenCount / isUnseen — the sidebar badge, not "today"', () => {
  it('counts only records strictly after lastSeenAt', () => {
    const records = [{ ts: 100 }, { ts: 200 }, { ts: 300 }];
    expect(unseenCount(records, 200)).toBe(1); // only ts:300
    expect(unseenCount(records, 0)).toBe(3);
    expect(unseenCount(records, 300)).toBe(0);
  });

  it('never seen (lastSeenAt=0) counts every retained record as new', () => {
    expect(unseenCount([{ ts: 1 }, { ts: 2 }], 0)).toBe(2);
  });

  it('isUnseen agrees with unseenCount on the same boundary', () => {
    expect(isUnseen(300, 200)).toBe(true);
    expect(isUnseen(200, 200)).toBe(false);
    expect(isUnseen(100, 200)).toBe(false);
  });

  it('is zero for an empty list', () => {
    expect(unseenCount([], Date.now())).toBe(0);
  });
});

describe('formatBlockedWhen', () => {
  it('shows "Today · <time>" for a timestamp at or after local midnight', () => {
    const now = new Date(2026, 9, 9, 15, 0, 0).getTime();
    const todayMorning = new Date(2026, 9, 9, 6, 39, 0).getTime();
    expect(formatBlockedWhen(todayMorning, now)).toMatch(/^Today · /);
  });

  it('shows "Yesterday · <time>" for a timestamp in the previous calendar day', () => {
    const now = new Date(2026, 9, 9, 15, 0, 0).getTime();
    const yesterday = new Date(2026, 9, 8, 11, 2, 0).getTime();
    expect(formatBlockedWhen(yesterday, now)).toMatch(/^Yesterday · /);
  });

  it('falls through to "<Mon D> · <time>" beyond yesterday', () => {
    const now = new Date(2026, 9, 14, 15, 0, 0).getTime();
    const older = new Date(2026, 9, 12, 9, 15, 0).getTime();
    const out = formatBlockedWhen(older, now);
    expect(out).toMatch(/^Oct 12 · /);
    expect(out).not.toMatch(/Today|Yesterday/);
  });

  it('always appends the time, for every bucket', () => {
    const now = new Date(2026, 9, 9, 15, 0, 0).getTime();
    expect(formatBlockedWhen(now, now)).toContain(' · ');
  });
});
