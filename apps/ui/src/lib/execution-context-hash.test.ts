/**
 * v0.8: the browser execution_context_hash must equal hap-core's
 * computeExecutionContextHash (sha256 over the JCS of executionContextSchema),
 * or a v0.8 Authority Server refuses every mandate the sign page sends
 * (MALFORMED_MANDATE). Found by the Rehearsal's A11 on 0.41.0, 2026-11-04.
 */
import { describe, it, expect } from 'vitest';
import { computeExecutionContextHash, type AgentProfile } from '@hap/core';
import { computeExecutionContextHashBrowser } from './frame';

const withSchema = {
  id: 'p@1', version: '1', description: 'd', requiredGates: [], ttl: { default: 1, max: 2 }, retention_minimum: 0,
  executionContextSchema: { fields: {
    amount: { source: 'declared', description: 'Amount — €', required: true, constraint: { type: 'number', enforceable: ['max'] } },
    amount_daily: { source: 'cumulative', cumulativeField: 'amount', window: 'daily', description: 'daily', required: true },
  } },
} as unknown as AgentProfile;

describe('computeExecutionContextHashBrowser', () => {
  it('equals hap-core for a profile with a schema', async () => {
    expect(await computeExecutionContextHashBrowser(withSchema)).toBe(computeExecutionContextHash(withSchema));
  });
  it('hashes {} for a profile without one, like hap-core', async () => {
    const none = { ...withSchema, executionContextSchema: undefined } as unknown as AgentProfile;
    expect(await computeExecutionContextHashBrowser(none)).toBe(computeExecutionContextHash(none));
  });
  it('is not the old per-call hash', async () => {
    expect(await computeExecutionContextHashBrowser(withSchema)).not.toBe(computeExecutionContextHash({ executionContextSchema: { profile: 'p@1' } } as never));
  });
});
