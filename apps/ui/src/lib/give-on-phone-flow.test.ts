import { describe, it, expect } from 'vitest';
import { phoneGiveOffered, afterPoll, afterRefusal, phoneGiveBusy, waitExpired, type GivePhoneState } from './give-on-phone-flow';

describe('Give on your phone (DEC-90): the page flow', () => {
  it('is offered only when this computer lacks a check key and a phone of the chain can grant', () => {
    expect(phoneGiveOffered({ onPhone: true, blocked: { code: 'no_check_key' } })).toBe(true);
    expect(phoneGiveOffered({ onPhone: true, blocked: null })).toBe(false);                       // this computer can give it itself
    expect(phoneGiveOffered({ onPhone: false, blocked: { code: 'no_check_key' } })).toBe(false);   // no phone that can
    expect(phoneGiveOffered({ onPhone: true, blocked: { code: 'approver_not_listed' } })).toBe(false); // another refusal stays a refusal
    expect(phoneGiveOffered(null)).toBe(false);
  });

  it('waits until the phone has given it, then shows the result', () => {
    const w: GivePhoneState = { s: 'waiting', mandateId: 'm_12345678', expiresAt: 2_000_000_000 };
    expect(afterPoll(w, { state: 'waiting' })).toBe(w);
    expect(afterPoll(w, { state: 'done', authorizationId: 'authz_1' })).toEqual({ s: 'given', authorizationId: 'authz_1' });
    expect(afterPoll(w, { state: 'done', authorizationId: 'authz_1', revokeError: 'x' })).toEqual({ s: 'given', authorizationId: 'authz_1', revokeError: 'x' });
    expect(afterPoll(w, { state: 'unknown' })).toEqual({ s: 'stopped' });
  });

  it('a late answer after Stop or a refusal changes nothing', () => {
    expect(afterPoll({ s: 'stopped' }, { state: 'done', authorizationId: 'authz_1' })).toEqual({ s: 'stopped' });
    expect(afterPoll({ s: 'refused', message: 'no' }, { state: 'done', authorizationId: 'authz_1' })).toEqual({ s: 'refused', message: 'no' });
  });

  it('a refusal while sending or waiting ends the wait; otherwise it is ignored', () => {
    expect(afterRefusal({ s: 'sending' }, 'grant_invalid', 'm')).toEqual({ s: 'refused', code: 'grant_invalid', message: 'm' });
    expect(afterRefusal({ s: 'waiting', mandateId: 'm_12345678', expiresAt: 1 }, undefined, 'm')).toEqual({ s: 'refused', message: 'm' });
    expect(afterRefusal({ s: 'stopped' }, 'x', 'm')).toEqual({ s: 'stopped' });
  });

  it('is busy only while sending or waiting, and the wait runs out at the request expiry', () => {
    expect(phoneGiveBusy({ s: 'sending' })).toBe(true);
    expect(phoneGiveBusy({ s: 'offered' })).toBe(false);
    const w: GivePhoneState = { s: 'waiting', mandateId: 'm_12345678', expiresAt: 100 };
    expect(phoneGiveBusy(w)).toBe(true);
    expect(waitExpired(w, 99_999)).toBe(false);
    expect(waitExpired(w, 100_000)).toBe(true);
  });
});
