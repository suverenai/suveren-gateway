import { describe, it, expect } from 'vitest';
import { approverListDrifted } from './AuthorizationsPage';

const OWNER = 'u-owner';
const COLLEAGUE = 'u-colleague';
const cfg = (approvers: string[], keyedApprovers?: string[]) =>
  ({ approvers, ...(keyedApprovers ? { keyedApprovers } : {}) }) as never;

describe('approverListDrifted', () => {
  it('an approver without a gateway key yet is NOT a change (Rehearsal 2026-10-19)', () => {
    // Frozen with Owner only, because Colleague had no key to encrypt the intent for.
    expect(approverListDrifted([OWNER], cfg([OWNER, COLLEAGUE], [OWNER]))).toBe(false);
  });
  it('once Colleague has a key, the mandate is flagged — Colleague cannot read its intent', () => {
    expect(approverListDrifted([OWNER], cfg([OWNER, COLLEAGUE], [OWNER, COLLEAGUE]))).toBe(true);
  });
  it('an approver removed since signing is a change', () => {
    expect(approverListDrifted([OWNER, COLLEAGUE], cfg([OWNER], [OWNER]))).toBe(true);
  });
  it('keys unknown (lookup failed) → falls back to the configured list', () => {
    expect(approverListDrifted([OWNER], cfg([OWNER, COLLEAGUE]))).toBe(true);
    expect(approverListDrifted([OWNER], cfg([OWNER]))).toBe(false);
  });
  it('nothing frozen or no config → no badge', () => {
    expect(approverListDrifted([], cfg([OWNER], [OWNER]))).toBe(false);
    expect(approverListDrifted([OWNER], null)).toBe(false);
  });
});
