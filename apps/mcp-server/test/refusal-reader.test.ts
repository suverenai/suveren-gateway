/**
 * The one reader of an Authority Server refusal. Every caller used to read the
 * envelope on its own, and the two bugs that left (`body.message`, `approvers`)
 * were each fixed in only one copy. These pin the shapes a real server answers.
 */
import { describe, it, expect } from 'vitest';
import { readRefusal } from '@hap/core/refusal';

describe('a refusal is read the same way everywhere', () => {
  it('the spec envelope: code, message, and the other fields as facts', () => {
    const r = readRefusal({ approved: false, errors: [{ code: 'APPROVAL_REQUIRED', message: 'Above the cap', approvers: ['u1'], field: 'amount' }] });
    expect(r).toEqual({ code: 'APPROVAL_REQUIRED', message: 'Above the cap', facts: { approvers: ['u1'], field: 'amount' } });
  });
  it('a code without a sentence: the code is the message', () => {
    expect(readRefusal({ errors: [{ code: 'MANDATE_REVOKED' }] })).toEqual({ code: 'MANDATE_REVOKED', message: 'MANDATE_REVOKED', facts: {} });
  });
  it('older local shapes: message, detail, error (in that order)', () => {
    expect(readRefusal({ message: 'a', detail: 'b', error: 'c' }).message).toBe('a');
    expect(readRefusal({ detail: 'b', error: 'c' }).message).toBe('b');
    expect(readRefusal({ error: 'c' }).message).toBe('c');
  });
  it('a non-string `error` never becomes the message', () => {
    expect(readRefusal({ error: { nested: true } }, 'status 500').message).toBe('status 500');
  });
  it('nothing readable: the caller\'s fallback, never an empty sentence', () => {
    expect(readRefusal(undefined, 'status 502').message).toBe('status 502');
    expect(readRefusal(null, 'x').code).toBeUndefined();
    expect(readRefusal({ errors: [] }, 'y').message).toBe('y');
  });
});
