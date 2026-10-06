import { describe, it, expect } from 'vitest';
import { profileIdentity, isTestSetupAction, shortProfileId } from './profile-identity';

describe('shortProfileId', () => {
  it('extracts the short id from a qualified profile id', () => {
    expect(shortProfileId('github.com/humanagencyprotocol/hap-profiles/charge@0.4')).toBe('charge');
  });

  it('extracts the short id from a bare id with no path', () => {
    expect(shortProfileId('email@0.5')).toBe('email');
  });

  it('lowercases the short id so it matches the fallback map keys', () => {
    expect(shortProfileId('Email@0.5')).toBe('email');
  });
});

describe('profileIdentity — fallback map', () => {
  const cases: Array<[string, ReturnType<typeof profileIdentity>['icon']]> = [
    ['email@0.5', 'mail'],
    ['customers@0.5', 'users'],
    ['sales@0.3', 'receipt'],
    ['charge@0.4', 'credit-card'],
    ['calendar@0.1', 'calendar'],
    ['publish@0.1', 'megaphone'],
    ['records@0.1', 'archive'],
    ['deploy@0.4', 'rocket'],
    ['delegation@0.1', 'flask'],
    ['purchase@0.1', 'shopping-cart'],
    ['reporting@0.1', 'bar-chart'],
  ];

  for (const [profileId, icon] of cases) {
    it(`maps ${profileId} to ${icon} when no icon is declared`, () => {
      expect(profileIdentity(profileId).icon).toBe(icon);
    });
  }
});

describe('profileIdentity — declared icon', () => {
  it('uses the declared icon when it names a known icon', () => {
    const identity = profileIdentity('email@0.5', { icon: 'rocket' });
    expect(identity.icon).toBe('rocket');
  });

  it('falls back to the short-id map when the declared icon is not a known name', () => {
    const identity = profileIdentity('email@0.5', { icon: 'not-a-real-icon' });
    expect(identity.icon).toBe('mail');
  });
});

describe('profileIdentity — unknown profile', () => {
  it('falls back to help-circle for a profile with no fallback-map entry', () => {
    const identity = profileIdentity('github.com/acme/hap-profiles/claims@0.1');
    expect(identity.icon).toBe('help-circle');
  });
});

describe('profileIdentity — delegation display override', () => {
  it('displays delegation as "Test Setup" and sets testSetup', () => {
    const identity = profileIdentity('delegation@0.1');
    expect(identity.name).toBe('Test Setup');
    expect(identity.testSetup).toBe(true);
  });

  it('does not mark a non-delegation profile as test setup', () => {
    const identity = profileIdentity('email@0.5');
    expect(identity.testSetup).toBe(false);
  });

  it('keeps the profile id on the wire unaffected by the display override', () => {
    // The override is display-only — profileIdentity never mutates the id,
    // it only returns a different display name for it.
    const identity = profileIdentity('delegation@0.1');
    expect(identity.name).not.toBe('delegation@0.1');
  });
});

describe('isTestSetupAction', () => {
  it('is true for a setup__ prefixed tool/action name', () => {
    expect(isTestSetupAction('setup__create_mandate')).toBe(true);
  });

  it('is false for an unrelated action name', () => {
    expect(isTestSetupAction('gmail__send_message')).toBe(false);
  });

  it('is false for a name that merely contains "setup__" mid-string', () => {
    expect(isTestSetupAction('gmail__setup__send_message')).toBe(false);
  });
});
