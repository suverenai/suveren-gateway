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
  className?: string;
}

type Phase =
  | { t: 'idle' }
  | { t: 'change' }
  | { t: 'working'; kind: DecisionKind }
  | { t: 'done'; kind: DecisionKind; result: DecisionResult };

export function ApprovalCard({
  proposal, currentUserId, manifests, toolDisplay, proposalLinks, mandateTitle, nameOf, topExtras,
  canApprove = true, alreadyDecided = false, decide, onDecided, nextLabelText, onBusyChange, className,
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
      setError(err instanceof Error ? err.message : 'Failed');
      setPhase(kind === 'change' ? { t: 'change' } : { t: 'idle' });
    }
  };

  const sendChange = () => {
    const v = validateChangeNote(note);
    if (!v.valid) { setError(v.error); return; }
    void run('change', v.trimmed);
  };

  const busy = phase.t === 'working' || phase.t === 'done';
  useEffect(() => {
    onBusyChange?.(busy);
    return () => { if (busy) onBusyChange?.(false); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const showButtons = !alreadyDecided && !busy && decisionButtonsVisible({ loading: contentLoading, readable: contentReadable });
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
        <article className="av3-body" aria-hidden={busy || undefined}>
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
          <div className={`av3-btns${canApprove ? '' : ' av3-btns-two'}`}>
            {canApprove && (
              <button type="button" className="av3-btn av3-btn-primary" data-testid="btn-approve" aria-describedby={describedBy} onClick={() => void run('approve')}>
                {approveWord}
              </button>
            )}
            <button type="button" className="av3-btn" data-testid="btn-change-needed" onClick={() => { setError(''); setPhase({ t: 'change' }); }}>
              <span className="long">Ask for changes</span><span className="short">Changes</span>
            </button>
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
      {phase.t === 'done' && (
        <div className="av3-stamp" role="status" data-testid="decision-stamp">
          <svg className="av3-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          <div className="av3-stamp-w">{stampWord(phase.kind, isMandate)}</div>
          <div className="av3-stamp-t">{stampLine(phase.kind, phase.result)}</div>
        </div>
      )}
    </div>
  );
}
