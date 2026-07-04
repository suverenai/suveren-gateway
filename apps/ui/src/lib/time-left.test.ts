/**
 * formatTimeLeft — the approval countdown shown on pending review cards.
 */
import { describe, it, expect } from 'vitest';
import { formatTimeLeft } from './time-left';

const NOW_MS = 1_800_000_000_000;
const nowSec = NOW_MS / 1000;

describe('formatTimeLeft', () => {
  it('days + hours for multi-day windows (the 72h default)', () => {
    const t = formatTimeLeft(nowSec + 72 * 3600, NOW_MS);
    expect(t.label).toBe('expires in 3d 0h');
    expect(t.urgent).toBe(false);
    expect(t.expired).toBe(false);
  });

  it('hours + minutes under a day', () => {
    expect(formatTimeLeft(nowSec + 5 * 3600 + 30 * 60, NOW_MS).label).toBe('expires in 5h 30m');
  });

  it('minutes only under an hour — and urgent', () => {
    const t = formatTimeLeft(nowSec + 45 * 60, NOW_MS);
    expect(t.label).toBe('expires in 45m');
    expect(t.urgent).toBe(true);
  });

  it('urgency threshold is 2 hours', () => {
    expect(formatTimeLeft(nowSec + 2 * 3600 + 60, NOW_MS).urgent).toBe(false);
    expect(formatTimeLeft(nowSec + 2 * 3600 - 60, NOW_MS).urgent).toBe(true);
  });

  it('never shows "0m" — floors at 1 minute', () => {
    expect(formatTimeLeft(nowSec + 20, NOW_MS).label).toBe('expires in 1m');
  });

  it('past deadline reads expired', () => {
    const t = formatTimeLeft(nowSec - 10, NOW_MS);
    expect(t.expired).toBe(true);
    expect(t.label).toBe('expired');
  });
});
