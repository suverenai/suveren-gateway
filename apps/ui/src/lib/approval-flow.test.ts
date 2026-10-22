import { describe, it, expect } from 'vitest';
import { workingWord, stampWord, stampLine, ticketIdOf, nextAfter, positionLabel, nextLabel, navKeyFor } from './approval-flow';

describe('approval flow words (UI spec §17.5)', () => {
  it('names the call while it is out, and the stamp after', () => {
    expect(workingWord('approve', false)).toBe('Approving');
    expect(workingWord('approve', true)).toBe('Signing');
    expect(workingWord('reject', false)).toBe('Rejecting');
    expect(workingWord('change', false)).toBe('Sending');
    expect(stampWord('approve', false)).toBe('Approved');
    expect(stampWord('approve', true)).toBe('Signed');
    expect(stampWord('reject', false)).toBe('Rejected');
    expect(stampWord('change', false)).toBe('Sent back to the AI');
  });
  it('the line under the stamp is a ticket only when the gateway sent one', () => {
    expect(stampLine('approve', { ticketId: '3fa9c1d2-aaaa-bbbb' })).toBe('Ticket 3fa9c1d2');
    expect(stampLine('approve', {})).toBe('Recorded');
    expect(stampLine('approve', undefined)).toBe('Recorded');
    expect(stampLine('reject', { ticketId: 'x1' })).toBe('Recorded');
    expect(stampLine('approve', { detail: '1 more approval needed' })).toBe('1 more approval needed');
  });
  it('reads a ticket id off a receipt object, nothing else', () => {
    expect(ticketIdOf({ id: 'abc' })).toBe('abc');
    expect(ticketIdOf({ receiptId: 'r1' })).toBe('r1');
    expect(ticketIdOf({})).toBeUndefined();
    expect(ticketIdOf(null)).toBeUndefined();
    expect(ticketIdOf({ id: 42 })).toBeUndefined();
  });
});

describe('which card comes next', () => {
  const ids = ['a', 'b', 'c'];
  it('the next one takes the place; the last falls back; none left is null', () => {
    expect(nextAfter(ids, 'a')).toBe('b');
    expect(nextAfter(ids, 'b')).toBe('c');
    expect(nextAfter(ids, 'c')).toBe('b');
    expect(nextAfter(['a'], 'a')).toBeNull();
    expect(nextAfter(ids, 'zzz')).toBe('a');
  });
  it('position labels count from one', () => {
    expect(positionLabel(ids, 'b')).toBe('2 of 3');
    expect(positionLabel(ids, 'zzz')).toBeNull();
    expect(positionLabel(ids, null)).toBeNull();
    expect(nextLabel(['b', 'c'], 'b')).toBe('Next · 1 of 2');
  });
});

describe('keys', () => {
  it('only arrows and Escape move; no key decides', () => {
    expect(navKeyFor('ArrowLeft')).toBe('prev');
    expect(navKeyFor('ArrowRight')).toBe('next');
    expect(navKeyFor('Escape')).toBe('list');
    for (const k of ['a', 'A', 'c', 'C', 'r', 'R', 'Enter', ' ']) expect(navKeyFor(k)).toBeNull();
  });
});
