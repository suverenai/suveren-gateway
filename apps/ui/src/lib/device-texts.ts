/**
 * Every word the person reads on the device-key screens (unlock password, Connect, recovery code, unlock,
 * confirm a login change, errors). The texts are the maintainer's final choice
 * (temp/device-keys-mockup/wording-recommendation.md, DEC-70); the number in a comment is the item of that
 * file. A code the control plane sends is mapped to its text in {@link textForCode}; a code the
 * recommendation has no text for gets one in the same style, marked `DRAFT` (listed in the hand-over report).
 *
 * Pure: no React, no network. Sample values of the recommendation ("10 minutes", "71 hours", "Gmail") are
 * filled in by the functions here.
 */

export const T = {
  // Screen 1: password
  passwordTitle: 'Set an unlock password', // 1
  passwordWhy: 'You type it when the gateway starts and to open this page. Without it, your connector logins (for example Gmail) stay locked.', // 2 (+ confusion note 2)
  passwordLabel: 'Password', // 3
  passwordHint: 'At least 10 characters.', // 3
  passwordAgainLabel: 'Password again', // 4
  passwordButton: 'Set password', // 5
  passwordTooShort: 'Too short. Use at least 10 characters.', // 6
  passwordMismatch: 'The two passwords are different.', // 7
  passwordExists: 'A password is already set. Use it to unlock.', // 8
  passwordNotSignedIn: 'Sign in to your account first, then set a password.', // 9
  passwordSet: 'Password set.', // 10
  passwordSetPending: 'Password set. One step is still finishing in the background. It needs nothing from you.', // 11

  // Screen 2a: name this computer
  nameTitle: 'Set up this computer', // 29
  nameLabel: 'Name of this computer', // 30
  nameHint: 'For example: Office Mac. You will see it in your list of devices.', // 30
  nameButton: 'Continue', // 31
  nameInvalid: 'This name does not work. Use another name.', // 32
  setupPasswordFirst: 'Set an unlock password first.', // 33
  setupAlreadyDone: 'This computer is already set up.', // 34
  setupUnfinished: 'An earlier set-up was not finished. Cancel it, then start again.', // 35
  setupBusy: 'Another set-up step is still running. Wait a moment.', // 36
  setupGone: 'This set-up is no longer open. Start again.', // 37
  setupNotFinished: 'Not finished yet. Wait a moment and try again.', // 38

  // Screen 2b-2f: Connect
  connectTitle: 'Connect this computer to your Suveren account', // 52
  connectWhy: 'This gateway is not yet connected to your account. This step connects it. You do it once on every computer.', // 106
  connectHow: 'The button opens suveren.ai in your browser. Enter your email there and open the link we send you. Then come back to this page.', // 53
  connectButton: 'Connect', // 54
  connectBadStart: 'Connect does not work with the way this gateway was started. Ask whoever set it up.', // 56
  connectWaiting: 'Finish in the browser window that just opened. This page goes on by itself.', // 57
  connectCancel: 'Cancel', // 58
  connectTimeout: 'Nothing came back from the browser in time. Press Connect to try again.', // 59
  connectOtherWindow: 'Connect was started in another window. Finish it there, or start again here.', // 60
  connectTabDone: 'Done. You can close this tab and go back to the gateway.', // 61
  connectTabGone: 'This link no longer works. Start again from the gateway page.', // 62
  connectedTitle: 'Connected', // 63
  connectedAs: (name: string, email: string): string => `Connected as ${name} (${email}). You are signed in.`, // 64
  startConnectedAs: (name: string, email: string): string => `Connected to the account of ${name} (${email}).`, // DRAFT (DEC-93)
  connectedSigninFailed: 'Connected, but signing in did not work. Try again.', // 65
  connectRefused: 'The connection was refused. Nothing changed. Try again.', // 66
  connectNotAccepted: 'suveren.ai did not accept this set-up. Nothing changed. Try again.', // 67
  connectCodeBad: 'The code does not work. Connect again to get a new one.', // 68
  connectWrongList: 'suveren.ai answered with a list of devices that is not this computer\'s. Nothing was saved. Try again; if it repeats, tell support.', // 69
  connectedContinue: 'Continue', // (button of the Connected screen, as item 31 / 48)

  // Screen 3: recovery code
  codeTitle: 'Your recovery code', // 39
  codeWhy: 'This code gets you back in if you lose this computer or forget your password. Suveren cannot make it again.', // 40
  codeOnce: 'It is shown only once.', // 41
  codePaper: 'Write it on paper or print it. Do not take a screenshot or save it in a file on this computer.', // 42
  codeNever: 'Never give this code to your AI or anyone else. Enter it only on your gateway page.', // 43
  codePrint: 'Print the code', // 44
  codeCancel: 'Cancel set-up. This code stops working.', // 45
  codeKeptTitle: 'Did you keep it?', // 46
  codeKeptBox: 'I wrote the code down and keep it where my AI cannot read it.', // 47
  codeKeptButton: 'Continue', // 48
  conditionTitle: 'Keep your AI away from this page', // 49
  conditionBody: 'Use this page yourself. Your AI must not see or control your screen or your browser, and must not run as the same user as the gateway. If it can, it can read your logins as you type them, and Suveren cannot stop that.', // 50
  conditionButton: 'I understand', // 51

  // Screen 4: unlock
  unlockTitle: 'Unlock the gateway', // 12
  unlockWhy: 'The computer restarted, so the gateway is locked. Your AI cannot work until you open it. Type your password.', // 13
  unlockButton: 'Unlock', // 14
  unlockSigningIn: 'Signing in to your account...', // 16
  unlockTouchButton: 'Unlock with Touch ID', // 18
  unlockOr: 'or', // 19
  unlockTouchPrompt: 'unlock your gateway', // 20 (the helper's Touch ID window: "Suveren is trying to unlock your gateway")
  unlockDone: 'Unlocked.', // 26
  // The line of item 15 is not shown: see DRAFT.unlockForgot.

  // Screen 5: confirm a login change
  confirmTitle: 'Confirm this change', // 70
  confirmScope: 'This confirms this one change only.', // 72
  confirmWithTouch: 'Confirm with Touch ID', // 76
  confirmReadTouch: 'Read what the Touch ID window says. It names this change.', // 77
  confirmUseTouch: 'On this computer, use Touch ID to confirm.', // 80
  confirmCancelled: 'Cancelled. Nothing changed.', // 81
  confirmTouchFailed: 'Touch ID did not work this time. Nothing changed. Try again.', // 82
  confirmTouchBroken: 'Touch ID no longer works for this computer. You can reset it with your password and your recovery code.', // 83
  confirmExpired: 'This confirmation has run out. Make the change again.', // 74
  // The phone path (plan 7, stage D3): on a computer without Touch ID the phone is asked first. All DRAFT.
  confirmOnPhone: 'Confirm this change on your phone.', // DRAFT new
  confirmOpenPhone: 'Open Suveren on your phone. The change waits there.', // DRAFT new (plan 20.13: until notifications ship)
  confirmPhoneWaiting: 'Waiting for your phone…', // DRAFT new
  confirmUsePassword: 'Use the password instead', // DRAFT new
  confirmPhoneDenied: 'Not allowed on your phone. Nothing changed.', // DRAFT new (mockup E3)
  confirmPhoneUnreachable: 'Your phone could not be reached. Confirm with your password instead.', // DRAFT new (independent review L3)
  confirmPhoneInvalid: 'The answer from your phone could not be checked. Nothing changed. Try again; if it repeats, tell support.', // DRAFT new

  // Screen 6: errors
  wrongPassword: 'Wrong password.', // 86
  locked: 'The gateway is locked. Unlock it with your password.', // 88
  sessionIdle: 'You were away for an hour, so this page closed. Unlock it again to go on.', // 89
  sessionLong: 'This page has been open for 12 hours, so it closed. Unlock it again to go on.', // 90
  sessionClosed: 'This page was closed, for example after a restart, sleep or a locked screen. Unlock it again to go on.', // 91
  asUnreachable: 'Cannot reach suveren.ai. Check your internet connection and try again.', // 92
  asWrongServer: 'The server that answered is not the suveren.ai this gateway was set up with. Nothing was sent. Do not go on, and tell whoever runs your gateway.', // 93
  asProblem: 'suveren.ai had a problem. Nothing changed. Try again later.', // 94
  chainMismatch: 'Your list of devices of this account does not match what this computer remembers. The gateway is locked until this is checked. Contact support.', // 95 (+ confusion note 6)
  deviceRemoved: 'This computer was removed from your account on another device. The gateway is locked.', // 96
  deviceCannotSignIn: 'This computer cannot sign in to your account. Use your recovery code to set it up again.', // 97
  deviceNotSetUp: 'This computer is not set up yet. Set it up first.', // 97 (split, confusion note 8)
  signinRefused: 'suveren.ai did not let this computer in. Try again; if it repeats, tell support.', // 98 (B)
  identityReset: (hours: number): string => `Someone asked to start your account again from scratch. Your mandates would have to be granted again. It takes effect in ${hours} ${hours === 1 ? 'hour' : 'hours'}. If this was not you, cancel it now.`, // 99
  identityResetDue: 'Someone asked to start your account again from scratch. Your mandates would have to be granted again. It takes effect any moment. If this was not you, cancel it now.', // 99 (no hours left)
  identityResetCancel: 'Cancel this request', // 100
  identityResetCancelled: 'Cancelled. Your account stays as it was.', // 100 (screen after cancelling)
  notLocal: 'This gateway can be reached from other computers, so passwords are off. Ask whoever runs it.', // 101 (B)
  originRefused: 'Request refused. Open the gateway page in your own browser and try again.', // 102
  generic: 'This did not work. Nothing was changed. Try again.', // 103 (B)

  // Touch ID, unlock path
  touchCancelled: 'Cancelled. Use Touch ID again, or type your password.', // 21
  touchNotRecognised: 'Touch ID did not recognise you. Try again, or type your password.', // 22
  touchLocked: 'Touch ID is locked. Use your Mac password, or the unlock password here.', // 23
  touchCannot: 'Touch ID cannot open the gateway right now. Type your password.', // 24 (B)
  touchNoAsk: 'Touch ID could not ask for your touch. Bring this window to the front and try again.', // 25

  // The Touch ID window's own sentences (sent by the helper; kept here so the screens and the helper agree)
  touchWindowReplace: (name: string): string => `replace the login of "${name}"`, // 78
  touchWindowRemove: (name: string): string => `remove the login of "${name}"`, // 79
} as const;

/** The card of screen 5 (item 71) and the done line (item 75). */
export function changeSentence(kind: 'replace' | 'remove', name: string): string {
  return kind === 'replace'
    ? `Replace the login of "${name}".`
    : `Remove the login of "${name}". Your AI can no longer use ${name}.`; // 71
}
export function changeButton(kind: 'replace' | 'remove'): string {
  return kind === 'replace' ? 'Replace login' : 'Remove login'; // 73
}
export function changeDone(kind: 'replace' | 'remove', name: string): string {
  return `Done. The login of "${name}" was ${kind === 'replace' ? 'replaced' : 'removed'}.`; // 75
}

/**
 * Texts the recommendation does not have: written in its style (what happened, then what to do, "Nothing
 * changed" only where it is true). Every one is listed in the hand-over report for the maintainer to confirm.
 */
export const DRAFT = {
  loading: 'Loading…', // DRAFT
  // DEC-92: Touch ID opens the gateway page; turned on at set-up where this computer has Touch ID, or later in Settings.
  touchSetupWaiting: 'Touch the sensor when your Mac asks. This touch lets you open the gateway with Touch ID.', // DRAFT (touch 1 of 2 at set-up)
  touchCheckKeyWaiting: 'Touch the sensor once more when your Mac asks. This touch makes this computer\'s key for giving mandates and approving changes.', // DRAFT (touch 2 of 2 at set-up)
  // DEC-93: the first screen of a gateway nobody has used yet (no account key)
  startTitle: 'Connect to your Suveren account', // DRAFT
  startWhy: 'This gateway is new. Connect it to your Suveren account first; then you set an unlock password.', // DRAFT

  touchSetupSkipped: 'Touch ID was not turned on. You can turn it on later under Settings.', // DRAFT
  touchCardTitle: 'Unlock with Touch ID', // DRAFT
  touchCardBody: 'Open this gateway with your fingerprint instead of typing the unlock password. The password still works.', // DRAFT
  touchCardOn: 'Touch ID is on for this gateway.', // DRAFT
  touchCardButton: 'Turn on Touch ID', // DRAFT
  touchCardDone: 'Touch ID is on. Next time, unlock with your fingerprint.', // DRAFT
  // Item 15 says "Your recovery code gets you back in" after a forgotten password. #217 has no route that
  // does that (recovery needs an unlocked gateway), so the line is not shown on the unlock screen.
  unlockForgot: 'Forgot your password? Your recovery code gets you back in. You will have to type your connector logins again.', // 15, NOT SHOWN
  // Recovery with the recovery code (a new computer, or one set up again)
  recoverLink: 'Use your recovery code', // DRAFT
  recoverTitle: 'Use your recovery code', // DRAFT
  recoverWhy: 'Use this on a computer that is not set up yet. It connects this computer to your existing account and removes the devices you had before.', // DRAFT
  recoverCodeLabel: 'Recovery code', // DRAFT
  recoverButton: 'Continue', // DRAFT
  recoverBack: 'Back', // DRAFT
  recoverRemoves: 'This removes these devices from your account:', // DRAFT
  recoverCompare: 'Check that suveren.ai shows this code:', // DRAFT
  recoverMail: 'The button opens suveren.ai in your browser. Open the link we send you in this same browser, then come back to this page.', // DRAFT
  recoverWaiting: 'Finish in the browser window that just opened. This page goes on by itself.', // = 57
  recoverFinishing: 'Finishing...', // DRAFT
  recoverDone: 'Done. This computer is set up and signed in.', // DRAFT
  recoverDoneNoSignin: 'Done. This computer is set up, but signing in did not work. Unlock the gateway again.', // DRAFT
  recoverPendingClosed: 'Your request for a new identity is closed by this recovery.', // DRAFT
  // Replace the recovery code
  rotateTitle: 'Replace your recovery code', // DRAFT
  rotateWhy: 'Do this if the old code was seen by someone else or got lost. The old code stops working.', // DRAFT
  rotateStart: 'Make a new code', // DRAFT
  rotateNewTitle: 'Your new recovery code', // DRAFT
  rotateOldLabel: 'Old recovery code', // DRAFT
  rotateNewLabel: 'New recovery code, typed again', // DRAFT
  rotateSubmit: 'Replace code', // DRAFT
  rotateDone: 'Done. Your new recovery code works. The old one does not.', // DRAFT
  oauthContinue: 'Continue to sign in', // DRAFT
  // Pending identity reset (item 99/100), cancelling
  cancelling: 'Cancelling...', // DRAFT
  // Settings entry
  deviceCardTitle: 'Recovery code', // DRAFT
  deviceCardBody: 'This code gets you back in if you lose this computer.', // DRAFT
  // Waiting-state messages (neutral)
  working: 'One moment...', // DRAFT
  tryAgain: 'Try again', // DRAFT
  // Signing in with the device key after an unlock
  signinFailedRetry: 'Signing in did not work. Try again.', // DRAFT
} as const;

/** Wording for codes the recommendation has no text for. DRAFT, same style. */
const DRAFT_CODES: Record<string, string> = {
  recovery_code_invalid: 'This is not a recovery code. Check it and try again.',
  recovery_code_unknown: 'No account belongs to this recovery code. Check it and try again.',
  recovery_code_wrong: 'This is not the current recovery code of this account. Use the newest one.',
  recovery_pending: 'A recovery was started and not finished. Cancel it, then start again.',
  recovery_unknown: 'This recovery is no longer open. Start again.',
  recovery_not_done: 'suveren.ai does not have the new entry yet. Finish in the browser, then try again.',
  recovery_refused: 'suveren.ai refused this. Nothing changed. Try again; if it repeats, tell support.',
  device_key_in_chain: 'This computer was part of that account before. Nothing changed. Use another computer or tell support.',
  entry_invalid: 'suveren.ai sent an entry that is not valid. Nothing was saved. Try again; if it repeats, tell support.',
  chain_moved: 'Your list of devices changed meanwhile. Nothing was saved. Start again.',
  handoff_not_started: 'The browser step was not started. Start again.',
  handoff_refused: 'The browser step was refused. Nothing changed. Start again.',
  handoff_failed: 'The browser step failed. Nothing changed. Start again.',
  handoff_timeout: 'Nothing came back from the browser in time. Start again.',
  root_key_taken: 'This recovery code is already in use. Make another.',
  mail_failed: 'The email with the link could not be sent. Try again.',
  rotate_unknown: 'This new code is no longer open. Make another.',
  rotate_expired: 'The new code was not used in time. Make another.',
  new_code_mismatch: 'The new code you typed is not the one shown. Check it and try again.',
  granting_device_required: 'This computer needs Touch ID to replace the recovery code.',
  check_unavailable: 'Touch ID is not available on this computer. Nothing changed.',
  not_signed_in: 'This computer is not signed in to your account. Unlock the gateway again.',
  reset_unknown: 'This request no longer exists. Nothing changed.',
  cancel_refused: 'suveren.ai refused the cancel. Try again; if it repeats, tell support.',
  // Decisions on the gateway page (signed with this computer's device key)
  proposal_unknown: 'This request no longer exists. Nothing changed.',
  proposal_not_pending: 'This request is no longer waiting for a decision. Nothing changed.',
  content_mismatch: 'What this page shows is not what was sent. Nothing changed. Reload the page.',
  content_not_shown: 'Open the details first, then decide. Nothing changed.',
  content_unreadable: 'This computer cannot show the details, so it cannot approve. Nothing changed.',
  facts_unavailable: 'The gateway could not tell which mandate this decision is for. Nothing changed. Try again.',
  gateway_unreachable: 'The gateway does not answer. Check that it is running, then try again.',
  // Resetting this computer's Touch ID key (no screen yet; #217's route needs the password and the recovery code)
  wrong_recovery_code: 'This is not the recovery code of this account. Check it and try again.',
  no_check_key: 'This computer has no Touch ID key. Nothing changed.',
  key_not_reported_invalid: 'Touch ID still works here, so nothing was cleared.',
  // Touch ID turning on and off (no Settings screen yet)
  already_enabled: 'Touch ID unlock is already on.',
  not_enabled: 'Touch ID unlock is not on.',
  busy: 'Another Touch ID step is running. Wait a moment.',
  vault_changed: 'The gateway changed meanwhile. Try again.',
};

/** The codes with a DRAFT text (so a test can list them, and the report can). */
export const DRAFT_CODE_LIST: readonly string[] = Object.keys(DRAFT_CODES);

export interface TextContext {
  /** Where the code was met. Some codes read differently there (a cancelled Touch ID on unlock vs on confirm). */
  screen?: 'password' | 'setup' | 'connect' | 'unlock' | 'confirm' | 'signin' | 'recover' | 'general';
  retryAfterSeconds?: number;
}

/** "10 minutes" for the wait the control plane named; at least one minute. */
export function minutesText(retryAfterSeconds: number | undefined): string {
  const minutes = Math.max(1, Math.ceil((retryAfterSeconds ?? 600) / 60));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * The words for a refusal code of the control plane (any of its routers). Total: a code nobody knows gets the
 * generic text 103, never the raw code and never the control plane's placeholder message.
 */
export function textForCode(code: string | undefined, ctx: TextContext = {}): string {
  const screen = ctx.screen ?? 'general';
  switch (code) {
    // The page session (DEC-47)
    case 'session_idle': return T.sessionIdle;
    case 'session_expired': return T.sessionLong;
    case 'session_missing':
    case 'session_invalid': return T.sessionClosed;
    case 'locked': return T.locked;
    case 'unauthorized': return T.sessionClosed;
    case 'origin_refused': return T.originRefused;
    case 'not_local': return T.notLocal;
    // Password
    case 'wrong_password': return T.wrongPassword;
    case 'too_many_attempts':
    case 'rate_limited': return `Too many tries. Try again in ${minutesText(ctx.retryAfterSeconds)}.`; // 87
    case 'password_invalid': return T.passwordTooShort;
    case 'password_exists': return T.passwordExists;
    case 'not_signed_in': return screen === 'password' ? T.passwordNotSignedIn : DRAFT_CODES.not_signed_in;
    case 'no_password':
    case 'password_required': return T.setupPasswordFirst;
    case 'rekey_pending':
    case 'rekey_incomplete': return T.setupNotFinished;
    case 'password_changed':
    case 'wipe_refused': return T.generic;
    // Set-up
    case 'already_set_up': return T.setupAlreadyDone;
    case 'setup_pending': return T.setupUnfinished;
    case 'setup_busy': return T.setupBusy;
    case 'setup_unknown': return T.setupGone;
    case 'label_invalid': return T.nameInvalid;
    case 'enrolment_code_missing':
    case 'enrolment_code_invalid': return T.connectCodeBad;
    case 'setup_refused': return T.connectNotAccepted;
    case 'head_mismatch': return T.connectWrongList;
    // Connect
    case 'connect_not_started': return T.setupGone;
    case 'connect_other_session': return T.connectOtherWindow;
    case 'connect_port_unsupported':
    case 'connect_loopback_unsupported': return T.connectBadStart;
    case 'connect_refused':
    case 'connect_failed': return T.connectRefused;
    case 'connect_timeout': return T.connectTimeout;
    case 'connect_callback_done': return T.connectTabDone;
    case 'connect_callback_unknown': return T.connectTabGone;
    // The Authority Server (shown as suveren.ai)
    case 'as_unreachable': return T.asUnreachable;
    case 'as_unverified':
    case 'as_key_mismatch':
    case 'as_tls_mismatch':
    case 'as_url_mismatch':
    case 'aud_mismatch': return T.asWrongServer;
    case 'as_error':
    case 'as_answer_invalid': return T.asProblem;
    // Sign-in with the device key
    case 'not_set_up': return T.deviceNotSetUp;
    case 'chain_unreadable':
    case 'key_mismatch':
    case 'chain_invalid':
    case 'chain_rollback':
    case 'chain_fork': return T.chainMismatch;
    case 'device_removed': return T.deviceRemoved;
    case 'key_missing': return T.deviceCannotSignIn;
    case 'signin_refused': return T.signinRefused;
    case 'establish_failed':
    case 'signin_failed':
    case 'use_device_signin':
    case 'vault_unreadable': return T.generic;
    // Touch ID (this computer's helper)
    case 'cancelled': return screen === 'confirm' ? T.confirmCancelled : T.touchCancelled;
    case 'not_recognised': return screen === 'confirm' ? T.confirmTouchFailed : T.touchNotRecognised;
    case 'biometry_locked': return T.touchLocked;
    case 'interaction_required': return screen === 'confirm' ? T.confirmTouchFailed : T.touchNoAsk;
    case 'key_invalid': return screen === 'confirm' ? T.confirmTouchBroken : T.touchCannot;
    case 'helper_failed':
    case 'wrap_mismatch':
    case 'check_invalid': return screen === 'confirm' ? T.confirmTouchFailed : T.touchCannot;
    case 'check_key_required': return T.confirmUseTouch;
    case 'request_unknown': return T.confirmExpired;
    case 'confirmation_required': return T.generic;
    // Recovery, decisions, Touch ID settings
    default:
      if (code && Object.prototype.hasOwnProperty.call(DRAFT_CODES, code)) return DRAFT_CODES[code];
      // No text: no button, no message (item "no_biometry, helper_unavailable", "already_unlocked")
      return T.generic;
  }
}

/**
 * Codes that mean "show nothing": the person's way on is simply another path
 * (no Touch ID on this computer, no helper, the vault is already open).
 */
export function isSilentCode(code: string | undefined): boolean {
  return code === 'no_biometry' || code === 'helper_unavailable' || code === 'already_unlocked';
}

/** Hours until a request for a new identity takes effect, from epoch seconds; never below 0. */
export function hoursLeft(effectiveAt: number, nowSeconds: number): number {
  return Math.max(0, Math.ceil((effectiveAt - nowSeconds) / 3600));
}

/** The alarm sentence (item 99) for a request taking effect at `effectiveAt`. */
export function identityResetText(effectiveAt: number, nowSeconds: number): string {
  const h = hoursLeft(effectiveAt, nowSeconds);
  return h <= 0 ? T.identityResetDue : T.identityReset(h);
}

/** The codes of `/device-decision` (control plane routes/device-decision.ts and lib/device-decision.ts). */
const DECISION_CODES: ReadonlySet<string> = new Set([
  'unauthorized', 'origin_refused', 'not_local', 'bad_request', 'locked', 'not_set_up', 'chain_unreadable', 'not_signed_in',
  'key_missing', 'key_mismatch', 'proposal_unknown', 'proposal_not_pending', 'content_mismatch', 'content_not_shown',
  'content_unreadable', 'facts_unavailable', 'as_unreachable', 'as_tls_mismatch', 'as_answer_invalid',
]);

export function isDecisionCode(code: string): boolean {
  return DECISION_CODES.has(code);
}
