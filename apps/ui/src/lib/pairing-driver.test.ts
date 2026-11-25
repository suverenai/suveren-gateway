import { describe, it, expect } from 'vitest';
import { DeviceClient, type PairingView } from './device-client';
import { PairingDriver, isWaiting } from './pairing-driver';
import { T, textForCode } from './device-texts';
import { pairingErrorText } from './pairing-texts';

/** A control plane that answers what the test says; it records the calls. */
function plane(answers: Record<string, () => { status: number; body: unknown }>) {
  const calls: string[] = [];
  const client = new DeviceClient(async (path, init) => {
    const key = `${init?.method ?? 'GET'} ${path}`;
    calls.push(key + (init?.body ? ` ${init.body}` : ''));
    const a = answers[key];
    if (!a) throw new Error(`unexpected ${key}`);
    const r = a();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  return { client, calls };
}
const ok = (view: PairingView) => () => ({ status: 200, body: { ok: true, view } });
const refused = (code: string, status = 409) => () => ({ status, body: { error: code, code, message: code } });

const QR: PairingView = { flow: 'admit', step: 'qr', qr: 'SUVEREN-PAIR-1:x', expiresAt: 1 };

describe('PairingDriver: the page shows what the control plane says', () => {
  it('resumes a pairing of its own flow and shows nothing of the other flow', async () => {
    const a = plane({ 'GET /auth/device/pairing/status': ok(QR) });
    const admit = new PairingDriver({ client: a.client, flow: 'admit' });
    await admit.resume();
    expect(admit.get()).toEqual({ view: QR, busy: false, loading: false });
    const join = new PairingDriver({ client: a.client, flow: 'join' });
    await join.resume();
    expect(join.get().view).toEqual({ flow: 'none' });
  });

  it('start: the QR from the control plane; a refusal keeps the view and says why in words', async () => {
    const p = plane({ 'POST /auth/device/pairing/admit/start': ok(QR) });
    const d = new PairingDriver({ client: p.client, flow: 'admit' }, { view: { flow: 'none' }, busy: false, loading: false });
    await d.start();
    expect(d.get().view).toEqual(QR);
    const q = plane({ 'POST /auth/device/pairing/admit/start': refused('cannot_grant') });
    const e = new PairingDriver({ client: q.client, flow: 'admit' }, { view: { flow: 'none' }, busy: false, loading: false });
    await e.start();
    expect(e.get().view).toEqual({ flow: 'none' });
    expect(e.get().error).toBe(pairingErrorText('cannot_grant'));
    expect(e.get().busy).toBe(false);
  });

  it('a network failure reads as the gateway not answering, not as a state', async () => {
    const client = new DeviceClient(async () => { throw new Error('offline'); });
    const d = new PairingDriver({ client, flow: 'join' }, { view: { flow: 'none' }, busy: false, loading: false });
    await d.start();
    expect(d.get().error).toBe(textForCode('gateway_unreachable'));
    expect(d.get().view).toEqual({ flow: 'none' });
  });

  it('poll looks only while a step waits, and takes the control plane\'s view as it is', async () => {
    const connected: PairingView = { flow: 'admit', step: 'connected' };
    const p = plane({ 'GET /auth/device/pairing/status': ok(connected) });
    const d = new PairingDriver({ client: p.client, flow: 'admit' }, { view: QR, busy: false, loading: false });
    await d.poll();
    expect(d.get().view).toEqual(connected);
    const idle = new PairingDriver({ client: p.client, flow: 'admit' }, { view: { flow: 'none' }, busy: false, loading: false });
    await idle.poll();
    expect(p.calls).toHaveLength(1);
    expect(isWaiting({ flow: 'admit', step: 'choose', label: 'x', kind: 'approve-app', codes: [], rows: [] })).toBe(false);
    expect(isWaiting({ flow: 'join', step: 'compare', code: '123456', admitterLabel: 'x' })).toBe(true);
  });

  it('an answer that arrives after the person acted is dropped (the later action wins)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const client = new DeviceClient(async (path) => {
      if (path.endsWith('/status')) { await gate; return new Response(JSON.stringify({ ok: true, view: QR }), { status: 200 }); }
      return new Response(JSON.stringify({ ok: true, view: { flow: 'none' } }), { status: 200 });
    });
    const d = new PairingDriver({ client, flow: 'admit' }, { view: { flow: 'admit', step: 'connected' }, busy: false, loading: false });
    const polling = d.poll();
    await d.cancel();
    release();
    await polling;
    expect(d.get().view).toEqual({ flow: 'none' });
  });

  it('choose sends the tapped code; the answer is the control plane\'s view', async () => {
    const done: PairingView = { flow: 'admit', step: 'done', label: 'My iPhone', rows: [] };
    const p = plane({ 'POST /auth/device/pairing/admit/choose': ok(done) });
    const d = new PairingDriver({ client: p.client, flow: 'admit' }, { view: { flow: 'admit', step: 'choose', label: 'My iPhone', kind: 'approve-app', codes: ['111111', '222222', '333333'], rows: [] }, busy: false, loading: false });
    await d.choose('222222');
    expect(p.calls).toEqual(['POST /auth/device/pairing/admit/choose {"code":"222222"}']);
    expect(d.get().view).toEqual(done);
    expect(d.get().busy).toBe(false);
  });

  it('confirm sends the name; a refused name keeps the review', async () => {
    const review: PairingView = { flow: 'join', step: 'review', identityCode: '1', origin: null, devices: [], admitterLabel: 'My iPhone', suggestedLabel: 'This computer', canGrant: true, error: 'label_taken' };
    const p = plane({ 'POST /auth/device/pairing/join/confirm': ok(review) });
    const d = new PairingDriver({ client: p.client, flow: 'join' }, { view: { ...review, error: undefined }, busy: false, loading: false });
    await d.confirm('my iphone');
    expect(p.calls).toEqual(['POST /auth/device/pairing/join/confirm {"label":"my iphone"}']);
    expect(d.get().view).toEqual(review);
  });

  it('cancel is final only when the control plane says so', async () => {
    const p = plane({ 'POST /auth/device/pairing/cancel': refused('locked', 401) });
    const d = new PairingDriver({ client: p.client, flow: 'admit' }, { view: QR, busy: false, loading: false });
    await d.cancel();
    expect(d.get().view).toEqual(QR);
    expect(d.get().error).toBe(T.locked);
  });

  it('after "added" with a sign-in that failed, the retry signs in and shows it', async () => {
    const p = plane({ 'POST /auth/device/signin': () => ({ status: 200, body: { ok: true, expiresAt: 1 } }) });
    const d = new PairingDriver({ client: p.client, flow: 'join' }, { view: { flow: 'join', step: 'done', signedIn: false, signinCode: 'as_error' }, busy: false, loading: false });
    await d.retrySignIn();
    expect(d.get().view).toEqual({ flow: 'join', step: 'done', signedIn: true });
  });
});
