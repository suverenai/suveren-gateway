/**
 * The pairing routes (device-keys plan 4.3, step 11 gateway part), through the REAL routers, vault and page-session guard:
 * mounted only with the device-keys switch on, every one behind the page session, answers never cached, nothing secret
 * in a log. The ceremony itself (the protocol against the phone app's own drivers) is __tests__/device-pairing.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as dk from '@hap/core/device-keys';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { bootGateway, call, sessionHeaders } from '../../__tests__/helpers/device-rig';

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const o of open.splice(0).reverse()) await o.close(); vi.restoreAllMocks(); });

const ROUTES: Array<[string, string]> = [
  ['GET', '/auth/device/devices'], ['GET', '/auth/device/pairing/status'],
  ['POST', '/auth/device/pairing/admit/start'], ['POST', '/auth/device/pairing/admit/choose'],
  ['POST', '/auth/device/pairing/join/start'], ['POST', '/auth/device/pairing/join/confirm'], ['POST', '/auth/device/pairing/cancel'],
];

async function world(enabled = true) {
  const as = await new StubAs().listen();
  open.push(as);
  const gw = await bootGateway({ as, enabled });
  open.push(gw);
  const session = enabled ? await gw.unlock().catch(() => null) : null;
  const h = session ? sessionHeaders(session) : {};
  return {
    as, gw, h,
    get: (p: string) => call(gw.port, 'GET', p, { headers: h }),
    post: (p: string, body: unknown = {}) => call(gw.port, 'POST', p, { headers: h, body }),
  };
}

describe('the switch and the page session', () => {
  it('off: none of the pairing routes exist (404)', async () => {
    const w = await world(false);
    for (const [m, p] of ROUTES) expect((await call(w.gw.port, m, p, { body: m === 'POST' ? {} : undefined })).status, `${m} ${p}`).toBe(404);
  });

  it('on: every route refuses a request without the page session, and one from a foreign origin', async () => {
    const w = await world();
    for (const [m, p] of ROUTES) {
      expect((await call(w.gw.port, m, p, { body: m === 'POST' ? {} : undefined })).status, `${m} ${p} no session`).toBe(401);
      if (m === 'POST') expect((await call(w.gw.port, m, p, { headers: w.h, body: {}, origin: 'http://evil.example' })).status, `${p} foreign origin`).toBe(403);
    }
  });
});

describe('a computer that is not set up: "Add this computer"', () => {
  it('shows a joiner QR with nothing of an account in it, never cached, and the secret reaches no log line', async () => {
    const w = await world();
    const logs: string[] = [];
    for (const k of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    expect((await w.get('/auth/device/pairing/status')).body).toMatchObject({ ok: true, view: { flow: 'none' } });
    const r = await w.post('/auth/device/pairing/join/start');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const view = r.body.view as { flow: string; step: string; qr: string };
    expect(view).toMatchObject({ flow: 'join', step: 'qr' });
    const qr = dk.decodePairingQr(view.qr, { now: Math.floor(Date.now() / 1000) });
    expect(qr).toMatchObject({ shown_by: 'joiner', as_url: w.as.url, root_did: null, head: null, key_id: null });
    expect(logs.join('\n')).not.toContain(qr.secret);
    // the status read looks at the mailbox, which does not exist yet: still waiting, not failed
    expect((await w.get('/auth/device/pairing/status')).body).toMatchObject({ view: { flow: 'join', step: 'qr' } });
    // a second one is refused until the first is cancelled
    expect((await w.post('/auth/device/pairing/join/start')).body).toMatchObject({ code: 'pairing_pending' });
    expect((await w.post('/auth/device/pairing/cancel')).body).toMatchObject({ view: { flow: 'none' } });
    const again = await w.post('/auth/device/pairing/join/start');
    expect(again.body.code ?? again.status).toBe(200);
  });

  it('cannot add a phone or list devices: there is no account on this computer', async () => {
    const w = await world();
    expect((await w.post('/auth/device/pairing/admit/start')).body).toMatchObject({ code: 'not_set_up' });
    expect((await w.get('/auth/device/devices')).body).toMatchObject({ code: 'not_set_up' });
    expect((await w.post('/auth/device/pairing/admit/choose', { code: '123456' })).body).toMatchObject({ code: 'pairing_unknown' });
    expect((await w.post('/auth/device/pairing/join/confirm', { label: 'x' })).body).toMatchObject({ code: 'pairing_unknown' });
  });
});

describe('a computer that is set up', () => {
  it('refuses "Add this computer" (it has the account), lists its device, and cannot add a phone without a check key', async () => {
    const w = await world();
    const start = await w.post('/auth/device/setup/start');
    const fin = await w.post('/auth/device/setup/finish', { setupId: start.body.setupId, enrolmentCode: w.as.issueEnrolmentCode() });
    expect(fin.status).toBe(200);
    expect((await w.post('/auth/device/pairing/join/start')).body).toMatchObject({ code: 'already_set_up' });
    const list = await w.get('/auth/device/devices');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ ok: true, canGrant: false, hasRoom: true, rows: [{ label: 'This computer', thisDevice: true, canGrant: false, kind: 'gateway' }] });
    expect(list.body.identityCode).toBe(await dk.identityCode(String(start.body.rootDid)));
    expect((await w.post('/auth/device/pairing/admit/start')).body).toMatchObject({ code: 'cannot_grant' });
  });
});
