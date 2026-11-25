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
  /** DRAFT: after the touch, while the give runs (never a silent wait). */
  giveWorkingSigning: 'Signing…',
  giveWorkingSending: 'Sending to suveren.ai…',
  giveWorkingDelivering: 'Getting it ready on this computer…',
  /** DRAFT: the gateway's result stamp after a give with Touch ID. */
  giveSigned: 'Signed',
  giveRecorded: 'Recorded',
  giveResultClose: 'Close',
  giveCardButton: 'Give this mandate', // DRAFT: the AI-proposal card's "Sign mandate" only until the gateway knows how this computer gives it
  /** The card's give button where this computer gives with Touch ID is `giveButton`; where it gives on the phone, this (maintainer 2026-11-22). */
  giveCardPhoneButton: 'Give this mandate on your phone',
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
  giveUnconfirmedReason: (name: string, admin: string): string => `${name} is not confirmed by your admin yet. They cannot approve until ${admin} confirms them.`, // 214
  giveUnconfirmedStep: (admin: string): string => `Ask ${admin} to confirm them.`, // 215
  /** DRAFT: shown until the check can read confirmations before the touch (DEC-73 member list). */
  giveApproversChecked: 'Checking with the team settings…', // DRAFT: shown only until the gateway has answered
  giveDone: (area: string, end: string): string => `Done. The mandate for ${area} is active until ${end}.`, // 217
  giveErrCap: 'A limit is higher than your team allows. Nothing changed. Lower it and try again.', // 218
  giveErrApprovers: 'suveren.ai did not say who may approve for this team. Nothing changed. Try again.', // 219
  giveErrNoChain: 'An approver has not finished setting up Suveren yet. Nothing changed. Ask them to finish it.', // 220
  giveErrNoChainNamed: (names: string[]): string => `${names.length === 1 ? `${names[0]} has` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} have`} not finished setting up Suveren yet. Nothing changed. Ask them to finish it.`, // DRAFT (names the approvers)
  giveErrCancelled: 'Cancelled. Nothing changed.', // 221
  giveErrTouch: 'Touch ID did not work this time. Nothing changed. Try again.', // 222
  giveErrChanged: 'What would be granted changed since you looked. Look at it again.', // DRAFT
  giveErrNotAccepted: 'suveren.ai did not accept the mandate. Try again.', // 223
  giveErrNotDelivered: 'The mandate could not reach the gateway, so it was ended again. Give it again.', // 224
  giveAnyDevice: 'You can do this on any of your devices. The mandate then holds for all of them.', // 225
  // "Give on your phone" on a computer without Touch ID (DEC-90, mockup phone-d3-live.html v7, Gateway view). All DRAFT.
  givePhoneOffer: 'This computer has no Touch ID. Give this mandate on your phone: it shows you the same, and you give it there with your touch.', // DRAFT
  givePhoneButton: 'Give this mandate on your phone', // maintainer 2026-11-22 (was "Give on your phone")
  givePhoneWaiting: 'Waiting for your phone… Open Suveren on your phone and give it there.', // DRAFT
  givePhoneWaitingNote: 'Nothing is given until you touch on your phone. You can close this page; the request waits 30 minutes.', // DRAFT
  givePhoneStop: 'Stop waiting', // DRAFT
  givePhoneGiven: 'Signed', // DRAFT: the gateway's result stamp
  givePhoneGivenOn: 'Given on your phone', // DRAFT
  givePhoneStopped: 'Stopped. Nothing was given. The request on your phone runs out by itself.', // DRAFT
  givePhoneAgain: 'Give on your phone again', // DRAFT
  givePhoneMismatch: 'The answer from your phone does not match what is shown here. Nothing was given.', // DRAFT
  givePhoneClose: 'Close', // DRAFT
  givePhoneCancel: 'Cancel', // DRAFT

  // Screen 3: a mandate this gateway holds back
  heldTitle: 'On hold: Your AI cannot use these yet', // 250
  heldName: (profile: string, owner: string): string => `${profile}, from ${owner}`, // 251
  heldOwnerYou: 'you', // 251
  heldNotReceived: 'This device has not received this mandate yet. Your AI cannot use it until it does.', // 252
  heldCheckAgain: 'Check again', // 253
  heldNoCheck: (owner: string): string => `${owner} did not confirm this mandate with Touch ID. Your AI cannot use it.`, // 254
  heldNoCheckStep: 'Ask them to give it again on one of their devices.', // 255
  heldNotOnList: (owner: string): string => `${owner} is not on the list your admin confirmed. Your AI cannot use their mandate.`, // 256
  heldNotOnListStep: (admin: string): string => `Ask ${admin}, your admin, to confirm them.`, // 257
  heldChanged: (owner: string): string => `This mandate does not match what ${owner} confirmed. It may have been changed since. Your AI cannot use it.`, // 258
  heldChangedStep: 'Ask them to give it again.', // 259
  heldOnHold: 'This mandate is on hold. Your AI cannot use it until it is given again.', // maintainer 2026-11-24 (B): any reason that is not a known, specific one
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
  /** DRAFT (UI review, DEC-88): the destructive button names what ends. Replaces endButton on the screen. */
  endButtonNamed: (profile: string): string => `End the mandate for ${profile}`,
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

  // Screen 2: identity codes at the join (option B, DEC-73 design 20.21.5: each side shows its own code and TYPES the other's).
  // Numbers are the mockup's (step13.html rev 2). Every code is named with its noun (terms.md row 32), so "Your code" became
  // "Your identity code" (DRAFT noun). Where the typed variant needs a sentence the mockup has none for, the line says DRAFT.
  joinAdminTitle: (member: string, team: string): string => `Confirm ${member} to join ${team}`, // 310
  joinAdminIntro: (member: string): string => `${member} asked to join your team. Compare identity codes with them first. You do this once.`, // 311 (+ "identity")
  /** DRAFT: the name from the sign-up is not checked by anyone (design 20.21.5 step 1). */
  joinNameNotChecked: (member: string): string => `The name ${member} comes from the sign-up and is not checked.`,
  joinYourCode: 'Your identity code', // 312 (+ noun)
  joinTheirCode: (name: string): string => `${name}'s identity code`, // 313 (+ noun)
  /** DRAFT: the typed variant of 314/234 (the mockup shows both codes; the design has each person type the other's). */
  joinAdminRead: (member: string): string => `Read your identity code to ${member}. Ask them in person, or by a way you trust. Do not take it from your AI.`,
  /** DRAFT: label of the field. */
  joinAdminType: (member: string): string => `Type ${member}'s identity code`,
  /** DRAFT: label of the check button (239 "Check the code", with the noun). */
  joinCheck: 'Check the identity code',
  joinChecking: 'Checking...', // DRAFT
  /** DRAFT: the design's wrong-code text (20.21.5 step 2). */
  joinWrongAdmin: (member: string): string => `This is not ${member}'s identity code. Do not continue.`,
  joinWrongMember: "This is not the admin's identity code. Do not continue.",
  /** DRAFT. */
  joinTriesLeft: (n: number): string => `${n} ${n === 1 ? 'try' : 'tries'} left.`,
  /** DRAFT: after three wrong codes, before 318 / 329. */
  joinTriesUsed: 'Three identity codes did not match.',
  /** DRAFT: after the right code, on the admin's side. */
  joinAdminMatched: (member: string): string => `The identity code is ${member}'s.`,
  /** DRAFT: design 20.21.5 step 4, the button is off. */
  joinAnchorWaiting: (member: string): string => `${member} has not compared your identity code yet.`,
  /** DRAFT: the member's anchor is there and verified. */
  joinAnchorThere: (member: string): string => `${member} compared your identity code.`,
  /** DRAFT: the member's anchor does not verify against their own device list. */
  joinAnchorInvalid: (member: string): string => `What ${member} signed does not match their devices. Do not add them. Ask them to try again.`,
  /** DRAFT: the admin's button (design: "Add Maria"); the touch follows. */
  joinAddButton: (member: string): string => `Add ${member} with Touch ID`,
  /** DRAFT: names what the system window will say, as step 13 screen 1 does (212). */
  joinAdminTouchNote: (member: string): string => `Your device asks for your touch. It says you add ${member} and shows the code.`,
  joinMemberTitle: (admin: string): string => `Compare identity codes with ${admin}`, // 320 (+ "identity")
  joinMemberIntro: (team: string, admin: string): string => `You asked to join ${team}. ${admin} confirms it. Compare identity codes with them first. You do this once.`, // 321 (+ "identity")
  /** DRAFT: design 20.21.5 step 1: "Read your code to <team> admin". */
  joinMemberRead: (team: string, admin: string): string => `Read your identity code to ${admin}, the admin of ${team}. Do it in person or by phone, never by email.`,
  /** DRAFT: label of the field. */
  joinMemberType: (admin: string): string => `Type ${admin}'s identity code`,
  /** DRAFT: the button after the right code; the touch follows. */
  joinMemberTrust: (admin: string): string => `Trust ${admin} with Touch ID`,
  /** DRAFT: names what the system window will say. */
  joinMemberTouchNote: 'Your device asks for your touch. It says you trust the admin of the team you asked to join.',
  joinMemberMatched: (admin: string): string => `The identity code is ${admin}'s.`, // DRAFT
  joinWaiting: (admin: string): string => `Waiting for ${admin} to confirm.`, // 327
  joinAdminDone: (member: string): string => `${member} has joined. Your members now trust them because you confirmed them.`, // 317
  joinDifferResult: (member: string): string => `${member} is not added. Nothing changed. Do not go on until you know why the codes differ: suveren.ai may have shown one of you the wrong code.`, // 318
  joinMemberDone: (team: string, admin: string): string => `You have joined ${team}. You trust the members ${admin} confirmed.`, // 328
  joinMemberDifferResult: 'Nothing changed. Do not go on until you know why the codes differ. Tell whoever runs your team.', // 329
  joinErrTouch: 'Touch ID did not work this time. Nothing changed. Try again.', // 222
  joinErrOffline: 'Cannot reach suveren.ai. Nothing changed. Check your internet connection and try again.', // 279
  /** DRAFT: the list moved while the admin looked (409 LIST_HEAD_MOVED). */
  joinErrMoved: "The team's list changed while you were adding. Nothing changed. Try again.",
  /** DRAFT: the gateway could not check the team's list. */
  joinErrTrust: "This gateway could not check the team's list. Nothing changed.",
  /** DRAFT: the person asking has no device keys (the request carries no identity). */
  joinErrNoChain: (member: string): string => `${member} has not finished setting up Suveren yet. Ask them to finish it.`,
  /** DRAFT: the check key of this device is missing or not named by the device list. */
  joinErrNoCheck: 'This device cannot ask for your touch. Nothing changed.',
  joinErrLocked: 'The gateway is locked. Unlock it and try again.', // DRAFT
  /** DRAFT: anything else. */
  joinErrOther: 'This did not work. Nothing changed. Try again.',
  /** DRAFT: the admin's list of requests on the Team page. */
  joinRequestsTitle: 'Requests to join', // DRAFT
  joinRequestsNone: 'No one is asking to join.', // DRAFT
  joinOpen: 'Compare identity codes', // DRAFT: the button on a request
  colleaguesTitle: 'Members', // 331
  confirmedBy: (name: string): string => `confirmed by ${name}`, // 330
  confirmedByYou: 'confirmed by you', // 333
  colleaguesWhy: (admin: string): string => `You trust them because ${admin}, your admin, compared codes with each of them. You do not compare codes yourself.`, // 332

  // Changes of the team's list after the join (DEC-73 step 5, design 20.21.5, 20.21.3, 20.21.8). ALL of these are DRAFT: the
  // mockup has no sentence for them; wording is the maintainer's. Never a gendered pronoun for a named person.
  /** DRAFT: title of the panel on the Team page. */
  changesTitle: 'Changes to your team',
  changesNone: 'Nothing to change.',
  changesChecking: 'Checking...',
  // someone left or was removed (admin)
  changesLeftIntro: (name: string): string => `${name} left the team. Your members still trust them until you sign a new list.`,
  changesRemovedIntro: (name: string): string => `${name} was removed from the team. Your members still trust them until you sign a new list.`,
  changesGoneIntro: (name: string): string => `${name} is no longer in the team. Your members still trust them until you sign a new list.`,
  changesRemoveButton: (name: string): string => `Remove ${name} with Touch ID`,
  changesRemoveDone: (name: string): string => `${name} is removed. Your members no longer trust them.`,
  // a new identity of a member (admin): a new join
  changesNewIdentityIntro: (name: string): string => `${name} took a new identity. Compare identity codes with them again, as when they joined. Until you do, they are not trusted.`,
  /** DRAFT: which identity is replaced by which (the ends of the two identities), so the admin sees WHAT is confirmed. */
  changesNewIdentityFromTo: (oldTail: string, newTail: string | null): string => (newTail ? `Old identity ${oldTail}, new identity ${newTail}.` : `Old identity ${oldTail}.`),
  changesNewIdentityNotYet: (name: string): string => `${name} has not set up the new identity yet.`,
  changesNewIdentityType: (name: string): string => `Type ${name}'s new identity code`,
  changesNewIdentityAnchorWaiting: (name: string): string => `${name} has not compared your identity code yet.`,
  changesNewIdentityButton: (name: string): string => `Confirm ${name}'s new identity with Touch ID`,
  changesNewIdentityDone: (name: string): string => `${name}'s new identity is confirmed. The old one no longer counts.`,
  // re-sign (admin)
  changesResignIntro: 'You removed the device that signed your team list. Your members need the list signed again by a device you still have.',
  changesResignButton: 'Sign the list again with Touch ID',
  changesResignDone: 'The list is signed again.',
  // hand-over, both sides
  changesHandoverTitle: 'Hand the team over',
  changesHandoverIntro: 'Choose who becomes the admin. You and they both confirm with Touch ID. Your members do not need to do anything.',
  changesHandoverChoose: 'New admin',
  changesHandoverStart: (name: string): string => `Ask ${name} to take over`,
  changesHandoverWaitingNew: 'Waiting for the new admin to confirm.',
  changesHandoverSignedOld: (name: string): string => `${name} confirmed. Confirm too, and ${name} becomes the admin.`,
  changesHandoverSignOld: 'Hand over with Touch ID',
  changesHandoverIncoming: 'Your admin wants to hand the team over to you. You become the admin of the team.',
  changesHandoverBuild: 'Take over with Touch ID',
  changesHandoverWaitingOld: 'Waiting for the old admin to confirm.',
  changesHandoverWithdraw: 'Cancel the hand-over',
  changesHandoverDone: 'The team has a new admin.',
  // the admin changed (member): compare again
  changesAdminChanged: 'Your team has a new admin. Compare identity codes with them so you trust them.',
  // the admin took a new identity (member)
  /** DRAFT: the admin took a new identity; a take-over is deferred (DEC-82), so the member is only told what must happen. */
  changesAdminGone: 'Your admin took a new identity and cannot sign for the team any more. The admin must set up the team again. Until then your team list does not change.',
  // refusals
  changesErrTrust: "This gateway could not check the team's list. Nothing changed.",
  changesErrNoReplacement: 'There is nothing to confirm for this person any more. Nothing changed.',
  changesErrNotCompared: 'Compare identity codes first. Nothing changed.',
  changesErrAnchor: 'This person has not compared your identity code yet. Nothing changed.',
  changesErrMismatch: 'What the new admin signed is not what you expected. Nothing was signed.',
} as const;

/** Never a gendered pronoun for a named person: "them", "their". */

/** Group a code of digits in fours for the eye: "73142208556109423375" -> "7314 2208 5561 0942 3375". */
export function groupCode(digits: string): string {
  return digits.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
}
