import { describe, expect, it } from 'vitest';
import { replacedRevokeProblem } from './mandate-replace';

describe('a replaced mandate that cannot be revoked is never silent', () => {
  it('a failed revoke becomes a sentence saying the old mandate is still live', () => {
    expect(replacedRevokeProblem(new Error('Failed: 500'))).toMatch(/still live with its old limits.*Failed: 500/);
  });
  it('an already-revoked old mandate is not a problem', () => {
    expect(replacedRevokeProblem(new Error('Already revoked'))).toBe('');
  });
});
