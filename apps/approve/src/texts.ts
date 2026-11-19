/**
 * Every word the person reads in the phone app, in ONE module (the texts-module pattern of the shared package: approval-card
 * `S13` and `S8`; the gateway page's `device-texts.ts`).
 *
 * EVERY text here is `DRAFT`: no signed-off mockup has a sentence for the phone yet, and the wording is the maintainer's
 * (O19). Nothing here is final. Words follow DEC-75/78/79 (`temp/device-keys-mockup/terms.md`): mandate, device (on approval and
 * list screens), computer only for set-up and connecting (adding a computer is that), member, "your AI" and never "agent", suveren.ai
 * and never "Authority Server", an identity code and a recovery code always with their noun, "Nothing changed." where it is true.
 * Where a sentence is the SAME as a gateway-page sentence it says so; the two are to be one string once the device texts move
 * into the shared package (open question in the hand-over).
 *
 * Texts that already exist in the shared package are imported where they are used, never copied: `S8.notYetOpenable` and
 * `S8.contextMissing` (approval-card `proposal-readers`), `S13.giveBusy`.
 *
 * Pure: no React, no network.
 */

export const P = {
  // ─── The phone cannot pair (compat.ts) ───────────────────────────────────────
  needsTitle: 'This phone cannot be set up yet', // DRAFT
  needsIntro: 'To work, this app needs:', // DRAFT
  needsInstall: 'The app opened from its icon. In Safari, tap Share, then Add to Home Screen, then open Suveren from your home screen.', // DRAFT
  needsSystem: 'A newer system. An iPhone needs iOS 18.4 or later (iPhone XS or newer). An Android phone needs Android 10 or later and Chrome 137 or later.', // DRAFT (DEC-19)
  needsPasskey: 'A screen lock (Face ID, Touch ID, a fingerprint or a PIN) and a place that keeps passkeys: iCloud Keychain on an iPhone, a signed-in Google account on Android. Turn them on, then open this page again.', // DRAFT
  needsStorage: 'A browser that can keep data for the app. Open this page in another browser.', // DRAFT

  // ─── Start ────────────────────────────────────────────────────────────────────
  welcomeTitle: 'Your AI asks, you decide', // DRAFT
  welcomeBody: 'This phone becomes one of your devices. Here you can read what your AI wants to do.', // DRAFT
  welcomeReadOnly: 'For now you read requests here. You approve or reject them on your computer.', // DRAFT (D1 is read-only)
  welcomeNew: 'Set up my account on this phone', // DRAFT
  welcomeNewWhy: 'You come from suveren.ai and have a setup code.', // DRAFT
  welcomeJoin: 'Add this phone to my account', // DRAFT
  welcomeJoinWhy: 'Your account already exists on another device.', // DRAFT
  storagePersistent: 'This phone keeps the app\'s data.', // DRAFT
  secondIcon: 'Keep one Suveren icon on your home screen. A second icon is a separate app: it does not know this phone and must be set up again.', // DRAFT (step 1, check 16: a second icon on an iPhone is a separate app)
  storageNotPersistent: 'This phone may clear the app\'s data when it runs low on space. If that happens, add this phone to your account again.', // DRAFT

  // ─── Scanning ─────────────────────────────────────────────────────────────────
  scanStart: 'Scan the code', // DRAFT
  scanStop: 'Stop', // DRAFT
  scanFrame: 'Hold the phone so the code is inside the frame.', // DRAFT (the preview can stay black on an iPhone: this line and the frame carry the screen)
  scanBlackNote: 'The picture may stay black. The phone is still looking.', // DRAFT (step 1, check 7)
  scanProgress: (seconds: number): string => `Looking for the code... ${seconds} s`, // DRAFT
  scanCameraRefused: 'The camera is off for this app. Allow the camera in your phone settings, then try again.', // DRAFT
  scanCameraUnavailable: 'The camera cannot be used right now.', // DRAFT
  scanTimeout: 'No code was found. Try again.', // DRAFT

  // ─── Set up with a code from suveren.ai ───────────────────────────────────────
  setupTitle: 'Set up this phone', // DRAFT
  setupCodeWhy: 'On suveren.ai, open your account and choose to set up your phone. It shows a code. Scan it here.', // DRAFT
  setupTypeInstead: 'Type the code instead', // DRAFT
  setupCodeLabel: 'Code from suveren.ai', // DRAFT
  setupCodeButton: 'Continue', // DRAFT
  setupChecking: 'Checking suveren.ai...', // DRAFT
  nameTitle: 'Name this phone', // DRAFT
  nameLabel: 'Name of this phone', // DRAFT
  nameHint: 'For example: My iPhone. You will see it in your list of devices.', // DRAFT
  nameButton: 'Continue', // DRAFT

  // Recovery code: the same sentences as the gateway page's `T.code*` (device-texts.ts 39-45), "computer" changed to "phone".
  codeTitle: 'Your recovery code', // = T.codeTitle (39)
  codeWhy: 'This code gets you back in if you lose this phone. Suveren cannot make it again.', // DRAFT (T.codeWhy 40 says "this computer or forget your password")
  codeOnce: 'It is shown only once.', // = T.codeOnce (41)
  codePaper: 'Write it on paper or print it. Do not take a screenshot or save it in a file on this phone.', // DRAFT (T.codePaper 42 says "computer")
  codeNever: 'Never give this code to your AI or anyone else. You type it only in this app.', // DRAFT (T.codeNever 43 names the gateway page; DEC-16)
  codePrint: 'Print the code', // = T.codePrint (44)
  codeCancel: 'Cancel. This code stops working.', // DRAFT (T.codeCancel 45)
  codeContinue: 'Continue', // = T.codeKeptButton (48)
  keptTitle: 'Did you keep it?', // = T.codeKeptTitle (46)
  keptBox: 'I wrote the code down and keep it where my AI cannot read it.', // = T.codeKeptBox (47)
  keptButton: 'Continue', // = T.codeKeptButton (48)

  doKeys: 'Making the keys of this phone...', // DRAFT
  doPasskey: 'Your phone asks for your touch, to make the passkey of this app.', // DRAFT
  doSign: 'Preparing your account...', // DRAFT
  doCheck: 'Your phone asks for your touch once more, to confirm your account.', // DRAFT
  doSend: 'Sending to suveren.ai...', // DRAFT
  setupDoneTitle: 'This phone is ready', // DRAFT
  setupDoneBody: 'It is now one of your devices.', // DRAFT
  tryAgain: 'Try again', // = DRAFT.tryAgain of device-texts.ts
  startAgain: 'Start again', // DRAFT
  cancel: 'Cancel', // = T.connectCancel (58)
  continue: 'Continue', // DRAFT
  back: 'Back', // DRAFT

  // ─── Join: this phone is added to an account that exists ──────────────────────
  joinTitle: 'Add this phone to your account', // DRAFT
  joinIntro: 'This phone becomes one of your devices. Here you read what your AI wants to do. You approve or reject on your computer for now.', // DRAFT (DEC-83: the start screen is this one)
  joinScanWhy: 'On a device that already has your account, choose to add a device. It shows a code. Scan it here.', // DRAFT
  reviewTitle: 'You are about to join this account', // DRAFT
  reviewIdentity: 'Identity code', // = S13.joinYourCode (312)
  reviewIdentityNote: 'Check that this is the identity code of your account.', // DRAFT
  reviewMade: (label: string, when: string): string => `Made on ${label}, ${when}.`, // DRAFT
  reviewDevices: 'Devices in this account:', // DRAFT
  reviewNotMine: 'This is not my account', // DRAFT
  reviewButton: 'Add this phone to it', // DRAFT
  compareTitle: 'Check the code', // DRAFT
  compareBody: (label: string): string => `Check that ${label} shows the same six digits. Then confirm on ${label}.`, // DRAFT
  compareWaiting: (label: string): string => `Waiting for ${label}...`, // DRAFT
  joinDoneTitle: 'This phone was added', // DRAFT

  // ─── Admit: this phone adds a computer ────────────────────────────────────────
  admitTitle: 'Add a computer', // DRAFT
  admitScanWhy: 'On the new computer, open the gateway page and choose Add this computer. It shows a code. Scan it here.', // DRAFT
  admitOpening: 'Waiting for the computer...', // DRAFT
  admitChooseTitle: (label: string): string => `Add "${label}"?`, // DRAFT (20.11)
  admitChooseBody: 'Tap the code your computer shows. A wrong code ends this, and nothing is added.', // DRAFT (20.11)
  admitListTitle: 'Your devices after this:', // DRAFT
  admitNew: 'new', // DRAFT
  admitChecking: 'Your phone asks for your touch, to add the computer.', // DRAFT
  admitDoneTitle: (label: string): string => `"${label}" was added`, // DRAFT
  admitDoneList: 'Your devices now:', // DRAFT
  admitAfter: 'Enter no login for a connected system on the new computer until it is in this list.', // DRAFT (4.3 "The admitter's device list is the truth")

  // ─── Device list ──────────────────────────────────────────────────────────────
  devicesTitle: 'Your devices', // DRAFT
  devThisPhone: 'This phone', // DRAFT
  devKindComputer: 'Computer', // DRAFT
  devKindPhone: 'Phone', // DRAFT
  devCanConfirm: 'confirms changes with a touch', // DRAFT
  devRecent: 'added in the last 14 days', // DRAFT
  devAdded: (when: string): string => `added ${when}`, // DRAFT
  devIdentity: 'Your identity code', // DRAFT
  devAddComputer: 'Add a computer', // DRAFT
  devRefresh: 'Check the list again', // DRAFT
  appVersion: (version: string, build: string): string => `App ${version} (${build})`, // DRAFT (plan 8: the app shows its version and build commit)
  appUpdated: 'The app was updated.', // DRAFT (plan 8)

  // ─── The session ──────────────────────────────────────────────────────────────
  openTitle: 'Open the app', // DRAFT
  openBody: 'Touch to open the app. It closes itself after a break so nobody else can read your requests.', // DRAFT (DEC-47)
  openButton: 'Open with a touch', // DRAFT
  openBusy: 'Waiting for your touch...', // = S13.giveBusy
  openEnded: 'The app closed itself after a break. Touch to open it again.', // DRAFT
  forgetButton: 'Clear the data of this phone', // DRAFT
  forgetNote: 'This only clears the app on this phone. Your account and your other devices stay as they are.', // DRAFT

  // ─── Requests (read-only) ─────────────────────────────────────────────────────
  listTitle: 'Waiting for you', // DRAFT
  listEmpty: 'Nothing is waiting for you.', // DRAFT
  listRefresh: 'Refresh', // DRAFT
  listLoading: 'Loading...', // DRAFT
  listOpen: 'Open', // DRAFT
  listBack: 'Back to the list', // DRAFT
  readOnlyNote: 'You can read this here. Approve or reject it on your computer for now.', // DRAFT (D1)
  listFailed: 'The list could not be read. Nothing changed. Try again.', // DRAFT

  // ─── Time ─────────────────────────────────────────────────────────────────────
  whenToday: 'today', // DRAFT
  whenYesterday: 'yesterday', // DRAFT
  whenDaysAgo: (n: number): string => `${n} days ago`, // DRAFT

  // ─── Navigation ───────────────────────────────────────────────────────────────
  navRequests: 'Requests', // DRAFT
  navDevices: 'Devices', // DRAFT
} as const;

/** The sentence for a code. Total: a code nobody knows gets the generic text, never the code itself and never the server's message. */
const ERRORS: Record<string, string> = {
  generic: 'This did not work. Nothing was changed. Try again.', // DRAFT (= T.generic 103)
  // The phone's passkey
  cancelled: 'Cancelled. Nothing changed.', // = T.confirmCancelled (81)
  check_failed: 'Your touch did not work this time. Nothing changed. Try again.', // DRAFT (T.confirmTouchFailed 82 names Touch ID)
  no_user_verification: 'This phone did not ask for your touch. Turn on a screen lock for this phone, then try again.', // DRAFT
  unsupported: 'This phone cannot make the passkey this app needs.', // DRAFT
  // suveren.ai
  as_unreachable: 'Cannot reach suveren.ai. Check your internet connection and try again.', // = T.asUnreachable (92)
  as_unverified: 'The server that answered is not the suveren.ai this app expects. Nothing was sent. Do not go on, and tell whoever runs your account.', // DRAFT (T.asWrongServer 93)
  as_key_mismatch: 'The server that answered is not the suveren.ai this app expects. Nothing was sent. Do not go on, and tell whoever runs your account.', // DRAFT (T.asWrongServer 93)
  aud_mismatch: 'The server that answered is not the suveren.ai this app expects. Nothing was sent. Do not go on, and tell whoever runs your account.', // DRAFT (T.asWrongServer 93)
  as_answer_invalid: 'suveren.ai had a problem. Nothing changed. Try again later.', // = T.asProblem (94)
  as_error: 'suveren.ai had a problem. Nothing changed. Try again later.', // = T.asProblem (94)
  rate_limited: 'Too many tries. Wait a few minutes, then try again.', // DRAFT (T 87)
  signin_refused: 'suveren.ai did not let this phone in. Try again; if it repeats, tell support.', // = T.signinRefused (98)
  session_ended: 'The app closed itself. Open it again with your touch.', // DRAFT
  // The chain
  chain_invalid: 'Your list of devices could not be checked. Nothing was saved. Contact support.', // DRAFT (T.chainMismatch 95)
  chain_rollback: 'Your list of devices does not match what this phone remembers. Contact support.', // DRAFT (T.chainMismatch 95)
  chain_fork: 'Your list of devices does not match what this phone remembers. Contact support.', // DRAFT (T.chainMismatch 95)
  head_mismatch: 'suveren.ai answered with a list of devices that does not fit. Nothing was saved. Try again; if it repeats, tell support.', // DRAFT (T.connectWrongList 69)
  device_removed: 'This phone was removed from your account on another device.', // DRAFT (T.deviceRemoved 96)
  not_paired: 'This phone is not set up yet.', // DRAFT
  keys_missing: 'This phone no longer has its keys. Add this phone to your account again.', // DRAFT
  already_paired: 'This phone is already set up. Remove it from your account first to set it up again.', // DRAFT (plan 4.3 rules)
  store_failed: 'suveren.ai has your account, but this phone could not keep it. Use your recovery code to add this phone again.', // DRAFT
  // Names
  label_invalid: 'This name does not work. Use another name.', // = T.nameInvalid (32)
  label_taken: 'Another device in your account has this name. Use another name.', // DRAFT (DEC-47)
  // Enrolment code and genesis (suveren-as codes, lower-cased)
  enrolment_code_invalid: 'The code does not work. Go back to suveren.ai and get a new one.', // = T.connectCodeBad (68)
  enrolment_code_used: 'This code was already used. Go back to suveren.ai and get a new one.', // DRAFT
  enrolment_code_expired: 'This code has run out. Go back to suveren.ai and get a new one.', // DRAFT
  enrolment_key_mismatch: 'This code belongs to another device. Go back to suveren.ai and get a new one.', // DRAFT
  chain_exists: 'This account already has devices. Add this phone from one of them instead.', // DRAFT
  root_key_taken: 'This recovery code is already in use. Start again.', // = DRAFT_CODES.root_key_taken
  passkey_required: 'suveren.ai did not accept the passkey of this phone. Nothing changed. Try again; if it repeats, tell support.', // DRAFT
  account_suspended: 'This account is suspended. Contact support.', // DRAFT
  // QR codes and pairing
  qr_invalid: 'This is not a code from Suveren. Nothing changed.', // DRAFT
  qr_expired: 'This code has run out. Show a new one and scan it again.', // DRAFT (10 minutes, plan 4.3)
  qr_wrong_kind: 'This code is for another step. Nothing changed.', // DRAFT
  qr_other_server: 'This code is for another suveren.ai than this app uses. Nothing changed.', // DRAFT
  qr_not_open: 'This code is not open any more. Show a new one and scan it again.', // DRAFT
  admitter_cannot_grant: 'The device that shows this code cannot add devices. Use another device.', // DRAFT
  bad_message: 'Something is wrong with this pairing. Nothing was added. Start again.', // DRAFT (a MAC that does not verify)
  commit_mismatch: 'Something is wrong with this pairing. Nothing was added. Start again.', // DRAFT
  open_invalid: 'Something is wrong with this pairing. Nothing was added. Start again.', // DRAFT
  mailbox_refused: 'suveren.ai did not take this pairing. Nothing changed. Try again.', // DRAFT
  mailbox_missing: 'This code is not open any more. Show a new one and scan it again.', // DRAFT
  wrong_code: 'That was not the code. Nothing was added.', // DRAFT (20.11: "A wrong choice ends the pairing")
  code_mismatch: 'The codes did not match. Nothing was added.', // DRAFT
  too_many_devices: 'Your account already has the most devices it can have. Remove one first.', // DRAFT
  cannot_grant: 'This phone cannot add devices.', // DRAFT
  chain_moved: 'Your list of devices changed meanwhile. Nothing was added. Start again.', // = DRAFT_CODES.chain_moved
  chain_head_moved: 'Your list of devices changed meanwhile. Nothing was added. Start again.', // = DRAFT_CODES.chain_moved
  check_cancelled: 'Cancelled. Nothing was added.', // DRAFT
};

export function errorText(code: string | undefined): string {
  const key = (code ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(ERRORS, key) ? ERRORS[key] : ERRORS.generic;
}

/** Every code with a text of its own (so a test can list them, and the hand-over can). */
export const ERROR_CODES: readonly string[] = Object.keys(ERRORS);

/** The scan failures, as sentences. */
export function scanFailureText(code: 'camera_refused' | 'camera_unavailable' | 'timeout'): string {
  return code === 'camera_refused' ? P.scanCameraRefused : code === 'timeout' ? P.scanTimeout : P.scanCameraUnavailable;
}
