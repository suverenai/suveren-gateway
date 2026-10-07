import { describe, it, expect } from 'vitest';
import { deriveManaged } from './useManaged';

describe('deriveManaged', () => {
  it('any locked key at all: managed', () => {
    expect(deriveManaged({ policyLocked: ['simulation'] })).toBe(true);
    expect(deriveManaged({ policyLocked: ['asUrl', 'pinTls'] })).toBe(true);
  });

  it('empty array: not managed', () => {
    expect(deriveManaged({ policyLocked: [] })).toBe(false);
  });

  it('older control-plane: no policyLocked field at all — must behave like "not managed", never throw', () => {
    expect(deriveManaged({})).toBe(false);
  });

  it('missing / malformed payload survives instead of throwing', () => {
    expect(deriveManaged(null)).toBe(false);
    expect(deriveManaged(undefined)).toBe(false);
  });

  it('non-array policyLocked does not crash or falsely report managed', () => {
    // @ts-expect-error — a malformed /health response should never throw
    expect(deriveManaged({ policyLocked: 'simulation' })).toBe(false);
  });
});
