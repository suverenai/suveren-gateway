import { describe, it, expect } from 'vitest';
import {
  boundsSatisfyReadGate,
  parseMessageTimestamp,
  ageInDays,
  maxReadAgeDays,
  isOlderThanMaxAge,
  composeReadQuery,
  resolveAgeBoundField,
  getByDottedPath,
  extractEmails,
  emailDomain,
  resolveScopeFields,
  authorityCoversParticipants,
  extractParticipants,
  buildScopeQuery,
} from '../src/lib/read-gate';

describe('boundsSatisfyReadGate', () => {
  it('no boundField declared → no static gate → permitted', () => {
    expect(boundsSatisfyReadGate({ read_access: 'none' }, {})).toBe(true);
    expect(boundsSatisfyReadGate(undefined, {})).toBe(true);
  });

  it('bound present and equal to requiredValue → permitted', () => {
    expect(
      boundsSatisfyReadGate({ read_access: 'unlimited' }, { boundField: 'read_access', requiredValue: 'unlimited' }),
    ).toBe(true);
  });

  it('bound present but different value → blocked (fail closed)', () => {
    expect(
      boundsSatisfyReadGate({ read_access: 'none' }, { boundField: 'read_access', requiredValue: 'unlimited' }),
    ).toBe(false);
  });

  it('bound missing → blocked (fail closed, not skipped)', () => {
    expect(
      boundsSatisfyReadGate({ write_daily_max: 10 }, { boundField: 'read_access', requiredValue: 'unlimited' }),
    ).toBe(false);
    expect(
      boundsSatisfyReadGate(undefined, { boundField: 'read_access', requiredValue: 'unlimited' }),
    ).toBe(false);
  });

  it('coerces non-string bound values before comparing', () => {
    expect(
      boundsSatisfyReadGate({ level: 5 }, { boundField: 'level', requiredValue: '5' }),
    ).toBe(true);
  });
});

// Fixed clock for deterministic age math.
const NOW = 1_700_000_000_000; // arbitrary epoch ms
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number): number => NOW - d * DAY;

describe('parseMessageTimestamp (provider-agnostic)', () => {
  it('parses Gmail string internalDate (epoch millis)', () => {
    expect(parseMessageTimestamp('1700000000000')).toBe(1_700_000_000_000);
  });
  it('accepts a numeric timestamp', () => {
    expect(parseMessageTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
  it('parses ISO/RFC3339 dates (calendar / CRM / Drive — NOT email-only)', () => {
    expect(parseMessageTimestamp('2023-11-14T22:13:20Z')).toBe(Date.parse('2023-11-14T22:13:20Z'));
    expect(parseMessageTimestamp('2026-07-18T10:00:00+02:00')).toBe(Date.parse('2026-07-18T10:00:00+02:00'));
  });
  it('returns null for absent/unparseable (caller fails closed)', () => {
    expect(parseMessageTimestamp(undefined)).toBeNull();
    expect(parseMessageTimestamp('')).toBeNull();
    expect(parseMessageTimestamp('not-a-date')).toBeNull();
  });
});

describe('ageInDays', () => {
  it('is 0 within the first day and whole-day floored otherwise', () => {
    expect(ageInDays(daysAgo(0), NOW)).toBe(0);
    expect(ageInDays(daysAgo(1), NOW)).toBe(1);
    expect(ageInDays(daysAgo(32), NOW)).toBe(32);
  });
});

describe('maxReadAgeDays (field is caller-supplied, not hardcoded)', () => {
  it('takes the most-permissive window across matching auths', () => {
    expect(maxReadAgeDays([{ read_max_age_days: 30 }, { read_max_age_days: 90 }], 'read_max_age_days')).toBe(90);
  });
  it('works for an arbitrary (non-email) age-bound field name', () => {
    expect(maxReadAgeDays([{ event_read_max_age_days: 14 }], 'event_read_max_age_days')).toBe(14);
  });
  it('coerces string bound values', () => {
    expect(maxReadAgeDays([{ read_max_age_days: '30' as unknown as number }], 'read_max_age_days')).toBe(30);
  });
  it('returns null when no matching auth declares the bound', () => {
    expect(maxReadAgeDays([{ recipient_max: 5 }, undefined], 'read_max_age_days')).toBeNull();
  });
});

describe('isOlderThanMaxAge', () => {
  it('blocks a message older than the window (the pentest case)', () => {
    expect(isOlderThanMaxAge(daysAgo(32), 30, NOW)).toBe(true);
  });
  it('permits a message within the window', () => {
    expect(isOlderThanMaxAge(daysAgo(10), 30, NOW)).toBe(false);
  });
  it('permits a message exactly at the boundary', () => {
    expect(isOlderThanMaxAge(daysAgo(30), 30, NOW)).toBe(false);
  });
  it('fails closed on an unparseable/absent timestamp', () => {
    expect(isOlderThanMaxAge(null, 30, NOW)).toBe(true);
  });
});

// NOTE: the former `injectAgeQuery` helper was deleted with the F8 fix. It was
// never used in production (tool-proxy re-implemented the same bare space-join
// inline) — two composition paths, both unsafe, which is how F8 survived
// review. There is now exactly one: composeReadQuery, below.

// ── F8: the agent's own query must not be able to escape the injected clause ──
//
// Enforcement-by-construction assumes the injected clause is ANDed. A bare
// space-join lets the agent's fragment bind ACROSS the boundary and turn the
// intersection into a union (or swallow the clause as an operand), so the age
// window stops meaning anything. See doc/read-bounds-enforcement-plan.md F8.
describe('composeReadQuery — hostile agent fragments (F8)', () => {
  const AGE = 'newer_than:30d';

  it('composes a benign fragment unchanged in meaning', () => {
    const r = composeReadQuery('invoices', [AGE]);
    expect(r.ok).toBe(true);
    expect(r.query).toBe('(invoices) newer_than:30d');
  });

  it('emits the clause alone when the agent supplied no query', () => {
    expect(composeReadQuery('', [AGE]).query).toBe('newer_than:30d');
    expect(composeReadQuery(undefined, [AGE]).query).toBe('newer_than:30d');
  });

  it('a contradictory fragment still yields the empty set', () => {
    const r = composeReadQuery('older_than:365d', [AGE]);
    expect(r.ok).toBe(true);
    expect(r.query).toBe('(older_than:365d) newer_than:30d');
  });

  it('REJECTS a trailing OR (the bypass: "older_than:365d OR newer_than:30d")', () => {
    const r = composeReadQuery('older_than:365d OR', [AGE]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/operator/i);
  });

  it('rejects every trailing binary operator form', () => {
    for (const q of ['a OR', 'a or', 'a AND', 'a NOT', 'a |', 'a -', 'a +']) {
      expect(composeReadQuery(q, [AGE]).ok).toBe(false);
    }
  });

  it('rejects a trailing field operator that would eat the clause as its value', () => {
    // "from: newer_than:30d" ⇒ the age clause becomes the value of from:
    expect(composeReadQuery('from:', [AGE]).ok).toBe(false);
  });

  it('rejects unbalanced parentheses', () => {
    expect(composeReadQuery('(a OR b', [AGE]).ok).toBe(false);
    expect(composeReadQuery('a) OR (b', [AGE]).ok).toBe(false);
  });

  it('allows balanced parentheses, and brackets them so OR cannot bind outward', () => {
    const r = composeReadQuery('(a OR b)', [AGE]);
    expect(r.ok).toBe(true);
    expect(r.query).toBe('((a OR b)) newer_than:30d');
  });

  it('ignores parens inside quoted strings when balancing', () => {
    const r = composeReadQuery('subject:"a (draft"', [AGE]);
    expect(r.ok).toBe(true);
  });

  it('an interior OR cannot reach the injected clause once bracketed', () => {
    const r = composeReadQuery('older_than:365d OR from:x@y.com', [AGE]);
    expect(r.ok).toBe(true);
    // The OR is contained: the age clause is ANDed with the whole disjunction.
    expect(r.query).toBe('(older_than:365d OR from:x@y.com) newer_than:30d');
  });

  it('ANDs multiple clauses (age + correspondent scope) after the bracket', () => {
    const r = composeReadQuery('invoices', [AGE, '(from:a@b.com OR to:a@b.com)']);
    expect(r.query).toBe('(invoices) newer_than:30d (from:a@b.com OR to:a@b.com)');
  });

  it('is provider-agnostic — clauses are supplied, never built here', () => {
    expect(composeReadQuery('x', ['createdAfter=-14days']).query).toBe('(x) createdAfter=-14days');
  });
});

describe('resolveAgeBoundField (schema-driven, no field literal)', () => {
  // Shape mirrors email@0.4 boundsSchema: recipient_max and read_max_age_days
  // are both per_transaction, distinguished only by their boundType.of.
  const emailSchema = {
    fields: {
      recipient_max: { boundType: { kind: 'per_transaction', of: 'recipient_count' } },
      read_max_age_days: { boundType: { kind: 'per_transaction', of: 'read_age_days' } },
      read_daily_max: { boundType: { kind: 'cumulative_count', window: 'daily' } },
    },
  };
  it('finds the bound whose boundType compares the adapter age field', () => {
    expect(resolveAgeBoundField(emailSchema, 'read_age_days')).toBe('read_max_age_days');
  });
  it('does NOT confuse it with another per_transaction bound', () => {
    expect(resolveAgeBoundField(emailSchema, 'recipient_count')).toBe('recipient_max');
  });
  it('generalizes to any profile/field name', () => {
    const cal = { fields: { event_max_age_days: { boundType: { kind: 'per_transaction', of: 'event_age_days' } } } };
    expect(resolveAgeBoundField(cal, 'event_age_days')).toBe('event_max_age_days');
  });
  it('returns null when no matching bound is declared', () => {
    expect(resolveAgeBoundField(emailSchema, 'nonexistent')).toBeNull();
    expect(resolveAgeBoundField(undefined, 'read_age_days')).toBeNull();
  });
});

describe('getByDottedPath', () => {
  // A representative Gmail messages.get shape (top-level string internalDate).
  const gmailGet = { id: 'abc', internalDate: '1700000000000', payload: { headers: [] } };
  it('reads a top-level field', () => {
    expect(getByDottedPath(gmailGet, 'internalDate')).toBe('1700000000000');
  });
  it('reads a nested field', () => {
    expect(getByDottedPath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  });
  it('returns undefined for a missing path (caller fails closed)', () => {
    expect(getByDottedPath(gmailGet, 'nope')).toBeUndefined();
    expect(getByDottedPath(gmailGet, 'payload.missing.deep')).toBeUndefined();
  });
});

// email@0.4 contextSchema: allowed_recipients (format email), allowed_domains (format domain).
const emailContextSchema = {
  fields: {
    allowed_recipients: { format: 'email' },
    allowed_domains: { format: 'domain' },
  },
};

describe('extractEmails / emailDomain', () => {
  it('pulls addresses out of a display-name header value', () => {
    expect(extractEmails('Oliver Kartak <hello@oliverkartak.com>')).toEqual(['hello@oliverkartak.com']);
  });
  it('handles multiple addresses', () => {
    expect(extractEmails('a@x.com, "B" <b@y.com>')).toEqual(['a@x.com', 'b@y.com']);
  });
  it('returns [] for non-strings / no address', () => {
    expect(extractEmails(undefined)).toEqual([]);
    expect(extractEmails('no address here')).toEqual([]);
  });
  it('emailDomain extracts the domain', () => {
    expect(emailDomain('Hello@OliverKartak.com')).toBe('oliverkartak.com');
  });
});

describe('extractParticipants', () => {
  const gmailResp = {
    payload: {
      headers: [
        { name: 'From', value: 'Oliver Kartak <hello@oliverkartak.com>' },
        { name: 'To', value: 'andreas.schadauer@gmail.com' },
        { name: 'Subject', value: 'ignore me' },
        { name: 'Date', value: 'ignore me too' },
      ],
    },
  };
  it('extracts From/To emails, ignoring other headers', () => {
    expect(extractParticipants(gmailResp, 'payload.headers', ['From', 'To']).sort()).toEqual(
      ['andreas.schadauer@gmail.com', 'hello@oliverkartak.com'],
    );
  });
  it('returns [] when the headers path is missing (caller fails closed)', () => {
    expect(extractParticipants({}, 'payload.headers', ['From', 'To'])).toEqual([]);
  });
});

describe('authorityCoversParticipants + resolveScopeFields (the Oliver case)', () => {
  const scope = (ctx: Record<string, string>) => resolveScopeFields(emailContextSchema, ctx);
  const oliverThread = ['hello@oliverkartak.com', 'andreas.schadauer@gmail.com'];

  it('a Sonja-scoped authority does NOT cover an Oliver↔Andreas thread', () => {
    expect(authorityCoversParticipants(oliverThread, scope({ allowed_recipients: 'gebertsonja@gmail.com' }))).toBe(false);
  });
  it('an andreas-scoped authority DOES cover it (Andreas is a participant)', () => {
    expect(authorityCoversParticipants(oliverThread, scope({ allowed_recipients: 'andreas.schadauer@gmail.com' }))).toBe(true);
  });
  it('a domain-scoped authority covers by domain', () => {
    expect(authorityCoversParticipants(['x@acme.com'], scope({ allowed_domains: 'acme.com' }))).toBe(true);
    expect(authorityCoversParticipants(['x@other.com'], scope({ allowed_domains: 'acme.com' }))).toBe(false);
  });
  it('an unscoped authority covers everyone', () => {
    expect(authorityCoversParticipants(oliverThread, scope({}))).toBe(true);
  });
});

describe('buildScopeQuery', () => {
  const TERM = '(from:{v} OR to:{v})';
  const sf = (ctx: Record<string, string>) => resolveScopeFields(emailContextSchema, ctx);
  it('unions scoped authorities into an OR clause', () => {
    const q = buildScopeQuery([sf({ allowed_recipients: 'a@x.com' }), sf({ allowed_recipients: 'b@y.com' })], TERM);
    expect(q).toBe('((from:a@x.com OR to:a@x.com) OR (from:b@y.com OR to:b@y.com))');
  });
  it('returns no filter when ANY authority is unscoped (covers all)', () => {
    expect(buildScopeQuery([sf({ allowed_recipients: 'a@x.com' }), sf({})], TERM)).toBe('');
  });
});
