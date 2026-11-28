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
import { SP, SHARED_ERRORS, whenText } from '@suveren/approval-card/lib/pairing-texts';
import { liveTexts } from '@suveren/approval-card/lib/as-host';

export { whenText };

export const PT = liveTexts({
  // ─── The Devices page ─────────────────────────────────────────────────────────
  devicesTitle: SP.devicesTitle, // shared (approval-card pairing-texts)
  devicesBack: 'Back to settings', // DRAFT
  devKindComputer: SP.devKindComputer, // shared (approval-card pairing-texts)
  devKindPhone: SP.devKindPhone, // shared (approval-card pairing-texts)
  devCanConfirm: SP.devCanConfirm, // shared (approval-card pairing-texts)
  devRecent: SP.devRecent, // shared (approval-card pairing-texts)
  devAdded: SP.devAdded, // shared (approval-card pairing-texts)
  devThisComputer: 'This computer', // DRAFT (P.devThisPhone for the phone)
  devIdentity: SP.devIdentity, // shared (approval-card pairing-texts)
  devAddPhone: 'Add a phone', // DRAFT
  devRefresh: SP.devRefresh, // shared (approval-card pairing-texts)
  devCannotAdd: 'This computer has no Touch ID key, so it cannot add devices. Add a phone from a device that has one.', // DRAFT
  devFull: SHARED_ERRORS.too_many_devices, // shared (approval-card pairing-texts)
  devLoading: 'Loading...', // DRAFT
  devSettingsLink: SP.devicesTitle, // shared (approval-card pairing-texts)
  devSettingsBody: 'The computers and phones that belong to your account. Add a phone here.', // DRAFT
  whenToday: SP.whenToday, // shared (approval-card pairing-texts)
  whenYesterday: SP.whenYesterday, // shared (approval-card pairing-texts)
  whenDaysAgo: SP.whenDaysAgo, // shared (approval-card pairing-texts)

  // ─── Add a phone (this computer admits) ───────────────────────────────────────
  addPhoneTitle: 'Add a phone', // DRAFT
  // Changes when D2 ships (the phone approves): today the phone only reads, so "you approve or reject them here" is true; after D2 it is not.
  addPhoneIntro: 'The Suveren app on your phone becomes one of your devices. For now you read requests there. You approve or reject them here.', // DRAFT (= P.joinIntro, from the other side)
  addPhoneShow: 'Show the code', // DRAFT
  addPhoneScan: 'On your phone, open the Suveren app, choose Add this phone to my account, and scan this code.', // DRAFT (= P.welcomeJoin); the sentence of a server that names no phone app address (see addPhoneScanText)
  addPhoneQrLabel: 'Code to add a phone', // DRAFT (the picture's text for a screen reader)
  addPhoneQrTime: 'The code works for 10 minutes. Show it to your own phone only.', // DRAFT
  addPhoneConnected: 'Your phone is connecting...', // DRAFT
  addPhoneChooseTitle: SP.admitChooseTitle, // shared (approval-card pairing-texts)
  addPhoneChooseBody: 'Tap the code your phone shows. A wrong code ends this, and nothing is added.', // DRAFT (= P.admitChooseBody)
  addPhoneListTitle: SP.admitListTitle, // shared (approval-card pairing-texts)
  addPhoneNew: SP.admitNew, // shared (approval-card pairing-texts)
  addPhoneChecking: 'This computer asks for your touch, to add the phone.', // DRAFT
  addPhoneDoneTitle: SP.admitDoneTitle, // shared (approval-card pairing-texts)
  addPhoneDone: SP.joinedBody, // shared (approval-card pairing-texts)
  addPhoneDoneList: SP.admitDoneList, // shared (approval-card pairing-texts)

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
  reviewTitle: SP.reviewTitle, // shared (approval-card pairing-texts)
  reviewMade: (label: string, when: string): string => `This account already has an identity, created ${when} on ${label}. This computer is being added to it.`, // DRAFT (plan 4.3 step 8, DEC-47)
  reviewIdentity: SP.reviewIdentity, // shared (approval-card pairing-texts)
  reviewIdentityNote: SP.reviewIdentityNote, // shared (approval-card pairing-texts)
  reviewDevices: SP.reviewDevices, // shared (approval-card pairing-texts)
  reviewNameLabel: 'Name of this computer', // DRAFT
  reviewNameHint: 'For example: Office Mac. You will see it in your list of devices.', // DRAFT (= T.nameHint)
  reviewButton: 'Add this computer to it', // DRAFT
  reviewNotMine: SP.reviewNotMine, // shared (approval-card pairing-texts)
  workCheck: 'This computer asks for your touch, to prove its own Touch ID key.', // DRAFT
  workSend: SP.sending, // shared (approval-card pairing-texts)
  waitingFor: SP.compareWaiting, // shared (approval-card pairing-texts)
  compareTitle: SP.compareTitle, // shared (approval-card pairing-texts)
  compareBody: (label: string): string => `${label} shows three codes. Tap the one that matches this code. Then it asks for your touch.`, // DRAFT
  showTitle: SP.showOnPhoneTitle, // shared (DEC-96): the computer shows, the phone taps
  tapThis: SP.tapThisNumber, // shared (DEC-96)
  otherReady: SP.otherReadyPhone, // shared (DEC-96): the computer adds a phone
  addedComputerTitle: 'This computer was added', // DRAFT
  addedComputerBody: 'It is now one of your devices, and you are signed in.', // DRAFT
  addedComputerNoSignin: 'This computer was added, but signing in did not work. Try again.', // DRAFT (T.connectedSigninFailed)

  // ─── Shared buttons ───────────────────────────────────────────────────────────
  cancel: SP.cancel, // shared (approval-card pairing-texts)
  continue: SP.continue, // shared (approval-card pairing-texts)
  back: SP.back, // shared (approval-card pairing-texts)
  startAgain: SP.startAgain, // shared (approval-card pairing-texts)
  tryAgain: SP.tryAgain, // shared (approval-card pairing-texts)
} as const);

/**
 * "Add a phone": where the person opens the phone app. The address comes from the gateway (`appOrigin`: SUVEREN_APP_ORIGIN, or
 * app.suveren.ai for suveren.ai), never from the Authority Server. Without one the sentence is `PT.addPhoneScan`.
 * Outside `PT` on purpose: the host of the app is not the name of the Authority Server and must not be rewritten with it.
 */
export function addPhoneScanText(appOrigin: string | undefined): string {
  let host = '';
  try { host = appOrigin ? new URL(appOrigin).host : ''; } catch { host = ''; }
  return host ? `On your phone, open ${host}, choose Add this phone to my account, and scan this code.` : PT.addPhoneScan;
}

/** The sentence for a pairing code. DRAFT, in the style of the phone app's `ERRORS`; a code nobody here knows falls to the device-key texts, then the generic one. */
const ERRORS: Record<string, string> = liveTexts({
  ...SHARED_ERRORS, // the pairing sentences both apps say in the same words
  other_account: 'This phone belongs to another account than the one this computer is signed in to. Nothing was added.', // DRAFT (plan 20.2)
  sign_in_first: 'This computer holds logins for connected systems. Sign in to your account first, then add this computer.', // DRAFT (plan 20.2)
  pairing_busy: 'Another step of this is still running. Wait a moment.', // DRAFT
  pairing_pending: 'A pairing is already open. Cancel it, then start again.', // DRAFT
  pairing_unknown: 'This pairing is no longer open. Start again.', // DRAFT
  cannot_grant: 'This computer has no Touch ID key, so it cannot add devices. Nothing changed.', // DRAFT
  admitter_cannot_grant: 'The phone that scanned this code cannot add devices. Use another device.', // DRAFT
  as_key_mismatch: 'The phone and this computer do not use the same suveren.ai. Nothing was added. Do not go on, and tell whoever runs your account.', // DRAFT
  check_cancelled: 'Cancelled on the phone. Nothing was added.', // DRAFT
  cancelled_by_phone: 'The phone ended this. Nothing was added.', // DRAFT
  store_failed: 'suveren.ai has added this computer, but this computer could not keep the account. Use your recovery code to set it up again.', // DRAFT (= P.store_failed)
  passkey_required: 'suveren.ai did not accept the passkey of the phone. Nothing changed. Try again; if it repeats, tell support.', // DRAFT (= P.passkey_required)
  too_many_tries: 'Too many tries. Wait a few minutes, then try again.', // DRAFT
  no_user_verification: 'The phone did not ask for a touch. Nothing was added.', // DRAFT
  helper_unavailable: 'This computer cannot ask for your touch right now. Nothing changed.', // DRAFT
  no_biometry: 'This computer has no Touch ID. Nothing changed.', // DRAFT
});

export function pairingErrorText(code: string | undefined): string {
  const key = (code ?? '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ERRORS, key)) return ERRORS[key];
  return textForCode(code, { screen: 'general' });
}

/** Every pairing code with a text of its own (so a test can list them, and the hand-over can). */
export const PAIRING_ERROR_CODES: readonly string[] = Object.keys(ERRORS);
