/**
 * The words of the commitment choice — ONE place, used by the manual mandate
 * screen (AgentReviewPage "Commitment") and the mandate proposal card, so the
 * two cannot drift.
 */
export const COMMITMENT_LABEL = 'Commitment';
export const COMMITMENT_REVIEW = { title: 'Review Each Action', text: 'You review and approve each action before it executes.' } as const;
export const COMMITMENT_AUTOMATIC = { title: 'Automatic', text: 'Agent acts freely within your limits.' } as const;
/** The mandate mode `review_above_cap`: acts alone up to the limit, the person decides above it. Never labelled "above cap". */
export const COMMITMENT_REVIEW_ABOVE_LIMIT = { title: 'Review above the limit', text: 'The agent acts freely up to the limit; above it you approve each action.' } as const;
