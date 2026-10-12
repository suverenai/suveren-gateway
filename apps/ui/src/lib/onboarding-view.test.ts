import { describe, it, expect } from 'vitest';
import { shouldRestoreWaitingState, shouldLeaveOnboardingForTeam, declinedGroupName } from './onboarding-view';

describe('shouldRestoreWaitingState — reloading restores the waiting state ONCE, from backend truth', () => {
  it('true: a pending request exists and this page has not restored yet', () => {
    expect(shouldRestoreWaitingState({ groupName: 'Acme' }, false)).toBe(true);
  });

  it('false: already restored — never re-triggers (e.g. right after withdrawing)', () => {
    expect(shouldRestoreWaitingState({ groupName: 'Acme' }, true)).toBe(false);
  });

  it('false: no pending request at all', () => {
    expect(shouldRestoreWaitingState(null, false)).toBe(false);
  });
});

describe('shouldLeaveOnboardingForTeam — the account moved into the team while waiting', () => {
  it('true: on the waiting screen and the account is now in a team', () => {
    expect(shouldLeaveOnboardingForTeam('join-waiting', 'team')).toBe(true);
  });

  it('false: on the waiting screen but still Personal', () => {
    expect(shouldLeaveOnboardingForTeam('join-waiting', 'personal')).toBe(false);
  });

  it('false: already in a team but on a different screen (not this function\'s case)', () => {
    expect(shouldLeaveOnboardingForTeam('choose', 'team')).toBe(false);
    expect(shouldLeaveOnboardingForTeam('create', 'team')).toBe(false);
  });
});

describe('declinedGroupName — pendingRequest disappeared without the account moving', () => {
  it('returns the lost group name: waiting, still Personal, request just vanished', () => {
    expect(declinedGroupName('join-waiting', 'personal', null, 'Acme Corp')).toBe('Acme Corp');
  });

  it('null: the request is STILL pending — nothing lost yet', () => {
    expect(declinedGroupName('join-waiting', 'personal', { groupName: 'Acme Corp' }, 'Acme Corp')).toBeNull();
  });

  it('null: the account moved into the team — that is a success, not a decline', () => {
    expect(declinedGroupName('join-waiting', 'team', null, 'Acme Corp')).toBeNull();
  });

  it('null: not on the waiting screen — this function only watches that screen', () => {
    expect(declinedGroupName('choose', 'personal', null, 'Acme Corp')).toBeNull();
  });

  it('null: nothing was pending before either (no previous group name to lose)', () => {
    expect(declinedGroupName('join-waiting', 'personal', null, null)).toBeNull();
  });
});
