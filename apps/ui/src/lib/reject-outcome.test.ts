import { describe, it, expect } from 'vitest';
import {
  CHANGE_NOTE_MAX,
  QUICK_CHIPS,
  validateChangeNote,
  chipSelected,
  applyQuickChip,
  rejectOutcomeArgs,
  changeNeededOutcomeArgs,
  replacedOutcomeArgs,
  outcomeAfterView,
} from './reject-outcome';
import type { Proposal } from './sp-client';

describe('validateChangeNote', () => {
  it('rejects an empty or whitespace-only note', () => {
    expect(validateChangeNote('')).toEqual({ valid: false, error: 'Describe what should change.' });
    expect(validateChangeNote('   ')).toEqual({ valid: false, error: 'Describe what should change.' });
  });

  it('accepts 1 char and trims', () => {
    const v = validateChangeNote('  x  ');
    expect(v).toEqual({ valid: true, trimmed: 'x' });
  });

  it('accepts exactly 500 trimmed chars', () => {
    const note = 'a'.repeat(CHANGE_NOTE_MAX);
    expect(validateChangeNote(note)).toEqual({ valid: true, trimmed: note });
  });

  it('rejects 501 trimmed chars', () => {
    const note = 'a'.repeat(CHANGE_NOTE_MAX + 1);
    const v = validateChangeNote(note);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.error).toContain('500');
  });

  it('counts length AFTER trim — surrounding whitespace does not count against the cap', () => {
    const note = `  ${'a'.repeat(CHANGE_NOTE_MAX)}  `;
    expect(validateChangeNote(note)).toEqual({ valid: true, trimmed: 'a'.repeat(CHANGE_NOTE_MAX) });
  });
});

describe('chipSelected / applyQuickChip', () => {
  it('is not selected when the note is empty', () => {
    expect(chipSelected('', 'Lower the discount')).toBe(false);
  });

  it('clicking a chip on an empty note starts the note with it', () => {
    expect(applyQuickChip('', 'Lower the discount')).toBe('Lower the discount');
  });

  it('clicking a chip on a non-empty note appends it', () => {
    expect(applyQuickChip('Max 5% discount, please', 'Shorter')).toBe('Max 5% discount, please. Shorter');
  });

  it('a chip already present (case-insensitive) is detected as selected', () => {
    expect(chipSelected('please keep it SHORTER', 'Shorter')).toBe(true);
  });

  it('clicking an already-present chip removes just that phrase', () => {
    const withChip = applyQuickChip('', 'Lower the discount');
    const removed = applyQuickChip(withChip, 'Lower the discount');
    expect(removed).toBe('');
    expect(chipSelected(removed, 'Lower the discount')).toBe(false);
  });

  it('removing a chip leaves the rest of a hand-written note intact', () => {
    const note = applyQuickChip('Max 5% discount, please', 'Lower the discount');
    expect(note).toBe('Max 5% discount, please. Lower the discount');
    const removed = applyQuickChip(note, 'Lower the discount');
    expect(removed).toBe('Max 5% discount, please');
  });

  it('every declared quick chip round-trips through add/remove', () => {
    for (const chip of QUICK_CHIPS) {
      const added = applyQuickChip('', chip);
      expect(chipSelected(added, chip)).toBe(true);
      expect(applyQuickChip(added, chip)).toBe('');
    }
  });
});

describe('outcome mapping — what each button sends', () => {
  it('Reject: rejected, no note', () => {
    expect(rejectOutcomeArgs()).toEqual({ outcome: 'rejected' });
  });

  it('Send back for change: change_needed with the trimmed note', () => {
    expect(changeNeededOutcomeArgs('  Max 5% discount, please.  ')).toEqual({
      outcome: 'change_needed',
      note: 'Max 5% discount, please.',
    });
  });

  it('Send back for change throws on an invalid note — callers must validate first', () => {
    expect(() => changeNeededOutcomeArgs('   ')).toThrow();
    expect(() => changeNeededOutcomeArgs('a'.repeat(CHANGE_NOTE_MAX + 1))).toThrow();
  });

  it('Edit before signing (replaced): no note', () => {
    expect(replacedOutcomeArgs()).toEqual({ outcome: 'replaced' });
  });
});

describe('outcomeAfterView', () => {
  const base = (over: Partial<Pick<Proposal, 'rejectedBy' | 'approverRejectedBy'>> = {}) => ({
    rejectedBy: null,
    approverRejectedBy: undefined,
    ...over,
  });

  it('returns null for a proposal never rejected', () => {
    expect(outcomeAfterView(base(), 'u_me')).toBeNull();
  });

  it('a row with no outcome at all (pre-feature) reads as REJECTED', () => {
    const v = outcomeAfterView(base({ rejectedBy: { domain: 'owner', userId: 'u_1', at: 100 } }), 'u_me');
    expect(v).toEqual({ kind: 'REJECTED', who: 'u_1', at: 100, note: undefined });
  });

  it('change_needed carries the note', () => {
    const v = outcomeAfterView(
      base({ rejectedBy: { domain: 'owner', userId: 'u_1', at: 100, outcome: 'change_needed', note: 'Max 5% discount, please.' } }),
      'u_me',
    );
    expect(v).toEqual({ kind: 'CHANGE NEEDED', who: 'u_1', at: 100, note: 'Max 5% discount, please.' });
  });

  it('replaced carries no note', () => {
    const v = outcomeAfterView(
      base({ rejectedBy: { domain: 'owner', userId: 'u_1', at: 100, outcome: 'replaced' } }),
      'u_me',
    );
    expect(v).toEqual({ kind: 'REPLACED', who: 'u_1', at: 100, note: undefined });
  });

  it('resolves "who" to You when the current viewer decided it', () => {
    const v = outcomeAfterView(base({ rejectedBy: { domain: 'owner', userId: 'u_me', at: 100 } }), 'u_me');
    expect(v?.who).toBe('You');
  });

  it('falls back to approverRejectedBy (above-cap path) when rejectedBy is absent', () => {
    const v = outcomeAfterView(
      base({ approverRejectedBy: { userId: 'u_2', at: 200, outcome: 'rejected', reason: 'too risky' } }),
      'u_me',
    );
    expect(v).toEqual({ kind: 'REJECTED', who: 'u_2', at: 200, note: 'too risky' });
  });

  it('prefers rejectedBy over approverRejectedBy when (improbably) both are set', () => {
    const v = outcomeAfterView(
      base({
        rejectedBy: { domain: 'owner', userId: 'u_1', at: 100, outcome: 'change_needed', note: 'from domain path' },
        approverRejectedBy: { userId: 'u_2', at: 200, reason: 'from approver path' },
      }),
      'u_me',
    );
    expect(v?.note).toBe('from domain path');
  });
});
