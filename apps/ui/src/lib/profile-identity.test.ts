import { describe, it, expect } from 'vitest';
import { profileIdentity, isTestSetupAction, shortProfileId } from './profile-identity';
import { areaIcon } from './area';

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

describe('profileIdentity — the area icon, from the profile id only (UI spec §13.1)', () => {
  const cases: Array<[string, ReturnType<typeof profileIdentity>['icon']]> = [
    ['email@0.5', 'email'],
    ['customers@0.5', 'customers'],
    ['sales@0.3', 'sales'],
    ['charge@0.4', 'payments'],
    ['calendar@0.1', 'calendar'],
    ['publish@0.1', 'publishing'],
    ['records@0.1', 'records'],
    ['deploy@0.4', 'deployments'],
    ['delegation@0.1', 'setup'],
    ['purchase@0.1', 'purchasing'],
    ['reporting@0.1', 'reports'],
  ];

  for (const [profileId, icon] of cases) {
    it(`maps ${profileId} to ${icon}`, () => {
      expect(profileIdentity(profileId).icon).toBe(icon);
    });
  }

  it('is the same icon the top line uses — one set to learn', () => {
    expect(profileIdentity('x/charge@0.6').icon).toBe(areaIcon('x/charge@0.6'));
  });

  it('an unknown profile gets the neutral icon', () => {
    expect(profileIdentity('github.com/acme/hap-profiles/claims@0.1').icon).toBe('unknown');
  });
});

describe('profileIdentity — delegation', () => {
  it('without a catalog reads "Delegation" (its id) and sets testSetup', () => {
    const identity = profileIdentity('delegation@0.1');
    expect(identity.name).toBe('Delegation');
    expect(identity.testSetup).toBe(true);
  });

  it('does not mark a non-delegation profile as test setup', () => {
    const identity = profileIdentity('email@0.5');
    expect(identity.testSetup).toBe(false);
  });

  it('returns a display name, never the raw id', () => {
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
