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

import { SP, SHARED_ERRORS } from '@suveren/approval-card/lib/pairing-texts';

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
  welcomeBody: 'This phone becomes one of your devices. Here you read what your AI wants to do, and you decide.', // DRAFT
  welcomeReadOnly: 'Here you approve or reject what your AI asks for.', // DRAFT (D2: decisions on the phone)
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
  doSend: SP.sending, // shared (approval-card pairing-texts)
  setupDoneTitle: 'This phone is ready', // DRAFT
  setupDoneBody: SP.joinedBody, // shared (approval-card pairing-texts)
  tryAgain: SP.tryAgain, // shared (approval-card pairing-texts)
  startAgain: SP.startAgain, // shared (approval-card pairing-texts)
  cancel: SP.cancel, // shared (approval-card pairing-texts)
  continue: SP.continue, // shared (approval-card pairing-texts)
  back: SP.back, // shared (approval-card pairing-texts)

  // ─── Join: this phone is added to an account that exists ──────────────────────
  joinTitle: 'Add this phone to your account', // DRAFT
  joinIntro: 'This phone becomes one of your devices. Here you read what your AI wants to do, and you approve or reject it.', // DRAFT (DEC-83: the start screen is this one)
  joinScanWhy: 'On a device that already has your account, choose to add a device. It shows a code. Scan it here.', // DRAFT
  reviewTitle: SP.reviewTitle, // shared (approval-card pairing-texts)
  reviewIdentity: SP.reviewIdentity, // shared (approval-card pairing-texts)
  reviewIdentityNote: SP.reviewIdentityNote, // shared (approval-card pairing-texts)
  reviewMade: (label: string, when: string): string => `Made on ${label}, ${when}.`, // DRAFT
  reviewDevices: SP.reviewDevices, // shared (approval-card pairing-texts)
  reviewNotMine: SP.reviewNotMine, // shared (approval-card pairing-texts)
  reviewButton: 'Add this phone to it', // DRAFT
  compareTitle: SP.compareTitle, // shared (approval-card pairing-texts)
  compareBody: (label: string): string => `Check that ${label} shows the same six digits. Then confirm on ${label}.`, // DRAFT
  compareWaiting: SP.compareWaiting, // shared (approval-card pairing-texts)
  joinDoneTitle: 'This phone was added', // DRAFT

  // ─── Admit: this phone adds a computer ────────────────────────────────────────
  admitTitle: 'Add a computer', // DRAFT
  admitScanWhy: 'On the new computer, open the gateway page and choose Add this computer. It shows a code. Scan it here.', // DRAFT
  admitOpening: 'Waiting for the computer...', // DRAFT
  admitChooseTitle: SP.admitChooseTitle, // shared (approval-card pairing-texts)
  admitChooseBody: 'Tap the code your computer shows. A wrong code ends this, and nothing is added.', // DRAFT (20.11)
  admitListTitle: SP.admitListTitle, // shared (approval-card pairing-texts)
  admitNew: SP.admitNew, // shared (approval-card pairing-texts)
  admitChecking: 'Your phone asks for your touch, to add the computer.', // DRAFT
  admitDoneTitle: SP.admitDoneTitle, // shared (approval-card pairing-texts)
  admitDoneList: SP.admitDoneList, // shared (approval-card pairing-texts)
  admitAfter: 'Enter no login for a connected system on the new computer until it is in this list.', // DRAFT (4.3 "The admitter's device list is the truth")

  // ─── Device list ──────────────────────────────────────────────────────────────
  devicesTitle: SP.devicesTitle, // shared (approval-card pairing-texts)
  devThisPhone: 'This phone', // DRAFT
  devKindComputer: SP.devKindComputer, // shared (approval-card pairing-texts)
  devKindPhone: SP.devKindPhone, // shared (approval-card pairing-texts)
  devCanConfirm: SP.devCanConfirm, // shared (approval-card pairing-texts)
  devRecent: SP.devRecent, // shared (approval-card pairing-texts)
  devAdded: SP.devAdded, // shared (approval-card pairing-texts)
  devIdentity: SP.devIdentity, // shared (approval-card pairing-texts)
  devAddComputer: 'Add a computer', // DRAFT
  devRefresh: SP.devRefresh, // shared (approval-card pairing-texts)
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
  cardChecking: 'Checking this request...', // DRAFT
  cardBlockedTitle: 'You cannot decide this request here', // DRAFT
  cardBlockedNothing: 'Nothing was decided.', // DRAFT
  decideAskTouch: 'Your break ended the session. Touch to go on with your decision.', // DRAFT (the check comes before the decision, DEC-47)
  decideChangesElsewhere: 'To ask your AI for changes, use your computer.', // DRAFT (the note cannot be sealed for your AI from this phone yet)
  listFailed: 'The list could not be read. Nothing changed. Try again.', // DRAFT

  // ─── Time ─────────────────────────────────────────────────────────────────────
  whenToday: SP.whenToday, // shared (approval-card pairing-texts)
  whenYesterday: SP.whenYesterday, // shared (approval-card pairing-texts)
  whenDaysAgo: SP.whenDaysAgo, // shared (approval-card pairing-texts)

  // ─── Notifications (stage D4, plan 8) ────────────────────────────────────────
  // The notification itself: fixed and generic, no name, no amount, no action (F14). public/sw.js carries a copy of
  // these three (a service worker cannot import this module); texts.test.ts fails when they drift.
  pushTitle: 'Suveren', // DRAFT
  pushOne: 'A request is waiting for you.', // DRAFT
  pushMany: (n: number) => `${n} requests are waiting for you.`, // DRAFT
  pushDevicesChanged: 'Your devices changed. Open Suveren to see what changed.', // DRAFT
  pushRecoveryStarted: 'Someone started a change with your recovery code. If this was not you, open Suveren now.', // DRAFT
  pushIdentityReset: 'Someone asked for a new identity for your account. If this was not you, open Suveren now.', // DRAFT
  pushOfferTitle: 'Get a notice when something waits for you', // DRAFT
  pushOfferBody: 'The notice says only that a request is waiting. What it is about you see here, after you open the app.', // DRAFT
  pushTurnOn: 'Turn on notifications', // DRAFT
  pushNotNow: 'Not now', // DRAFT
  pushTurnOff: 'Turn off notifications', // DRAFT
  pushStateOn: 'Notifications on this phone are on.', // DRAFT
  pushStateOff: 'Notifications on this phone are off.', // DRAFT
  pushStateDenied: 'This phone blocks notifications for Suveren. Allow them in the phone\'s settings, then come back here.', // DRAFT
  pushStateUnsupported: 'This phone cannot show notifications from this app. Open the app now and then to see what waits.', // DRAFT
  pushMissed: (n: number) => (n === 1 ? '1 waiting request came without a notice.' : `${n} waiting requests came without a notice.`), // DRAFT (plan 8: the app counts them)
  // ─── Remove a device (stage D3, mockup C1–C5) ─────────────────────────────────
  devRemove: 'Remove', // DRAFT new
  removeTitle: (label: string): string => `Remove "${label}"?`, // DRAFT new
  removeSelfTitle: 'Remove this phone?', // DRAFT new
  removeComputerEffect: (label: string): string => `${label} can no longer sign in, read new requests or decide. Its gateway locks.`, // DRAFT new
  removePhoneEffect: (label: string): string => `${label} can no longer sign in, read new requests or decide.`, // DRAFT new
  removeLogins: (label: string): string => `The logins of your connected systems stay on ${label} until someone clears it. If it was lost or stolen, change those passwords too.`, // DRAFT new
  removeSelfEffect: 'This phone can no longer sign in, read requests or decide. The app then clears its data on this phone.', // DRAFT new
  removeListAfter: SP.admitListTitle, // shared (approval-card pairing-texts): "Your devices after this:"
  removeButton: 'Remove with your touch', // DRAFT new (DEC-85: "... with your touch")
  /** UI review (DEC-88): the destructive button names what it removes. Replaces removeButton on the screen. */
  removeButtonNamed: (label: string, self: boolean): string => (self ? 'Remove this phone with your touch' : `Remove ${label} with your touch`), // DRAFT new
  touchWait: 'Waiting for your touch…', // DRAFT (Andreas 2026-11-20: the only line while the system's touch window comes)
  // A computer's change to a connector login, confirmed here (stage D3, mockup E1–E3; plan 7 phone path)
  changeRowType: 'Change', // DRAFT new (mockup E1)
  changeRemoveTitle: (name: string) => `Remove the login of "${name}"`, // DRAFT new (mockup E1; gateway changeSentence)
  changeReplaceTitle: (name: string) => `Replace the login of "${name}"`, // DRAFT new (gateway changeSentence)
  changeConfirmTitle: 'Confirm this change', // = T.confirmTitle (70)
  changeAskedBy: (computer: string) => `Asked by ${computer}.`, // DRAFT new (mockup E2)
  changeRemoveEffect: (name: string) => `Your AI can no longer use ${name}.`, // DRAFT new (mockup E2)
  changeReplaceEffect: 'Your AI then works with the new login.', // DRAFT new
  changeFieldSecret: 'changes (the value is not shown)', // DRAFT new
  changeScope: 'This confirms this one change only.', // = T.confirmScope (72)
  changeRunsOut: (left: string) => `Runs out in ${left}.`, // DRAFT new (mockup E2)
  changeConfirmButton: 'Confirm with your touch', // DRAFT new (DEC-85: "... with your touch")
  changeDeny: 'Do not allow', // DRAFT new (mockup E2)
  changeConfirming: 'Confirming…', // DRAFT (approved mockup v6: after the touch)
  changeConfirmed: 'Confirmed', // DRAFT (approved mockup v6: the gateway's result stamp)
  changeRecorded: 'Recorded', // DRAFT (approved mockup v6: no ticket line)
  changeNext: (title: string) => `Next: ${title}`, // DRAFT (approved mockup v6: during the 1.5 s auto-advance)
  changeNotAllowed: (computer: string, name: string) => `Not allowed. ${computer} keeps the login of "${name}".`, // DRAFT new (mockup E3)
  changeExpired: 'This confirmation has run out. Make the change again.', // = T.confirmExpired (74)
  removeDone: (label: string): string => `${label} was removed.`, // DRAFT new
  removeListNow: SP.admitDoneList, // shared (approval-card pairing-texts): "Your devices now:"
  removedSelf: 'This phone was removed from your account.', // DRAFT new

  // ─── Replace the recovery code after joining (DEC-85, mockup D1–D5) ───────────
  rotateOfferTitle: 'Replace your recovery code', // DRAFT
  rotateOfferBody: (label: string): string => `Your recovery code was made on ${label}. Replace it now on this phone, so only the new code works.`, // DRAFT new
  rotateNeedPaper: 'You need the paper with your old code.', // DRAFT new
  rotateOfferJoined: 'Your recovery code was made on another of your devices. Replace it now on this phone, so only the new code works.', // DRAFT new (the join knows no label yet)
  rotateStart: 'Make a new code', // DRAFT
  rotateLater: 'Later', // DRAFT new
  rotateTitle: 'Replace your recovery code', // DRAFT
  rotateOldScan: 'Scan the code on your recovery paper.', // DRAFT new
  rotateTypeInstead: 'Type it instead', // DRAFT new
  rotateOldLabel: 'Old recovery code', // DRAFT new
  rotateNewTitle: 'Your new recovery code', // DRAFT
  rotateNewPaper: 'Write it on paper. Do not take a screenshot or save it in a file on this phone.', // DRAFT (DEC-85: paper only, no print)
  rotateNewAgain: 'New recovery code, typed again', // DRAFT new
  rotateButton: 'Replace code with your touch', // DRAFT new (DEC-85: "... with your touch")
  rotateEmail: (to: string | null): string => (to ? `We sent an email to ${to}. Open the link in it on this phone.` : 'We sent an email to the address of your account. Open the link in it on this phone.'), // DRAFT new
  rotateCompare: 'Check that the page from the email shows this number:', // DRAFT
  rotateWaiting: 'Waiting for the email link...', // DRAFT
  rotateDone: 'Done. Your new recovery code works. The old one does not.', // DRAFT
  rotateThrowAway: 'Throw away the paper with the old code.', // DRAFT new
  rotateGoDevices: 'Go to your devices', // DRAFT

  // ─── Notices from the other devices (mockup F1–F3, plan 20.17) ────────────────
  noticeAdded: (label: string, when: string, by: string): string => `${label} was added to your account ${when} on ${by}. If this was not you, remove it.`, // DRAFT new
  noticeRemoved: (label: string, by: string): string => `${label} was removed from your account on ${by}.`, // DRAFT new
  noticeRotated: (by: string): string => `${by} replaced your recovery code. The old code no longer works. If this was not you, contact support.`, // DRAFT new
  noticeTouchId: (label: string, when: string): string => `Touch ID was turned on for ${label} ${when}, with your recovery code. If this was not you, someone has your recovery code: replace it.`, // DRAFT new
  noticeByCode: 'your recovery code', // DRAFT new (who signed: the recovery code, not a device)

  // ─── Navigation ───────────────────────────────────────────────────────────────
  navRequests: 'Requests', // DRAFT
  navDevices: 'Devices', // DRAFT
  // Mandates on the phone (stage D3; mockup A1–A6, B2, F2). DRAFT texts.
  giveRowKind: 'Mandate to give', // DRAFT new (mockup A1)
  giveTitle: (title: string) => `Give the mandate for ${title}`, // = S13 screen 1 title
  renewTitle: (title: string) => `Extend the mandate for ${title}`, // DRAFT new (DEC-90: a renewal on the phone)
  giveFrom: (device: string, when: string) => `Prepared on ${device}, ${when}.`, // DRAFT new
  giveRead: 'This is what you sign with your touch. Read it first.', // DRAFT
  giveMay: 'What your AI may do', // = S13
  giveLimits: 'Limits', // = S13
  giveScope: 'Scope', // = S13
  giveHowLong: 'How long', // = S13
  giveLasts: 'From your touch for', // = S13
  giveApprovals: 'Approvals', // = S13
  giveAboveCap: (n: number) => `Above the limit, ${n} of these people must approve first:`, // DRAFT new
  giveCheckCode: 'Check identity code', // DRAFT new (UI review, DEC-88)
  giveWhy: 'Why you give it (your words)', // = S13
  giveFromRules: (area: string) => `From the rules of ${area}.`, // DRAFT new (UI review, DEC-88)
  giveAnyDevice: 'You can do this on any of your devices. The mandate then holds for all of them.', // = S13
  giveButton: 'Give this mandate with your touch', // DRAFT new (DEC-85)
  changeButton: 'Change with your touch', // DRAFT new (mockup B1, DEC-85)
  changeRowKind: 'Change to give', // DRAFT new
  giveSigning: 'Signing…', // = the gateway's working word
  giveSigned: 'Signed', // = the gateway's stamp word
  giveReceivedBy: (device: string) => `${device} received it. Your AI can use it now.`, // DRAFT new (mockup A5)
  giveNotReceivedWord: 'Signed', // DRAFT new
  giveNotReceived: (device: string) => `${device} has not received it yet, so your AI cannot use it.`, // DRAFT new (mockup A4, UI review)
  giveNotReceivedHint: (device: string) => `If it never arrives: open the gateway on ${device}.`, // DRAFT new
  giveRefusedAs: 'suveren.ai did not accept the mandate. Try again.', // = S13
  endTitle: 'End a mandate', // = S13 screen 4
  endStops: 'Your AI stops using it at once.', // = S13
  endFinal: 'This cannot be undone. To work again, you give a new mandate.', // = S13
  endNoTouch: 'You do not need your touch to end a mandate.', // DRAFT new (mockup B2)
  endKeep: 'Keep it', // = S13
  endButton: (title: string) => `End the mandate for ${title}`, // = S13.endButtonNamed
  endDone: (title: string) => `The mandate for ${title} has ended.`, // DRAFT new
  mineTitle: 'Your mandates', // DRAFT new
  mineEnd: 'End', // DRAFT new
  mineActiveUntil: (when: string) => `Active until ${when}`, // DRAFT new
  noticeGiven: (title: string, by: string) => `The mandate for ${title} was given on ${by}.`, // DRAFT new (mockup F2)
  noticeEnded: (title: string, by: string) => `The mandate for ${title} was ended on ${by}.`, // DRAFT new (mockup F2)
} as const;

/**
 * Why a request shows no buttons (card-checks.ts). One sentence each, written for a person who knows nothing of keys or
 * fingerprints: what is wrong in their words, that nothing was decided, and what to do. Every text DRAFT.
 */
const BLOCKED: Record<string, string> = {
  not_pending: 'This request was already decided, or it ran out.', // DRAFT
  content_not_here: 'This phone has not received the key to this request yet. Another of your devices will pass it on. Try again in a little while.', // DRAFT (= S8.notYetOpenable, shorter)
  content_unreadable: 'This phone cannot open this request. Decide it on another of your devices.', // DRAFT
  content_mismatch: 'What this phone opened is not what suveren.ai says was asked. Do not approve it. Tell whoever runs your account.', // DRAFT (the fingerprint differs)
  context_missing: 'The details that belong to this request did not arrive. Decide it on your computer.', // DRAFT
  context_unreadable: 'The details that belong to this request could not be opened. Decide it on your computer.', // DRAFT
  context_mismatch: 'The numbers that suveren.ai holds for this request are not the ones this phone works out from what your AI asked. Do not approve it. Tell whoever runs your account.', // DRAFT (the execution context differs)
  crypto_unavailable: 'This phone cannot check mandates here, so nothing can be approved on it. Nothing was decided. Decide it on your computer.', // DRAFT (no WebCrypto in this browser)
  mandate_unavailable: 'The mandate behind this request could not be found. Try again, or decide on your computer.', // DRAFT
  mandate_invalid: 'The mandate behind this request cannot be read. Decide it on your computer.', // DRAFT
  mandate_signature: 'The mandate behind this request was not signed by the suveren.ai this app trusts. Do not approve it. Tell whoever runs your account.', // DRAFT
  mandate_expired: 'The mandate behind this request has run out. Nothing can be approved under it.', // DRAFT
  mandate_ended: 'The mandate behind this request was ended. Nothing can be approved under it.', // DRAFT
  profile_unavailable: 'The rules that this mandate refers to could not be found. Try again later.', // DRAFT
  profile_mismatch: 'The rules that suveren.ai gave for this mandate are not the ones it was made under. Do not approve it. Tell whoever runs your account.', // DRAFT
  owner_not_you: 'This mandate belongs to someone else. You cannot decide it on this phone yet. Use your computer.', // DRAFT
  mandate_not_granted: 'You did not confirm this mandate on one of your devices, so nothing can be approved under it. Do not approve it. Tell whoever runs your account.', // DRAFT (no owner grant verifies)
  action_type_missing: 'This request does not say what kind of action it is, so it cannot be checked here. Decide it on your computer.', // DRAFT
  action_type_unknown: 'This request names a kind of action that its rules do not know. Do not approve it. Tell whoever runs your account.', // DRAFT
  session_ended: 'The app closed itself. Open it again with your touch.', // DRAFT
  reads_failed: 'This request could not be checked right now. Nothing was decided. Try again.', // DRAFT
  proposal_invalid: 'This request could not be read. Nothing was decided.', // DRAFT
};

export function blockedText(reason: string): string {
  return Object.prototype.hasOwnProperty.call(BLOCKED, reason) ? BLOCKED[reason] : BLOCKED.reads_failed;
}

/** Every reason with a text of its own. */
export const BLOCKED_REASONS: readonly string[] = Object.keys(BLOCKED);

/** The sentence for a code. Total: a code nobody knows gets the generic text, never the code itself and never the server's message. */
const ERRORS: Record<string, string> = {
  ...SHARED_ERRORS, // the pairing sentences both apps say in the same words
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
  qr_wrong_kind: 'This code is for another step. Nothing changed.', // DRAFT
  qr_other_server: 'This code is for another suveren.ai than this app uses. Nothing changed.', // DRAFT
  qr_not_open: SHARED_ERRORS.mailbox_missing, // shared (approval-card pairing-texts)
  admitter_cannot_grant: 'The device that shows this code cannot add devices. Use another device.', // DRAFT
  cannot_grant: 'This phone cannot add devices.', // DRAFT
  check_cancelled: 'Cancelled. Nothing was added.', // DRAFT
  // A decision (decide.ts): the Authority Server's codes, lower-cased. None of them tells the person a code or the server's words.
  not_pending: 'This request was already decided, or it ran out. Nothing changed.', // DRAFT
  content_changed: 'This request changed while you looked at it. Nothing was decided. Open it again.', // DRAFT
  content_mismatch: 'What suveren.ai holds for this request is not what you saw. Nothing was decided. Tell whoever runs your account.', // DRAFT
  device_decision_required: 'This phone\'s decision did not reach suveren.ai in the way it needs. Nothing was decided. Try again; if it repeats, tell support.', // DRAFT
  device_mismatch: 'suveren.ai did not accept this phone for this decision. Nothing was decided. Try again; if it repeats, tell support.', // DRAFT
  not_active: 'This phone is no longer one of your devices. Nothing was decided.', // DRAFT
  wrong_root: 'This phone does not belong to the account that owns this request. Nothing was decided.', // DRAFT
  bad_signature: 'suveren.ai did not accept this phone\'s signature. Nothing was decided. Try again; if it repeats, tell support.', // DRAFT
  fork: 'Your list of devices does not match what suveren.ai holds. Nothing was decided. Contact support.', // DRAFT
  chain_ahead: 'Your list of devices changed meanwhile. Nothing was decided. Open the app again and try again.', // DRAFT
  proposal_mismatch: 'suveren.ai did not find this request the way this phone checked it. Nothing was decided. Open it again.', // DRAFT
  action_type_unknown: 'This request does not say what kind of action it is, so it cannot be decided here. Use your computer.', // DRAFT
  decision_nonce_reused: 'This decision was already sent once. Nothing changed. Open the request again.', // DRAFT
  device_decision_exists: 'You already decided this request. Nothing changed.', // DRAFT
  proposal_already_decided: 'This request was already decided. Nothing changed.', // DRAFT
  mandate_revoked: 'The mandate behind this request was ended. Nothing can be approved under it.', // DRAFT
  mandate_expired: 'The mandate behind this request has run out. Nothing can be approved under it.', // DRAFT
  check_required: 'Your touch is needed first. Nothing was decided. Try again.', // DRAFT
  // Notifications (push.ts; suveren-as codes lower-cased)
  push_unsupported: 'This phone cannot show notifications from this app.', // DRAFT
  push_denied: 'This phone blocks notifications for Suveren. Allow them in the phone\'s settings, then try again.', // DRAFT
  push_dismissed: 'Notifications stay off. You can turn them on here at any time.', // DRAFT
  push_subscribe_failed: 'The phone did not set up notifications. Nothing changed. Try again.', // DRAFT
  push_not_configured: 'suveren.ai does not send notifications yet. Open the app now and then to see what waits.', // DRAFT
  push_endpoint_not_allowed: 'suveren.ai did not accept this phone\'s notification service. Nothing changed. Tell support.', // DRAFT
  // Removing a device (stage D3)
  last_granting_self: 'This phone is the only one of your devices that can confirm changes. Add a device that can, then remove this phone. Nothing changed.', // DRAFT new (mockup C3)
  last_granting: 'Then none of your devices could confirm changes. Add a device that can first. Nothing changed.', // DRAFT new
  no_granting_device: 'Then none of your devices could confirm changes. Add a device that can first. Nothing changed.', // DRAFT new (the AS code NO_GRANTING_DEVICE)
  bad_target: 'This device is no longer in your list. Nothing changed.', // DRAFT new (BAD_TARGET)
  recovery_code_invalid: 'This is not a recovery code. Check each character and try again.', // DRAFT new
  recovery_code_wrong: 'This is not the recovery code of your account. Nothing changed.', // DRAFT new
  new_code_mismatch: 'What you typed is not the new code. Look at it again.', // DRAFT new
  handoff_expired: 'The email link ran out. Nothing changed. Start again.', // DRAFT new
  handoff_used: 'This replacement was already used. Nothing changed. Start again.', // DRAFT new
  mail_failed: 'The email could not be sent. Nothing changed. Try again.', // DRAFT new
  no_chain: 'suveren.ai did not accept the old code. Nothing changed. Check the code and try again.', // DRAFT new (NO_CHAIN: the same answer for every failure before the root signature)
  bad_op: 'suveren.ai did not accept this change. Nothing changed. Try again; if it repeats, tell support.', // DRAFT new
  rotate_chain_moved: 'Your list of devices changed meanwhile. Nothing changed. Start again.', // DRAFT new
  list_not_refreshed: 'The list could not be refreshed. Look at it again in a moment.', // DRAFT new
  remove_chain_moved: 'Your list of devices changed meanwhile. Nothing was removed. Look at the list again.', // DRAFT new
  // Confirming a computer's change (stage D3)
  change_answered: 'This change was already answered on another of your devices. Nothing changed here.', // DRAFT new
  // Giving a mandate on the phone (stage D3, mockup A2–A6)
  give_renewal_is_a_change: 'This extension would change more than the end date. Nothing was signed. Extend it again on your computer.', // DRAFT new (DEC-90)
  give_expired: 'This mandate was waiting too long and has run out. Nothing was signed. Prepare it again on your computer.', // DRAFT new (mockup A6)
  grant_version_refused: 'This phone already has a newer version of this mandate. Nothing was signed.', // DRAFT new (mockup A6)
  mandate_expired_grant: 'This mandate was waiting too long and has run out. Nothing was signed. Prepare it again on your computer.', // DRAFT new
  check_required_grant: 'Your touch is needed to give a mandate. Nothing was signed. Try again.', // DRAFT new
  end_failed: 'suveren.ai did not accept ending the mandate. It still runs. Try again.', // DRAFT new
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
