/**
 * What the phone's mandate card shows and offers beyond the one shared card (components/MandateProposalCard.tsx in the approval-card
 * package). Each point is a named switch, so the next decision is one line, never a hunt through the screen. The decisions were
 * the maintainer's, 2026-11-26; the card itself is not decided here.
 */
export const PHONE_CARD = {
  /** Request and History inside the card, from the data the computer sealed into the give. */
  showsRequestAndHistory: true,
  /** When the computer sent no Request or History (an older computer, or the read failed): the one line instead. Approved text. */
  nothingSentText: 'Your computer did not send this. You can see it there.',
  /** "Reject" under the give button for a mandate an AI proposed; the same decision the gateway's Reject makes, signed by this phone. */
  offersReject: true,
  /**
   * "Ask for changes". OFF: the note must be sealed for the AI's side (the proposal's submitter and the mandate owner) with their
   * end-to-end public keys, and the phone is neither given those keys nor allowed to look them up. See the report of 2026-11-26.
   */
  offersAskForChanges: false,
} as const;
