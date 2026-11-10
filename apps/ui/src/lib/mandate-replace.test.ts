import { describe, expect, it } from 'vitest';
import { replacedRevokeProblem } from './mandate-replace';
import { encryptsIntent } from './mandate-rights';

describe('a replaced mandate that cannot be revoked is never silent', () => {
  it('a failed revoke becomes a sentence saying the old mandate is still live', () => {
    expect(replacedRevokeProblem(new Error('Failed: 500'))).toMatch(/still live with its old limits.*Failed: 500/);
  });
  it('an already-revoked old mandate is not a problem', () => {
    expect(replacedRevokeProblem(new Error('Already revoked'))).toBe('');
  });
});

describe('the intent is encrypted whenever the workspace is a team', () => {
  // Edit and Copy never set the old `isTeam` flag, so their intent went unencrypted.
  it('a team signing from Edit or Copy encrypts', () => {
    expect(encryptsIntent({ isPersonal: false })).toBe(true);
  });
  it('a snapshot without the flag counts as a team (the safe side)', () => {
    expect(encryptsIntent({})).toBe(true);
  });
  it('the personal workspace does not encrypt', () => {
    expect(encryptsIntent({ isPersonal: true })).toBe(false);
  });
});
