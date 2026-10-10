/**
 * "What was done" (AU6) — the five ticket-bound states, the generic
 * bound-content renderer (reusing preview-render.ts), and the
 * no-bound-content fallback (profile-labelled executionContext).
 */
import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import { ticketBoundStatus, boundContentView, checkedValueRows } from './ticket-what-was-done';

function profile(scopeFields: Record<string, unknown> = {}): AgentProfile {
  return {
    id: 'test/profile@1', version: '1', description: '',
    executionContextSchema: { fields: {} },
    requiredGates: [], ttl: { default: 0, max: 0 }, retention_minimum: 0,
    scopeSchema: { keyOrder: [], fields: scopeFields },
    boundsSchema: { keyOrder: [], fields: {} },
  } as unknown as AgentProfile;
}

describe('ticketBoundStatus', () => {
  it('off-device wins over everything else — no local copy, nothing else to say', () => {
    expect(ticketBoundStatus({ offDevice: true, boundContent: { a: 1 }, hasHashToCheck: true, hashVerified: true })).toBe('off-device');
    expect(ticketBoundStatus({ offDevice: true, boundContent: undefined, hasHashToCheck: false, hashVerified: null })).toBe('off-device');
  });

  it('none: a local copy exists but carries no bound content', () => {
    expect(ticketBoundStatus({ offDevice: false, boundContent: undefined, hasHashToCheck: false, hashVerified: null })).toBe('none');
  });

  it('verified: bound content present, a hash check ran, and it passed', () => {
    expect(ticketBoundStatus({ offDevice: false, boundContent: { a: 1 }, hasHashToCheck: true, hashVerified: true })).toBe('verified');
  });

  it('mismatch: bound content present, a hash check ran, and it FAILED', () => {
    expect(ticketBoundStatus({ offDevice: false, boundContent: { a: 1 }, hasHashToCheck: true, hashVerified: false })).toBe('mismatch');
  });

  it('unchecked (2026-10-10 correction): bound content present but no signed hash/binding to check against at all — NEVER "mismatch" (that would claim a check failed when none ran)', () => {
    expect(ticketBoundStatus({ offDevice: false, boundContent: { a: 1 }, hasHashToCheck: false, hashVerified: null })).toBe('unchecked');
  });

  it('unchecked, not verified, when there is bound content but a string/object instead of a real hash would be — still gated on hasHashToCheck alone', () => {
    expect(ticketBoundStatus({ offDevice: false, boundContent: 'free text', hasHashToCheck: false, hashVerified: null })).toBe('unchecked');
  });
});

describe('boundContentView — reuses preview-render.ts\'s generic rules', () => {
  it('undefined bound content is empty', () => {
    expect(boundContentView(undefined).kind).toBe('empty');
  });

  it('an object renders as labelled fields, nested rows not raw JSON', () => {
    const v = boundContentView({ contact: 'cust-1', type: 'Note', lines: [{ qty: 4, sku: 'CH-120' }] });
    expect(v.kind).toBe('structured');
    expect(v.fields.map((f) => f.label)).toEqual(['Contact', 'Type', 'Lines']);
    expect(v.fields[2].lines![0]).not.toMatch(/[{}[\]]/);
  });

  it('respects the profile\'s declared content_binding.fields order', () => {
    const v = boundContentView({ subject: 'Hi', to: ['a@x.example'], body: 'Hello' }, ['to', 'subject', 'body']);
    expect(v.fields.map((f) => f.key)).toEqual(['to', 'subject', 'body']);
  });

  it('a string (text-kind binding) renders as plain text, never truncated', () => {
    const v = boundContentView('Q-0001 for four CH-120 chairs, EUR 480, 0% discount.');
    expect(v.kind).toBe('text');
    expect(v.text).toBe('Q-0001 for four CH-120 chairs, EUR 480, 0% discount.');
  });

  it('rounds a non-integer number the same way the preview box does', () => {
    const v = boundContentView({ amount: 44.44444444444444 });
    expect(v.fields[0].value).toBe('44.44');
    expect(v.fields[0].valueTitle).toBe('44.44444444444444');
  });
});

describe('checkedValueRows — the no-bound-content fallback, profile-labelled', () => {
  it('labels from the profile\'s scope schema displayName, never a guessed field-name pattern', () => {
    const p = profile({ value: { displayName: 'Quote value' }, discount_pct: { displayName: 'Discount' } });
    const rows = checkedValueRows({ value: 480, discount_pct: 0, action_type: 'send' }, p);
    expect(rows).toEqual([
      { key: 'value', label: 'Quote value', value: '480' },
      { key: 'discount_pct', label: 'Discount', value: '0' },
      { key: 'action_type', label: 'action_type', value: 'send' },
    ]);
  });

  it('falls back to the plain key without a profile — never invents a label', () => {
    const rows = checkedValueRows({ value: 480 }, null);
    expect(rows).toEqual([{ key: 'value', label: 'value', value: '480' }]);
  });

  it('skips undefined/null/empty-string values, never shows them as "undefined"', () => {
    const rows = checkedValueRows({ value: 480, notes: null, label: '' }, null);
    expect(rows.map((r) => r.key)).toEqual(['value']);
  });

  it('empty for no execution context at all', () => {
    expect(checkedValueRows(undefined, null)).toEqual([]);
  });

  it('0 and false are real, shown values — never skipped like null/""', () => {
    const rows = checkedValueRows({ discount_pct: 0, sent: false }, null);
    expect(rows.map((r) => r.value)).toEqual(['0', 'false']);
  });
});
