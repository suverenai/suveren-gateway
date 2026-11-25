import { describe, it, expect } from 'vitest';
import { durationText } from './give-view';

describe('how long a mandate lasts, in words', () => {
  it('whole days and hours as before', () => {
    expect(durationText(86400)).toBe('1 day');
    expect(durationText(3 * 86400)).toBe('3 days');
    expect(durationText(3600)).toBe('1 hour');
    expect(durationText(5 * 3600)).toBe('5 hours');
  });
  it('what is left of a mandate reads as hours and minutes, never "495 minutes" (phone, dev lane 2026-11-23)', () => {
    expect(durationText(495 * 60)).toBe('8 hours 15 minutes');
    expect(durationText(61 * 60)).toBe('1 hour 1 minute');
    expect(durationText(45 * 60)).toBe('45 minutes');
    expect(durationText(60)).toBe('1 minute');
  });
});
