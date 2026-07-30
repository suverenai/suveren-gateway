import { describe, it, expect } from 'vitest';
import {
  renderAgeConstraint,
  ageFloorValue,
  clampAgeFloor,
  firstParsableDate,
} from '../src/lib/read-gate';

/**
 * The three declarative mechanisms a connector uses to express "how far back
 * may this be read", so no provider ever needs engine code:
 *
 *   {days}/{date}  — relative vs absolute query syntax (Gmail vs Slack search)
 *   ageFloorArg    — time-range APIs (calendar timeMin, Slack history oldest)
 *   resultDatePath — one item, several possible date shapes
 *
 * `now` is injected everywhere; none of these read the clock themselves.
 */

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const DAY = 86_400_000;

describe('renderAgeConstraint — both query dialects from one template', () => {
  it('substitutes {days} for relative syntax', () => {
    expect(renderAgeConstraint('newer_than:{days}d', 30, NOW)).toBe('newer_than:30d');
  });

  it('substitutes {date} with the absolute UTC floor', () => {
    // 30 days before 2026-07-30 is 2026-06-30.
    expect(renderAgeConstraint('after:{date}', 30, NOW)).toBe('after:2026-06-30');
  });

  it('handles a template using both, and repeats', () => {
    expect(renderAgeConstraint('{days}d since {date} ({date})', 7, NOW))
      .toBe('7d since 2026-07-23 (2026-07-23)');
  });

  it('leaves a template with no placeholder untouched', () => {
    expect(renderAgeConstraint('is:unread', 30, NOW)).toBe('is:unread');
  });

  it('renders a 0-day window as a real constraint, not an empty one', () => {
    // 0 = "read nothing". It must still produce a clause; dropping it would
    // widen the query to everything.
    expect(renderAgeConstraint('newer_than:{days}d', 0, NOW)).toBe('newer_than:0d');
    expect(renderAgeConstraint('after:{date}', 0, NOW)).toBe('after:2026-07-30');
  });
});

describe('ageFloorValue — provider time formats', () => {
  it('defaults to RFC3339', () => {
    expect(ageFloorValue(30, NOW)).toBe(new Date(NOW - 30 * DAY).toISOString());
  });

  it('emits epoch milliseconds as a number', () => {
    expect(ageFloorValue(1, NOW, 'epoch_ms')).toBe(NOW - DAY);
  });

  it('emits epoch seconds as a STRING', () => {
    // Slack's `oldest` is a string-encoded epoch; a bare number is rejected.
    const v = ageFloorValue(1, NOW, 'epoch_s');
    expect(typeof v).toBe('string');
    expect(v).toBe(String(Math.floor((NOW - DAY) / 1000)));
  });
});

describe('clampAgeFloor — narrows only, never widens', () => {
  const floorIso = new Date(NOW - 30 * DAY).toISOString();

  it('replaces an omitted lower bound', () => {
    // The important case: at most providers "no lower bound" means all
    // history, which is exactly what the window exists to prevent.
    expect(clampAgeFloor(undefined, 30, NOW)).toBe(floorIso);
    expect(clampAgeFloor(null, 30, NOW)).toBe(floorIso);
    expect(clampAgeFloor('', 30, NOW)).toBe(floorIso);
  });

  it('replaces a bound that reaches further back than the window', () => {
    expect(clampAgeFloor('2020-01-01T00:00:00.000Z', 30, NOW)).toBe(floorIso);
  });

  it('KEEPS a tighter bound the agent asked for', () => {
    // Clamping must not widen a deliberately narrow request.
    const tight = new Date(NOW - 2 * DAY).toISOString();
    expect(clampAgeFloor(tight, 30, NOW)).toBe(tight);
  });

  it('keeps a bound exactly on the boundary', () => {
    expect(clampAgeFloor(floorIso, 30, NOW)).toBe(floorIso);
  });

  it('replaces unparseable junk rather than forwarding it', () => {
    // Junk must not wash out the ceiling by being passed through.
    for (const junk of ['not-a-date', {}, [], true, NaN]) {
      expect(clampAgeFloor(junk, 30, NOW)).toBe(floorIso);
    }
  });

  it('clamps in the provider format when one is declared', () => {
    expect(clampAgeFloor(undefined, 30, NOW, 'epoch_s'))
      .toBe(String(Math.floor((NOW - 30 * DAY) / 1000)));
  });

  it('a 0-day window floors at now', () => {
    expect(clampAgeFloor('2020-01-01T00:00:00.000Z', 0, NOW)).toBe(new Date(NOW).toISOString());
  });
});

describe('firstParsableDate — one item, several date shapes', () => {
  const timed = { start: { dateTime: '2026-07-29T10:00:00Z', timeZone: 'Europe/Vienna' } };
  const allDay = { start: { date: '2026-07-29' } };

  it('reads the first path when present', () => {
    expect(firstParsableDate(timed, ['start.dateTime', 'start.date']))
      .toBe(Date.parse('2026-07-29T10:00:00Z'));
  });

  it('falls through to the second shape', () => {
    // Without this, an all-day event has no parseable date and fails closed —
    // meaning whole-day entries could never be read at all.
    expect(firstParsableDate(allDay, ['start.dateTime', 'start.date']))
      .toBe(Date.parse('2026-07-29'));
  });

  it('still accepts a single path (existing connectors unchanged)', () => {
    expect(firstParsableDate({ internalDate: '1750000000000' }, 'internalDate')).toBe(1750000000000);
  });

  it('returns null when no path parses — callers fail closed', () => {
    expect(firstParsableDate({ start: {} }, ['start.dateTime', 'start.date'])).toBeNull();
    expect(firstParsableDate({}, ['a.b'])).toBeNull();
    expect(firstParsableDate(undefined, ['a'])).toBeNull();
    expect(firstParsableDate({ start: { date: 'garbage' } }, ['start.date'])).toBeNull();
  });

  it('skips an unparseable earlier path instead of giving up', () => {
    expect(firstParsableDate({ a: 'junk', b: '2026-07-29' }, ['a', 'b'])).toBe(Date.parse('2026-07-29'));
  });
});
