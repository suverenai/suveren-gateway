/**
 * The device and pairing sentences that the gateway page and the phone app say IN THE SAME WORDS: one string, both apps import it
 * (apps/ui `lib/pairing-texts.ts` `PT`, apps/approve `texts.ts` `P`). A sentence that differs between the two (it names the phone in one
 * and the computer in the other) stays in its app. ALL are DRAFT: the wording is the maintainer's (O19). Words follow DEC-78/79.
 * Pure: no React, no network.
 */
export const SP = {
  // The device list
  devicesTitle: 'Your devices', // DRAFT
  devKindComputer: 'Computer', // DRAFT
  devKindPhone: 'Phone', // DRAFT
  devCanConfirm: 'confirms changes with a touch', // DRAFT
  devRecent: 'added in the last 14 days', // DRAFT
  devAdded: (when: string): string => `added ${when}`, // DRAFT
  /** UI review (DEC-88): on the row of a device added in the last 14 days, where it can be removed. */
  devAddedWarn: (when: string): string => `Added ${when}. If this was not you, remove it.`, // DRAFT
  devRemove: 'Remove', // DRAFT
  devIdentity: 'Your identity code', // DRAFT
  devRefresh: 'Check the list again', // DRAFT
  whenToday: 'today', // DRAFT
  whenYesterday: 'yesterday', // DRAFT
  whenDaysAgo: (n: number): string => `${n} days ago`, // DRAFT
  // Adding a device (the admitter's screens)
  admitChooseTitle: (label: string): string => `Add "${label}"?`, // DRAFT (20.11)
  admitListTitle: 'Your devices after this:', // DRAFT
  admitNew: 'new', // DRAFT
  admitDoneTitle: (label: string): string => `"${label}" was added`, // DRAFT
  admitDoneList: 'Your devices now:', // DRAFT
  // Joining (the joiner's screens)
  joinedBody: 'It is now one of your devices.', // DRAFT
  reviewTitle: 'You are about to join this account', // DRAFT
  reviewIdentity: 'Identity code', // DRAFT
  reviewIdentityNote: 'Check that this is the identity code of your account.', // DRAFT
  reviewDevices: 'Devices in this account:', // DRAFT
  reviewNotMine: 'This is not my account', // DRAFT
  compareTitle: 'Check the code', // DRAFT
  // DEC-96: the side that SHOWS the number says plainly that the next step is on the other device.
  showOnComputerTitle: 'Now on your computer', // DRAFT
  showOnPhoneTitle: 'Now on your phone', // DRAFT
  tapThisNumber: (label: string): string => `On ${label}, tap this number.`, // DRAFT
  // DEC-96: the side that CHOOSES says the other device is ready.
  otherReadyPhone: 'Your phone is ready. Tap the number it shows.', // DRAFT
  otherReadyComputer: 'Your computer is ready. Tap the number it shows.', // DRAFT
  rotateWhy: 'Replace it if anyone could have seen your screen when you set up.', // DRAFT (DEC-96)
  compareWaiting: (label: string): string => `Waiting for ${label}...`, // DRAFT
  sending: 'Sending to suveren.ai...', // DRAFT
  // Buttons
  cancel: 'Cancel', // = T.connectCancel (58)
  continue: 'Continue', // DRAFT
  back: 'Back', // DRAFT
  startAgain: 'Start again', // DRAFT
  tryAgain: 'Try again', // = DRAFT.tryAgain of device-texts.ts
} as const;

/** Where a line says when a device was added: today, yesterday, n days ago, else the date. */
export function whenText(epochSeconds: number, nowSeconds: number): string {
  const days = Math.floor((nowSeconds - epochSeconds) / 86400);
  if (days <= 0) return SP.whenToday;
  if (days === 1) return SP.whenYesterday;
  if (days < 14) return SP.whenDaysAgo(days);
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Pairing refusals whose sentence is the same on both apps, by code. */
export const SHARED_ERRORS: Record<string, string> = {
  too_many_devices: 'Your account already has the most devices it can have. Remove one first.', // DRAFT
  qr_expired: 'This code has run out. Show a new one and scan it again.', // DRAFT (10 minutes, plan 4.3)
  wrong_code: 'That was not the code. Nothing was added.', // DRAFT (20.11)
  code_mismatch: 'The codes did not match. Nothing was added.', // DRAFT
  label_taken: 'Another device in your account has this name. Use another name.', // DRAFT (DEC-47)
  label_invalid: 'This name does not work. Use another name.', // = T.nameInvalid (32)
  bad_message: 'Something is wrong with this pairing. Nothing was added. Start again.', // DRAFT
  commit_mismatch: 'Something is wrong with this pairing. Nothing was added. Start again.', // DRAFT
  open_invalid: 'Something is wrong with this pairing. Nothing was added. Start again.', // DRAFT
  mailbox_refused: 'suveren.ai did not take this pairing. Nothing changed. Try again.', // DRAFT
  mailbox_missing: 'This code is not open any more. Show a new one and scan it again.', // DRAFT
  chain_moved: 'Your list of devices changed meanwhile. Nothing was added. Start again.', // DRAFT
  chain_head_moved: 'Your list of devices changed meanwhile. Nothing was added. Start again.', // DRAFT
};
