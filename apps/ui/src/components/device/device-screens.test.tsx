import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextValue } from '../../contexts/AuthContext';
import { T, DRAFT } from '../../lib/device-texts';
import { PasswordScreen } from './PasswordScreen';
import { UnlockScreen } from './UnlockScreen';
import { SetupScreen, type SetupScreenProps } from './SetupScreens';
import { ConnectWaiting, CONNECT_STUCK_MS } from './ConnectWaiting';
import { ConfirmChange } from './ConfirmChange';
import { RecoverScreen } from './RecoverScreens';
import { CheckKeyScreen } from './CheckKeyScreens';
import { IdentityResetNotice } from './IdentityResetBanner';
import { LoginPage } from '../../pages/LoginPage';
import type { UnlockState } from '../../lib/unlock-driver';
import type { SetupState } from '../../lib/setup-driver';
import type { ConfirmState } from '../../lib/confirm-driver';
import type { RecoverState } from '../../lib/recover-driver';

// The top bar, the update banner and the simulation banner are untouched by this work and read the browser's
// localStorage and the network; the screens are what is under test.
vi.mock('../TopNav', () => ({ TopNav: () => <nav data-stub="top-nav" /> }));
vi.mock('../UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('../SimulationBanner', () => ({ SimulationBanner: () => null }));

const auth = (over: Partial<AuthContextValue> = {}): AuthContextValue => ({
  user: null, access: 'password', deviceKeysSwitch: true, passwordSet: true, pageSessionOpen: false, sessionEnd: null,
  refreshAccess: async () => ({ access: 'password', switchOn: true, passwordSet: true }), openPageSession: () => {}, adoptSessionUser: async () => true, clearSessionEnd: () => {},
  mode: 'personal', group: null, domain: '', groupId: null, activeTeam: null, activeMembership: null, pendingRequest: null,
  isLoading: false, error: '', login: async () => {}, logout: async () => {}, clearError: () => {}, handleSessionLocked: () => {},
  activeGroup: null, activeDomain: '', groups: [], setActiveContext: () => {}, refreshGroups: async () => {},
  ...over,
});
const html = (el: ReactElement, over?: Partial<AuthContextValue>): string =>
  renderToStaticMarkup(<MemoryRouter><AuthContext.Provider value={auth(over)}>{el}</AuthContext.Provider></MemoryRouter>);
const text = (s: string): string => s.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noop = () => {};

describe('screen 1: password', () => {
  it('the form', () => {
    const t = text(html(<PasswordScreen busy={false} onSubmit={noop} />));
    for (const s of [T.passwordTitle, T.passwordWhy, T.passwordLabel, T.passwordHint, T.passwordAgainLabel, T.passwordButton]) expect(t).toContain(s);
  });
  it('error and success states', () => {
    expect(text(html(<PasswordScreen busy={false} error={T.passwordTooShort} onSubmit={noop} />))).toContain(T.passwordTooShort);
    const ok = html(<PasswordScreen busy={false} success={T.passwordSetPending} onSubmit={noop} />);
    expect(text(ok)).toContain(T.passwordSetPending);
    expect(ok).toContain('disabled');
  });
});

describe('screen 4: unlock', () => {
  const base: UnlockState = { phase: 'form', busy: false, touchBusy: false, touchAvailable: false, passwordOnly: false };
  const render = (s: Partial<UnlockState>) => html(<UnlockScreen state={{ ...base, ...s }} onPassword={noop} onTouch={noop} onRetry={noop} />);

  it('password only: the why, the field, Unlock; no Touch ID button', () => {
    const t = text(render({}));
    expect(t).toContain(T.unlockTitle); expect(t).toContain(T.unlockWhy); expect(t).toContain(T.unlockButton);
    expect(t).not.toContain(T.unlockTouchButton);
    expect(t).not.toContain(DRAFT.unlockForgot); // item 15 does not ship: no route behind it
  });
  it('with Touch ID: the button, "or", then the password', () => {
    const h = render({ touchAvailable: true });
    const divider = h.indexOf(`<div class="login-divider">${T.unlockOr}</div>`);
    expect(divider).toBeGreaterThan(-1);
    expect(h.indexOf(T.unlockTouchButton)).toBeLessThan(divider);
    expect(divider).toBeLessThan(h.indexOf(T.passwordLabel));
  });
  it('the vault is open but the page needs the password: no Touch ID button, the reason shown', () => {
    const t = text(render({ touchAvailable: true, passwordOnly: true, notice: T.sessionClosed }));
    expect(t).not.toContain(T.unlockTouchButton);
    expect(t).toContain(T.sessionClosed);
  });
  it('every reason the page closed is shown instead of the why', () => {
    for (const n of [T.sessionIdle, T.sessionLong, T.sessionClosed, T.locked]) {
      const t = text(render({ notice: n }));
      expect(t).toContain(n);
      expect(t).not.toContain(T.unlockWhy);
    }
  });
  it('error lines and the signing-in state', () => {
    for (const e of [T.wrongPassword, T.touchCancelled, T.touchNotRecognised, T.touchLocked, T.touchCannot, T.touchNoAsk, 'Too many tries. Try again in 10 minutes.']) expect(text(render({ error: e }))).toContain(e);
    const s = text(render({ phase: 'signing-in' }));
    expect(s.trim()).toBe("");  // only the turning mark (no text) while signing in
    expect(s).not.toContain(T.unlockSigningIn);
    expect(s).not.toContain(T.passwordLabel);
    const f = text(render({ phase: 'sign-in-failed', error: T.deviceRemoved }));
    expect(f).toContain(T.deviceRemoved); expect(f).toContain(T.unlockButton);
  });
});

describe('screens 2 and 3: set up this computer', () => {
  const props = (state: SetupState, extra: Partial<SetupScreenProps> = {}): SetupScreenProps => ({
    state, code: null, onBegin: noop, onConnect: noop, onCancel: noop, onKept: noop, onFinish: noop, onRetrySignIn: noop, onDone: noop, ...extra,
  });
  const render = (state: SetupState, extra?: Partial<SetupScreenProps>) => html(<SetupScreen {...props(state, extra)} />);

  it('the second Touch ID prompt of set-up says what it is for, before the Mac asks; nothing when no check key is made', () => {
    expect(text(render({ step: 'start', busy: true }, { touchForCheckKey: true }))).toContain(DRAFT.touchCheckKeyWaiting);
    expect(text(render({ step: 'start', busy: true }, { touchForCheckKey: false }))).not.toContain(DRAFT.touchCheckKeyWaiting);
    expect(text(render({ step: 'start', busy: false }, { touchForCheckKey: true }))).not.toContain(DRAFT.touchCheckKeyWaiting);
  });
  it('the done screen names the connected account (DEC-93) before the dashboard', () => {
    const h = render({ step: 'connected', account: { name: 'Anna Muster', email: 'anna@example.com' }, signedIn: true, busy: false });
    expect(text(h)).toContain(T.connectedAs('Anna Muster', 'anna@example.com'));
  });

  it('DEC-91: no name screen; the start (shown only after a cancel or a failed start) has one button and each refusal', () => {
    const t = text(render({ step: 'start', busy: false }));
    expect(t).toContain(T.nameTitle); expect(t).not.toContain(T.nameLabel); expect(t).not.toContain(T.nameHint);
    expect(render({ step: 'start', busy: false })).not.toContain('<input');
    for (const e of [T.nameInvalid, T.setupPasswordFirst, T.setupAlreadyDone, T.setupUnfinished, T.setupBusy, T.setupGone, T.setupNotFinished]) expect(text(render({ step: 'start', busy: false, error: e }))).toContain(e);
  });
  it('the start offers the recovery code only where a handler exists', () => {
    expect(text(render({ step: 'start', busy: false }))).not.toContain(DRAFT.recoverLink);
    expect(text(render({ step: 'start', busy: false }, { onRecover: noop }))).toContain(DRAFT.recoverLink);
  });
  it('2b Connect, and its refusals', () => {
    const t = text(render({ step: 'connect', busy: false, setupId: 's' }));
    for (const s of [T.connectTitle, T.connectWhy, T.connectHow, T.connectButton, T.connectCancel]) expect(t).toContain(s);
    for (const e of [T.connectBadStart, T.connectTimeout, T.connectOtherWindow, T.connectRefused, T.connectNotAccepted, T.connectCodeBad, T.connectWrongList]) expect(text(render({ step: 'connect', busy: false, setupId: 's', error: e }))).toContain(e);
  });
  it('2c waiting (DEC-68: the name is asked on suveren.ai; here only the waiting state)', () => {
    const t = text(render({ step: 'waiting', setupId: 's' }));
    expect(t).toContain(T.connectWaiting); expect(t).toContain(T.connectCancel);
    // It says what is still missing; no "Start again" before the wait has run long.
    expect(t).toContain(DRAFT.connectWaitingWhat);
    expect(t).not.toContain(DRAFT.connectStuck);
    expect(t).not.toContain(DRAFT.connectStartAgain);
  });
  it('Connect waiting that ran long: says nothing arrived yet and offers Start again (never waits for good)', () => {
    const t = text(html(<ConnectWaiting onStartAgain={noop} initiallyStuck />));
    expect(t).toContain(DRAFT.connectWaitingWhat);
    expect(t).toContain(DRAFT.connectStuck);
    expect(t).toContain(DRAFT.connectStartAgain);
    expect(CONNECT_STUCK_MS).toBeGreaterThan(10_000);
  });
  it('3 DEC-91: the code, the tick and the one condition on one screen; Continue stays off until ticked, the code stays', () => {
    const off = render({ step: 'code', setupId: 's', checked: false, busy: false }, { code: 'SV1-7QK2-M9XD' });
    const t = text(off);
    expect(off).toContain('SV1-7QK2-M9XD');
    for (const s of [T.codeTitle, T.codeWhy, T.codeOnce, T.codePaper, T.codeNever, T.codePrint, T.codeCancel, T.codeKeptBox, T.conditionBody]) expect(t).toContain(s);
    expect(t).not.toContain(T.codeKeptTitle); // no separate "Did you keep it?" screen
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Continue/);
    const on = render({ step: 'code', setupId: 's', checked: true, busy: false }, { code: 'SV1-7QK2-M9XD' });
    expect(on).toContain('SV1-7QK2-M9XD');
    expect(on).not.toMatch(/<button[^>]*disabled=""[^>]*>Continue/);
    expect(render({ step: 'code', setupId: 's', checked: true, busy: true }, { code: 'X' })).toMatch(/<button[^>]*disabled=""[^>]*>Continue/);
  });
  it('2e connected, and 2f signed in did not work', () => {
    const ok = text(render({ step: 'connected', signedIn: true, busy: false, account: { name: 'Anna Muster', email: 'anna@example.com' } }));
    expect(ok).toContain(T.connectedTitle);
    expect(ok).toContain('Connected as Anna Muster (anna@example.com). You are signed in.');
    const bad = text(render({ step: 'connected', signedIn: false, busy: false, error: T.connectedSigninFailed }));
    expect(bad).toContain(T.connectedSigninFailed); expect(bad).toContain(DRAFT.tryAgain);
  });
  it('a set-up left half-way offers the cancel', () => {
    const t = text(render({ step: 'stuck', busy: false, error: T.setupUnfinished }));
    expect(t).toContain(T.setupUnfinished); expect(t).toContain(T.connectCancel);
  });
  it('the code is in no screen but 3', () => {
    for (const st of [{ step: 'start', busy: false }, { step: 'connect', busy: false, setupId: 's' }, { step: 'waiting', setupId: 's' }, { step: 'stuck', busy: false }] as SetupState[]) {
      expect(render(st, { code: null })).not.toContain('SV1-');
    }
  });
});

describe('screen 5: confirm a change to a login', () => {
  const state = (over: Partial<ConfirmState>): ConfirmState => ({ phase: 'asking', kind: 'replace', name: 'Gmail', mode: 'password', ...over });
  const render = (s: ConfirmState) => text(html(<ConfirmChange state={s} onPassword={noop} onTouch={noop} onCancel={noop} />));
  it('password path, replace', () => {
    const t = render(state({}));
    for (const s of [T.confirmTitle, 'Replace the login of "Gmail".', T.confirmScope, T.passwordLabel, 'Replace login']) expect(t).toContain(s);
    expect(t).not.toContain(T.confirmWithTouch);
  });
  it('password path, removal states its cost', () => {
    const t = render(state({ kind: 'remove' }));
    expect(t).toContain('Remove the login of "Gmail". Your AI can no longer use Gmail.');
    expect(t).toContain('Remove login');
  });
  it('Touch ID path tells the person to read the window', () => {
    const t = render(state({ mode: 'touch' }));
    expect(t).toContain(T.confirmWithTouch); expect(t).toContain(T.confirmReadTouch);
    expect(t).not.toContain(T.passwordLabel);
  });
  it('each error line', () => {
    for (const e of [T.confirmExpired, T.confirmCancelled, T.confirmTouchFailed, T.confirmTouchBroken, T.confirmUseTouch, T.wrongPassword]) expect(render(state({ error: e }))).toContain(e);
  });
});

describe('recovery and replacing the recovery code', () => {
  const render = (state: RecoverState, newCode?: string) => html(<RecoverScreen state={state} newCode={newCode} onStart={noop} onCancel={noop} onRotateStart={noop} onRotateSubmit={noop} onDone={noop} />);
  it('recover: form, waiting with what it removes, done', () => {
    expect(text(render({ kind: 'reset', step: 'form', busy: false, error: 'No account belongs to this recovery code. Check it and try again.' }))).toContain('No account belongs');
    const w = text(render({ kind: 'reset', step: 'waiting', recoveryId: 'r', confirmCode: '4821', removes: [{ label: 'Old Mac', kind: 'device' }], hadPendingReset: true }));
    expect(w).toContain('4821'); expect(w).toContain('Old Mac'); expect(w).toContain(DRAFT.recoverPendingClosed); expect(w).toContain(DRAFT.recoverWaiting);
    expect(text(render({ kind: 'reset', step: 'done', signedIn: true }))).toContain(DRAFT.recoverDone);
    expect(text(render({ kind: 'reset', step: 'done', signedIn: false }))).toContain(DRAFT.recoverDoneNoSignin);
  });
  it('rotate: the new code once, old and new typed, waiting, done', () => {
    expect(text(render({ kind: 'rotate', step: 'intro', busy: false }))).toContain(DRAFT.rotateStart);
    const s = render({ kind: 'rotate', step: 'show', rotateId: 'n', checked: false }, 'SV1-NEW-CODE');
    expect(s).toContain('SV1-NEW-CODE'); expect(text(s)).toContain(T.codeKeptBox);
    // the code is hidden before the person is asked to type it again
    expect(text(s)).not.toContain(DRAFT.rotateOldLabel); expect(s).not.toContain('type="password"');
    expect(s).toMatch(/<button[^>]*disabled=""[^>]*>Continue/);
    const e = render({ kind: 'rotate', step: 'enter', rotateId: 'n', busy: false }, 'SV1-NEW-CODE');
    expect(e).not.toContain('SV1-NEW-CODE'); expect(text(e)).toContain(DRAFT.rotateOldLabel); expect(text(e)).toContain(DRAFT.rotateNewLabel);
    // recovery codes are plain text fields that password managers are told to leave alone
    expect(e).not.toContain('type="password"'); expect(e).toContain('data-1p-ignore'); expect(e).toContain('data-lpignore'); expect(e).toContain('spellCheck="false"'.replace('C','c'));
    expect(text(render({ kind: 'rotate', step: 'waiting', recoveryId: 'r', confirmCode: '77' }))).toContain('77');
    expect(text(render({ kind: 'rotate', step: 'done' }))).toContain(DRAFT.rotateDone);
    expect(render({ kind: 'rotate', step: 'waiting', recoveryId: 'r', confirmCode: '77' })).not.toContain('SV1-');
  });
});

describe('the alarm for a request for a new identity', () => {
  it('item 99 with the hours left, and the cancel button (item 100)', () => {
    const t = text(html(<IdentityResetNotice state={{ pending: { id: 'r', effectiveAt: 1000 + 71 * 3600 }, busy: false, cancelled: false }} nowSeconds={1000} onCancel={noop} />));
    expect(t).toContain('Someone asked to start your account again from scratch. Your mandates would have to be granted again. It takes effect in 71 hours. If this was not you, cancel it now.');
    expect(t).toContain('Cancel this request');
  });
  it('after the cancel: "Cancelled. Your account stays as it was."; with no request: nothing', () => {
    expect(text(html(<IdentityResetNotice state={{ pending: null, busy: false, cancelled: true }} nowSeconds={0} onCancel={noop} />))).toContain(T.identityResetCancelled);
    expect(html(<IdentityResetNotice state={{ pending: null, busy: false, cancelled: false }} nowSeconds={0} onCancel={noop} />)).toBe('');
  });
});

describe('a gateway without an unlock password keeps today\'s sign-in page', () => {
  it('the login page shows the account-key form and none of the device-key words', () => {
    const h = html(<LoginPage />, { access: 'legacy', deviceKeysSwitch: false, passwordSet: false });
    const t = text(h);
    expect(t).toContain('Sign In'); expect(t).toContain('Enter your API key to manage mandates.'); expect(t).toContain('API Key');
    for (const v of ([...Object.values(T), ...Object.values(DRAFT)] as unknown[]).filter((x): x is string => typeof x === 'string')) {
      if (v.length < 12) continue; // single words (Cancel, Continue, Connect) also exist on the old page
      expect(t, v).not.toContain(v);
    }
    expect(h).not.toContain('device-screen');
  });
  it('is the same page with the switch on but no password', () => {
    const off = html(<LoginPage />, { access: 'legacy', deviceKeysSwitch: false, passwordSet: false });
    const on = html(<LoginPage />, { access: 'legacy', deviceKeysSwitch: true, passwordSet: false });
    expect(on).toBe(off);
  });
});

describe('turn on Touch ID for approvals (a computer set up without it)', () => {
  const props = { onSubmit: noop, onCancel: noop, onBack: noop, onDone: noop };
  it('the form asks for the recovery code and the unlock password; each touch says what it is for; the email step shows the code to compare', () => {
    const f = text(html(<CheckKeyScreen {...props} state={{ step: 'form', busy: false }} />));
    expect(f).toContain(DRAFT.addCheckTitle);
    expect(f).toContain(DRAFT.addCheckWhy);
    expect(f).toContain(DRAFT.recoverCodeLabel);
    expect(f).toContain(T.passwordLabel);
    expect(text(html(<CheckKeyScreen {...props} state={{ step: 'touch-key' }} />))).toContain(DRAFT.touchCheckKeyWaiting);
    const w = text(html(<CheckKeyScreen {...props} state={{ step: 'waiting', recoveryId: 'r', confirmCode: '654321' }} />));
    expect(w).toContain('654321');
    expect(w).toContain(DRAFT.recoverMail);
    expect(text(html(<CheckKeyScreen {...props} state={{ step: 'touch-unlock' }} />))).toContain(DRAFT.touchSetupWaiting);
    expect(html(<CheckKeyScreen {...props} state={{ step: 'finishing' }} />)).toContain('brand-spin');
    expect(text(html(<CheckKeyScreen {...props} state={{ step: 'done', unlockOn: true }} />))).toContain(DRAFT.addCheckDone);
    expect(text(html(<CheckKeyScreen {...props} state={{ step: 'done', unlockOn: false }} />))).toContain(DRAFT.addCheckDoneNoUnlock);
  });
});
