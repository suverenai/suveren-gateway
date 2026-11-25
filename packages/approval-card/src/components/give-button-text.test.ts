/** The card's give button says how this computer gives the mandate (Andreas 2026-11-22). */
import { describe, it, expect } from 'vitest';
import { giveButtonText } from './ApprovalCard';
import { S13 } from '../mandate-screens/texts';

describe('the card give button text', () => {
  it('with a check key here: "Give this mandate with Touch ID", the same words as the give page', () => {
    expect(giveButtonText('touch')).toBe('Give this mandate with Touch ID');
    expect(giveButtonText('touch')).toBe(S13.giveButton);
  });
  it('without one (Windows, Linux, a Mac without Touch ID): "Give this mandate on your phone", the same words as the give page', () => {
    expect(giveButtonText('phone')).toBe('Give this mandate on your phone');
    expect(giveButtonText('phone')).toBe(S13.givePhoneButton);
  });
  it('before the gateway has checked the plan: the plain words', () => {
    expect(giveButtonText(null)).toBe('Give this mandate');
    expect(giveButtonText(undefined)).toBe('Give this mandate');
  });
});
