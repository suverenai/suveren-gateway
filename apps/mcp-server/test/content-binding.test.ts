/**
 * Content binding (gateway side) — the jcs hash MUST match
 * @humanagencyp/hap-core's pinned vector, and the helper must no-op for
 * profiles that declare no content_binding.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerProfile } from '@hap/core';
import { computeContentBinding, attachTicketId } from '../src/lib/content-binding';
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

  // ERP1-3 (quote revisions, hap-erp-mcp): a `revision` argument on a write
  // tool call is a generic new field, not special-cased anywhere in the
  // gateway. The sales profile's jcs binding hashes `toolArgs` whole (no
  // `fields` allowlist — see the non-field branch above), so a tool call
  // that adds `revision` is covered automatically. This is the evidence for
  // "already bound by the whole-args binding" — no erp-specific code needed.
  it('a jcs (whole-payload) binding automatically covers a new call argument like `revision` — no per-field change needed', () => {
    const withoutRevision = computeContentBinding(JCS_PROFILE, tool, {
      id: 'q-1', value: 100, discount_pct: 0, currency: 'EUR',
    });
    const withRevision = computeContentBinding(JCS_PROFILE, tool, {
      id: 'q-1', value: 100, discount_pct: 0, currency: 'EUR', revision: 1,
    });
    const staleRevision = computeContentBinding(JCS_PROFILE, tool, {
      id: 'q-1', value: 100, discount_pct: 0, currency: 'EUR', revision: 2,
    });
    // Adding the field changes the hash (it is part of what gets signed)...
    expect(withRevision?.contentHash).not.toBe(withoutRevision?.contentHash);
    // ...and a different revision value produces a different hash too — a
    // receipt signed over revision 1 does not verify against revision 2.
    expect(withRevision?.contentHash).not.toBe(staleRevision?.contentHash);
    expect(withRevision?.boundContent).toMatchObject({ revision: 1 });
  });
});

describe('attachTicketId — HAP v0.7 wire rename (was attachReceiptId / receipt_id)', () => {
  it('injects ticket_id when the tool declares it in its input schema', () => {
    const declaring = { inputSchema: { properties: { ticket_id: { type: 'string' } } } } as unknown as DiscoveredTool;
    expect(attachTicketId(declaring, { a: 1 }, 'tk-1')).toEqual({ a: 1, ticket_id: 'tk-1' });
  });

  it('does NOT inject under the old receipt_id key — hard switch, no fallback', () => {
    const oldKey = { inputSchema: { properties: { receipt_id: { type: 'string' } } } } as unknown as DiscoveredTool;
    expect(attachTicketId(oldKey, { a: 1 }, 'tk-1')).toEqual({ a: 1 });
  });

  it('leaves args untouched when the tool declares neither field', () => {
    expect(attachTicketId(tool, { a: 1 }, 'tk-1')).toEqual({ a: 1 });
  });
});
