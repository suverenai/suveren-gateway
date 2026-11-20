import { describe, it, expect } from 'vitest';
import { assess, type Probe } from './compat';

const ok: Probe = { ed25519: true, x25519: true, passkey: true, iosTab: false, storage: true };

describe('can this phone pair (plan 8, DEC-19)?', () => {
  it('a capable phone', () => {
    expect(assess(ok)).toEqual({ ok: true });
  });

  it('names WHICH ability is missing, in a fixed order', () => {
    expect(assess({ ...ok, x25519: false })).toEqual({ ok: false, needs: ['newer_system'] });
    expect(assess({ ...ok, ed25519: false, x25519: false })).toEqual({ ok: false, needs: ['newer_system'] });
    expect(assess({ ...ok, passkey: false })).toEqual({ ok: false, needs: ['passkey'] });
    expect(assess({ ...ok, storage: false })).toEqual({ ok: false, needs: ['storage'] });
    expect(assess({ ed25519: false, x25519: true, passkey: false, iosTab: true, storage: false })).toEqual({
      ok: false, needs: ['install_app', 'newer_system', 'passkey', 'storage'],
    });
  });

  it('an iPhone browser tab is told to install the app: its storage is not the home-screen app\'s', () => {
    expect(assess({ ...ok, iosTab: true })).toEqual({ ok: false, needs: ['install_app'] });
  });
});
