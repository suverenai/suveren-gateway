/**
 * Refusing audibly when the requested age window exceeds the authorized one.
 *
 * The age ceiling is ANDed onto the agent's search. That is safe but SILENT:
 * asking for mail 90–120 days old against a 90-day window composes
 * `(older_than:90d newer_than:120d) newer_than:90d` — a contradiction that
 * returns zero results with nothing to say the request was narrowed.
 *
 * Observed live: a query for mail from one sender 90–120 days ago returned
 * `resultSizeEstimate: 0`, while the same query without dates returned 13
 * messages. An agent that had not separately checked the bound would have
 * reported "there are no such emails" — false, and stated with confidence.
 * That is worse than a refusal, and it is the same silent-filtering failure we
 * rejected when deciding NOT to scope reads by category.
 */
import { describe, it, expect } from 'vitest';
import { detectAgeConflict } from '../src/lib/read-gate';

const GMAIL = 'older_than:(\\d+)d';

describe('detectAgeConflict', () => {
  it('flags a request for older data than the window allows', () => {
    expect(detectAgeConflict('from:x older_than:90d newer_than:120d', GMAIL, 90)).toBe(90);
  });

  it('treats equal-to-the-ceiling as a conflict — it can only match nothing', () => {
    // older_than:90d against a 90-day ceiling is the empty set by definition.
    expect(detectAgeConflict('older_than:90d', GMAIL, 90)).toBe(90);
  });

  it('permits a request comfortably inside the window', () => {
    expect(detectAgeConflict('from:x older_than:10d', GMAIL, 90)).toBeNull();
  });

  it('reports the WORST offender when several are present', () => {
    // The message quotes this back, so it must name the real problem.
    expect(detectAgeConflict('older_than:100d OR older_than:365d', GMAIL, 90)).toBe(365);
  });

  it('ignores an unrelated query', () => {
    expect(detectAgeConflict('from:sonja is:unread', GMAIL, 90)).toBeNull();
  });

  it('is inert when the tool declares no pattern', () => {
    // Providers without a declared conflict syntax keep the old behaviour
    // rather than the engine guessing at their query language.
    expect(detectAgeConflict('older_than:900d', undefined, 90)).toBeNull();
  });

  it('is inert when no age bound applies', () => {
    expect(detectAgeConflict('older_than:900d', GMAIL, null)).toBeNull();
  });

  it('survives a malformed pattern rather than breaking reads', () => {
    expect(detectAgeConflict('older_than:900d', '([unclosed', 90)).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectAgeConflict('OLDER_THAN:120d', GMAIL, 90)).toBe(120);
  });

  it('ignores a non-numeric capture', () => {
    expect(detectAgeConflict('older_than:manyd', GMAIL, 90)).toBeNull();
  });
});
