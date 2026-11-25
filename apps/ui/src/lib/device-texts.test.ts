import { describe, it, expect } from 'vitest';
import { T, DRAFT, DRAFT_CODE_LIST, textForCode, minutesText, hoursLeft, identityResetText, changeSentence, changeButton, changeDone, isSilentCode, isDecisionCode } from './device-texts';
import { DEVICE_MESSAGES } from '../../../control-plane/src/routes/device-setup';
import { PASSWORD_MESSAGES } from '../../../control-plane/src/routes/password';
import { PLATFORM_MESSAGES } from '../../../control-plane/src/routes/platform';
import { RECOVERY_MESSAGES } from '../../../control-plane/src/routes/device-recovery';
import { DECISION_MESSAGES } from '../../../control-plane/src/routes/device-decision';

/** Codes whose text is deliberately the generic one (103) or silent: no text of their own in the recommendation. */
const GENERIC_OR_SILENT = new Set([
  'bad_request', 'no_biometry', 'helper_unavailable', 'already_unlocked', 'confirmation_required',
  'establish_failed', 'signin_failed', 'use_device_signin', 'vault_unreadable', 'password_changed', 'wipe_refused',
]);

describe('every code of the control plane has a text of its own', () => {
  const all: Array<[string, Record<string, string>]> = [
    ['device', DEVICE_MESSAGES], ['password', PASSWORD_MESSAGES], ['platform', PLATFORM_MESSAGES],
    ['recovery', RECOVERY_MESSAGES], ['decision', DECISION_MESSAGES],
  ];
  for (const [name, table] of all) {
    it(`${name}: no code falls through to the placeholder or the raw code`, () => {
      for (const [code, placeholder] of Object.entries(table)) {
        const text = textForCode(code, { retryAfterSeconds: 600 });
        expect(text, code).not.toBe(code);
        expect(text.length, code).toBeGreaterThan(5);
        if (!GENERIC_OR_SILENT.has(code)) {
          // A mapped code must not read as the generic fallback (it has its own words) ...
          expect(text, `${code} fell through to the generic text`).not.toBe(T.generic);
        }
        // ... and the control plane's placeholder is never what the person reads, unless the final text happens to equal it.
        if (text === placeholder) expect(Object.values(T).includes(text as never) || Object.values(DRAFT).includes(text as never) || DRAFT_CODE_LIST.includes(code)).toBe(true);
      }
    });
  }

  it('the page-session codes map to the three session sentences', () => {
    expect(textForCode('session_idle')).toBe(T.sessionIdle);
    expect(textForCode('session_expired')).toBe(T.sessionLong);
    expect(textForCode('session_missing')).toBe(T.sessionClosed);
    expect(textForCode('session_invalid')).toBe(T.sessionClosed);
    expect(textForCode('locked')).toBe(T.locked);
  });

  it('an unknown code reads as the generic text, never the code', () => {
    expect(textForCode('something_new')).toBe(T.generic);
    expect(textForCode(undefined)).toBe(T.generic);
  });

  it('the codes that show nothing are exactly the three the recommendation names', () => {
    expect(['no_biometry', 'helper_unavailable', 'already_unlocked'].every(isSilentCode)).toBe(true);
    expect(isSilentCode('wrong_password')).toBe(false);
  });
});

describe('the final texts, exactly (wording-recommendation.md, DEC-70)', () => {
  it('screen 1', () => {
    expect(T.passwordTitle).toBe('Set an unlock password');
    expect(T.passwordButton).toBe('Set password');
    expect(T.passwordTooShort).toBe('Too short. Use at least 10 characters.');
    expect(T.passwordMismatch).toBe('The two passwords are different.');
    expect(T.passwordExists).toBe('A password is already set. Use it to unlock.');
    expect(T.passwordNotSignedIn).toBe('Sign in to your account first, then set a password.');
    expect(T.passwordSet).toBe('Password set.');
    expect(T.passwordSetPending).toBe('Password set. One step is still finishing in the background. It needs nothing from you.');
  });
  it('screens 2 and 3', () => {
    expect(T.connectTitle).toBe('Connect this computer to your Suveren account');
    expect(T.connectWaiting).toBe('Finish in the browser window that just opened. This page goes on by itself.');
    expect(T.connectTimeout).toBe('Nothing came back from the browser in time. Press Connect to try again.');
    expect(T.connectedAs('Anna Muster', 'anna@example.com')).toBe('Connected as Anna Muster (anna@example.com). You are signed in.');
    expect(T.codeTitle).toBe('Your recovery code');
    expect(T.codeOnce).toBe('It is shown only once.');
    expect(T.codePrint).toBe('Print the code');
    expect(T.codeCancel).toBe('Cancel set-up. This code stops working.');
    expect(T.codeKeptBox).toBe('I wrote the code down and keep it where my AI cannot read it.');
    expect(T.conditionTitle).toBe('Keep your AI away from this page');
    expect(T.conditionButton).toBe('I understand');
  });
  it('screens 4 to 6', () => {
    expect(T.unlockTitle).toBe('Unlock the gateway');
    expect(T.unlockTouchButton).toBe('Unlock with Touch ID');
    expect(T.unlockSigningIn).toBe('Signing in to your account...');
    expect(T.touchCancelled).toBe('Cancelled. Use Touch ID again, or type your password.');
    expect(T.touchNoAsk).toBe('Touch ID could not ask for your touch. Bring this window to the front and try again.');
    expect(T.confirmTitle).toBe('Confirm this change');
    expect(changeSentence('replace', 'Gmail')).toBe('Replace the login of "Gmail".');
    expect(changeSentence('remove', 'Gmail')).toBe('Remove the login of "Gmail". Your AI can no longer use Gmail.');
    expect(changeButton('replace')).toBe('Replace login');
    expect(changeButton('remove')).toBe('Remove login');
    expect(changeDone('remove', 'Gmail')).toBe('Done. The login of "Gmail" was removed.');
    expect(T.touchWindowReplace('Gmail')).toBe('replace the login of "Gmail"');
    expect(T.wrongPassword).toBe('Wrong password.');
    expect(T.sessionIdle).toBe('You were away for an hour, so this page closed. Unlock it again to go on.');
    expect(T.sessionLong).toBe('This page has been open for 12 hours, so it closed. Unlock it again to go on.');
    expect(T.generic).toBe('This did not work. Nothing was changed. Try again.');
    expect(T.identityResetCancel).toBe('Cancel this request');
  });
  it('the sample values are filled in', () => {
    expect(textForCode('too_many_attempts', { retryAfterSeconds: 600 })).toBe('Too many tries. Try again in 10 minutes.');
    expect(minutesText(30)).toBe('1 minute');
    expect(T.identityReset(71)).toContain('It takes effect in 71 hours.');
    expect(hoursLeft(1000 + 71 * 3600 - 5, 1000)).toBe(71);
    expect(identityResetText(1000, 2000)).toBe(T.identityResetDue);
    expect(textForCode('cancelled', { screen: 'unlock' })).toBe(T.touchCancelled);
    expect(textForCode('cancelled', { screen: 'confirm' })).toBe(T.confirmCancelled);
    expect(textForCode('key_invalid', { screen: 'confirm' })).toBe(T.confirmTouchBroken);
  });
  it('a refused Connect for an account that already has a device chain says to add the computer from a device (plan 20.18 point 6)', () => {
    expect(textForCode('connect_refused', { screen: 'connect', asCode: 'CHAIN_EXISTS' })).toBe(DRAFT.connectChainExists);
    expect(textForCode('connect_refused', { screen: 'connect' })).toBe(T.connectRefused);
    expect(textForCode('connect_refused', { screen: 'connect', asCode: 'SOMETHING_ELSE' })).toBe(T.connectRefused);
  });

  it('decision codes are recognised', () => {
    expect(isDecisionCode('content_mismatch')).toBe(true);
    expect(isDecisionCode('wrong_password')).toBe(false);
  });
});
