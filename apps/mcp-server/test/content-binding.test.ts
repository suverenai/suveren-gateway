/**
 * Content binding (gateway side) — the jcs hash MUST match
 * @humanagencyp/hap-core's pinned vector, and the helper must no-op for
 * profiles that declare no content_binding.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerProfile } from '@hap/core';
import { computeContentBinding } from '../src/lib/content-binding';
import type { DiscoveredTool } from '../src/lib/integration-manager';

const JCS_PROFILE = 'records-test';
const PLAIN_PROFILE = 'charge-test';

// Minimal DiscoveredTool stub — jcs ignores the tool entirely.
const tool = { inputSchema: { properties: {} } } as unknown as DiscoveredTool;

beforeAll(() => {
  registerProfile(JCS_PROFILE, {
    id: JCS_PROFILE,
    version: '0.4',
    description: 'test',
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 1, max: 1 },
    retention_minimum: 1,
    content_binding: { version: '1', kind: 'jcs' },
  });
  registerProfile(PLAIN_PROFILE, {
    id: PLAIN_PROFILE,
    version: '0.4',
    description: 'test',
    executionContextSchema: { fields: {} },
    requiredGates: [],
    ttl: { default: 1, max: 1 },
    retention_minimum: 1,
  });
});

describe('computeContentBinding', () => {
  it('jcs: hashes the record payload, matching the hap-core vector (order-independent)', () => {
    const a = computeContentBinding(JCS_PROFILE, tool, { title: 'Q3 plan', type: 'note' });
    const b = computeContentBinding(JCS_PROFILE, tool, { type: 'note', title: 'Q3 plan' });
    expect(a?.contentHash).toBe('sha256:82c28e63f951c1ac68080788fda46be42b2128f80c43dbc01d5c3b160a09717f');
    expect(a?.contentBinding).toEqual({ version: '1', kind: 'jcs' });
    expect(a?.contentHash).toBe(b?.contentHash);
  });

  it('returns undefined when the profile declares no content_binding', () => {
    expect(computeContentBinding(PLAIN_PROFILE, tool, { amount: 10 })).toBeUndefined();
  });

  it('returns undefined for an unknown profile', () => {
    expect(computeContentBinding('does-not-exist', tool, { x: 1 })).toBeUndefined();
  });
});
