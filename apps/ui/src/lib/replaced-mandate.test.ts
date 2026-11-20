import { describe, it, expect } from 'vitest';
import { replacedLine, REPLACED_LINE } from './replaced-mandate';

describe('replacedLine — the quiet line on a replaced mandate', () => {
  const set = new Set(['authz_old']);
  it('shows the approved line on an active mandate the gateway recorded as replaced', () => {
    expect(replacedLine('active', 'authz_old', set)).toBe('Replaced by your change. Your AI no longer uses it.');
    expect(REPLACED_LINE).toBe('Replaced by your change. Your AI no longer uses it.');
  });
  it('shows nothing on a mandate that was not replaced', () => {
    expect(replacedLine('active', 'authz_new', set)).toBeNull();
  });
  it('shows nothing once the mandate is revoked or expired (the AS ended it)', () => {
    expect(replacedLine('revoked', 'authz_old', set)).toBeNull();
    expect(replacedLine('expired', 'authz_old', set)).toBeNull();
  });
  it('shows nothing while the list is not known', () => {
    expect(replacedLine('active', 'authz_old', undefined)).toBeNull();
  });
});
