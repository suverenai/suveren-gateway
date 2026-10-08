/**
 * Item 7 — wireExecutionContext (tool-proxy.ts): the execution-context
 * values this gateway puts ON THE WIRE (a ticket/proposal request) are
 * filtered to exactly what a `boundType` reads, plus `action_type` —
 * content/0.7/review.md -> "Scope values must not travel in the execution
 * context". The LOCAL `execution` object (Gatekeeper verify(), selection)
 * is a separate, untouched value — this only narrows what crosses the
 * network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { registerProfile, clearProfiles, type AgentProfile } from '@hap/core';
import { wireExecutionContext } from '../src/lib/tool-proxy';

const PROFILE_ID = 'test/wire-exec-ctx@1';

// Mirrors a real profile's shape (charge/sales): a per_transaction bound
// reading `amount`, a cumulative_sum bound on the SAME field, and a scope
// `currency` field the AS has no bound for at all — the exact shape
// review.md's finding describes ("a message's recipients mapped into the
// same key the scope schema declares").
const PROFILE: AgentProfile = {
  id: PROFILE_ID,
  version: '1',
  description: 'test',
  boundsSchema: {
    keyOrder: ['profile', 'amount_max', 'amount_daily_max'],
    fields: {
      profile: { type: 'string', required: true },
      amount_max: { type: 'number', required: true, boundType: { kind: 'per_transaction', of: 'amount' } },
      amount_daily_max: { type: 'number', required: true, boundType: { kind: 'cumulative_sum', of: 'amount', window: 'daily' } },
    },
  } as never,
  scopeSchema: {
    keyOrder: ['currency'],
    fields: {
      currency: { type: 'string', required: true, constraint: { type: 'string', enforceable: ['enum'] } },
    },
  } as never,
  executionContextSchema: { fields: {} },
  requiredGates: [],
  ttl: { default: 3600, max: 86400 },
  retention_minimum: 0,
};

afterEach(() => clearProfiles());

describe('wireExecutionContext', () => {
  it('keeps the field(s) a boundType.of names and action_type, drops a scope-only field', () => {
    registerProfile(PROFILE_ID, PROFILE);
    const result = wireExecutionContext(PROFILE_ID, { amount: 50, currency: 'EUR', action_type: 'charge' });
    expect(result).toEqual({ amount: 50, action_type: 'charge' });
    expect(result).not.toHaveProperty('currency');
  });

  it('drops a scope-only field even with no boundType match at all (fails safe, not open)', () => {
    registerProfile(PROFILE_ID, PROFILE);
    const result = wireExecutionContext(PROFILE_ID, { currency: 'EUR', unrelated_scope_field: 'x' });
    expect(result).toEqual({});
  });

  it('an unknown profile id yields only action_type (never fails open to "send everything")', () => {
    const result = wireExecutionContext('no-such-profile@1', { amount: 50, currency: 'EUR', action_type: 'charge' });
    expect(result).toEqual({ action_type: 'charge' });
  });

  it('a profile with no boundsSchema at all still keeps only action_type', () => {
    registerProfile(PROFILE_ID, { ...PROFILE, boundsSchema: undefined } as never);
    const result = wireExecutionContext(PROFILE_ID, { amount: 50, action_type: 'write' });
    expect(result).toEqual({ action_type: 'write' });
  });
});
