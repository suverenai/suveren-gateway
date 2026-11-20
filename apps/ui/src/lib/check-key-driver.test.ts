import { describe, it, expect, vi } from 'vitest';
import { CheckKeyDriver, type CheckKeyDeps } from './check-key-driver';
import type { Result } from './device-client';

const ok = <T,>(data: T): Result<T> => ({ ok: true, data, status: 200 });
const no = (code: string, status = 409): Result<never> => ({ ok: false, code, status, extra: {} });

function client(over: Partial<CheckKeyDeps['client']> = {}): CheckKeyDeps['client'] {
  return {
    checkKeySubmit: vi.fn(async () => ok({ recoveryId: 'r1', pageUrl: 'http://as/recover?x', checkEmail: true as const, sameBrowser: true as const, confirmCode: '123456', expiresAt: 0 })),
    checkKeyStatus: vi.fn(async () => ok({ state: 'authorised' as const })),
    checkKeyFinish: vi.fn(async () => ok({ rootDid: 'did:x', checkKey: true as const })),
    recoverCancel: vi.fn(async () => ok({ cancelled: true })),
    platformCapabilities: vi.fn(async () => ok({ unlockEnabled: false, checkKey: true, available: true })),
    enablePlatform: vi.fn(async () => ok({ backend: 'se', policy: 'p' })),
    ...over,
  } as unknown as CheckKeyDeps['client'];
}

describe('turning on Touch ID for approvals on a computer set up without it', () => {
  it('code + password → touch (key) → browser → email link → finish → touch (unlock) → done', async () => {
    const c = client();
    const opened: string[] = [];
    const d = new CheckKeyDriver({ client: c, open: u => opened.push(u) });
    const steps: string[] = [];
    d.subscribe(() => steps.push(d.get().step));
    await d.submit(' SV1-CODE ', 'pw-1234567');
    expect(c.checkKeySubmit).toHaveBeenCalledWith('SV1-CODE');
    expect(opened).toEqual(['http://as/recover?x']);
    expect(d.get()).toMatchObject({ step: 'waiting', confirmCode: '123456' });
    await d.poll();
    expect(c.checkKeyFinish).toHaveBeenCalledWith('r1');
    expect(c.enablePlatform).toHaveBeenCalledWith('pw-1234567');
    expect(d.get()).toEqual({ step: 'done', unlockOn: true });
    expect(steps).toEqual(['touch-key', 'waiting', 'finishing', 'touch-unlock', 'done']);
  });

  it('Touch ID unlock already on: no second touch; a failed unlock still ends done with approvals on', async () => {
    const on = client({ platformCapabilities: vi.fn(async () => ok({ unlockEnabled: true, checkKey: true, available: true })) });
    const d1 = new CheckKeyDriver({ client: on, open: () => {} });
    await d1.submit('c', 'pw'); await d1.poll();
    expect(on.enablePlatform).not.toHaveBeenCalled();
    expect(d1.get()).toEqual({ step: 'done', unlockOn: true });
    const fails = client({ enablePlatform: vi.fn(async () => no('cancelled')) });
    const d2 = new CheckKeyDriver({ client: fails, open: () => {} });
    await d2.submit('c', 'pw'); await d2.poll();
    expect(d2.get()).toEqual({ step: 'done', unlockOn: false });
  });

  it('a refusal at submit returns to the form with the reason; nothing is opened; the password is not kept', async () => {
    const c = client({ checkKeySubmit: vi.fn(async () => no('recovery_code_wrong')) });
    const opened: string[] = [];
    const d = new CheckKeyDriver({ client: c, open: u => opened.push(u) });
    await d.submit('c', 'pw');
    expect(d.get()).toMatchObject({ step: 'form', busy: false });
    expect((d.get() as { error?: string }).error).toBeTruthy();
    expect(opened).toEqual([]);
    expect((d as unknown as { password: string | null }).password).toBeNull();
  });

  it('waiting stays waiting; a failed or expired hand-off cancels and returns to the form', async () => {
    const c = client({ checkKeyStatus: vi.fn(async () => ok({ state: 'waiting' as const })) });
    const d = new CheckKeyDriver({ client: c, open: () => {} });
    await d.submit('c', 'pw'); await d.poll();
    expect(d.get().step).toBe('waiting');
    const e = client({ checkKeyStatus: vi.fn(async () => ok({ state: 'expired' as const })) });
    const d2 = new CheckKeyDriver({ client: e, open: () => {} });
    await d2.submit('c', 'pw'); await d2.poll();
    expect(e.recoverCancel).toHaveBeenCalled();
    expect(d2.get().step).toBe('form');
    expect(e.checkKeyFinish).not.toHaveBeenCalled();
  });

  it('nothing is sent without both a code and a password', async () => {
    const c = client();
    const d = new CheckKeyDriver({ client: c, open: () => {} });
    await d.submit('', 'pw'); await d.submit('c', '');
    expect(c.checkKeySubmit).not.toHaveBeenCalled();
  });
});
