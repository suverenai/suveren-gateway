/** Step 13 mandate screens, shared by the gateway page and the phone app. Texts: ./texts. Data shapes: ./interface. */
export { S13, groupCode } from './texts';
export * from './interface';
export { teamDiff, tagWord, type TeamRow, type TeamTag } from './team-diff';
export { HeldBackCard, HeldBackList, heldCardText } from './HeldBackCard';
export { EndMandate, endErrorText, type EndState, type EndFacts } from './EndMandate';
export { ChangeMandate, isExtendOnly, changeErrorText, type ChangeMandateProps, type ChangeState, type ChangeError } from './ChangeMandate';
export { JoinCompare, ColleagueList, type JoinState, type JoinFacts } from './JoinCompare';
export * from './give-view';
export { GiveApprovers, giveBlocked } from './GiveApprovers';
