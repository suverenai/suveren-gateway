/**
 * DEC-99: only macOS gets a check key and unlock by the platform authenticator. On Windows and Linux the control plane
 * never starts the helper — no capability, no check key, no unlock wrap, no touch — even when a working helper is there.
 * Decided by the gateway's own OS (`process.platform`), never by the helper's description of itself.
 */
import { describe, it, expect } from 'vitest';
import { PlatformHelper, platformKeysAllowed, checkPolicyFor, CHECK_POLICY, HelperUnavailableError } from '../../lib/platform-helper';
import { PlatformChecks } from '../../lib/platform-checks';

/** A locate() that would hand out a helper: it must never even be called off macOS. */
function countingLocate() {
  const calls = { n: 0 };
  const locate = () => { calls.n++; return { spec: { command: process.execPath, args: ['-e', 'process.exit(1)'], files: [] } }; };
  return { calls, locate };
}

describe('DEC-99: the platform authenticator only on macOS', () => {
  it('platformKeysAllowed: darwin only', () => {
    expect(platformKeysAllowed('darwin')).toBe(true);
    for (const p of ['win32', 'linux', 'freebsd'] as NodeJS.Platform[]) expect(platformKeysAllowed(p)).toBe(false);
  });

  it('the check policy is biometric, with no Windows user-presence path left', () => {
    expect(checkPolicyFor()).toBe(CHECK_POLICY);
    expect(CHECK_POLICY).toBe('biometry-current-set');
  });

  for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
    it(`${platform}: status says unsupported and the helper is never located or started`, async () => {
      const { calls, locate } = countingLocate();
      const host = new PlatformHelper({ platform, locate, idleMs: 30 });
      const s = await host.status();
      expect(s).toMatchObject({ available: false, reason: 'unsupported_platform' });
      expect(calls.n).toBe(0);
      await expect(host.use(async () => 'used')).rejects.toBeInstanceOf(HelperUnavailableError);
      expect(calls.n).toBe(0);
      host.close();
    });

    it(`${platform}: no check key can be made`, async () => {
      const { calls, locate } = countingLocate();
      const host = new PlatformHelper({ platform, locate, idleMs: 30 });
      const checks = new PlatformChecks(host);
      expect(await checks.possible()).toMatchObject({ ok: false, code: 'unsupported_platform' });
      await expect(checks.createKey()).rejects.toMatchObject({ code: 'unsupported_platform' });
      expect(calls.n).toBe(0);
      host.close();
    });
  }
});
