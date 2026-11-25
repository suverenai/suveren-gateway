/**
 * The page's routes of the phone path (routes/confirm-phone.ts): only with the switch on, only with the page session, a request id in its
 * one shape. The path itself (sealing, the phone's answer, the verification) is covered in __tests__/phone-confirmation.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { StubAs } from '../../__tests__/helpers/stub-as';
import { bootGateway, call, sessionHeaders } from '../../__tests__/helpers/device-rig';

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const o of open.splice(0).reverse()) await o.close(); });

async function rig(enabled = true) {
  const as = await new StubAs().listen();
  open.push(as);
  const g = await bootGateway({ as, enabled });
  open.push(g);
  return g;
}

describe('/auth/confirm/phone', () => {
  it('with the switch off nothing of it exists', async () => {
    const g = await rig(false);
    expect((await call(g.port, 'POST', '/auth/confirm/phone', { body: { request_id: 'AAAAAAAAAAAAAAAAAAAAAA' } })).status).toBe(404);
  });

  it('refuses every handler without the page session', async () => {
    const g = await rig();
    for (const [m, p] of [['POST', '/auth/confirm/phone'], ['GET', '/auth/confirm/phone/AAAAAAAAAAAAAAAAAAAAAA'], ['DELETE', '/auth/confirm/phone/AAAAAAAAAAAAAAAAAAAAAA']] as const) {
      const r = await call(g.port, m, p, { body: { request_id: 'AAAAAAAAAAAAAAAAAAAAAA' } });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it('with the page session: a bad id is 400, a computer without device keys set up gets "not set up", an unknown request 404', async () => {
    const g = await rig();
    const s = await g.unlock();
    expect((await call(g.port, 'POST', '/auth/confirm/phone', { body: { request_id: 'short' }, headers: sessionHeaders(s) })).status).toBe(400);
    expect((await call(g.port, 'GET', '/auth/confirm/phone/not-an-id', { headers: sessionHeaders(s) })).status).toBe(400);
    const r = await call(g.port, 'POST', '/auth/confirm/phone', { body: { request_id: 'AAAAAAAAAAAAAAAAAAAAAA' }, headers: sessionHeaders(s) });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('not_set_up');
    expect((await call(g.port, 'GET', '/auth/confirm/phone/AAAAAAAAAAAAAAAAAAAAAA', { headers: sessionHeaders(s) })).body.code).toBe('request_unknown');
  });
});
