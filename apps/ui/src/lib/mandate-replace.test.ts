import { describe, expect, it } from 'vitest';
import { replacedRevokeProblem } from './mandate-replace';

describe('a replaced mandate that cannot be revoked is never silent', () => {
  it('a failed revoke becomes a sentence saying the old mandate is still live', () => {
    expect(replacedRevokeProblem('Failed: 500')).toMatch(/still live with its old limits.*Failed: 500/);
  });
  it('no revoke error, nothing to tell', () => {
    expect(replacedRevokeProblem(undefined)).toBe('');
  });
});
