import { describe, it, expect } from 'vitest';
import { deriveFirstRunCard, type FirstRunCardInput } from './first-run-card';

const base: FirstRunCardInput = {
  hasContact: false,
  hasDelegationMandate: false,
  otherMandateCount: 0,
  delegationProposalCount: 0,
  managed: false,
  simulationOn: true,
};

describe('deriveFirstRunCard', () => {
  it('(a) self-installed, nothing done: step 1 open/self, 2 and 3 todo', () => {
    expect(deriveFirstRunCard(base)).toEqual({
      visible: true,
      step1: { status: 'open', variant: 'self' },
      step2: { status: 'todo' },
      step3: { status: 'todo' },
    });
  });

  it('(b) AI connected, no delegation: step 1 done, step 2 open, step 3 todo', () => {
    const r = deriveFirstRunCard({ ...base, hasContact: true });
    expect(r.step1).toEqual({ status: 'done' });
    expect(r.step2).toEqual({ status: 'open', variant: 'self', simulationOn: true });
    expect(r.step3).toEqual({ status: 'todo' });
    expect(r.visible).toBe(true);
  });

  it('(c) managed, nothing done: step 1 open/managed', () => {
    const r = deriveFirstRunCard({ ...base, managed: true });
    expect(r.step1).toEqual({ status: 'open', variant: 'managed' });
  });

  it('(d) delegation given + AI connected: steps 1 and 2 done, step 3 open', () => {
    const r = deriveFirstRunCard({ ...base, hasContact: true, hasDelegationMandate: true });
    expect(r.step1).toEqual({ status: 'done' });
    expect(r.step2).toEqual({ status: 'done' });
    expect(r.step3).toEqual({ status: 'open' });
    expect(r.visible).toBe(true);
  });

  it('step 2 open and simulation is off: carries simulationOn:false through for the "turn it on" copy', () => {
    const r = deriveFirstRunCard({ ...base, hasContact: true, simulationOn: false });
    expect(r.step2).toEqual({ status: 'open', variant: 'self', simulationOn: false });
  });

  it('managed + step 2 open: variant is managed (drives the approver-rights note)', () => {
    const r = deriveFirstRunCard({ ...base, hasContact: true, managed: true });
    expect(r.step2).toEqual({ status: 'open', variant: 'managed', simulationOn: true });
  });

  it('steps 1 and 2 are independent: delegation given before the AI ever connected', () => {
    const r = deriveFirstRunCard({ ...base, hasDelegationMandate: true });
    expect(r.step1).toEqual({ status: 'open', variant: 'self' });
    expect(r.step2).toEqual({ status: 'done' });
    expect(r.step3).toEqual({ status: 'todo' });
  });

  it('all three done: card is not visible (removed, not a "well done" screen)', () => {
    const r = deriveFirstRunCard({
      ...base,
      hasContact: true,
      hasDelegationMandate: true,
      delegationProposalCount: 1,
    });
    expect(r.visible).toBe(false);
  });

  it('another mandate already exists: not visible even if nothing else is done — this is no longer a first-run dashboard', () => {
    const r = deriveFirstRunCard({ ...base, otherMandateCount: 1 });
    expect(r.visible).toBe(false);
  });

  it('another mandate exists AND all three steps happen to be done: still not visible', () => {
    const r = deriveFirstRunCard({
      ...base,
      hasContact: true,
      hasDelegationMandate: true,
      delegationProposalCount: 2,
      otherMandateCount: 3,
    });
    expect(r.visible).toBe(false);
  });

  it('step 3 done counts a decided (not just pending) proposal — any count > 0', () => {
    const r = deriveFirstRunCard({
      ...base,
      hasContact: true,
      hasDelegationMandate: true,
      delegationProposalCount: 1,
    });
    expect(r.step3).toEqual({ status: 'done' });
  });
});
