import { describe, it, expect } from 'vitest';
import { decisionAwaitsOutcome, outcomeOfProposal, resultDismissLabel, mandateEndedHead, decisionErrorWords } from './approval-outcome';

describe('decisionAwaitsOutcome', () => {
  it('an approval with nothing else needed waits for the ticket', () => {
    expect(decisionAwaitsOutcome('approve', {})).toBe(true);
    expect(decisionAwaitsOutcome('approve', { ticketId: 't1' })).toBe(true);
  });
  it('a reject or a change never does, nor an approval that still needs another approver', () => {
    expect(decisionAwaitsOutcome('reject', {})).toBe(false);
    expect(decisionAwaitsOutcome('change', {})).toBe(false);
    expect(decisionAwaitsOutcome('approve', { detail: '1 more approval still needed' })).toBe(false);
  });
});

describe('outcomeOfProposal', () => {
  it('committed: not known yet (the ticket is being asked for)', () => {
    expect(outcomeOfProposal({ status: 'committed' })).toBe('waiting');
  });
  it('still pending after an approval means it waits for someone else: no false "not known"', () => {
    expect(outcomeOfProposal({ status: 'pending' })).toBe('done');
  });
  it('executed: done', () => {
    expect(outcomeOfProposal({ status: 'executed' })).toBe('done');
  });
  it('refused with a reason: refused', () => {
    expect(outcomeOfProposal({ status: 'refused', refusal: { code: 'X', message: 'm', at: 1 } })).toBe('refused');
  });
  it('refused with no reason recorded never counts as refused', () => {
    expect(outcomeOfProposal({ status: 'refused' })).toBe('waiting');
  });
});

describe('resultDismissLabel', () => {
  it('Next while another approval waits, Close when nothing does', () => {
    expect(resultDismissLabel(true)).toBe('Next');
    expect(resultDismissLabel(false)).toBe('Close');
  });
});

describe('a dead mandate in plain words', () => {
  it('names the fact', () => {
    expect(mandateEndedHead('revoked')).toBe('This mandate was revoked.');
    expect(mandateEndedHead('expired')).toBe('This mandate has expired.');
  });
  it('a gateway error carrying the code becomes a sentence, never the code', () => {
    expect(decisionErrorWords('The parent mandate has been revoked (MANDATE_REVOKED)')).toBe('This mandate was revoked. It can no longer be approved.');
    expect(decisionErrorWords('Mandate gone (MANDATE_EXPIRED)')).toBe('This mandate has expired. It can no longer be approved.');
  });
  it('any other error is left as it came', () => {
    expect(decisionErrorWords('Network down')).toBe('Network down');
  });
});
