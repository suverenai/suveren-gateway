/**
 * Sending a decision from the approval card (UI spec §17.5): the two routes a
 * pending proposal can be decided through. Both resolve ONLY after the gateway
 * answered and reject with its error — the card shows its ✓ stamp from the
 * resolved value and nothing earlier (UI reflects backend truth).
 */
import { spClient, type Proposal } from './sp-client';
import { resolveDomainFor } from './my-queue';
import { rejectOutcomeArgs } from './reject-outcome';
import { contentHashForDecision, noteRecipients } from './use-proposal-content';
import { ticketIdOf, type DecisionKind, type DecisionResult } from './approval-flow';

interface Args {
  kind: DecisionKind;
  note?: string;
  shownHash?: string;
}

/** Review-mode ("Send with Review"): the proposal waits in a workspace queue. */
export async function decideInQueue(
  proposal: Proposal,
  { kind, note, shownHash }: Args,
  ctx: { activeDomain: string | null | undefined; userId: string },
): Promise<DecisionResult> {
  // Resolve under the proposal's own queue — a personal one stays 'owner' in team context.
  const domain = resolveDomainFor(proposal, ctx.activeDomain);
  // PE1 — the fingerprint of what THIS device decrypted and showed.
  const contentHash = await contentHashForDecision(proposal);
  if (kind === 'approve') {
    const res = await spClient.resolveProposal(proposal.id, 'commit', domain, { contentHash, shownHash });
    return { ticketId: ticketIdOf(res.receipt) };
  }
  if (kind === 'reject') {
    await spClient.resolveProposal(proposal.id, 'reject', domain, { ...rejectOutcomeArgs(), contentHash, shownHash });
    return {};
  }
  // G5 — the note is sealed on THIS (deciding) gateway for exactly who can
  // already read the proposal, plus this device's own signed-in user.
  const { noteEncrypted } = await spClient.encryptProposalNote(note ?? '', noteRecipients(proposal, ctx.userId));
  await spClient.resolveProposal(proposal.id, 'reject', domain, { outcome: 'change_needed', noteEncrypted, contentHash, shownHash });
  return {};
}

/** TR5 — the AS's own refusal text already explains both cases; this only
 *  replaces the trailing "(CODE)" asErrorMessage adds with plain words. */
export function friendlyApprovalError(err: unknown): string {
  const msg = err instanceof Error ? err.message : 'Approval failed';
  if (msg.includes('APPROVER_IS_PROPOSER')) return "You can't approve your own action. Ask another approver.";
  if (msg.includes('APPROVAL_IMPOSSIBLE')) {
    return 'This action cannot be approved — there is no one else eligible to approve it. Ask a team admin to add another approver.';
  }
  return msg;
}

/** Above-cap: the person is one of the proposal's required approvers. */
export async function decideAsApprover(
  proposal: Proposal,
  { kind, note, shownHash }: Args,
  ctx: { userId: string },
): Promise<DecisionResult> {
  try {
    const contentHash = await contentHashForDecision(proposal);
    if (kind === 'approve') {
      const result = await spClient.approveProposal(proposal.id, contentHash, shownHash);
      // Intent as an accountability record (best-effort; the approval is already recorded).
      try {
        const intentData = await spClient.getAttestationIntent(proposal.authorizationId);
        if (intentData) {
          const decrypted = await spClient.decryptIntent({
            intentCiphertext: intentData.intentCiphertext,
            encryptedKey: intentData.encryptedKey,
            approverId: ctx.userId,
          });
          await spClient.storeApprovedIntent(proposal.authorizationId, decrypted);
        }
      } catch { /* non-fatal */ }
      // AS truth from THIS call's own response — never a client-side guess.
      const { requiredApprovals, approvedCount } = result;
      const stillNeeded = requiredApprovals !== undefined && approvedCount !== undefined ? requiredApprovals - approvedCount : undefined;
      return {
        ticketId: ticketIdOf(result.receipt),
        ...(stillNeeded !== undefined && stillNeeded > 0
          ? { detail: `${stillNeeded} more approval${stillNeeded === 1 ? '' : 's'} still needed` }
          : {}),
      };
    }
    if (kind === 'reject') {
      await spClient.rejectProposal(proposal.id, rejectOutcomeArgs(), contentHash, shownHash);
      return {};
    }
    const { noteEncrypted } = await spClient.encryptProposalNote(note ?? '', noteRecipients(proposal, ctx.userId));
    await spClient.rejectProposal(proposal.id, { outcome: 'change_needed', noteEncrypted }, contentHash, shownHash);
    return {};
  } catch (err) {
    throw new Error(friendlyApprovalError(err));
  }
}
