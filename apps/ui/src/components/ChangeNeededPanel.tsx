/**
 * The "Change needed" panel (RJ2, temp/briefs/rj-reject-brief.md; approved
 * mockup temp/mockups/reject-reason-v2.html §1) — shown in place of the
 * Approve/Change needed/Reject row once "Change needed" is clicked. Shared
 * by ActionCard (review-mode pending proposals) and ApproverProposalCard
 * (above-cap approvals), which otherwise render this card differently.
 *
 * Pure-logic parts (chip fill/extend, note validation) live in
 * lib/reject-outcome.ts — this component only wires them to inputs.
 */
import { QUICK_CHIPS, chipSelected, applyQuickChip, CHANGE_NOTE_MAX } from '../lib/reject-outcome';

interface Props {
  note: string;
  onNoteChange: (note: string) => void;
  onSend: () => void;
  onCancel: () => void;
  sending: boolean;
  error?: string;
}

export function ChangeNeededPanel({ note, onNoteChange, onSend, onCancel, sending, error }: Props) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-main)',
        padding: '0.75rem 0.875rem',
        marginTop: '0.5rem',
      }}
    >
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
        <strong style={{ color: 'var(--text-primary)' }}>What should change?</strong> (the AI will read this)
      </div>

      <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        {QUICK_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            className={`filter-chip${chipSelected(note, chip) ? ' selected' : ''}`}
            onClick={() => onNoteChange(applyQuickChip(note, chip))}
            disabled={sending}
          >
            {chip}
          </button>
        ))}
      </div>

      <textarea
        data-testid="change-note"
        className="form-input"
        value={note}
        maxLength={CHANGE_NOTE_MAX}
        onChange={(e) => onNoteChange(e.target.value)}
        rows={3}
        placeholder="What should the AI do differently?"
        disabled={sending}
        style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
      />
      <div style={{ textAlign: 'right', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
        {note.length} / {CHANGE_NOTE_MAX}
      </div>

      {error && <div className="error-message" style={{ marginTop: '0.4rem' }}>{error}</div>}

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
        <button
          data-testid="btn-send-back"
          className="btn btn-primary"
          style={{ background: 'var(--warning)', borderColor: 'var(--warning)' }}
          onClick={onSend}
          disabled={sending}
        >
          {sending ? 'Sending…' : 'Send back for change'}
        </button>
        <button className="btn btn-ghost" onClick={onCancel} disabled={sending}>
          Cancel
        </button>
      </div>

      <p style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', marginTop: '0.5rem', marginBottom: 0 }}>
        The AI is told: adjust and propose again — a new proposal you approve again. Nothing runs from this one.
      </p>
    </div>
  );
}
