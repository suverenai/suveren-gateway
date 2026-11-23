import { describe, it, expect } from 'vitest';
import { changesFromProposal } from './card-change-give';

describe('an AI-proposed change, given from the card', () => {
  it('asks for exactly the change the proposal names, in the shape the Change screen sends', () => {
    expect(changesFromProposal({
      mandate_id: 'authz_x', profile: 'records', mode: 'review', change: { limits: [] },
      limits: { archive_access: 'allowed' }, intent: 'Archive test notes.', duration_hours: 24, mandate_title: 'Notes',
    })).toEqual({ limits: { archive_access: 'allowed' }, mode: 'review', intent: 'Archive test notes.', durationHours: 24 });
  });

  it('carries nothing the proposal does not name (no scope, no end date)', () => {
    expect(changesFromProposal({ mandate_id: 'authz_x', limits: { write_daily_max: 20 } })).toEqual({ limits: { write_daily_max: 20 } });
  });
});
