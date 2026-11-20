import { describe, it, expect } from 'vitest';
import { mayGoToPhone, afterLookup, afterGivePoll, holdsOutcome, LOOKUP_TRIES, type ApprovedPhoneGive } from './approved-phone-give';

describe('an approved mandate that went to the phone (DEC-90)', () => {
  it('only the two Setup mandate tools are looked up', () => {
    expect(mayGoToPhone('setup__create_mandate')).toBe(true);
    expect(mayGoToPhone('setup__change_mandate')).toBe(true);
    expect(mayGoToPhone('mail__send_message')).toBe(false);
    expect(mayGoToPhone('setup__set_agent_brief')).toBe(false);
  });

  it('a give found while looking makes the card wait for the phone', () => {
    expect(afterLookup({ s: 'looking', tries: 0 }, { mandateId: 'm-12345678' })).toEqual({ s: 'waiting', mandateId: 'm-12345678' });
  });

  it('no give after the last try: given on this computer, the panel goes on', () => {
    let st: ApprovedPhoneGive = { s: 'looking', tries: 0 };
    for (let i = 0; i < LOOKUP_TRIES - 1; i++) { st = afterLookup(st, null); expect(st.s).toBe('looking'); }
    expect(afterLookup(st, null)).toEqual({ s: 'none' });
  });

  it('the wait ends with Signed, or Stopped when nothing waits any more; a late answer changes nothing', () => {
    const w: ApprovedPhoneGive = { s: 'waiting', mandateId: 'm-12345678' };
    expect(afterGivePoll(w, { state: 'waiting' })).toBe(w);
    expect(afterGivePoll(w, { state: 'done' })).toEqual({ s: 'given' });
    expect(afterGivePoll(w, { state: 'unknown' })).toEqual({ s: 'stopped' });
    expect(afterGivePoll({ s: 'stopped' }, { state: 'done' })).toEqual({ s: 'stopped' });
  });

  it('the panel does not move on while it looks, waits or shows the phone\'s result', () => {
    expect(holdsOutcome({ s: 'idle' })).toBe(false);
    expect(holdsOutcome({ s: 'none' })).toBe(false);
    for (const st of [{ s: 'looking', tries: 0 }, { s: 'waiting', mandateId: 'x' }, { s: 'given' }, { s: 'stopped' }, { s: 'refused', message: 'no' }] as ApprovedPhoneGive[]) {
      expect(holdsOutcome(st)).toBe(true);
    }
  });
});
