import { describe, it, expect } from 'vitest';
import type { CumulativeUsageEntry } from './sp-client';
import { usageEntryFor } from './cumulative-usage';

const e = (over: Partial<CumulativeUsageEntry>): CumulativeUsageEntry =>
  ({ field: 'write_daily_max', action_type: 'write', kind: 'cumulative_count', window: 'daily', used: 2, limit: 2, ...over });

describe('usageEntryFor', () => {
  it('is undefined when the server sent nothing, or nothing for this bound', () => {
    expect(usageEntryFor(null, 'write_daily_max')).toBeUndefined();
    expect(usageEntryFor([e({ field: 'other' })], 'write_daily_max')).toBeUndefined();
  });
  it('takes the single entry of a bound that names its action', () => {
    expect(usageEntryFor([e({})], 'write_daily_max')?.used).toBe(2);
  });
  it('picks the action type when a bound without appliesTo has one entry per type', () => {
    const entries = [e({ action_type: 'send', used: 1 }), e({ action_type: 'draft', used: 4 })];
    expect(usageEntryFor(entries, 'write_daily_max', 'draft')?.used).toBe(4);
    expect(usageEntryFor(entries, 'write_daily_max', 'unknown')).toBeUndefined();
  });
  it('without an action type, shows only what all entries agree on', () => {
    expect(usageEntryFor([e({ action_type: 'a', used: 1 }), e({ action_type: 'b', used: 4 })], 'write_daily_max')).toBeUndefined();
    expect(usageEntryFor([e({ action_type: 'a', used: 3 }), e({ action_type: 'b', used: 3 })], 'write_daily_max')?.used).toBe(3);
  });
  it('keeps a null limit (none set) as it is', () => {
    expect(usageEntryFor([e({ limit: null })], 'write_daily_max')?.limit).toBeNull();
  });
});
