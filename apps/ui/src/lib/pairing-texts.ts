/**
 * Every word the person reads on the pairing screens of the gateway page: the Devices page, "Add a phone" (this computer admits the
 * phone app) and "Add this computer" (a computer without the account is admitted by the phone). ONE module, the texts-module pattern
 * of `device-texts.ts` and the phone app's `texts.ts`.
 *
 * EVERY text here is `DRAFT`: no signed-off mockup has a sentence for these screens, and the wording is the maintainer's (O19).
 * Nothing here is final. Words follow DEC-78/79 (`temp/device-keys-mockup/terms.md`): "device" on list and approval screens, "computer" for
 * set-up and connecting (adding a computer is that), "phone" for the phone app, "your AI" and never "agent", suveren.ai and never
 * "Authority Server", an identity code and a recovery code always with their noun, "Nothing changed." where it is true. No gendered pronoun
 * anywhere. Where a sentence is the SAME as one of the phone app's (`apps/approve/src/texts.ts`) it says so: the two are to become one
 * string once the device texts move into the shared package (open question in the hand-over).
 *
 * Pure: no React, no network.
 */
import { textForCode } from './device-texts';

export const PT = {
  // ─── The Devices page ─────────────────────────────────────────────────────────
  devicesTitle: 'Your devices', // DRAFT (= phone P.devicesTitle)
  devicesBack: 'Back to settings', // DRAFT
  devKindComputer: 'Computer', // DRAFT (= P.devKindComputer)
  devKindPhone: 'Phone', // DRAFT (= P.devKindPhone)
  devCanConfirm: 'confirms changes with a touch', // DRAFT (= P.devCanConfirm)
  devRecent: 'added in the last 14 days', // DRAFT (= P.devRecent)
  devAdded: (when: string): string => `added ${when}`, // DRAFT (= P.devAdded)
  devThisComputer: 'This computer', // DRAFT (P.devThisPhone for the phone)
  devIdentity: 'Your identity code', // DRAFT (= P.devIdentity)
  devAddPhone: 'Add a phone', // DRAFT
  devRefresh: 'Check the list again', // DRAFT (= P.devRefresh)
  devCannotAdd: 'This computer has no Touch ID key, so it cannot add devices. Add a phone from a device that has one.', // DRAFT
  devFull: 'Your account already has the most devices it can have. Remove one first.', // DRAFT (= P.too_many_devices)
  devLoading: 'Loading...', // DRAFT
  devSettingsLink: 'Your devices', // DRAFT (the link on the Settings card)
  devSettingsBody: 'The computers and phones that belong to your account. Add a phone here.', // DRAFT
  whenToday: 'today', // DRAFT (= P.whenToday)
  whenYesterday: 'yesterday', // DRAFT
  whenDaysAgo: (n: number): string => `${n} days ago`, // DRAFT

  // ─── Add a phone (this computer admits) ───────────────────────────────────────
  addPhoneTitle: 'Add a phone', // DRAFT
  addPhoneIntro: 'The Suveren app on your phone becomes one of your devices. For now you read requests there. You approve or reject them here.', // DRAFT (= P.joinIntro, from the other side)
  addPhoneShow: 'Show the code', // DRAFT
  addPhoneScan: 'On your phone, open the Suveren app, choose Add this phone to my account, and scan this code.', // DRAFT (= P.welcomeJoin)
  addPhoneQrLabel: 'Code to add a phone', // DRAFT (the picture's text for a screen reader)
  addPhoneQrTime: 'The code works for 10 minutes. Show it to your own phone only.', // DRAFT
  addPhoneConnected: 'Your phone is connecting...', // DRAFT
  addPhoneChooseTitle: (label: string): string => `Add "${label}"?`, // DRAFT (= P.admitChooseTitle, 20.11)
  addPhoneChooseBody: 'Tap the code your phone shows. A wrong code ends this, and nothing is added.', // DRAFT (= P.admitChooseBody)
  addPhoneListTitle: 'Your devices after this:', // DRAFT (= P.admitListTitle)
  addPhoneNew: 'new', // DRAFT (= P.admitNew)
  addPhoneChecking: 'This computer asks for your touch, to add the phone.', // DRAFT
  addPhoneDoneTitle: (label: string): string => `"${label}" was added`, // DRAFT (= P.admitDoneTitle)
  addPhoneDone: 'It is now one of your devices.', // DRAFT (= P.setupDoneBody)
  addPhoneDoneList: 'Your devices now:', // DRAFT (= P.admitDoneList)

  // ─── Add this computer (a computer without the account is admitted by the phone) ──
  addComputerTitle: 'Add this computer to my account', // DRAFT
  addComputerLink: 'Add this computer from my phone', // DRAFT (the button on the screen of a computer that is not set up)
  addComputerIntro: 'Your account already exists on your phone. This computer becomes one of your devices. You approve what your AI asks of you here.', // DRAFT
  addComputerNeedsPhone: 'You need the Suveren app on a phone that already has your account.', // DRAFT
  addComputerShow: 'Show the code', // DRAFT
  addComputerScan: 'On your phone, open the Suveren app, choose Add a computer, and scan this code.', // DRAFT (= P.admitScanWhy says "On the new computer, open the gateway page and choose Add this computer")
  addComputerQrLabel: 'Code to add this computer', // DRAFT
  addComputerQrTime: 'The code works for 10 minutes. Show it to your own phone only.', // DRAFT
  addComputerNoTouch: 'This computer has no Touch ID key. It will show your AI\'s requests, and it cannot add devices or give mandates.', // DRAFT
  reviewTitle: 'You are about to join this account', // DRAFT (= P.reviewTitle)
  reviewMade: (label: string, when: string): string => `This account already has an identity, created ${when} on ${label}. This computer is being added to it.`, // DRAFT (plan 4.3 step 8, DEC-47)
  reviewIdentity: 'Identity code', // DRAFT (= P.reviewIdentity)
  reviewIdentityNote: 'Check that this is the identity code of your account.', // DRAFT (= P.reviewIdentityNote)
  reviewDevices: 'Devices in this account:', // DRAFT (= P.reviewDevices)
  reviewNameLabel: 'Name of this computer', // DRAFT
  reviewNameHint: 'For example: Office Mac. You will see it in your list of devices.', // DRAFT (= T.nameHint)
  reviewButton: 'Add this computer to it', // DRAFT
  reviewNotMine: 'This is not my account', // DRAFT (= P.reviewNotMine)
  workCheck: 'This computer asks for your touch, to prove its own Touch ID key.', // DRAFT
  workSend: 'Sending to suveren.ai...', // DRAFT (= P.doSend)
  waitingFor: (label: string): string => `Waiting for ${label}...`, // DRAFT (= P.compareWaiting)
  compareTitle: 'Check the code', // DRAFT (= P.compareTitle)
  compareBody: (label: string): string => `${label} shows three codes. Tap the one that matches this code. Then it asks for your touch.`, // DRAFT
  addedComputerTitle: 'This computer was added', // DRAFT
  addedComputerBody: 'It is now one of your devices, and you are signed in.', // DRAFT
  addedComputerNoSignin: 'This computer was added, but signing in did not work. Try again.', // DRAFT (T.connectedSigninFailed)

  // ─── Shared buttons ───────────────────────────────────────────────────────────
  cancel: 'Cancel', // = T.connectCancel (58)
  continue: 'Continue', // DRAFT
  back: 'Back', // DRAFT
  startAgain: 'Start again', // DRAFT (= P.startAgain)
  tryAgain: 'Try again', // DRAFT (= DRAFT.tryAgain)
} as const;

/** Where a line says when a device was added: today, yesterday, n days ago, else the date. */
export function whenText(epochSeconds: number, nowSeconds: number): string {
  const days = Math.floor((nowSeconds - epochSeconds) / 86400);
  if (days <= 0) return PT.whenToday;
  if (days === 1) return PT.whenYesterday;
  if (days < 14) return PT.whenDaysAgo(days);
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The sentence for a pairing code. DRAFT, in the style of the phone app's `ERRORS`; a code nobody here knows falls to the device-key texts, then the generic one. */
const ERRORS: Record<string, string> = {
  pairing_busy: 'Another step of this is still running. Wait a moment.', // DRAFT
  pairing_pending: 'A pairing is already open. Cancel it, then start again.', // DRAFT
  pairing_unknown: 'This pairing is no longer open. Start again.', // DRAFT
  cannot_grant: 'This computer has no Touch ID key, so it cannot add devices. Nothing changed.', // DRAFT
  too_many_devices: 'Your account already has the most devices it can have. Remove one first.', // DRAFT (= P.too_many_devices)
  qr_expired: 'This code has run out. Show a new one and scan it again.', // DRAFT (= P.qr_expired)
  wrong_code: 'That was not the code. Nothing was added.', // DRAFT (= P.wrong_code)
  code_mismatch: 'The codes did not match. Nothing was added.', // DRAFT (= P.code_mismatch)
  label_taken: 'Another device in your account has this name. Use another name.', // DRAFT (= P.label_taken)
  label_invalid: 'This name does not work. Use another name.', // = T.nameInvalid (32)
  bad_message: 'Something is wrong with this pairing. Nothing was added. Start again.', // DRAFT (= P.bad_message)
  commit_mismatch: 'Something is wrong with this pairing. Nothing was added. Start again.', // DRAFT
  open_invalid: 'Something is wrong with this pairing. Nothing was added. Start again.', // DRAFT
  mailbox_refused: 'suveren.ai did not take this pairing. Nothing changed. Try again.', // DRAFT (= P.mailbox_refused)
  mailbox_missing: 'This code is not open any more. Show a new one and scan it again.', // DRAFT
  admitter_cannot_grant: 'The phone that scanned this code cannot add devices. Use another device.', // DRAFT
  as_key_mismatch: 'The phone and this computer do not use the same suveren.ai. Nothing was added. Do not go on, and tell whoever runs your account.', // DRAFT
  chain_moved: 'Your list of devices changed meanwhile. Nothing was added. Start again.', // DRAFT (= P.chain_moved)
  chain_head_moved: 'Your list of devices changed meanwhile. Nothing was added. Start again.', // DRAFT
  check_cancelled: 'Cancelled on the phone. Nothing was added.', // DRAFT
  cancelled_by_phone: 'The phone ended this. Nothing was added.', // DRAFT
  store_failed: 'suveren.ai has added this computer, but this computer could not keep the account. Use your recovery code to set it up again.', // DRAFT (= P.store_failed)
  passkey_required: 'suveren.ai did not accept the passkey of the phone. Nothing changed. Try again; if it repeats, tell support.', // DRAFT (= P.passkey_required)
  too_many_tries: 'Too many tries. Wait a few minutes, then try again.', // DRAFT
  no_user_verification: 'The phone did not ask for a touch. Nothing was added.', // DRAFT
  helper_unavailable: 'This computer cannot ask for your touch right now. Nothing changed.', // DRAFT
  no_biometry: 'This computer has no Touch ID. Nothing changed.', // DRAFT
};

export function pairingErrorText(code: string | undefined): string {
  const key = (code ?? '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ERRORS, key)) return ERRORS[key];
  return textForCode(code, { screen: 'general' });
}

/** Every pairing code with a text of its own (so a test can list them, and the hand-over can). */
export const PAIRING_ERROR_CODES: readonly string[] = Object.keys(ERRORS);
