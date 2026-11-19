/**
 * Step 13: every word the person reads on the mandate screens (held back, End, Change, identity codes at the join).
 * ONE module for every device: the gateway page and the later phone app import these same strings. The number in a
 * comment is the item in temp/device-keys-mockup/step13.html rev 2 (signed off), terms in terms.md (DEC-75/78/79).
 * `DRAFT` marks a text the mockup has no sentence for; it is listed in the hand-over report.
 *
 * Pure: no React, no network.
 */

export const S13 = {
  // Screen 1: give a mandate (step 13; today's review step, changed in place: DEC-80)
  giveButton: 'Give this mandate with Touch ID', // 211
  /** DRAFT: while the touch is asked for. */
  giveBusy: 'Waiting for your touch...',
  giveCardButton: 'Give this mandate', // DRAFT: the AI-proposal card's "Sign mandate"; the touch follows
  giveCardApprove: 'Approve', // DRAFT: the card's "Approve and sign"
  giveTouchNote: 'Your device asks for your touch. It names only the area ({area}). The details are on this page.', // 212 (device, not Mac)
  giveHowLong: 'How long', // 206
  giveUntil: (duration: string, end: string): string => `${duration} (until ${end})`, // 206
  giveApproversAbove: (cap: string, n: number): string => `Above ${cap}, ${n} of these people must approve first:`, // 208
  giveApproversAll: (n: number): string => `${n} of these people must approve first:`, // DRAFT: team without caps
  giveWithinCaps: (cap: string): string => `Up to ${cap} your AI acts alone.`, // 207
  giveApproverConfirmed: (admin: string): string => `confirmed by ${admin}`, // 330
  giveApproverUnconfirmed: 'not confirmed by your admin yet', // 330
  giveYou: 'You', // 245
  giveYouNote: 'Someone else must approve your AI\'s actions above this limit.', // 245
  giveUnconfirmedReason: (name: string, admin: string): string => `${name} is not confirmed by your admin yet. She cannot approve until ${admin} confirms her.`, // 214
  giveUnconfirmedStep: (admin: string): string => `Ask ${admin} to confirm her.`, // 215
  /** DRAFT: shown until the check can read confirmations before the touch (DEC-73 member list). */
  giveApproversChecked: 'Checked when you give the mandate.',
  giveDone: (area: string, end: string): string => `Done. The mandate for ${area} is active until ${end}.`, // 217
  giveErrCap: 'A limit is higher than your team allows. Nothing changed. Lower it and try again.', // 218
  giveErrApprovers: 'suveren.ai did not say who may approve for this team. Nothing changed. Try again.', // 219
  giveErrNoChain: 'An approver has not finished setting up Suveren yet. Nothing changed. Ask them to finish it.', // 220
  giveErrCancelled: 'Cancelled. Nothing changed.', // 221
  giveErrTouch: 'Touch ID did not work this time. Nothing changed. Try again.', // 222
  giveErrNotAccepted: 'suveren.ai did not accept the mandate. Try again.', // 223
  giveErrNotDelivered: 'The mandate could not reach the gateway, so it was ended again. Give it again.', // 224
  giveAnyDevice: 'You can do this on any of your devices. The mandate then holds for all of them.', // 225

  // Screen 3: a mandate this gateway holds back
  heldTitle: 'On hold: Your AI cannot use these yet', // 250
  heldName: (profile: string, owner: string): string => `${profile}, from ${owner}`, // 251
  heldOwnerYou: 'you', // 251
  heldNotReceived: 'This device has not received this mandate yet. Your AI cannot use it until it does.', // 252
  heldCheckAgain: 'Check again', // 253
  heldNoCheck: (owner: string): string => `${owner} did not confirm this mandate with Touch ID. Your AI cannot use it.`, // 254
  heldNoCheckStep: 'Ask her to give it again on one of her devices.', // 255
  heldNotOnList: (owner: string): string => `${owner} is not on the list your admin confirmed. Your AI cannot use her mandate.`, // 256
  heldNotOnListStep: (admin: string): string => `Ask ${admin}, your admin, to confirm her.`, // 257
  heldChanged: (owner: string): string => `This mandate does not match what ${owner} confirmed. It may have been changed since. Your AI cannot use it.`, // 258
  heldChangedStep: 'Ask her to give it again.', // 259
  heldEnded: (owner: string): string => `${owner} ended this mandate. This is final.`, // 260
  heldEndedStep: 'If the work still needs it, ask for a new mandate.', // 261
  heldOwnNoCheck: 'Touch ID was not confirmed for this mandate. Your AI cannot use it.', // 262
  heldGiveAgain: 'Give it again', // 263
  /** DRAFT: the mockup names no admin when the gateway does not know one; the step is then said without a name. */
  heldAdminUnknown: 'your admin',

  // Screen 4: End a mandate
  endTitle: 'End a mandate', // 270
  endNames: (profile: string): string => `The mandate for ${profile}`, // 280
  endAtOnce: 'Your AI stops using it at once.', // 271
  endFinal: 'This cannot be undone. To work again, you give a new mandate.', // 272
  endNoTouch: 'You do not need Touch ID to end a mandate.', // 273
  endButton: 'End this mandate', // 274
  endKeep: 'Keep it', // 275
  endActiveUntil: 'Active until', // (row label of 4a)
  endDone: (profile: string): string => `Ended. Your AI can no longer act under the mandate for ${profile}.`, // 276
  endAlready: 'This mandate was already ended.', // 277
  endUnknown: 'This mandate could not be found. Nothing changed.', // 278
  endOffline: 'Cannot reach suveren.ai. Nothing changed. Check your internet connection and try again.', // 279
  /** DRAFT: not in the mockup: the gateway refused for another reason (locked, device removed, bad request). */
  /** DRAFT: closes the result of End. */
  endClose: 'Close',
  endOther: 'The mandate was not ended. Nothing changed. Try again.',

  // Screen 5: change a mandate
  changeTitle: (profile: string): string => `Change the mandate for ${profile}`, // 290
  changeOnlyListed: 'Only what changes is listed. Everything else stays as you gave it.', // 291
  changeOnlyOwner: 'Only you change this mandate. Approvers are not asked.', // 309
  changeLimits: 'Limits', // 292
  changeScope: 'Scope', // 292
  changeHowLong: 'How long', // 295
  changeUntil: 'Until', // 295
  changeWhy: 'Why', // 296
  changeStays: 'Stays the same', // 297
  changeWhenTouch: 'When you touch, the new mandate starts and the old one ends.', // 298
  changeButton: 'Change with Touch ID', // 299
  changeCancel: 'Cancel', // 213
  changeFromAi: 'The AI wrote these words.', // DRAFT: amber marker of the why (open Q5 of the mockup)
  extendTitle: (profile: string): string => `Extend the mandate for ${profile}`, // 300
  extendNothingElse: 'Nothing else changes.', // 301
  extendButton: 'Extend with Touch ID', // 302
  changeDone: (profile: string): string => `Done. The mandate for ${profile} now says what you read. The old one ended.`, // 303
  changeChangedSince: 'The mandate or its area changed after this was proposed. Nothing was signed. Ask for the change again.', // 304
  changeNoChange: 'This changes nothing. Nothing to sign.', // 305
  changeNotYours: 'Only the person who gave this mandate can change it.', // 306
  changeNotActive: 'This mandate has ended already, so there is nothing to change.', // 307
  changeCancelled: 'Cancelled. Nothing changed.', // 308
  changeVersionMove: (from: string, to: string): string => `This also moves the area from version ${from} to ${to}.`, // 297
  // Step 13 rule: the difference list also covers approvers, team limits and the approval count (open Q15 of the mockup).
  // DRAFT, no sentence in the mockup:
  changeApprovals: 'Approvals',
  /** DRAFT: label of the commitment-mode line ("Your AI asks you before every action" -> "acts alone"). */
  changeMode: 'How your AI acts',
  changeApprovers: 'Who must approve',
  changeApprovalCount: 'How many must approve',
  changeTeamLimit: (label: string): string => `Team limit: ${label}`,
  tagMore: 'More', tagLess: 'Less', tagChanged: 'Changed', tagNew: 'New', tagRemoved: 'Removed', // 293, 294

  // Screen 2: identity codes at the join (option B; the AS and hap-core part is not built, see interface.ts)
  joinAdminTitle: (member: string, team: string): string => `Confirm ${member} to join ${team}`, // 310
  joinAdminIntro: (member: string): string => `${member} asked to join your team. Compare codes with her first. You do this once.`, // 311
  joinYourCode: 'Your code', // 312
  joinTheirCode: (name: string): string => `${name}'s code`, // 313
  joinCompareHint: 'Both codes are on both screens. Check that they are the same on both. Ask her in person, or by a way you trust.', // 314
  joinMatch: (member: string): string => `The codes match. Confirm ${member}`, // 315
  joinDiffer: 'The codes are different', // 316
  joinAdminDone: (member: string): string => `${member} has joined. Your colleagues now trust her because you confirmed her.`, // 317
  joinDifferResult: (member: string): string => `${member} is not added. Nothing changed. Do not go on until you know why the codes differ: suveren.ai may have shown one of you the wrong code.`, // 318
  joinMemberTitle: (admin: string): string => `Compare codes with ${admin}`, // 320
  joinMemberIntro: (team: string, admin: string): string => `You asked to join ${team}. ${admin} confirms it. Compare codes with her first. You do this once.`, // 321
  joinMemberHint: 'Both codes are on both screens. Check that they are the same on both.', // 324
  joinMemberMatch: 'The codes match', // 325
  joinMemberDiffer: 'The codes are different', // 326
  joinWaiting: (admin: string): string => `Waiting for ${admin} to confirm.`, // 327
  joinMemberDone: (team: string, admin: string): string => `You have joined ${team}. You trust the colleagues ${admin} confirmed.`, // 328
  joinMemberDifferResult: 'Nothing changed. Do not go on until you know why the codes differ. Tell whoever runs your team.', // 329
  colleaguesTitle: 'Colleagues', // 331
  confirmedBy: (name: string): string => `confirmed by ${name}`, // 330
  confirmedByYou: 'confirmed by you', // 333
  colleaguesWhy: (admin: string): string => `You trust them because ${admin}, your admin, compared codes with each of them. You do not compare codes yourself.`, // 332
  /** DRAFT: the interface behind the join is not built, so the page says so instead of showing codes it does not have. */
  joinUnavailable: 'Comparing codes is not available on this gateway yet.',
} as const;

/** Sentences that need "her"/"she" in the signed-off mockup keep it; the gateway knows no gender, so a later pass may reword them. */

/** Group a code of digits in fours for the eye: "73142208556109423375" -> "7314 2208 5561 0942 3375". */
export function groupCode(digits: string): string {
  return digits.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
}
