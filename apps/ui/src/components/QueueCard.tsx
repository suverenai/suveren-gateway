/**
 * The approval card for one entry of the "For me" queue — the real card,
 * unchanged. Shared by the Approvals page and the approval panel so the two
 * show exactly the same thing: what is bound plus the gateway's own local
 * data, never text the AI wrote for the approver.
 */
import { ReviewApprovalCard } from './ActionCard';
import { ApproverProposalCard } from './ApproverProposalCard';
import { useApprovalQueue } from '../contexts/ApprovalQueueContext';
import type { QueueEntry } from '../lib/approval-queue';
import type { Proposal } from '../lib/sp-client';
import type { DecisionKind, DecisionResult } from '@suveren/approval-card/lib/approval-flow';
import type { ApprovalOutcome } from '@suveren/approval-card/lib/approval-outcome';
import { useEffect, useRef, useState } from 'react';
import { GivePhoneFooter, S13 } from '@suveren/approval-card/mandate-screens';
import { spClient, MandateSignError } from '../lib/sp-client';
import { mayGoToPhone, afterLookup, afterGivePoll, LOOKUP_EVERY_MS, type ApprovedPhoneGive } from '../lib/approved-phone-give';
import { GIVE_PHONE_POLL_MS } from '../lib/give-on-phone-flow';
import { RESULT_SHOW_MS } from '../lib/approval-panel';

interface Props {
  entry: QueueEntry;
  onDecided: (proposalId: string, kind: DecisionKind, result: DecisionResult) => void;
  nextLabelText?: string | null;
  onBusyChange?: (busy: boolean) => void;
  /** What became of an approval on this card. */
  onOutcome?: (proposalId: string, outcome: ApprovalOutcome) => void;
  dismissLabel?: string;
  onDismissResult?: () => void;
  /** What opens after this one (named on the result). */
  nextProposal?: Proposal | null;
}

export function QueueCard({ entry, onDecided, nextLabelText, onBusyChange, onOutcome, dismissLabel, onDismissResult, nextProposal }: Props) {
  const { manifests, toolDisplay, titles, userId } = useApprovalQueue();
  const { proposal } = entry;
  // The tool is namespaced `<integrationId>__<tool>`, the only link back to the connector that produced it.
  const proposalLinks = manifests.find((m) => m.id === proposal.tool.split('__')[0])?.proposalLinks;
  const mandateTitle = proposal.authorizationId ? titles[proposal.authorizationId] : undefined;
  // DEC-90: an approved mandate on a computer without Touch ID goes to the phone; the card then waits for it like the give page.
  const [phone, setPhone] = useState<ApprovedPhoneGive>({ s: 'idle' });
  const dismissRef = useRef(onDismissResult);
  dismissRef.current = onDismissResult;
  const outcomeFromCard = onOutcome ? (o: ApprovalOutcome) => {
    if (o === 'done' && mayGoToPhone(proposal.tool) && phone.s === 'idle') { setPhone({ s: 'looking', tries: 0 }); return; }
    onOutcome(proposal.id, o);
  } : undefined;
  useEffect(() => {
    if (phone.s !== 'looking') return undefined;
    const t = window.setTimeout(() => {
      void spClient.findApprovedGiveOnPhone(proposal.id).then((found) => setPhone((cur) => afterLookup(cur, found)), () => setPhone((cur) => afterLookup(cur, null)));
    }, LOOKUP_EVERY_MS);
    return () => window.clearTimeout(t);
  }, [phone, proposal.id]);
  useEffect(() => {
    if (!onOutcome) return undefined;
    if (phone.s === 'none') onOutcome(proposal.id, 'done');
    // Waiting, stopped or refused: the panel keeps this card on screen until Close (the same rule as an outcome it does not know yet).
    if (phone.s === 'waiting') onOutcome(proposal.id, 'unknown');
    if (phone.s === 'given') {
      const t = window.setTimeout(() => dismissRef.current?.(), RESULT_SHOW_MS);
      return () => window.clearTimeout(t);
    }
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone.s]);
  useEffect(() => {
    if (phone.s !== 'waiting') return undefined;
    const id = phone.mandateId;
    const t = window.setInterval(() => {
      void spClient.pollGiveOnPhone(id).then(
        (a) => setPhone((cur) => afterGivePoll(cur, a)),
        (err) => setPhone((cur) => (cur.s === 'waiting' ? { s: 'refused', message: err instanceof MandateSignError ? err.message : String(err) } : cur)),
      );
    }, GIVE_PHONE_POLL_MS);
    return () => window.clearInterval(t);
  }, [phone]);
  const phoneFooter = phone.s === 'waiting' || phone.s === 'given' || phone.s === 'stopped' || phone.s === 'refused' ? (
    <div data-testid="approved-give-phone">
      {phone.s === 'waiting' && <p className="form-hint" style={{ margin: 'var(--space-2) var(--space-5) 0' }}>{S13.givePhoneApproved}</p>}
      <GivePhoneFooter
        view={phone.s === 'refused' ? { s: 'refused', message: phone.message } : { s: phone.s }}
        onGive={() => {}}
        onStop={() => { if (phone.s === 'waiting') { const id = phone.mandateId; void spClient.cancelGiveOnPhone(id); setPhone({ s: 'stopped' }); } }}
        onClose={() => dismissRef.current?.()}
        disabled
      />
    </div>
  ) : null;
  const card = entry.route === 'queue' ? (
    <ReviewApprovalCard
      key={entry.id}
      proposal={proposal}
      manifests={manifests}
      toolDisplay={toolDisplay[proposal.tool]}
      proposalLinks={proposalLinks}
      currentUserId={userId}
      mandateTitle={mandateTitle}
      onDecided={onDecided}
      nextLabelText={nextLabelText}
      onBusyChange={onBusyChange}
      onOutcome={outcomeFromCard}
      dismissLabel={dismissLabel}
      onDismissResult={onDismissResult}
      nextProposal={nextProposal}
    />
  ) : (
    <ApproverProposalCard
      key={entry.id}
      proposal={proposal}
      currentUserId={userId}
      manifests={manifests}
      toolDisplay={toolDisplay[proposal.tool]}
      proposalLinks={proposalLinks}
      mandateTitle={mandateTitle}
      onDecided={onDecided}
      nextLabelText={nextLabelText}
      onBusyChange={onBusyChange}
      onOutcome={outcomeFromCard}
      dismissLabel={dismissLabel}
      onDismissResult={onDismissResult}
      nextProposal={nextProposal}
    />
  );
  return phoneFooter ? <>{card}{phoneFooter}</> : card;
}
