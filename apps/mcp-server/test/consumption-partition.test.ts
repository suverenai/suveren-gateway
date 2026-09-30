/**
 * Usage is reported per action type — the same partition the gate enforces and
 * the Authority Server applies.
 *
 * Found 2026-09-30 on the shipped sales@0.1 profile through the dev gateway:
 * after one quote, one send and one order, list-authorizations reported
 * "Quotes per day 3", "Orders per day 3" and a daily order value that summed the
 * quote and send values. The log was asked for the profile's combined total for
 * every bound, so the agent was told it had used headroom it had not. Display
 * only — the gateway enforces no cumulative limit locally (the Authority Server
 * does, partitioned correctly) — but an agent that believes its usage holds back
 * or plans around limits that are not binding.
 *
 * Uses the real ExecutionLog (a mock would ignore the filter and pass anyway)
 * and the shipped profile file, not an inline copy.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile } from '@hap/core';
import { ExecutionLog } from '../src/lib/execution-log';
import { getConsumptionState } from '../src/lib/consumption';
import type { EnrichedAuthorization } from '../src/lib/shared-state';

const profile = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', '..', 'hap-profiles', 'sales', '0.1.profile.json'), 'utf8'),
) as AgentProfile;
const PATH = 'sales-path';

function logWith(entries: Array<[string | undefined, number]>): ExecutionLog {
  const log = new ExecutionLog(mkdtempSync(join(tmpdir(), 'suveren-partition-')));
  const now = Math.floor(Date.now() / 1000);
  for (const [action_type, value] of entries) {
    log.record({
      profileId: profile.id,
      path: PATH,
      execution: action_type ? { action_type, value } : { value },
      timestamp: now,
    });
  }
  return log;
}

const auth = {
  profileId: profile.id,
  path: PATH,
  frame: {
    profile: profile.id, read_access: 'unlimited', value_max: 50, discount_max: 25,
    order_value_daily_max: 500, quote_daily_max: 6, send_daily_max: 6, order_daily_max: 7,
  },
} as unknown as EnrichedAuthorization;

const usage = (log: ExecutionLog) =>
  Object.fromEntries(getConsumptionState(auth, log, profile).map(e => [e.field, e.current]));

describe('consumption is partitioned by action type (shipped sales@0.1)', () => {
  it('one quote, one send, one order read as one each — the live 2026-09-30 case', () => {
    const u = usage(logWith([['quote', 37], ['send', 37], ['order', 37]]));
    expect(u.quote_daily_max).toBe(1);
    expect(u.send_daily_max).toBe(1);
    expect(u.order_daily_max).toBe(1);
    // Daily order value counts orders only: 37, not 111.
    expect(u.order_value_daily_max).toBe(37);
  });

  it('the log filter itself: sum of value over orders only', () => {
    const log = logWith([['quote', 10], ['order', 40], ['send', 10], ['order', 5]]);
    expect(log.sumByWindow(profile.id, PATH, 'value', 'daily', undefined, ['order'])).toBe(45);
    expect(log.sumByWindow(profile.id, PATH, '_count', 'daily', undefined, ['quote'])).toBe(1);
    // No filter keeps the old meaning: every execution under the profile and path.
    expect(log.sumByWindow(profile.id, PATH, '_count', 'daily')).toBe(4);
  });

  it('an entry with no action type counts against every bound (fail closed)', () => {
    const u = usage(logWith([['quote', 10], [undefined, 20]]));
    expect(u.quote_daily_max).toBe(2);
    expect(u.order_daily_max).toBe(1);
    expect(u.order_value_daily_max).toBe(20);
  });
});
