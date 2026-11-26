/**
 * The pieces of a decision that every device draws the same way: the "what should the AI change?" footer, the working line and the
 * stamp ("Rejected", "Sent back to the AI") once the Authority Server has answered. The gateway's ApprovalCard and the phone's give
 * both use these, so the words and the shapes cannot differ (maintainer, 2026-11-26: phone and gateway always the same).
 */
import type { ReactNode } from 'react';
import { CHANGE_NOTE_MAX } from '../lib/reject-outcome';
import { workingWord, stampWord, stampLine, type DecisionKind, type DecisionResult } from '../lib/approval-flow';

/** The note box that replaces the buttons while the person writes what the AI should change. */
export function ChangeNoteFooter({ id, note, onNote, error, onSend, onBack }: {
  id: string; note: string; onNote: (v: string) => void; error: string; onSend: () => void; onBack: () => void;
}) {
  return (
    <footer className="av3-foot av3-chg">
      <label className="av3-chg-l" htmlFor={`chg-${id}`}>What should the AI change?</label>
      <textarea id={`chg-${id}`} data-testid="change-note" value={note} maxLength={CHANGE_NOTE_MAX} rows={3} onChange={(e) => onNote(e.target.value)} autoFocus />
      {error && <p className="msg-error av3-error" role="alert">{error}</p>}
      <div className="av3-btns av3-btns-two">
        <button type="button" className="av3-btn av3-btn-primary" data-testid="btn-send-back" onClick={onSend}>Send to the AI</button>
        <button type="button" className="av3-btn" onClick={onBack}>Back</button>
      </div>
    </footer>
  );
}

/** "Rejecting…" while the call is out. */
export function WorkingStamp({ kind, isMandate }: { kind: DecisionKind; isMandate: boolean }) {
  return (
    <div className="av3-stamp av3-stamp-wait" role="status" data-testid="decision-working">
      <span className="av3-spin" aria-hidden="true" />
      {workingWord(kind, isMandate)}…
    </div>
  );
}

/** The stamp, drawn only after the Authority Server has answered. `children`: what a host adds under it (the next card). */
export function DecisionStamp({ kind, isMandate, result, children }: { kind: DecisionKind; isMandate: boolean; result: DecisionResult | undefined; children?: ReactNode }) {
  return (
    <div className="av3-stamp" role="status" data-testid="decision-stamp">
      <svg className="av3-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
      <div className="av3-stamp-w">{stampWord(kind, isMandate)}</div>
      <div className="av3-stamp-t">{stampLine(kind, result)}</div>
      {children}
    </div>
  );
}
