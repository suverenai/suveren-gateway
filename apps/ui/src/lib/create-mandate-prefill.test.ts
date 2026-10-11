/**
 * "Edit before signing" (DL6) — the pure prefill mapping and the
 * withdraw-after-sign decision. See lib/create-mandate-prefill.ts for what
 * this module deliberately does NOT do (resolve the profile/workspace —
 * that stays in the component, same split as Copy/Edit).
 */
import { describe, it, expect } from 'vitest';
import {
  scalarRecord,
  mandatePrefillGate,
  shouldWithdrawProposalAfter,
  type CreateMandateProposalArgs,
} from './create-mandate-prefill';

describe('scalarRecord', () => {
  it('keeps string and number entries', () => {
    expect(scalarRecord({ a: 'x', b: 1 })).toEqual({ a: 'x', b: 1 });
  });

  it('drops a nested object, an array, and a boolean — never carried into a flat bounds/context record', () => {
    expect(scalarRecord({ a: 1, obj: { x: 1 }, arr: [1, 2], flag: true })).toEqual({ a: 1 });
  });

  it('a non-object value (including undefined) reads as nothing proposed', () => {
    expect(scalarRecord(undefined)).toEqual({});
    expect(scalarRecord('not an object')).toEqual({});
    expect(scalarRecord(42)).toEqual({});
    expect(scalarRecord([1, 2])).toEqual({});
  });

  it('an empty object stays empty', () => {
    expect(scalarRecord({})).toEqual({});
  });
});

describe('mandatePrefillGate', () => {
  const FULL_ARGS: CreateMandateProposalArgs = {
    team: 'Alpenwerk Innendienst',
    profile: 'sales',
    limits: { value_max: 1000, discount_max: 5 },
    scope: { currency: 'EUR' },
    intent: 'Why — Answer quote requests the same day.',
    mode: 'review',
    duration_hours: 720,
    title: 'Innendienst Angebote',
  };

  it('maps limits/scope/intent to bounds/context/gateContent.intent', () => {
    const gate = mandatePrefillGate(FULL_ARGS);
    expect(gate.bounds).toEqual({ value_max: 1000, discount_max: 5 });
    expect(gate.context).toEqual({ currency: 'EUR' });
    expect(gate.gateContent).toEqual({ intent: 'Why — Answer quote requests the same day.' });
  });

  it('carries `mode` through as `templateMode`, read by AgentReviewPage the same way Copy/Edit\'s is', () => {
    expect(mandatePrefillGate(FULL_ARGS).templateMode).toBe('review');
    expect(mandatePrefillGate({ ...FULL_ARGS, mode: 'automatic' }).templateMode).toBe('automatic');
  });

  it('an unrecognized `mode` is dropped rather than carried through', () => {
    expect(mandatePrefillGate({ ...FULL_ARGS, mode: 'critical' }).templateMode).toBeUndefined();
    expect(mandatePrefillGate({ ...FULL_ARGS, mode: undefined }).templateMode).toBeUndefined();
  });

  it('converts `duration_hours` to seconds as `templateTtl`', () => {
    expect(mandatePrefillGate(FULL_ARGS).templateTtl).toBe(720 * 3600);
  });

  it('a missing, zero, or negative `duration_hours` carries no templateTtl — the profile default applies downstream', () => {
    expect(mandatePrefillGate({ ...FULL_ARGS, duration_hours: undefined }).templateTtl).toBeUndefined();
    expect(mandatePrefillGate({ ...FULL_ARGS, duration_hours: 0 }).templateTtl).toBeUndefined();
    expect(mandatePrefillGate({ ...FULL_ARGS, duration_hours: -5 }).templateTtl).toBeUndefined();
  });

  it('a non-string intent (malformed proposal) reads as an empty intent, never throws', () => {
    expect(mandatePrefillGate({ ...FULL_ARGS, intent: 42 }).gateContent).toEqual({ intent: '' });
  });

  it('missing limits/scope map to empty records, not undefined', () => {
    const gate = mandatePrefillGate({ profile: 'sales', mode: 'review' });
    expect(gate.bounds).toEqual({});
    expect(gate.context).toEqual({});
  });
});

describe('shouldWithdrawProposalAfter', () => {
  it('withdraws (rejects) the proposal only when the person actually signed', () => {
    expect(shouldWithdrawProposalAfter('signed')).toBe(true);
  });

  it('leaves the proposal pending when the mandate screen was cancelled', () => {
    expect(shouldWithdrawProposalAfter('cancelled')).toBe(false);
  });

  it('leaves the proposal pending when signing failed', () => {
    expect(shouldWithdrawProposalAfter('failed')).toBe(false);
  });
});
