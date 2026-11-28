/** The locked notice the AI gets asks the control plane whether an unlock password exists; every doubt is the API key text. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { lockedNoticeNow } from '../src/lib/locked-notice-now';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const cp = (answer: () => Response) => {
  const f = vi.fn(async () => answer());
  vi.stubGlobal('fetch', f);
  return f;
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('lockedNoticeNow', () => {
  it('device keys on and a password set: password or Touch ID', async () => {
    vi.stubEnv('SUVEREN_DEVICE_KEYS', 'on'); vi.stubEnv('SUVEREN_INTERNAL_SECRET', 's');
    const f = cp(() => json({ hasPassword: true }));
    expect(await lockedNoticeNow('list authorizations')).toContain('unlock it with your password or Touch ID');
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain('/internal/unlock-password');
  });
  it('device keys on, no password: the API key', async () => {
    vi.stubEnv('SUVEREN_DEVICE_KEYS', 'on'); vi.stubEnv('SUVEREN_INTERNAL_SECRET', 's');
    cp(() => json({ hasPassword: false }));
    expect(await lockedNoticeNow()).toMatch(/enter your Suveren API key/);
  });
  it('the control plane does not answer: the API key', async () => {
    vi.stubEnv('SUVEREN_DEVICE_KEYS', 'on'); vi.stubEnv('SUVEREN_INTERNAL_SECRET', 's');
    cp(() => json({}, 500));
    expect(await lockedNoticeNow()).toMatch(/enter your Suveren API key/);
  });
  it('device keys off: the API key, and the control plane is not asked', async () => {
    vi.stubEnv('SUVEREN_DEVICE_KEYS', 'off');
    const f = cp(() => json({ hasPassword: true }));
    expect(await lockedNoticeNow()).toMatch(/enter your Suveren API key/);
    expect(f).not.toHaveBeenCalled();
  });
});
