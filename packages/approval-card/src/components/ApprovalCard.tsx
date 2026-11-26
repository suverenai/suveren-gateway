/**
 * ApprovalCard — the one approval card (UI spec §17, "Approval card v3").
 * Review-mode and above-cap proposals both render through it; what differs
 * (how a decision is sent, the over-limit block, who may approve) comes in as
 * props, so the two can never drift again.
 *
 * Layout: the middle (ApprovalBody) scrolls, the buttons stay fixed at the
 * bottom. No sentence above the buttons, no confirm step. The warning that
 * only a person approves is the Approve button's accessible description.
 *
 * After a click the buttons disappear at once and the card says "Approving…".
 * Only when the gateway has ANSWERED the stamp is drawn — "Approved" and the
 * ticket line, plain text, never shaped like a button. If the call fails the
 * buttons come back with the error and nothing shows a ✓ (backend truth).
 */
import { LoadGate, Gated, SkelArea, SkelBlock, SkelLine, useNetworkSettled } from './LoadGate';
import { S13 } from '../mandate-screens/texts';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProposalLink } from '../lib/proposal-links';
import type { IntegrationManifest, Proposal, ShownSnapshotPayload } from '../types';
import { approvalHost, hostData } from '../host';
import type { ToolDisplay } from '../lib/approval-view';
import { ApprovalBody } from './ApprovalBody';
import { CommitmentBand } from './MandateProposalCard';
import { ChangeNoteFooter, WorkingStamp, DecisionStamp } from './DecisionParts';
import { validateChangeNote, CHANGE_NOTE_MAX } from '../lib/reject-outcome';
import { decisionButtonsVisible } from '../lib/use-proposal-content';
import { isAutomatedBrowser, AUTOMATION_REFUSAL } from '../lib/automation';
import { GiveProblemTop, RefusedTop, ResultFoot, StampNext, UnknownTop } from './ApprovalResult';
import { ApprovalSummary } from './ApprovalSummary';
import {
  OUTCOME_POLL_MS, OUTCOME_WAIT_MS, OUTCOME_WAITING_LINE, OUTCOME_UNKNOWN_LINE, MANDATE_ENDED_DETAIL,
  decisionAwaitsOutcome, decisionErrorWords, mandateEndedHead, outcomeOfProposal, type ApprovalOutcome,
} from '../lib/approval-outcome';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { approveRoute, workingWord, stampWord, stampLine, type DecisionKind, type DecisionResult } from '../lib/approval-flow';

const CREATE_MANDATE_TOOL = 'setup__create_mandate';
const CHANGE_MANDATE_TOOL = 'setup__change_mandate';


export interface DecideArgs {
  kind: DecisionKind;
  /** The trimmed "what should change" text, for kind 'change'. */
  note?: string;
  /** AU10 §8.4 — the hash of exactly what this card showed. */
  shownHash?: string;
}

interface Props {
  proposal: Proposal;
  currentUserId: string;
  manifests?: IntegrationManifest[];
  toolDisplay?: ToolDisplay;
  proposalLinks?: ProposalLink[];
  mandateTitle?: string;
  nameOf?: (userId: string) => string;
  /** Over-limit block, approver progress, "you can't approve your own action". */
  topExtras?: ReactNode;
  /** False: no Approve button (the proposer of an above-cap action). */
  canApprove?: boolean;
  /**
   * False: no "Ask for changes" button. A host that cannot seal the note for the people who must read it (the phone app: it has
   * no key of anyone else's) leaves it out rather than send it in the clear. Default true: every existing host is unchanged.
   */
  canAskChanges?: boolean;
  /** True: this person already approved — no buttons, just the note in topExtras. */
  alreadyDecided?: boolean;
  /**
   * Sends the decision to the gateway. Resolves with what the gateway answered
   * and rejects with its error — it must never resolve before the call went through.
   */
  decide: (args: DecideArgs) => Promise<DecisionResult>;
  /** Called once the gateway has answered (the stamp is on screen). */
  onDecided?: (kind: DecisionKind, result: DecisionResult) => void;
  /** "Next · 2 of 3" — a small label on a card that has just slid in. */
  nextLabelText?: string | null;
  /** A decision is out or answered: the page hides its position arrows meanwhile. */
  onBusyChange?: (busy: boolean) => void;
  /** What became of an approval: the panel keeps this card on screen until it is known. */
  onOutcome?: (outcome: ApprovalOutcome) => void;
  /** The action under a result that stays on screen ("Next" / "Close"); with `onDismissResult` it is offered. */
  dismissLabel?: string;
  onDismissResult?: () => void;
  /** What opens after this one: named on the result while it waits to open ("Next: …", UI review DEC-88). */
  nextProposal?: Proposal | null;
  className?: string;
}

type Phase =
  | { t: 'idle' }
  | { t: 'change' }
  | { t: 'working'; kind: DecisionKind }
  | { t: 'done'; kind: DecisionKind; result: DecisionResult };

/** The card's give button says how the mandate is given on this computer (maintainer 2026-11-22): with Touch ID, or on the phone. */
export function giveButtonText(via: 'touch' | 'phone' | null | undefined): string {
  return via === 'touch' ? S13.giveButton : via === 'phone' ? S13.giveCardPhoneButton : S13.giveCardButton;
}

export function ApprovalCard({
  proposal, currentUserId, manifests, toolDisplay, proposalLinks, mandateTitle, nameOf, topExtras,
  canApprove = true, canAskChanges = true, alreadyDecided = false, decide, onDecided, nextLabelText, onBusyChange, onOutcome, dismissLabel, onDismissResult, nextProposal, className,
}: Props) {
  const isChange = proposal.tool === CHANGE_MANDATE_TOOL;
  const isMandate = proposal.tool === CREATE_MANDATE_TOOL || isChange;
  const [phase, setPhase] = useState<Phase>({ t: 'idle' });
  // A device-key gateway: "Give this mandate" runs the one give driver IN PLACE, from exactly what the body opened and shows.
  const [mandateArgs, setMandateArgs] = useState<Record<string, unknown> | null>(null);
  const onMandateArgs = useCallback((a: Record<string, unknown> | null) => setMandateArgs(a), []);
  // Given: the host keeps this card on screen with the result stamp (as after any decision) until the person presses Close —
  // told BEFORE the proposal is closed, or the queue would drop the card before "Signed" is seen.
  const onGiven = useCallback(() => { onDecided?.('approve', {}); onOutcome?.('unknown'); }, [onDecided, onOutcome]);
  const hostGive = (approvalHost().useMandateGive ?? noMandateGive)(proposal, mandateArgs, { onClose: () => onDismissResult?.(), onGiven });
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  // Whether THIS device can decrypt the content — nothing can be approved that
  // this device cannot show (PE1 mockup §4).
  const [contentLoading, setContentLoading] = useState(false);
  const [contentReadable, setContentReadable] = useState(true);
  // AU10 §8.4 — the payload the card is showing right now, read synchronously
  // at decision time (a ref, not state).
  const shownSnapshotRef = useRef<ShownSnapshotPayload | null>(null);

  const saveShownHash = async (): Promise<string | undefined> => {
    const snapshot = shownSnapshotRef.current;
    if (!snapshot) return undefined;
    try {
      const { shownHash } = await hostData().saveShownSnapshot(proposal.id, snapshot);
      return shownHash;
    } catch {
      return undefined; // never blocks the decision (doc §8.4)
    }
  };

  const run = async (kind: DecisionKind, changeNote?: string) => {
    if (phase.t === 'working' || phase.t === 'done') return;
    // Automation that announces itself may not approve (defense in depth — lib/automation.ts).
    if (kind === 'approve' && isAutomatedBrowser()) { setError(AUTOMATION_REFUSAL); return; }
    setError('');
    setPhase({ t: 'working', kind });
    try {
      const shownHash = await saveShownHash();
      const result = await decide({ kind, note: changeNote, shownHash });
      // The gateway has answered — only now does the stamp appear.
      setPhase({ t: 'done', kind, result });
      onDecided?.(kind, result);
    } catch (err) {
      // The server may have closed the proposal in this same call (a dead mandate): show that result, not the error.
      const fresh = kind === 'approve' ? await hostData().getProposal(proposal.id).catch(() => null) : null;
      if (fresh && outcomeOfProposal(fresh) === 'refused') {
        setRefusedAfter(fresh);
        setPhase({ t: 'done', kind, result: {} });
        onDecided?.(kind, {});
        return;
      }
      if (fresh?.status === 'pending' && fresh.mandateEnded) setMandateEnded(fresh.mandateEnded);
      setError(decisionErrorWords(err instanceof Error ? err.message : 'Failed'));
      setPhase(kind === 'change' ? { t: 'change' } : { t: 'idle' });
    }
  };

  const sendChange = () => {
    const v = validateChangeNote(note);
    if (!v.valid) { setError(v.error); return; }
    void run('change', v.trimmed);
  };

  // Folded rows are an accordion: opening one closes any other open one on this card.
  const bodyRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onToggle = (e: Event) => {
      const d = e.target as HTMLDetailsElement;
      if (!d.open || !d.classList?.contains('av3-fold')) return;
      el.querySelectorAll<HTMLDetailsElement>('details.av3-fold[open]').forEach((o) => { if (o !== d) o.open = false; });
    };
    el.addEventListener('toggle', onToggle, true);
    return () => el.removeEventListener('toggle', onToggle, true);
  }, []);

  // A mandate can end while this card is open. Read it again on a slow poll and at once when this
  // gateway revokes one; only what the server says is shown (`mandateEnded` on a waiting proposal).
  const [mandateEnded, setMandateEnded] = useState<Proposal['mandateEnded']>(proposal.mandateEnded);
  useEffect(() => { if (proposal.mandateEnded) setMandateEnded(proposal.mandateEnded); }, [proposal.mandateEnded]);
  const watchMandate = phase.t === 'idle' || phase.t === 'change';
  const checkMandate = () => {
    if (!watchMandate) return;
    hostData().getProposal(proposal.id)
      .then((p) => { if (p.status === 'pending') setMandateEnded(p.mandateEnded); })
      .catch(() => { /* keep what the server last said */ });
  };
  approvalHost().useServerEvent('attestation-changed', checkMandate);
  useVisiblePolling(checkMandate, 5_000, `${watchMandate}:${proposal.id}`);
  useEffect(() => { if (mandateEnded && phase.t === 'change') setPhase({ t: 'idle' }); }, [mandateEnded, phase.t]);

  // After an approval the Authority Server may still refuse the ticket (a shared
  // limit filled up in the meantime). The card stays until the outcome is known:
  // read the proposal again when the gateway reports something and on a short
  // poll, and if no answer comes in reasonable time, say so instead of a false
  // success. Only what the server says is shown.
  const [refusedAfter, setRefusedAfter] = useState<Proposal | null>(null);
  const [settled, setSettled] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const awaits = phase.t === 'done' && decisionAwaitsOutcome(phase.kind, phase.result);
  const outcome: ApprovalOutcome = phase.t !== 'done' ? 'none'
    : refusedAfter ? 'refused'
    : !awaits || settled ? 'done'
    : timedOut ? 'unknown'
    : 'waiting';
  const watching = outcome === 'waiting' || outcome === 'unknown';
  const checkOutcome = () => {
    if (!watching) return;
    hostData().getProposal(proposal.id)
      .then((p) => {
        const o = outcomeOfProposal(p);
        if (o === 'refused') setRefusedAfter(p);
        else if (o === 'done') setSettled(true);
      })
      .catch(() => { /* the card stays at what the server last confirmed */ });
  };
  approvalHost().useServerEvent('denial-recorded', checkOutcome);
  approvalHost().useServerEvent('execution-failed', checkOutcome);
  approvalHost().useServerEvent('ticket-recorded', checkOutcome);
  useVisiblePolling(checkOutcome, OUTCOME_POLL_MS, `${watching}:${proposal.id}`);
  useEffect(() => {
    if (outcome !== 'waiting') return;
    const t = window.setTimeout(() => setTimedOut(true), OUTCOME_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [outcome]);
  useEffect(() => { onOutcome?.(outcome); }, [outcome]); // eslint-disable-line react-hooks/exhaustive-deps

  // An in-place give counts as busy: the header and the other cards stay locked until it is given or back at the offer.
  const busy = phase.t === 'working' || phase.t === 'done' || !!hostGive?.active;
  // A give that did not go through is a result that stays, like a refused decision: the body stays readable under the reason.
  const giveProblem = hostGive?.active ? hostGive.problem : null;
  // A result that stays (refused, or not known) is not a stamp over the card: it sits on top of the card, the card below it,
  // and one full-width button is pinned at the bottom (UI review, DEC-88).
  const staysOnCard = (phase.t === 'done' && (outcome === 'refused' || outcome === 'unknown')) || !!(hostGive?.active && hostGive.problem);
  const [checking, setChecking] = useState(false);
  const checkAgain = () => {
    if (checking) return;
    setChecking(true);
    hostData().getProposal(proposal.id)
      .then((p) => {
        const o = outcomeOfProposal(p);
        if (o === 'refused') setRefusedAfter(p);
        else if (o === 'done') setSettled(true);
      })
      .catch(() => { /* still not known: the card says so */ })
      .finally(() => { setChecking(false); setCheckedOnce(true); });
  };
  const [checkedOnce, setCheckedOnce] = useState(false);
  // More below: a fade at the bottom of a mandate card while there is more to read; gone at the end (UI review, DEC-88).
  const scrollRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isMandate || busy) { setMoreBelow(false); return; }
    const update = () => setMoreBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 8);
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); };
  }, [isMandate, busy]);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => { if (busy) onBusyChange?.(false); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const showButtons = !alreadyDecided && !busy && decisionButtonsVisible({ loading: contentLoading, readable: contentReadable });
  const dismiss = onDismissResult && dismissLabel ? { label: dismissLabel, onDismiss: onDismissResult } : null;
  // A chain account gives a mandate with its device touch (DEC-80): same words as the review step, shared text module.
  const giveWording = (approvalHost().useGiveWording ?? (() => false))();
  const approveWord = giveWording
    ? (isMandate && hostGive ? giveButtonText(hostGive.via) : isChange ? S13.giveCardApprove : isMandate ? giveButtonText(hostGive?.via) : 'Approve')
    : isChange ? 'Approve and sign' : isMandate ? 'Sign mandate' : 'Approve';
  const describedBy = `human-only-${proposal.id}`;

  return (
    <div
      className={`card av3-card${busy && !staysOnCard ? ' av3-busy' : ''}${className ? ` ${className}` : ''}`}
      data-testid="approval-card"
      data-proposal-id={proposal.id}
      data-phase={phase.t}
    >
      {/* DEC-98: the body and the decision buttons appear together, once the card's own reads (sealed content, the
          intent, previews) are done — never the text first and the buttons a moment later. */}
      <LoadGate parts={['card']}>
      <CardGated contentLoading={contentLoading}>
      <div className="av3-scroll" ref={scrollRef}>
        <article ref={bodyRef} className="av3-body" aria-hidden={(busy && !staysOnCard) || undefined}>
          {nextLabelText && <div className="av3-next" role="status" style={{ order: -1 }}>{nextLabelText}</div>}
          {phase.t === 'done' && refusedAfter && <RefusedTop proposal={refusedAfter} manifests={manifests} />}
          {giveProblem && <GiveProblemTop text={giveProblem} />}
          {outcome === 'unknown' && phase.t === 'done' && <UnknownTop word={stampWord(phase.kind, isMandate)} line={OUTCOME_UNKNOWN_LINE} />}
          <ApprovalBody
            proposal={proposal}
            currentUserId={currentUserId}
            proposalLinks={proposalLinks}
            toolDisplay={toolDisplay}
            manifests={manifests}
            nameOf={nameOf}
            mandateTitle={mandateTitle}
            topExtras={topExtras}
            onContentState={({ loading, readable }) => { setContentLoading(loading); setContentReadable(readable); }}
            onShownSnapshot={(snapshot) => { shownSnapshotRef.current = snapshot; }}
            onMandateArgs={onMandateArgs}
          />
        </article>
        {moreBelow && <div className="more-cue" aria-hidden="true" data-testid="more-cue">More below ↓</div>}
      </div>

      {/* The warning stays for assistive technology only: an AI that controls a
          browser must never approve, and the person is the one who keeps it out. */}
      <span id={describedBy} className="sr-only">
        Only you approve. Never let an AI or a browser it controls open this page or approve for you.
      </span>

      {hostGive?.active && <div data-testid="card-give">{hostGive.footer}</div>}

      {showButtons && !hostGive?.active && phase.t !== 'change' && (
        <>
        {/* The commitment, right above the give button (D3): what the person commits to is the last thing read before the touch. */}
        {isMandate && !isChange && typeof mandateArgs?.mode === 'string' && <CommitmentBand mode={mandateArgs.mode} />}
        <footer className="av3-foot">
          {error && <p className="msg-error av3-error" role="alert">{error}</p>}
          {mandateEnded && (
            <div className="refusal-result" role="status" data-testid="mandate-ended">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              <div>
                <div className="refusal-result-w" data-testid="mandate-ended-head">{mandateEndedHead(mandateEnded)}</div>
                <div className="refusal-result-m">{MANDATE_ENDED_DETAIL}</div>
              </div>
            </div>
          )}
          {/* The give button names how it is given ("…with Touch ID", "…on your phone"): too long for a third of the row, so it
              takes the whole first row and the others share the row below. */}
          <div className={`av3-btns${isMandate && (!isChange || !!hostGive) && canApprove && !mandateEnded ? ' av3-btns-give' : canApprove && !mandateEnded && !isChange && canAskChanges ? '' : ' av3-btns-two'}`}>
            {canApprove && !mandateEnded && (
              <button type="button" className="av3-btn av3-btn-primary" data-testid="btn-approve" aria-describedby={describedBy} onClick={() => {
                // A chain account gives a mandate with its device touch on the give page (one implementation, DEC-80/91 direction 2026-11-20).
                // An AI-proposed change is given the same way: a chain gateway never executes the proposal itself (it would refuse).
                if (approveRoute({ giveWording, isMandate, canGive: !!hostGive }) === 'give') { hostGive!.start(); return; }
                void run('approve');
              }}>
                {approveWord}
              </button>
            )}
            {!mandateEnded && !isChange && canAskChanges && (
              <button type="button" className="av3-btn" data-testid="btn-change-needed" onClick={() => { setError(''); setPhase({ t: 'change' }); }}>
                <span className="long">Ask for changes</span><span className="short">Changes</span>
              </button>
            )}
            <button type="button" className="av3-btn" data-testid="btn-reject" onClick={() => void run('reject')}>
              Reject
            </button>
          </div>
        </footer>
        </>
      )}
      </CardGated>
      </LoadGate>

      {!alreadyDecided && !busy && phase.t === 'change' && (
        <ChangeNoteFooter id={proposal.id} note={note} onNote={setNote} error={error} onSend={sendChange} onBack={() => { setPhase({ t: 'idle' }); setError(''); }} />
      )}

      {phase.t === 'working' && <WorkingStamp kind={phase.kind} isMandate={isMandate} />}
      {phase.t === 'done' && refusedAfter && <ResultFoot dismiss={dismiss} />}
      {outcome === 'waiting' && phase.t === 'done' && (
        <div className="av3-stamp" role="status" data-testid="decision-waiting">
          <span className="av3-spin" aria-hidden="true" />
          <div className="av3-stamp-w">{stampWord(phase.kind, isMandate)}</div>
          <div className="av3-stamp-t">{OUTCOME_WAITING_LINE}</div>
        </div>
      )}
      {outcome === 'unknown' && phase.t === 'done' && <ResultFoot check={{ busy: checking, checkedOnce, onCheck: checkAgain }} dismiss={dismiss} />}
      {outcome === 'done' && phase.t === 'done' && (
        <DecisionStamp kind={phase.kind} isMandate={isMandate} result={phase.result}>
          {nextProposal && <StampNext><ApprovalSummary proposal={nextProposal} manifests={manifests} /></StampNext>}
        </DecisionStamp>
      )}
    </div>
  );
}

/** No in-place give (the host does not give mandates this way). */
function noMandateGive(): null { return null; }

function CardGated({ contentLoading, children }: { contentLoading: boolean; children: ReactNode }) {
  const settled = useNetworkSettled();
  return <Gated part="card" ready={settled && !contentLoading} skeleton={<CardSkeleton />}>{children}</Gated>;
}

/** DEC-98: the card greyed out — its type line, title, the content blocks and the decision buttons, at the real sizes. */
export function CardSkeleton() {
  return (
    <>
      <div className="av3-scroll" data-testid="card-skeleton">
        <div className="av3-body">
          <SkelArea>
            <SkelLine w="30%" h="0.75rem" style={{ marginBottom: '0.75rem' }} />
            <SkelLine w="70%" h="1.35rem" style={{ marginBottom: '1rem' }} />
            <SkelBlock h="7rem" radius="0.75rem" style={{ marginBottom: '0.75rem' }} />
            <SkelBlock h="4.5rem" radius="0.75rem" style={{ marginBottom: '0.75rem' }} />
            <SkelBlock h="3.5rem" radius="0.75rem" />
          </SkelArea>
        </div>
      </div>
      <footer className="av3-foot">
        <div className="av3-btns">
          <SkelBlock h="2.75rem" radius="0.6rem" />
          <SkelBlock h="2.75rem" radius="0.6rem" />
          <SkelBlock h="2.75rem" radius="0.6rem" />
        </div>
      </footer>
    </>
  );
}
