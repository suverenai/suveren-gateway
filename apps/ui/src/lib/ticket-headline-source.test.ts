import { describe, it, expect } from 'vitest';
import { headlineSourceFor } from './ticket-headline-source';

// DEC-22: the Authority Server deletes a proposal's content once its ticket is
// issued, so an approved ticket's headline must come from this gateway's own
// archive. Before this change, every approved ticket fetched the proposal from
// the AS — and with the content gone, the recipient vanished from the card
// (suveren-e2e files-connector.spec.ts:244, switch on).
describe('headlineSourceFor', () => {
  const maps = {
    automatic: { 't-auto': { to: 'a@example.com' } },
    approved: { 't-appr': { to: 'kunde@doc-allowed.example' } },
  };

  it('an approved ticket this gateway executed reads the archived approved args, not the AS', () => {
    expect(headlineSourceFor(maps, 't-appr', 'p-1')).toEqual({
      t: 'archive-approved', args: { to: 'kunde@doc-allowed.example' },
    });
  });

  it('an approved ticket with no local copy falls to the proposal fetch (another device executed it)', () => {
    expect(headlineSourceFor(maps, 't-other', 'p-2')).toEqual({ t: 'fetch-proposal', proposalId: 'p-2' });
  });

  it('an automatic ticket reads what was sent, or nothing', () => {
    expect(headlineSourceFor(maps, 't-auto')).toEqual({ t: 'archive-automatic', args: { to: 'a@example.com' } });
    expect(headlineSourceFor(maps, 't-none')).toEqual({ t: 'archive-automatic', args: null });
  });

  it('an automatic map entry never stands in for an approved ticket', () => {
    expect(headlineSourceFor({ automatic: { 't-x': { to: 'x' } }, approved: {} }, 't-x', 'p-3'))
      .toEqual({ t: 'fetch-proposal', proposalId: 'p-3' });
  });
});
