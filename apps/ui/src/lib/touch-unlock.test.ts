import { describe, it, expect, vi } from 'vitest';
import { turnOnTouchUnlock } from './touch-unlock';

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (code: string) => ({ ok: false as const, status: 409, code });

describe('turnOnTouchUnlock (DEC-92: Touch ID on at set-up)', () => {
  it('turns it on where this computer has Touch ID and it is off, with the password just set', async () => {
    const enablePlatform = vi.fn(async () => ok({ backend: 'secure-enclave', policy: 'user-presence' }));
    const c = { platformCapabilities: async () => ok({ available: true, unlockEnabled: false, checkKey: false }), enablePlatform };
    expect(await turnOnTouchUnlock(c as never, 'the password')).toBe('on');
    expect(enablePlatform).toHaveBeenCalledWith('the password');
  });
  it('asks nothing on a computer without Touch ID', async () => {
    const enablePlatform = vi.fn();
    const c = { platformCapabilities: async () => ok({ available: false, unlockEnabled: false, checkKey: false }), enablePlatform };
    expect(await turnOnTouchUnlock(c as never, 'p')).toBe('unavailable');
    expect(enablePlatform).not.toHaveBeenCalled();
  });
  it('asks nothing when the capabilities cannot be read', async () => {
    const enablePlatform = vi.fn();
    const c = { platformCapabilities: async () => fail('unauthorized'), enablePlatform };
    expect(await turnOnTouchUnlock(c as never, 'p')).toBe('unavailable');
    expect(enablePlatform).not.toHaveBeenCalled();
  });
  it('does not turn it on twice', async () => {
    const enablePlatform = vi.fn();
    const c = { platformCapabilities: async () => ok({ available: true, unlockEnabled: true, checkKey: true }), enablePlatform };
    expect(await turnOnTouchUnlock(c as never, 'p')).toBe('already-on');
    expect(enablePlatform).not.toHaveBeenCalled();
  });
  it('a cancelled touch does not block the set-up: skipped, the password stays the way in', async () => {
    const c = { platformCapabilities: async () => ok({ available: true, unlockEnabled: false, checkKey: false }), enablePlatform: async () => fail('cancelled') };
    expect(await turnOnTouchUnlock(c as never, 'p')).toBe('skipped');
  });
});
