import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@hap/core';
import { offeredCommitModes, settleCommitMode, toProtocolMode } from './commit-mode';

/**
 * A profile can be review-only (`commitment_modes: ['review']`). The mandate
 * screen must then offer only "Review each action" — offering "Automatic"
 * would let the person sign into a refusal from the Authority Server.
 */
const profile = (commitment_modes?: unknown) =>
  ({ id: 'p@0.1', version: '0.1', ...(commitment_modes === undefined ? {} : { commitment_modes }) }) as unknown as AgentProfile;

describe('offeredCommitModes', () => {
  it('a profile without the field offers both, review first — as before', () => {
    expect(offeredCommitModes(profile())).toEqual(['per-action', 'immediate']);
  });

  it('a review-only profile offers only review', () => {
    expect(offeredCommitModes(profile(['review']))).toEqual(['per-action']);
  });

  it.each([
    ['an empty list', []],
    ['a string instead of a list', 'review'],
    ['a misspelled mode', ['reveiw']],
    ['review_above_cap (not chosen by the signer)', ['review_above_cap']],
  ])('fail-closed like the AS: %s offers nothing', (_label, declared) => {
    expect(offeredCommitModes(profile(declared))).toEqual([]);
  });

  it('display order whatever order the profile lists them', () => {
    expect(offeredCommitModes(profile(['automatic', 'review']))).toEqual(['per-action', 'immediate']);
  });

  it('before the profile has loaded: both', () => {
    expect(offeredCommitModes(null)).toEqual(['per-action', 'immediate']);
  });
});

describe('settleCommitMode', () => {
  it('keeps an offered mode', () => {
    expect(settleCommitMode('immediate', ['per-action', 'immediate'])).toBe('immediate');
  });

  it('an automatic template on a review-only profile lands on review', () => {
    expect(settleCommitMode('immediate', ['per-action'])).toBe('per-action');
  });

  it('nothing offered → null', () => {
    expect(settleCommitMode('per-action', [])).toBeNull();
  });
});

describe('toProtocolMode', () => {
  it('maps the screen names to the signed values', () => {
    expect(toProtocolMode('per-action')).toBe('review');
    expect(toProtocolMode('immediate')).toBe('automatic');
  });
});
