import { describe, it, expect, vi } from 'vitest';
import { fakeClient, refuse } from './device-test-kit';
import { SetupDriver } from './setup-driver';
import { UnlockDriver } from './unlock-driver';
import { ConfirmDriver } from './confirm-driver';
import { RecoverDriver } from './recover-driver';
import { ResetDriver } from './reset-driver';
import { T, DRAFT } from './device-texts';

describe('set up this computer (screens 2 and 3)', () => {
  const happy = () => fakeClient({
    '/auth/device/setup/start': { body: { ok: true, setupId: 's1', recoveryCode: 'SV1-AAAA-BBBB', rootDid: 'did:x', deviceKeyId: 'k', label: 'Office Mac' } },
    '/auth/device/setup/connect': { body: { ok: true, authorizeUrl: 'https://suveren.ai/connect?x=1', expiresAt: 1 } },
    '/auth/device/setup/connect/status': [{ body: { ok: true, state: 'waiting' } }, { body: { ok: true, state: 'ready', account: { name: 'Anna Muster', email: 'anna@example.com' } } }],
    '/auth/device/setup/finish': { body: { ok: true, rootDid: 'did:x', deviceKeyId: 'k', signedIn: true, account: { name: 'Anna Muster', email: 'anna@example.com' } } },
    '/auth/device/setup/cancel': { body: { ok: true } },
  });

  it('name, Connect, wait, the code (kept unseen until then), kept, condition, connected', async () => {
    const { client, calls } = happy();
    const open = vi.fn();
    const d = new SetupDriver({ client, open });
    await d.continueWithName('  Office Mac ');
    expect(d.get()).toMatchObject({ step: 'connect', setupId: 's1' });
    // The code exists but is in no state object: the Connect screen cannot show it.
    expect(JSON.stringify(d.get())).not.toContain('SV1-');
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ label: 'Office Mac' });
    await d.connect();
    expect(open).toHaveBeenCalledWith('https://suveren.ai/connect?x=1');
    expect(d.get().step).toBe('waiting'); // DEC-68: the name is asked on suveren.ai; here only the waiting state
    await d.poll();
    expect(d.get().step).toBe('waiting');
    await d.poll();
    expect(d.get()).toMatchObject({ step: 'code', account: { name: 'Anna Muster' } });
    expect(d.recoveryCode()).toBe('SV1-AAAA-BBBB');
    d.codeSeen();
    expect(d.get().step).toBe('kept');
    d.kept(); // not ticked: no way on
    expect(d.get().step).toBe('kept');
    d.toggleKept(true);
    d.kept();
    expect(d.get().step).toBe('condition');
    await d.understand();
    expect(d.get()).toMatchObject({ step: 'connected', signedIn: true, account: { email: 'anna@example.com' } });
    expect(d.recoveryCode()).toBeNull(); // shown once, then gone
    // finish comes last: until then nothing is stored, so "Cancel set-up. This code stops working." is true
    expect(calls.map(c => c.path.split('?')[0]).slice(-1)[0]).toBe('/auth/device/setup/finish');
  });

  it('every refusal of the name step has its text', async () => {
    for (const [code, text] of [['label_invalid', T.nameInvalid], ['password_required', T.setupPasswordFirst], ['already_set_up', T.setupAlreadyDone], ['setup_pending', T.setupUnfinished], ['setup_busy', T.setupBusy]] as const) {
      const { client } = fakeClient({ '/auth/device/setup/start': refuse(409, code) });
      const d = new SetupDriver({ client, open: vi.fn() });
      await d.continueWithName('x');
      expect(d.get()).toMatchObject({ step: 'name', busy: false, error: text });
    }
  });

  it('Connect refusals, timeout and the browser failing go back to Connect with the right words', async () => {
    const mk = (connectStatus: object, connect = { body: { ok: true, authorizeUrl: 'u', expiresAt: 1 } } as object) => fakeClient({
      '/auth/device/setup/start': { body: { setupId: 's1', recoveryCode: 'C' } },
      '/auth/device/setup/connect': connect,
      '/auth/device/setup/connect/status': { body: connectStatus },
    });
    let { client } = mk({}, refuse(409, 'connect_port_unsupported'));
    let d = new SetupDriver({ client, open: vi.fn() });
    await d.continueWithName('x'); await d.connect();
    expect(d.get()).toMatchObject({ step: 'connect', error: T.connectBadStart });

    ({ client } = mk({ ok: true, state: 'expired', code: 'connect_timeout' }));
    d = new SetupDriver({ client, open: vi.fn() });
    await d.continueWithName('x'); await d.connect(); await d.poll();
    expect(d.get()).toMatchObject({ step: 'connect', error: T.connectTimeout });

    ({ client } = mk({ ok: true, state: 'failed', code: 'setup_refused' }));
    d = new SetupDriver({ client, open: vi.fn() });
    await d.continueWithName('x'); await d.connect(); await d.poll();
    expect(d.get()).toMatchObject({ step: 'connect', error: T.connectNotAccepted });

    ({ client } = mk({ ok: true, state: 'failed', code: 'connect_other_session' }));
    d = new SetupDriver({ client, open: vi.fn() });
    await d.continueWithName('x'); await d.connect(); await d.poll();
    expect(d.get()).toMatchObject({ error: T.connectOtherWindow });
  });

  it('cancel drops the code and goes back to the name', async () => {
    const { client } = happy();
    const d = new SetupDriver({ client, open: vi.fn() });
    await d.continueWithName('x'); await d.connect(); await d.cancel();
    expect(d.get()).toMatchObject({ step: 'name' });
    expect(d.recoveryCode()).toBeNull();
  });

  it('finish refused (head mismatch) keeps the person at the condition with the words', async () => {
    const { client } = fakeClient({
      '/auth/device/setup/start': { body: { setupId: 's1', recoveryCode: 'C' } },
      '/auth/device/setup/connect': { body: { authorizeUrl: 'u', expiresAt: 1 } },
      '/auth/device/setup/connect/status': { body: { state: 'ready' } },
      '/auth/device/setup/finish': refuse(502, 'head_mismatch'),
    });
    const d = new SetupDriver({ client, open: vi.fn() });
    await d.continueWithName('x'); await d.connect(); await d.poll(); d.codeSeen(); d.toggleKept(true); d.kept(); await d.understand();
    expect(d.get()).toMatchObject({ step: 'condition', error: T.connectWrongList });
  });

  it('connected but the sign-in did not work: item 65, and Try again signs in', async () => {
    const { client } = fakeClient({
      '/auth/device/setup/start': { body: { setupId: 's1', recoveryCode: 'C' } },
      '/auth/device/setup/connect': { body: { authorizeUrl: 'u', expiresAt: 1 } },
      '/auth/device/setup/connect/status': { body: { state: 'ready', account: { name: 'A', email: 'a@b' } } },
      '/auth/device/setup/finish': { body: { signedIn: false, signinCode: 'as_unreachable' } },
      '/auth/device/signin': [refuse(502, 'as_unreachable'), { body: { ok: true, expiresAt: 5 } }],
    });
    const d = new SetupDriver({ client, open: vi.fn() });
    await d.continueWithName('x'); await d.connect(); await d.poll(); d.codeSeen(); d.toggleKept(true); d.kept(); await d.understand();
    expect(d.get()).toMatchObject({ step: 'connected', signedIn: false, error: T.connectedSigninFailed });
    await d.retrySignIn();
    expect(d.get()).toMatchObject({ signedIn: false, error: T.asUnreachable });
    await d.retrySignIn();
    expect(d.get()).toMatchObject({ signedIn: true });
  });

  it('a set-up left half-way (code gone) can only be cancelled', async () => {
    const { client } = fakeClient({ '/auth/device/status': { body: { setUp: false, setupPending: true, signedIn: false } }, '/auth/device/setup/cancel': { body: {} } });
    const d = new SetupDriver({ client, open: vi.fn() });
    await d.resume();
    expect(d.get()).toMatchObject({ step: 'stuck', error: T.setupUnfinished });
    await d.cancel();
    expect(d.get().step).toBe('name');
  });
});

describe('unlock (screen 4)', () => {
  const deps = (client: ReturnType<typeof fakeClient>['client']) => {
    const log: string[] = [];
    return { log, d: { client, onSession: (t: string) => log.push(`session:${t}`), onIn: async () => { log.push('in'); return true; }, onAccountKey: () => log.push('account-key') } };
  };
  const status = (setUp: boolean, signedIn: boolean) => ({ body: { ok: true, setUp, setupPending: false, signedIn } });

  it('password: session, device status, sign-in by device key, in', async () => {
    const { client } = fakeClient({ '/auth/unlock': { body: { ok: true, sessionToken: 'T' } }, '/auth/device/status': status(true, false), '/auth/device/signin': { body: { ok: true, expiresAt: 1 } } });
    const { d, log } = deps(client);
    const u = new UnlockDriver(d);
    await u.withPassword('correct horse battery');
    expect(log).toEqual(['session:T', 'in']);
    expect(u.get().phase).toBe('done');
  });

  it('already signed in by the gateway: no second sign-in call', async () => {
    const { client, calls } = fakeClient({ '/auth/unlock': { body: { sessionToken: 'T' } }, '/auth/device/status': status(true, true) });
    const { d } = deps(client);
    await new UnlockDriver(d).withPassword('x'.repeat(10));
    expect(calls.some(c => c.path === '/auth/device/signin')).toBe(false);
  });

  it('no device key on this computer: the account-key sign-in follows', async () => {
    const { client } = fakeClient({ '/auth/unlock': { body: { sessionToken: 'T' } }, '/auth/device/status': status(false, false) });
    const { d, log } = deps(client);
    const u = new UnlockDriver(d);
    await u.withPassword('x'.repeat(10));
    expect(log).toEqual(['session:T', 'account-key']);
    expect(u.get().phase).toBe('account-key');
  });

  it('wrong password, too many tries, locked', async () => {
    for (const [r, text] of [[refuse(401, 'wrong_password'), T.wrongPassword], [refuse(429, 'too_many_attempts', { retryAfterSeconds: 600 }), 'Too many tries. Try again in 10 minutes.'], [refuse(403, 'origin_refused'), T.originRefused], [refuse(403, 'not_local'), T.notLocal]] as const) {
      const { client } = fakeClient({ '/auth/unlock': r });
      const { d, log } = deps(client);
      const u = new UnlockDriver(d);
      await u.withPassword('x'.repeat(10));
      expect(u.get().error).toBe(text);
      expect(log).toEqual([]);
    }
  });

  it('the sign-in by device key refused: the words, and Unlock again retries', async () => {
    const { client } = fakeClient({ '/auth/unlock': { body: { sessionToken: 'T' } }, '/auth/device/status': status(true, false), '/auth/device/signin': [refuse(409, 'device_removed'), { body: { ok: true, expiresAt: 1 } }] });
    const { d } = deps(client);
    const u = new UnlockDriver(d);
    await u.withPassword('x'.repeat(10));
    expect(u.get()).toMatchObject({ phase: 'sign-in-failed', error: T.deviceRemoved });
    await u.retry();
    expect(u.get().phase).toBe('done');
  });

  it('Touch ID where the helper is on: the button shows; a touch with a session (DEC-66 after S1) goes straight in', async () => {
    const { client } = fakeClient({ '/auth/platform/status': { body: { ok: true, unlockEnabled: true } }, '/auth/unlock/platform': { body: { ok: true, unlocked: true, sessionOpened: true, sessionToken: 'TT' } }, '/auth/device/status': status(true, true) });
    const { d, log } = deps(client);
    const u = new UnlockDriver(d);
    await u.init();
    expect(u.get().touchAvailable).toBe(true);
    await u.withTouch();
    expect(log).toEqual(['session:TT', 'in']);
  });

  it('Touch ID today (PLATFORM_UNLOCK_OPENS_PAGE_SESSION false): the vault opens, the page asks for the password', async () => {
    const { client } = fakeClient({ '/auth/platform/status': { body: { unlockEnabled: true } }, '/auth/unlock/platform': { body: { ok: true, unlocked: true, sessionOpened: false } } });
    const { d, log } = deps(client);
    const u = new UnlockDriver(d);
    await u.init();
    await u.withTouch();
    expect(log).toEqual([]);
    expect(u.get()).toMatchObject({ passwordOnly: true, notice: T.sessionClosed });
  });

  it('the vault is already open (409 already_unlocked): no message, the password is the way', async () => {
    const { client } = fakeClient({ '/auth/platform/status': { body: { unlockEnabled: true } }, '/auth/unlock/platform': refuse(409, 'already_unlocked') });
    const { d } = deps(client);
    const u = new UnlockDriver(d);
    await u.init(); await u.withTouch();
    expect(u.get().error).toBeUndefined();
    expect(u.get()).toMatchObject({ touchAvailable: false, passwordOnly: true });
  });

  it('no Touch ID here: no button, no message', async () => {
    const { client } = fakeClient({ '/auth/platform/status': refuse(404, 'bad_request') });
    const u = new UnlockDriver(deps(client).d);
    await u.init();
    expect(u.get()).toMatchObject({ touchAvailable: false });
    const c2 = fakeClient({ '/auth/platform/status': { body: { unlockEnabled: true } }, '/auth/unlock/platform': refuse(409, 'no_biometry') });
    const u2 = new UnlockDriver(deps(c2.client).d);
    await u2.init(); await u2.withTouch();
    expect(u2.get().error).toBeUndefined();
  });

  it('every Touch ID refusal reads in the recommended words', async () => {
    for (const [code, text] of [['cancelled', T.touchCancelled], ['not_recognised', T.touchNotRecognised], ['biometry_locked', T.touchLocked], ['key_invalid', T.touchCannot], ['helper_failed', T.touchCannot], ['wrap_mismatch', T.touchCannot], ['interaction_required', T.touchNoAsk]] as const) {
      const { client } = fakeClient({ '/auth/platform/status': { body: { unlockEnabled: true } }, '/auth/unlock/platform': refuse(409, code) });
      const u = new UnlockDriver(deps(client).d);
      await u.init(); await u.withTouch();
      expect(u.get().error, code).toBe(text);
    }
  });

  it('the notice for why the page closed is shown until the person is in', () => {
    const u = new UnlockDriver(deps(fakeClient({}).client).d, T.sessionIdle);
    expect(u.get().notice).toBe(T.sessionIdle);
  });
});

describe('confirm a change to a login (screen 5)', () => {
  const req = { ok: true, request: { request_id: 'R1', kind: 'replace', name: 'gmail', change_hash: 'h', expires_at: 1 } };
  it('password path where there is no check key', async () => {
    const { client } = fakeClient({ '/auth/platform/capabilities': { body: { checkKey: false } }, '/auth/confirm/request': { body: req }, '/auth/confirm': { body: { ok: true, confirmation: 'R1' } } });
    const settle = vi.fn();
    const d = new ConfirmDriver({ client, ask: { kind: 'replace', name: 'gmail', change: { a: 1 } }, settle });
    await d.begin();
    expect(d.get()).toMatchObject({ phase: 'asking', mode: 'password' });
    await d.withPassword('pw');
    expect(settle).toHaveBeenCalledWith('R1');
  });

  it('Touch ID where this computer has a check key', async () => {
    const { client, calls } = fakeClient({ '/auth/platform/capabilities': { body: { checkKey: true } }, '/auth/confirm/request': { body: req }, '/auth/confirm/check': { body: { ok: true, confirmation: 'R1' } } });
    const settle = vi.fn();
    const d = new ConfirmDriver({ client, ask: { kind: 'remove', name: 'gmail', change: null }, settle });
    await d.begin();
    expect(d.get().mode).toBe('touch');
    expect(JSON.parse(calls.find(c => c.path === '/auth/confirm/request')!.init!.body as string)).toEqual({ kind: 'remove', name: 'gmail', change: null });
    await d.withTouch();
    expect(settle).toHaveBeenCalledWith('R1');
  });

  it('a password refused where a check key exists switches to Touch ID with item 80', async () => {
    const { client } = fakeClient({ '/auth/platform/capabilities': refuse(404, 'bad_request'), '/auth/confirm/request': { body: req }, '/auth/confirm': refuse(409, 'check_key_required') });
    const d = new ConfirmDriver({ client, ask: { kind: 'replace', name: 'gmail', change: 1 }, settle: vi.fn() });
    await d.begin(); await d.withPassword('pw');
    expect(d.get()).toMatchObject({ mode: 'touch', error: T.confirmUseTouch });
  });

  it('every refusal has its words; the request running out says so', async () => {
    const cases: Array<[string, string, 'password' | 'touch']> = [
      ['wrong_password', T.wrongPassword, 'password'], ['request_unknown', T.confirmExpired, 'password'],
      ['cancelled', T.confirmCancelled, 'touch'], ['not_recognised', T.confirmTouchFailed, 'touch'], ['interaction_required', T.confirmTouchFailed, 'touch'],
      ['key_invalid', T.confirmTouchBroken, 'touch'], ['busy', 'Another Touch ID step is running. Wait a moment.', 'touch'],
    ];
    for (const [code, text, mode] of cases) {
      const { client } = fakeClient({ '/auth/platform/capabilities': { body: { checkKey: mode === 'touch' } }, '/auth/confirm/request': { body: req }, '/auth/confirm': refuse(401, code), '/auth/confirm/check': refuse(409, code) });
      const settle = vi.fn();
      const d = new ConfirmDriver({ client, ask: { kind: 'replace', name: 'gmail', change: 1 }, settle });
      await d.begin();
      if (mode === 'touch') await d.withTouch(); else await d.withPassword('pw');
      expect(d.get().error, code).toBe(text);
      expect(settle).not.toHaveBeenCalled();
    }
  });

  it('no check key and a phone: the phone is asked first; its confirmation settles with the request', async () => {
    const { client, calls } = fakeClient({
      '/auth/platform/capabilities': { body: { checkKey: false } }, '/auth/confirm/request': { body: req },
      '/auth/confirm/phone': { body: { ok: true, expiresAt: 999, phones: ['My iPhone'] } },
      '/auth/confirm/phone/R1': [{ body: { ok: true, status: 'waiting' } }, { body: { ok: true, status: 'confirmed' } }],
    });
    const settle = vi.fn();
    const d = new ConfirmDriver({ client, ask: { kind: 'replace', name: 'gmail', change: 1 }, settle });
    await d.begin();
    expect(d.get()).toMatchObject({ phase: 'asking', mode: 'phone', phoneUntil: 999 });
    expect(d.get().error).toBeUndefined();
    expect(JSON.parse(calls.find(c => c.path === '/auth/confirm/phone')!.init!.body as string)).toEqual({ request_id: 'R1' });
    await d.poll();
    expect(settle).not.toHaveBeenCalled();
    await d.poll();
    expect(settle).toHaveBeenCalledWith('R1');
  });

  it('no phone in the chain: the password, without a word', async () => {
    for (const code of ['no_phone', 'not_set_up', 'change_not_describable', 'bad_request']) {
      const { client } = fakeClient({ '/auth/platform/capabilities': { body: { checkKey: false } }, '/auth/confirm/request': { body: req }, '/auth/confirm/phone': refuse(409, code) });
      const d = new ConfirmDriver({ client, ask: { kind: 'replace', name: 'gmail', change: 1 }, settle: vi.fn() });
      await d.begin();
      expect(d.get(), code).toMatchObject({ mode: 'password' });
      expect(d.get().error, code).toBeUndefined();
    }
  });

  it('a phone that could not be reached: its own notice, then the password (L3)', async () => {
    const { client } = fakeClient({ '/auth/platform/capabilities': { body: { checkKey: false } }, '/auth/confirm/request': { body: req }, '/auth/confirm/phone': refuse(502, 'phone_unreachable'), '/auth/confirm': { body: { ok: true, confirmation: 'R1' } } });
    const settle = vi.fn();
    const d = new ConfirmDriver({ client, ask: { kind: 'replace', name: 'gmail', change: 1 }, settle });
    await d.begin();
    expect(d.get()).toMatchObject({ mode: 'password', error: T.confirmPhoneUnreachable });
    await d.withPassword('pw');
    expect(settle).toHaveBeenCalledWith('R1');
  });

  it('denied, run out, or an answer that does not verify: said in words, nothing settles', async () => {
    const cases: Array<[string, string]> = [['denied', T.confirmPhoneDenied], ['expired', T.confirmExpired], ['invalid', T.confirmPhoneInvalid]];
    for (const [status, text] of cases) {
      const { client } = fakeClient({
        '/auth/platform/capabilities': { body: { checkKey: false } }, '/auth/confirm/request': { body: req },
        '/auth/confirm/phone': { body: { ok: true, expiresAt: 999, phones: ['My iPhone'] } }, '/auth/confirm/phone/R1': { body: { ok: true, status } },
      });
      const settle = vi.fn();
      const d = new ConfirmDriver({ client, ask: { kind: 'replace', name: 'gmail', change: 1 }, settle });
      await d.begin(); await d.poll();
      expect(d.get().error, status).toBe(text);
      expect(settle).not.toHaveBeenCalled();
    }
  });

  it('"Use the password instead" withdraws the phone request and asks for a fresh one; cancel withdraws it too', async () => {
    const { client, calls } = fakeClient({
      '/auth/platform/capabilities': { body: { checkKey: false } }, '/auth/confirm/request': [{ body: req }, { body: { ok: true, request: { ...req.request, request_id: 'R2' } } }],
      '/auth/confirm/phone': { body: { ok: true, expiresAt: 999, phones: ['My iPhone'] } }, '/auth/confirm/phone/R1': { body: { ok: true } },
      '/auth/confirm': { body: { ok: true, confirmation: 'R2' } },
    });
    const settle = vi.fn();
    const d = new ConfirmDriver({ client, ask: { kind: 'replace', name: 'gmail', change: 1 }, settle });
    await d.begin();
    await d.usePassword();
    expect(d.get()).toMatchObject({ mode: 'password' });
    expect(calls.some(c => c.path === '/auth/confirm/phone/R1' && c.init?.method === 'DELETE')).toBe(true);
    await d.withPassword('pw');
    expect(settle).toHaveBeenCalledWith('R2');
    const second = fakeClient({ '/auth/platform/capabilities': { body: { checkKey: false } }, '/auth/confirm/request': { body: req }, '/auth/confirm/phone': { body: { ok: true, expiresAt: 999, phones: [] } }, '/auth/confirm/phone/R1': { body: { ok: true } } });
    const d2 = new ConfirmDriver({ client: second.client, ask: { kind: 'replace', name: 'gmail', change: 1 }, settle: vi.fn() });
    await d2.begin(); d2.cancel();
    expect(second.calls.some(c => c.path === '/auth/confirm/phone/R1' && c.init?.method === 'DELETE')).toBe(true);
  });

  it('cancel settles with nothing', async () => {
    const { client } = fakeClient({ '/auth/platform/capabilities': { body: {} }, '/auth/confirm/request': { body: req } });
    const settle = vi.fn();
    const d = new ConfirmDriver({ client, ask: { kind: 'replace', name: 'gmail', change: 1 }, settle });
    await d.begin(); d.cancel(); d.cancel();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(null);
  });
});

describe('recovery with the recovery code and replacing it', () => {
  it('recover: code in, browser hand-off, poll, finish, signed in', async () => {
    const { client, calls } = fakeClient({
      '/auth/device/recover/start': { body: { recoveryId: 'r1', pageUrl: 'https://suveren.ai/recover?x', confirmCode: '4821', expiresAt: 1, removes: [{ label: 'Old Mac', kind: 'device' }], pendingIdentityReset: { id: 'p', effectiveAt: 1 } } },
      '/auth/device/recover/status': [{ body: { state: 'waiting' } }, { body: { state: 'authorised' } }],
      '/auth/device/recover/finish': { body: { rootDid: 'd', deviceKeyId: 'k', head: { seq: 1, hash: 'h' }, signedIn: true } },
    });
    const open = vi.fn();
    const d = new RecoverDriver({ client, open, onSignedIn: async () => true }, 'reset');
    await d.start('SV1-CODE');
    expect(open).toHaveBeenCalledWith('https://suveren.ai/recover?x');
    expect(d.get()).toMatchObject({ step: 'waiting', confirmCode: '4821', removes: [{ label: 'Old Mac' }], hadPendingReset: true });
    expect(JSON.stringify(d.get())).not.toContain('SV1-CODE'); // the typed code is not kept
    await d.poll();
    expect(d.get().step).toBe('waiting');
    await d.poll();
    expect(d.get()).toMatchObject({ step: 'done', signedIn: true });
    expect(calls.filter(c => c.path.includes('finish'))).toHaveLength(1);
  });

  it('recover refusals have words; a failed browser step goes back to the form', async () => {
    for (const code of ['recovery_code_invalid', 'recovery_code_unknown', 'recovery_code_wrong', 'already_set_up', 'setup_pending', 'recovery_pending', 'as_unreachable', 'device_key_in_chain', 'root_key_taken', 'mail_failed']) {
      const { client } = fakeClient({ '/auth/device/recover/start': refuse(409, code) });
      const d = new RecoverDriver({ client, open: vi.fn() }, 'reset');
      await d.start('x');
      const s = d.get();
      expect(s.step).toBe('form');
      expect((s as { error?: string }).error, code).toBeTruthy();
      expect((s as { error?: string }).error, code).not.toBe(T.generic);
    }
    const { client } = fakeClient({
      '/auth/device/recover/start': { body: { recoveryId: 'r1', pageUrl: 'u', confirmCode: '1', expiresAt: 1, removes: [] } },
      '/auth/device/recover/status': { body: { state: 'failed', code: 'handoff_refused' } },
      '/auth/device/recover/cancel': { body: { cancelled: true } },
    });
    const d = new RecoverDriver({ client, open: vi.fn() }, 'reset');
    await d.start('x'); await d.poll();
    expect(d.get()).toMatchObject({ step: 'form', error: 'The browser step was refused. Nothing changed. Start again.' });
  });

  it('rotate: new code shown once, old code and the new one typed again, hand-off, finish', async () => {
    const { client, calls } = fakeClient({
      '/auth/device/rotate-root/start': { body: { rotateId: 'n1', recoveryCode: 'SV1-NEW', expiresAt: 1 } },
      '/auth/device/rotate-root/submit': { body: { recoveryId: 'r2', pageUrl: 'https://suveren.ai/x', confirmCode: '77', expiresAt: 1 } },
      '/auth/device/rotate-root/status': { body: { state: 'authorised' } },
      '/auth/device/rotate-root/finish': { body: { rootDid: 'd2' } },
    });
    const d = new RecoverDriver({ client, open: vi.fn() }, 'rotate');
    await d.rotateStart();
    expect(d.get()).toMatchObject({ step: 'show', rotateId: 'n1', checked: false });
    expect(d.newRecoveryCode()).toBe('SV1-NEW');
    expect(JSON.stringify(d.get())).not.toContain('SV1-NEW');
    d.writtenDown(); // not ticked: no way on
    expect(d.get().step).toBe('show');
    d.toggleWritten(true);
    d.writtenDown();
    expect(d.get()).toMatchObject({ step: 'enter' });
    expect(d.newRecoveryCode()).toBeNull(); // hidden before it is asked for again
    await d.rotateSubmit('SV1-OLD', 'SV1-NEW');
    expect(JSON.parse(calls.find(c => c.path.endsWith('submit'))!.init!.body as string)).toEqual({ rotateId: 'n1', oldCode: 'SV1-OLD', newCode: 'SV1-NEW' });
    expect(d.newRecoveryCode()).toBeNull();
    await d.poll();
    expect(d.get().step).toBe('done');
  });

  it('rotate refusals: wrong typed code stays, an expired new code goes back to the start', async () => {
    let { client } = fakeClient({ '/auth/device/rotate-root/start': { body: { rotateId: 'n1', recoveryCode: 'N', expiresAt: 1 } }, '/auth/device/rotate-root/submit': refuse(400, 'new_code_mismatch') });
    let d = new RecoverDriver({ client, open: vi.fn() }, 'rotate');
    await d.rotateStart(); d.toggleWritten(true); d.writtenDown(); await d.rotateSubmit('o', 'n');
    expect(d.get()).toMatchObject({ step: 'enter', error: 'The new code you typed is not the one shown. Check it and try again.' });
    ({ client } = fakeClient({ '/auth/device/rotate-root/start': { body: { rotateId: 'n1', recoveryCode: 'N', expiresAt: 1 } }, '/auth/device/rotate-root/submit': refuse(410, 'rotate_expired') }));
    d = new RecoverDriver({ client, open: vi.fn() }, 'rotate');
    await d.rotateStart(); d.toggleWritten(true); d.writtenDown(); await d.rotateSubmit('o', 'n');
    expect(d.get()).toMatchObject({ step: 'intro', error: 'The new code was not used in time. Make another.' });
    expect(d.newRecoveryCode()).toBeNull();
  });
});

describe('the alarm for a pending request for a new identity', () => {
  it('reads the status, never the event; cancel signs and clears', async () => {
    const { client, calls } = fakeClient({
      '/auth/device/status': [{ body: { setUp: true, setupPending: false, signedIn: true, pendingIdentityReset: { id: 'req1', effectiveAt: 5000 } } }, { body: { setUp: true, setupPending: false, signedIn: true, pendingIdentityReset: null } }],
      '/auth/device/identity-reset/cancel': { body: { ok: true, cancelled: true, requestId: 'req1' } },
    });
    const d = new ResetDriver(client);
    await d.refresh();
    expect(d.get().pending).toEqual({ id: 'req1', effectiveAt: 5000 });
    await d.cancel();
    expect(JSON.parse(calls.find(c => c.path.includes('cancel'))!.init!.body as string)).toEqual({ requestId: 'req1' });
    expect(d.get()).toMatchObject({ pending: null, cancelled: true });
    await d.refresh();
    expect(d.get().pending).toBeNull();
  });

  it('a refused cancel keeps the alarm and says why; an unreadable status keeps what is shown', async () => {
    const { client } = fakeClient({
      '/auth/device/status': [{ body: { setUp: true, setupPending: false, signedIn: true, pendingIdentityReset: { id: 'q', effectiveAt: 1 } } }, refuse(401, 'unauthorized')],
      '/auth/device/identity-reset/cancel': refuse(409, 'cancel_refused'),
    });
    const d = new ResetDriver(client);
    await d.refresh(); await d.cancel();
    expect(d.get().pending).not.toBeNull();
    expect(d.get().error).toBe('suveren.ai refused the cancel. Try again; if it repeats, tell support.');
    await d.refresh();
    expect(d.get().pending).not.toBeNull();
  });
});

describe('the gateway does not answer', () => {
  it('a network failure is a refusal the screens have words for', async () => {
    const { DeviceClient } = await import('./device-client');
    const c = new DeviceClient(async () => { throw new TypeError('fetch failed'); });
    const r = await c.unlock('x');
    expect(r).toMatchObject({ ok: false, code: 'gateway_unreachable' });
    const u = new UnlockDriver({ client: c, onSession: vi.fn(), onIn: async () => true, onAccountKey: vi.fn() });
    await u.withPassword('x');
    expect(u.get().error).toBe('The gateway does not answer. Check that it is running, then try again.');
  });
  it('DRAFT is a flat table of strings', () => {
    expect(Object.values(DRAFT).every(v => typeof v === 'string')).toBe(true);
  });
});

describe('fix round: cancel, check key, unlock once', () => {
  it('cancel is shown only after the gateway confirms; a refused cancel keeps the person where they are, with the reason', async () => {
    const { client } = fakeClient({
      '/auth/device/setup/start': { body: { setupId: 's1', recoveryCode: 'C' } },
      '/auth/device/setup/connect': { body: { authorizeUrl: 'u', expiresAt: 1 } },
      '/auth/device/setup/cancel': refuse(502, 'as_unreachable'),
    });
    const d = new SetupDriver({ client, open: vi.fn() });
    await d.continueWithName('x'); await d.connect();
    expect(d.get().step).toBe('waiting');
    await d.cancel();
    expect(d.get()).toMatchObject({ step: 'waiting', error: T.asUnreachable });
    expect(d.recoveryCode()).toBe('C'); // not dropped: the gateway did not confirm
  });

  it('recover and replace cancel only after the gateway says so; a recovery the server already holds is completed instead', async () => {
    let r = fakeClient({ '/auth/device/rotate-root/start': { body: { rotateId: 'n', recoveryCode: 'N', expiresAt: 1 } }, '/auth/device/recover/cancel': refuse(409, 'setup_busy') });
    let d = new RecoverDriver({ client: r.client, open: vi.fn() }, 'rotate');
    await d.rotateStart(); await d.cancel();
    expect(d.get()).toMatchObject({ step: 'show', error: T.setupBusy });
    r = fakeClient({ '/auth/device/rotate-root/start': { body: { rotateId: 'n', recoveryCode: 'N', expiresAt: 1 } }, '/auth/device/recover/cancel': { body: { cancelled: true } } });
    d = new RecoverDriver({ client: r.client, open: vi.fn() }, 'rotate');
    await d.rotateStart(); await d.cancel();
    expect(d.get().step).toBe('intro');
    expect(r.calls.some(c => c.path === '/auth/device/recover/cancel')).toBe(true);
    r = fakeClient({
      '/auth/device/recover/start': { body: { recoveryId: 'r', pageUrl: 'u', confirmCode: '1', expiresAt: 1, removes: [] } },
      '/auth/device/recover/cancel': { body: { completed: { signedIn: true } } },
    });
    d = new RecoverDriver({ client: r.client, open: vi.fn(), onSignedIn: async () => true }, 'reset');
    await d.start('x'); await d.cancel();
    expect(d.get()).toMatchObject({ step: 'done', signedIn: true });
  });

  it('the check key is asked at Continue, from a getter: it can change after the driver is built without dropping a started set-up', async () => {
    let want = false;
    const { client, calls } = fakeClient({ '/auth/device/setup/start': { body: { setupId: 's', recoveryCode: 'C' } } });
    const d = new SetupDriver({ client, open: vi.fn(), wantCheckKey: () => want });
    want = true; // the capabilities answer arrives after the driver exists
    await d.continueWithName('Mac');
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ label: 'Mac', checkKey: true });
    expect(d.get().step).toBe('connect');
  });

  it('one unlock signs in once: the status is read once and the sign-in is called once', async () => {
    const { client, calls } = fakeClient({ '/auth/unlock': { body: { sessionToken: 'T' } }, '/auth/device/status': { body: { setUp: true, setupPending: false, signedIn: false } }, '/auth/device/signin': { body: { ok: true, expiresAt: 1 } } });
    const u = new UnlockDriver({ client, onSession: vi.fn(), onIn: async () => true, onAccountKey: vi.fn() });
    await u.withPassword('x'.repeat(10));
    expect(calls.filter(c => c.path === '/auth/device/status')).toHaveLength(1);
    expect(calls.filter(c => c.path === '/auth/device/signin')).toHaveLength(1);
  });
});
