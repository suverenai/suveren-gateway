import { describe, it, expect } from 'vitest';
import { deriveWorkspacePolicy } from './useWorkspacePolicy';

// TopNav renders "· set by your IT" next to the workspace pill only when
// this is true — this derivation is the only thing deciding that.
describe('deriveWorkspacePolicy', () => {
  it('"team" present in policyLocked: managed', () => {
    expect(deriveWorkspacePolicy({ policyLocked: ['team', 'asUrl'] })).toEqual({ managed: true });
  });

  it('policyLocked present but without "team": not managed', () => {
    expect(deriveWorkspacePolicy({ policyLocked: ['asUrl', 'pinTls'] })).toEqual({ managed: false });
  });

  it('older control-plane: no policyLocked field at all — "not managed", never throw', () => {
    expect(deriveWorkspacePolicy({})).toEqual({ managed: false });
  });

  it('missing / malformed payload survives instead of throwing', () => {
    expect(deriveWorkspacePolicy(null)).toEqual({ managed: false });
    expect(deriveWorkspacePolicy(undefined)).toEqual({ managed: false });
    // @ts-expect-error — defensive at runtime even if the type doesn't allow it
    expect(deriveWorkspacePolicy('nonsense')).toEqual({ managed: false });
  });

  it('non-array policyLocked does not crash or falsely report managed', () => {
    // @ts-expect-error — a malformed /health response should never throw
    expect(deriveWorkspacePolicy({ policyLocked: 'team' })).toEqual({ managed: false });
  });
});
