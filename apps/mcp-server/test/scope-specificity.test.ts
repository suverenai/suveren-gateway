import { describe, it, expect } from 'vitest';
import { selectAuthorization, strictlyMoreSpecific, tokenSet, type Passer } from '../src/lib/scope-specificity';

const EMAIL_KEYS = ['allowed_recipients', 'allowed_domains'];

function p(id: string, context: Record<string, string>, requiresApproval: boolean): Passer<string> {
  return { id, auth: id, context, requiresApproval };
}

describe('tokenSet', () => {
  it('splits, trims, lowercases, drops empties', () => {
    expect([...tokenSet(' A@x , b@x ,')]).toEqual(['a@x', 'b@x']);
  });
  it('null/undefined/empty → empty set', () => {
    expect(tokenSet(undefined).size).toBe(0);
    expect(tokenSet('').size).toBe(0);
  });
});

describe('strictlyMoreSpecific', () => {
  it('a scoped grant is more specific than a wildcard', () => {
    expect(strictlyMoreSpecific(EMAIL_KEYS, { allowed_recipients: 'a@x' }, {})).toBe(true);
    expect(strictlyMoreSpecific(EMAIL_KEYS, {}, { allowed_recipients: 'a@x' })).toBe(false);
  });
  it('a subset is more specific than its superset', () => {
    expect(strictlyMoreSpecific(EMAIL_KEYS, { allowed_recipients: 'a@x' }, { allowed_recipients: 'a@x,b@x' })).toBe(true);
  });
  it('partial overlap is incomparable (neither direction)', () => {
    const a = { allowed_recipients: 'a@x,b@x' };
    const b = { allowed_recipients: 'b@x,c@x' };
    expect(strictlyMoreSpecific(EMAIL_KEYS, a, b)).toBe(false);
    expect(strictlyMoreSpecific(EMAIL_KEYS, b, a)).toBe(false);
  });
  it('no context keys → never strictly more specific', () => {
    expect(strictlyMoreSpecific([], { anything: '1' }, { other: '2' })).toBe(false);
  });
});

describe('selectAuthorization', () => {
  it('sole passer wins trivially', () => {
    const s = selectAuthorization(EMAIL_KEYS, [p('a', { allowed_recipients: 'a@x' }, false)]);
    expect(s.reason).toBe('sole');
    expect(s.chosen.id).toBe('a');
  });

  it('most-specific wins — exception honored (specific automatic beats broad review)', () => {
    const broad = p('broad', { allowed_recipients: 'a@x,b@x' }, true); // review
    const specific = p('specific', { allowed_recipients: 'a@x' }, false); // automatic
    const s = selectAuthorization(EMAIL_KEYS, [broad, specific]);
    expect(s.reason).toBe('most-specific');
    expect(s.chosen.id).toBe('specific');
    expect(s.chosen.requiresApproval).toBe(false); // → executes
  });

  it('most-specific wins — restriction enforced (specific review beats broad automatic)', () => {
    const broad = p('broad', { allowed_recipients: 'a@x,b@x' }, false); // automatic
    const specific = p('specific', { allowed_recipients: 'a@x' }, true); // review
    const s = selectAuthorization(EMAIL_KEYS, [broad, specific]);
    expect(s.reason).toBe('most-specific');
    expect(s.chosen.id).toBe('specific');
    expect(s.chosen.requiresApproval).toBe(true); // → proposal (approval NOT bypassed)
  });

  it('incomparable overlap → fail-safe to the approval-requiring passer', () => {
    const x = p('x', { allowed_recipients: 'a@x,b@x' }, false); // automatic
    const y = p('y', { allowed_recipients: 'a@x,c@x' }, true); // review
    const s = selectAuthorization(EMAIL_KEYS, [x, y]);
    expect(s.reason).toBe('fail-safe-approval');
    expect(s.chosen.requiresApproval).toBe(true);
  });

  it('no context schema (e.g. records) → always fail-safe to approval', () => {
    const x = p('x', {}, false);
    const y = p('y', {}, true);
    const s = selectAuthorization([], [x, y]);
    expect(s.reason).toBe('fail-safe-approval');
    expect(s.chosen.id).toBe('y');
  });

  it('all-automatic ambiguous twins → deterministic tie-break by id (not cache order)', () => {
    const b = p('b', { allowed_recipients: 'a@x,b@x' }, false);
    const a = p('a', { allowed_recipients: 'a@x,c@x' }, false);
    // input order [b, a]; deterministic result must not depend on it.
    expect(selectAuthorization(EMAIL_KEYS, [b, a]).chosen.id).toBe('a');
    expect(selectAuthorization(EMAIL_KEYS, [a, b]).chosen.id).toBe('a');
  });

  it('three nested grants → the innermost wins', () => {
    const broad = p('broad', {}, false);
    const mid = p('mid', { allowed_recipients: 'a@x,b@x' }, false);
    const inner = p('inner', { allowed_recipients: 'a@x' }, true);
    const s = selectAuthorization(EMAIL_KEYS, [broad, mid, inner]);
    expect(s.reason).toBe('most-specific');
    expect(s.chosen.id).toBe('inner');
    expect(s.superseded.map(x => x.id).sort()).toEqual(['broad', 'mid']);
  });
});
