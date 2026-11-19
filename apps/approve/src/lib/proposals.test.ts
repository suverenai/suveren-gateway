import { describe, it, expect } from 'vitest';
import { IDLE_LIMIT } from './session';
import { FakeAs, registerPhone, testRuntime } from './test-kit';

const prop = (id: string, createdAt: number) => ({ id, createdAt, tool: 'email__send_message', status: 'pending', expiresAt: createdAt + 86400 });

async function world() {
  const as = await FakeAs.create();
  const rt = testRuntime(as);
  await registerPhone(rt, as);
  expect((await rt.session.open()).ok).toBe(true);
  return { as, rt };
}

describe('reading proposals (stage D1 is read-only)', () => {
  it('lists what is pending for the person and what awaits their approval, once each, newest first', async () => {
    const { as, rt } = await world();
    as.pending = [prop('p1', 100), prop('p2', 300)];
    as.approverPending = [prop('p2', 300), prop('p3', 200)];
    const r = await rt.reader.list(true);
    expect(r.ok && r.data.map((p) => p.id)).toEqual(['p2', 'p3', 'p1']);
    const paths = as.calls.filter((c) => c.path.startsWith('/api/proposals')).map((c) => c.path);
    expect(paths).toEqual(expect.arrayContaining(['/api/proposals?domain=user-1', '/api/proposals?approver=me']));
    // Only the bearer token of the phone session is sent, nothing else.
    expect(as.calls.filter((c) => c.path.startsWith('/api/proposals')).every((c) => c.bearer === rt.session.bearer())).toBe(true);
  });

  it('a list the person asked for counts as use of the session; a list on a timer does not', async () => {
    const { as, rt } = await world();
    as.clock += IDLE_LIMIT - 60;
    expect((await rt.reader.list(false)).ok).toBe(true); // polling
    as.clock += 120;
    expect(rt.session.bearer()).toBeNull(); // an hour of no use, whatever the polling did

    const second = await world();
    second.as.clock += IDLE_LIMIT - 60;
    expect((await second.rt.reader.list(true)).ok).toBe(true); // the person
    second.as.clock += 120;
    expect(second.rt.session.bearer()).not.toBeNull();
  });

  it('a session the server no longer knows ends the phone\'s session and says so', async () => {
    const { as, rt } = await world();
    as.sessions.clear();
    expect(await rt.reader.list(true)).toEqual({ ok: false, code: 'session_ended' });
    expect(rt.session.bearer()).toBeNull();
    expect(await rt.reader.get('p1')).toEqual({ ok: false, code: 'session_ended' });
  });

  it('a server that cannot be reached is not "nothing is waiting"', async () => {
    const { as, rt } = await world();
    as.down = true;
    expect(await rt.reader.list(true)).toEqual({ ok: false, code: 'as_unreachable' });
  });

  it('one request, fresh from the server; an unknown one is refused, not invented', async () => {
    const { as, rt } = await world();
    as.byId.set('p1', prop('p1', 100));
    const r = await rt.reader.get('p1');
    expect(r.ok && r.data.id).toBe('p1');
    expect(await rt.reader.get('missing')).toEqual({ ok: false, code: 'refused' });
  });

  it('without a session nothing is read', async () => {
    const as = await FakeAs.create();
    const rt = testRuntime(as);
    await registerPhone(rt, as);
    expect(await rt.reader.list(true)).toEqual({ ok: false, code: 'session_ended' });
    expect(as.calls.some((c) => c.path.startsWith('/api/proposals'))).toBe(false);
  });
});
