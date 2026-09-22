import { describe, it, expect } from 'vitest';
import { teamGateBlocked } from './team-gate';

/**
 * A personal workspace showed "Approvers — Not enabled for Andreas's
 * Workspace" and a disabled Authorize button, because the page took the
 * presence of a groupId as "this is a team". The AS never requires approvers
 * for a personal group; the page must use the same discriminator.
 */
describe('teamGateBlocked', () => {
  it('never blocks a personal workspace, even with no profile config at all', () => {
    expect(teamGateBlocked({ isPersonal: true }, true, undefined)).toBe(false);
    expect(teamGateBlocked({ isPersonal: true }, true, [])).toBe(false);
  });

  it('blocks a team whose profile has no approvers (config missing or empty)', () => {
    expect(teamGateBlocked({ isPersonal: false }, true, undefined)).toBe(true);
    expect(teamGateBlocked({ isPersonal: false }, true, [])).toBe(true);
  });

  it('does not block a team with at least one approver', () => {
    expect(teamGateBlocked({ isPersonal: false }, true, ['user_1'])).toBe(false);
  });

  it('does not block while the config is still loading', () => {
    expect(teamGateBlocked({ isPersonal: false }, false, undefined)).toBe(false);
  });

  it('treats a pre-flag snapshot as a team — the safe side', () => {
    expect(teamGateBlocked({}, true, [])).toBe(true);
  });
});
