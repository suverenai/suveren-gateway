/**
 * What the consumption view shows an agent.
 *
 * Seen live in `list-authorizations`:
 *
 *   Not currently enforced: reads carry no receipt, so no component counts
 *   them. Hidden from the authorization editor until enforcement exists.: 0 / 7
 *
 * Two faults in one line. The bound is declared `enforced: false`, so there is
 * no consumption to report at all — showing "0 / 7" tells the agent it has
 * headroom under a limit that does not exist. And the label was taken from
 * `description`, which is prose for a human reading the profile, not a label.
 *
 * The authorization editor already hid the bound; this surface disagreed. Both
 * now use the same rule.
 */
import { describe, it, expect } from 'vitest';
import { getConsumptionState } from '../src/lib/consumption';
import type { ExecutionLogQuery } from '@hap/core';

const log = {
  sumByWindow: () => 0,
} as unknown as ExecutionLogQuery;

function profileWith(fields: Record<string, unknown>) {
  return { id: 'p', version: '0.4', boundsSchema: { keyOrder: Object.keys(fields), fields } } as never;
}

const auth = (frame: Record<string, unknown>) =>
  ({ profileId: 'p', path: 'p', frame } as never);

describe('consumption view', () => {
  it('OMITS a bound the profile declares unenforced', () => {
    const profile = profileWith({
      send_daily_max: {
        type: 'number', displayName: 'Daily send limit',
        boundType: { kind: 'cumulative_count', window: 'daily' },
      },
      read_daily_max: {
        type: 'number', displayName: 'Daily read limit',
        description: 'Not currently enforced: reads carry no receipt…',
        enforced: false,
        boundType: { kind: 'cumulative_count', window: 'daily' },
      },
    });

    const entries = getConsumptionState(
      auth({ send_daily_max: 4, read_daily_max: 7 }), log, profile,
    );

    expect(entries.map(e => e.field)).toEqual(['send_daily_max']);
    // Nothing counts reads, so "0 / 7" would imply headroom under a limit that
    // does not exist.
    expect(JSON.stringify(entries)).not.toContain('read_daily_max');
  });

  it('labels with displayName, not the description paragraph', () => {
    const profile = profileWith({
      send_daily_max: {
        type: 'number',
        displayName: 'Daily send limit',
        description: 'A long sentence explaining, at length, what this bound governs and why.',
        boundType: { kind: 'cumulative_count', window: 'daily' },
      },
    });

    const [entry] = getConsumptionState(auth({ send_daily_max: 4 }), log, profile);
    expect(entry.label).toBe('Daily send limit');
    expect(entry.label).not.toContain('at length');
  });

  it('falls back to description, then the field name, when there is no displayName', () => {
    const withDesc = profileWith({
      a_max: { type: 'number', description: 'Fallback label', boundType: { kind: 'cumulative_count', window: 'daily' } },
    });
    expect(getConsumptionState(auth({ a_max: 1 }), log, withDesc)[0].label).toBe('Fallback label');

    const bare = profileWith({
      b_max: { type: 'number', boundType: { kind: 'cumulative_count', window: 'daily' } },
    });
    expect(getConsumptionState(auth({ b_max: 1 }), log, bare)[0].label).toBe('b_max');
  });

  it('still reports enforced bounds — this must not hide real limits', () => {
    const profile = profileWith({
      send_daily_max: {
        type: 'number', displayName: 'Daily send limit', enforced: true,
        boundType: { kind: 'cumulative_count', window: 'daily' },
      },
    });
    expect(getConsumptionState(auth({ send_daily_max: 4 }), log, profile)).toHaveLength(1);
  });
});
