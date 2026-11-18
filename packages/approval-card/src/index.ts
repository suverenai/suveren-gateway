/**
 * @suveren/approval-card — the public API.
 *
 * The card, the code that opens sealed proposal content in the browser, and the
 * host seam that lets a page other than the gateway's render them. Everything
 * else in src/ is internal to the card; the gateway page still imports a few of
 * those modules by path (`@suveren/approval-card/lib/<name>`), because the same
 * helpers also serve its other screens.
 */
export { ApprovalCard, type DecideArgs } from './components/ApprovalCard';
export { ApprovalBody } from './components/ApprovalBody';

export {
  configureApprovalHost,
  approvalHost,
  type ApprovalHost,
  type ApprovalHostData,
  type ApprovalHostSession,
  type MandateScreenHandoff,
  type SealedWire,
} from './host';

export {
  decryptProposalArgs,
  contentHashForDecision,
  useProposalContent,
  useDecryptedNote,
  missingRecipients,
  noteRecipients,
  decisionButtonsVisible,
  type ProposalContentState,
  type ProposalForContent,
  type SealedDecryptor,
} from './lib/use-proposal-content';
export { computeContentHashBrowser, type ContentBindingKind } from './lib/content-hash';

export type { DecisionKind, DecisionResult } from './lib/approval-flow';
export type { ApprovalOutcome } from './lib/approval-outcome';
export type * from './types';
