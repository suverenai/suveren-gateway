/**
 * The sign-in's first steps fetched ahead (DeviceSession.prepare, Maria 2026-11-24: the card came seconds after a tap).
 * While the open screen waits for the tap, the server's key is proved and a challenge asked for; the open after the tap then
 * starts with the check. Nothing is signed or checked ahead, and a stale or failed step is never used.
 */
import { describe, it, expect } from 'vitest';
import { PREPARED_FOR } from './session';
import { FakeAs, FakePasskeys, registerPhone, testRuntime } from './test-kit';

async function paired() {
  const as = await FakeAs.create();
  const rt = testRuntime(as);
  await registerPhone(rt, as);
  return { as, rt };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const challenges = (as: FakeAs) => as.calls.filter((c) => c.path === '/api/devices/challenge').length;

describe('the phone\'s sign-in, prepared while the open screen waits', () => {
  it('prepare asks for the key proof and a challenge, signs nothing and asks for no check; open then uses that challenge', async () => {
    const { as, rt } = await paired();
    const proved = (rt.check as FakePasskeys).proved.length;
    const before = challenges(as);
    rt.session.prepare();
    await settle();
    expect(challenges(as)).toBe(before + 1);
    expect((rt.check as FakePasskeys).proved.length).toBe(proved);
    expect(as.calls.some((c) => c.path === '/api/devices/session')).toBe(false);
    const r = await rt.session.open();
    expect(r.ok).toBe(true);
    // The open used the challenge fetched ahead: no second one.
    expect(challenges(as)).toBe(before + 1);
  });

  it('a prepared challenge older than the limit is not used: open asks for a fresh one', async () => {
    const { as, rt } = await paired();
    const before = challenges(as);
    rt.session.prepare();
    await settle();
    as.clock += PREPARED_FOR + 1;
    const r = await rt.session.open();
    expect(r.ok).toBe(true);
    expect(challenges(as)).toBe(before + 2);
  });

  it('a prepared step that failed is never used: open asks again and opens', async () => {
    const { as, rt } = await paired();
    const answer = as.call.bind(as);
    let fail = true;
    as.call = async (m, p, o) => (fail && p === '/api/devices/challenge' ? { status: 503, body: { error: 'down' } } : answer(m, p, o));
    rt.session.prepare();
    await settle();
    fail = false;
    const r = await rt.session.open();
    expect(r.ok).toBe(true);
  });

  it('a prepared challenge is used once: a second open after an end asks for a new one', async () => {
    const { as, rt } = await paired();
    rt.session.prepare();
    await settle();
    const before = challenges(as);
    expect((await rt.session.open()).ok).toBe(true);
    await rt.session.end();
    expect((await rt.session.open()).ok).toBe(true);
    expect(challenges(as)).toBe(before + 1);
  });
});
