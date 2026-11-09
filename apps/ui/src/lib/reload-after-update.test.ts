import { describe, it, expect } from 'vitest';
import { shouldReloadAfterUpdate } from './reload-after-update';

describe('reload after an update', () => {
  it('reloads a signed-out tab running the previous build', () => {
    expect(shouldReloadAfterUpdate({ signedIn: false, serverRestarted: true })).toBe(true);
  });
  it('leaves a signed-in tab to the update banner', () => {
    expect(shouldReloadAfterUpdate({ signedIn: true, serverRestarted: true })).toBe(false);
  });
  it('does nothing without a new version', () => {
    expect(shouldReloadAfterUpdate({ signedIn: false, serverRestarted: false })).toBe(false);
  });
});
