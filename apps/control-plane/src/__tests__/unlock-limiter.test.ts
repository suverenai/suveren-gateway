import { describe, it, expect } from 'vitest';
import { UnlockLimiter, FREE_ATTEMPTS, BASE_LOCKOUT_MS, DECAY_MS } from '../lib/unlock-limiter';

describe('UnlockLimiter', () => {
  it('blocks after the free attempts, and the wait grows', () => {
    let t = 0;
    const l = new UnlockLimiter({ now: () => t });
    for (let i = 0; i < FREE_ATTEMPTS; i++) expect(l.begin().allowed).toBe(true);
    expect(l.begin()).toMatchObject({ allowed: false });
    t += BASE_LOCKOUT_MS + 1;
    expect(l.begin().allowed).toBe(true);
    t += BASE_LOCKOUT_MS + 1;
    expect(l.begin().allowed).toBe(false);
  });

  it('failures decay: after a quiet period the counter starts again', () => {
    let t = 0;
    const l = new UnlockLimiter({ now: () => t });
    for (let i = 0; i < FREE_ATTEMPTS - 1; i++) l.begin();   // four failures, none ever succeeded
    t += DECAY_MS + 1;
    for (let i = 0; i < FREE_ATTEMPTS - 1; i++) expect(l.begin().allowed).toBe(true);
    expect(l.begin().allowed).toBe(true);                     // would be the 8th failure without decay
  });

  it('a success forgets the failures', () => {
    const l = new UnlockLimiter({ now: () => 0 });
    for (let i = 0; i < FREE_ATTEMPTS - 1; i++) l.begin();
    l.succeed();
    for (let i = 0; i < FREE_ATTEMPTS; i++) expect(l.begin().allowed).toBe(true);
  });
});
