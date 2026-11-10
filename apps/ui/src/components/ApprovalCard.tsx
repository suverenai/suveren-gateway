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
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProposalLink } from '../lib/proposal-links';
import { spClient, type IntegrationManifest, type Proposal, type ShownSnapshotPayload } from '../lib/sp-client';
import type { ToolDisplay } from '../lib/approval-view';
import { ApprovalBody } from './ApprovalBody';
import { validateChangeNote, CHANGE_NOTE_MAX } from '../lib/reject-outcome';
import { decisionButtonsVisible } from '../lib/use-proposal-content';
import { isAutomatedBrowser, AUTOMATION_REFUSAL } from '../lib/automation';
import { RefusalResult } from './RefusalResult';
import {
  OUTCOME_POLL_MS, OUTCOME_WAIT_MS, OUTCOME_WAITING_LINE, OUTCOME_UNKNOWN_LINE, MANDATE_ENDED_DETAIL,
  decisionAwaitsOutcome, decisionErrorWords, mandateEndedHead, outcomeOfProposal, type ApprovalOutcome,
} from '../lib/approval-outcome';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { workingWord, stampWord, stampLine, type DecisionKind, type DecisionResult } from '../lib/approval-flow';

const CREATE_MANDATE_TOOL = 'setup__create_mandate';

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
  className?: string;
}

type Phase =
  | { t: 'idle' }
  | { t: 'change' }
  | { t: 'working'; kind: DecisionKind }
  | { t: 'done'; kind: DecisionKind; result: DecisionResult };

export function ApprovalCard({
  proposal, currentUserId, manifests, toolDisplay, proposalLinks, mandateTitle, nameOf, topExtras,
  canApprove = true, alreadyDecided = false, decide, onDecided, nextLabelText, onBusyChange, onOutcome, dismissLabel, onDismissResult, className,
}: Props) {
  const isMandate = proposal.tool === CREATE_MANDATE_TOOL;
  const [phase, setPhase] = useState<Phase>({ t: 'idle' });
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
      const { shownHash } = await spClient.saveShownSnapshot(proposal.id, snapshot);
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
      const fresh = kind === 'approve' ? await spClient.getProposal(proposal.id).catch(() => null) : null;
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
    spClient.getProposal(proposal.id)
      .then((p) => { if (p.status === 'pending') setMandateEnded(p.mandateEnded); })
      .catch(() => { /* keep what the server last said */ });
  };
  useSSEEvent('attestation-changed', checkMandate);
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
    spClient.getProposal(proposal.id)
      .then((p) => {
        const o = outcomeOfProposal(p);
        if (o === 'refused') setRefusedAfter(p);
        else if (o === 'done') setSettled(true);
      })
      .catch(() => { /* the card stays at what the server last confirmed */ });
  };
  useSSEEvent('denial-recorded', checkOutcome);
  useSSEEvent('execution-failed', checkOutcome);
  useSSEEvent('ticket-recorded', checkOutcome);
  useVisiblePolling(checkOutcome, OUTCOME_POLL_MS, `${watching}:${proposal.id}`);
  useEffect(() => {
    if (outcome !== 'waiting') return;
    const t = window.setTimeout(() => setTimedOut(true), OUTCOME_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [outcome]);
  useEffect(() => { onOutcome?.(outcome); }, [outcome]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = phase.t === 'working' || phase.t === 'done';
  useEffect(() => {
    onBusyChange?.(busy);
    return () => { if (busy) onBusyChange?.(false); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const showButtons = !alreadyDecided && !busy && decisionButtonsVisible({ loading: contentLoading, readable: contentReadable });
  const dismiss = onDismissResult && dismissLabel ? (
    <button type="button" className="av3-btn av3-btn-primary av3-result-act" data-testid="result-dismiss" onClick={onDismissResult}>{dismissLabel}</button>
  ) : null;
  const approveWord = isMandate ? 'Sign mandate' : 'Approve';
  const describedBy = `human-only-${proposal.id}`;

  return (
    <div
      className={`card av3-card${busy ? ' av3-busy' : ''}${className ? ` ${className}` : ''}`}
      data-testid="approval-card"
      data-proposal-id={proposal.id}
      data-phase={phase.t}
    >
      <div className="av3-scroll">
        <article ref={bodyRef} className="av3-body" aria-hidden={busy || undefined}>
          {nextLabelText && <div className="av3-next" role="status" style={{ order: -1 }}>{nextLabelText}</div>}
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
          />
        </article>
      </div>

      {/* The warning stays for assistive technology only: an AI that controls a
          browser must never approve, and the person is the one who keeps it out. */}
      <span id={describedBy} className="sr-only">
        Only you approve. Never let an AI or a browser it controls open this page or approve for you.
      </span>

      {showButtons && phase.t !== 'change' && (
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
          <div className={`av3-btns${canApprove && !mandateEnded ? '' : ' av3-btns-two'}`}>
            {canApprove && !mandateEnded && (
              <button type="button" className="av3-btn av3-btn-primary" data-testid="btn-approve" aria-describedby={describedBy} onClick={() => void run('approve')}>
                {approveWord}
              </button>
            )}
            {!mandateEnded && (
              <button type="button" className="av3-btn" data-testid="btn-change-needed" onClick={() => { setError(''); setPhase({ t: 'change' }); }}>
                <span className="long">Ask for changes</span><span className="short">Changes</span>
              </button>
            )}
            <button type="button" className="av3-btn" data-testid="btn-reject" onClick={() => void run('reject')}>
              Reject
            </button>
          </div>
        </footer>
      )}

      {!alreadyDecided && !busy && phase.t === 'change' && (
        <footer className="av3-foot av3-chg">
          <label className="av3-chg-l" htmlFor={`chg-${proposal.id}`}>What should the AI change?</label>
          <textarea
            id={`chg-${proposal.id}`}
            data-testid="change-note"
            value={note}
            maxLength={CHANGE_NOTE_MAX}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
          />
          {error && <p className="msg-error av3-error" role="alert">{error}</p>}
          <div className="av3-btns av3-btns-two">
            <button type="button" className="av3-btn av3-btn-primary" data-testid="btn-send-back" onClick={sendChange}>Send to the AI</button>
            <button type="button" className="av3-btn" onClick={() => { setPhase({ t: 'idle' }); setError(''); }}>Back</button>
          </div>
        </footer>
      )}

      {phase.t === 'working' && (
        <div className="av3-stamp av3-stamp-wait" role="status" data-testid="decision-working">
          <span className="av3-spin" aria-hidden="true" />
          {workingWord(phase.kind, isMandate)}…
        </div>
      )}
      {phase.t === 'done' && refusedAfter && (
        <div className="av3-stamp av3-stamp-refused" data-testid="decision-refused">
          <RefusalResult proposal={refusedAfter} manifests={manifests} />
          {dismiss}
        </div>
      )}
      {outcome === 'waiting' && phase.t === 'done' && (
        <div className="av3-stamp" role="status" data-testid="decision-waiting">
          <span className="av3-spin" aria-hidden="true" />
          <div className="av3-stamp-w">{stampWord(phase.kind, isMandate)}</div>
          <div className="av3-stamp-t">{OUTCOME_WAITING_LINE}</div>
        </div>
      )}
      {outcome === 'unknown' && phase.t === 'done' && (
        <div className="av3-stamp" role="status" data-testid="decision-unknown">
          <div className="av3-stamp-w">{stampWord(phase.kind, isMandate)}</div>
          <div className="av3-stamp-t av3-stamp-note">{OUTCOME_UNKNOWN_LINE}</div>
          {dismiss}
        </div>
      )}
      {outcome === 'done' && phase.t === 'done' && (
        <div className="av3-stamp" role="status" data-testid="decision-stamp">
          <svg className="av3-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          <div className="av3-stamp-w">{stampWord(phase.kind, isMandate)}</div>
          <div className="av3-stamp-t">{stampLine(phase.kind, phase.result)}</div>
        </div>
      )}
    </div>
  );
}
