/**
 * A mandate whose count bound for an action is 0 can never allow that action —
 * selection must skip it, so another mandate on the same profile that does allow
 * the action is chosen.
 *
 * Found 2026-10-02 (hap-e2e simulation-mode): with a work mandate
 * (setup_daily_max 0) and a setup mandate (setup_daily_max 1) on sales@0.2, the
 * selection tiebreak sometimes picked the work mandate for load_simulation and
 * the Authority Server refused — although the setup mandate allowed it.
 *
 * Uses the shipped sales@0.2 profile, not an inline copy.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerProfile } from '@hap/core';
import { zeroCappedBound } from '../src/lib/tool-proxy';

const profilesDir = process.env.SUVEREN_PROFILES_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', 'hap-profiles');
const SALES = JSON.parse(readFileSync(join(profilesDir, 'sales', '0.2.profile.json'), 'utf8'));

beforeAll(() => { registerProfile(SALES.id, SALES); });

describe('zero-capped mandates are skipped for the capped action only', () => {
  const work = { setup_daily_max: 0, quote_daily_max: 10, send_daily_max: 10, order_daily_max: 10 };
  const setup = { setup_daily_max: 1, quote_daily_max: 0, send_daily_max: 0, order_daily_max: 0 };

  it('the work mandate cannot load test data', () => {
    expect(zeroCappedBound(SALES.id, work, 'setup')).toBe('setup_daily_max');
  });

  it('the work mandate can still quote', () => {
    expect(zeroCappedBound(SALES.id, work, 'quote')).toBeNull();
  });

  it('the setup mandate can load but cannot quote', () => {
    expect(zeroCappedBound(SALES.id, setup, 'setup')).toBeNull();
    expect(zeroCappedBound(SALES.id, setup, 'quote')).toBe('quote_daily_max');
  });

  it('no action type, or an unknown profile, never skips (the AS still decides)', () => {
    expect(zeroCappedBound(SALES.id, work, undefined)).toBeNull();
    expect(zeroCappedBound('github.com/x/unknown@1', work, 'setup')).toBeNull();
  });
});
