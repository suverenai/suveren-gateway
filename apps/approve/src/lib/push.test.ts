import { describe, it, expect } from 'vitest';
import { MemoryKv } from './kv';
import { AsApi } from './as-api';
import type { Transport, Reply, Method } from './transport';
import { PushControl, requestFromHash, RESYNC_KEY, SEEN_KEY, SINCE_KEY, type PushPlatform, type SubscriptionLike } from './push';

const KEY = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const keyBytes = () => Uint8Array.from(atob(KEY.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (KEY.length % 4)) % 4)), (c) => c.charCodeAt(0));

class FakeTransport implements Transport {
  calls: { method: Method; path: string; body?: unknown; bearer?: string }[] = [];
  answers = new Map<string, Reply>();
  async call(method: Method, path: string, opts: { body?: unknown; bearer?: string } = {}): Promise<Reply> {
    this.calls.push({ method, path, ...opts });
    return this.answers.get(`${method} ${path}`) ?? { status: 200, body: method === 'GET' && path === '/api/push/key' ? { key: KEY } : {} };
  }
}

class FakeSub implements SubscriptionLike {
  unsubscribed = false;
  constructor(readonly endpoint: string, readonly options: { applicationServerKey: ArrayBuffer | null }) {}
  toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }
  async unsubscribe() { this.unsubscribed = true; return true; }
}

function platform(o: Partial<{ supported: boolean; permission: NotificationPermission; answer: NotificationPermission; sub: FakeSub | null; failSubscribe: boolean }> = {}) {
  const st = { supported: true, permission: 'default' as NotificationPermission, answer: 'granted' as NotificationPermission, sub: null as FakeSub | null, failSubscribe: false, asked: 0, subscribedWith: null as Uint8Array | null, ...o };
  const p: PushPlatform = {
    supported: () => st.supported,
    permission: () => st.permission,
    requestPermission: async () => { st.asked++; st.permission = st.answer; return st.answer; },
    getSubscription: async () => st.sub,
    subscribe: async (k) => {
      if (st.failSubscribe) throw new Error('no');
      st.subscribedWith = k;
      st.sub = new FakeSub('https://fcm.googleapis.com/x', { applicationServerKey: k.buffer as ArrayBuffer });
      return st.sub;
    },
  };
  return { p, st };
}

function control(pl: PushPlatform, t = new FakeTransport(), kv = new MemoryKv()) {
  return { c: new PushControl({ platform: pl, api: new AsApi(t), kv, now: () => 1000 }), t, kv };
}

describe('turning notifications on', () => {
  it('asks the permission, subscribes with the AS key and stores the subscription with the phone session', async () => {
    const { p, st } = platform();
    const { c, t, kv } = control(p);
    expect(await c.state()).toBe('off');
    expect(await c.turnOn('tok')).toEqual({ ok: true });
    expect(st.asked).toBe(1);
    expect([...st.subscribedWith!]).toEqual([...keyBytes()]);
    const put = t.calls.find((x) => x.method === 'PUT')!;
    expect(put.path).toBe('/api/devices/me/push');
    expect(put.bearer).toBe('tok');
    expect(put.body).toEqual({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } });
    expect(await kv.get(SINCE_KEY)).toBe(1000);
    expect(await c.state()).toBe('on');
  });

  it('a refused or dismissed permission stores nothing and says which', async () => {
    for (const answer of ['denied', 'default'] as const) {
      const { p } = platform({ answer });
      const { c, t } = control(p);
      expect(await c.turnOn('tok')).toEqual({ ok: false, code: answer === 'denied' ? 'push_denied' : 'push_dismissed' });
      expect(t.calls.filter((x) => x.method === 'PUT')).toHaveLength(0);
    }
  });

  it('an AS without push, a failed subscribe and an unsupported phone are each a code, never a throw', async () => {
    const t = new FakeTransport();
    t.answers.set('GET /api/push/key', { status: 503, body: { approved: false, errors: [{ code: 'PUSH_NOT_CONFIGURED', message: 'x' }] } });
    expect(await control(platform().p, t).c.turnOn('tok')).toEqual({ ok: false, code: 'PUSH_NOT_CONFIGURED' });
    expect(await control(platform({ failSubscribe: true }).p).c.turnOn('tok')).toEqual({ ok: false, code: 'push_subscribe_failed' });
    expect(await control(platform({ supported: false }).p).c.turnOn('tok')).toEqual({ ok: false, code: 'push_unsupported' });
    expect(await control(platform({ supported: false }).p).c.state()).toBe('unsupported');
    expect(await control(platform({ permission: 'denied' }).p).c.state()).toBe('denied');
  });

  it('a subscription made with another server key is replaced', async () => {
    const old = new FakeSub('https://fcm.googleapis.com/old', { applicationServerKey: new Uint8Array(65).fill(9).buffer });
    const { p, st } = platform({ permission: 'granted', sub: old });
    const { c, t } = control(p);
    expect(await c.turnOn('tok')).toEqual({ ok: true });
    expect(old.unsubscribed).toBe(true);
    expect((t.calls.find((x) => x.method === 'PUT')!.body as { endpoint: string }).endpoint).toBe('https://fcm.googleapis.com/x');
    expect(st.asked).toBe(0);
  });

  it('turning off deletes at the AS and in the browser', async () => {
    const { p, st } = platform();
    const { c, t, kv } = control(p);
    await c.turnOn('tok');
    const sub = st.sub!;
    expect(await c.turnOff('tok')).toEqual({ ok: true });
    expect(t.calls.some((x) => x.method === 'DELETE' && x.path === '/api/devices/me/push' && x.bearer === 'tok')).toBe(true);
    expect(sub.unsubscribed).toBe(true);
    expect(await kv.get(SINCE_KEY)).toBeUndefined();
  });

  it('resync sends the subscription again only when it is on', async () => {
    const { p } = platform();
    const { c, t } = control(p);
    await c.resync('tok');
    expect(t.calls).toHaveLength(0);
    await c.turnOn('tok');
    t.calls.length = 0;
    await c.resync('tok2');
    expect(t.calls.filter((x) => x.method === 'PUT').map((x) => `${x.method} ${x.bearer}`)).toEqual(['PUT tok2']);
  });

  it('L3: resync makes a subscription the browser dropped again, when the person had turned notifications on', async () => {
    const { p, st } = platform();
    const { c, t, kv } = control(p);
    await c.turnOn('tok');
    st.sub = null; // the browser dropped it (pushsubscriptionchange without a new one)
    await kv.set(RESYNC_KEY, true);
    t.calls.length = 0;
    await c.resync('tok3');
    expect(st.sub).not.toBeNull();
    expect(t.calls.filter((x) => x.method === 'PUT').map((x) => x.bearer)).toEqual(['tok3']);
    expect(await kv.get(RESYNC_KEY)).toBeUndefined();
    expect(await c.state()).toBe('on');
  });

  it('L3: resync does nothing when the person turned them off, or the permission was withdrawn', async () => {
    const { p, st } = platform();
    const { c, t } = control(p);
    await c.turnOn('tok');
    await c.turnOff('tok');
    t.calls.length = 0;
    await c.resync('tok');
    expect(t.calls).toHaveLength(0);
    const two = platform();
    const ctl = control(two.p);
    await ctl.c.turnOn('tok');
    two.st.permission = 'denied';
    ctl.t.calls.length = 0;
    await ctl.c.resync('tok');
    expect(ctl.t.calls).toHaveLength(0);
    expect(st.asked).toBe(1);
  });

  it('L1: a server key that does not decode is a code, never a throw', async () => {
    const t = new FakeTransport();
    t.answers.set('GET /api/push/key', { status: 200, body: { key: '%%% not base64 %%%' } });
    expect(await control(platform().p, t).c.turnOn('tok')).toEqual({ ok: false, code: 'push_subscribe_failed' });
  });

  it('turnOn and turnOff never throw, whatever the transport does', async () => {
    const boom: Transport = { call: async () => { throw new Error('boom'); } };
    const { p } = platform();
    const c = new PushControl({ platform: p, api: new AsApi(boom), kv: new MemoryKv(), now: () => 1 });
    expect(await c.turnOn('tok')).toEqual({ ok: false, code: 'push_subscribe_failed' });
    expect((await c.turnOff('tok')).ok).toBe(false);
    await expect(c.resync('tok')).resolves.toBeUndefined();
  });
});

describe('requests that came without a notice', () => {
  it('counts waiting requests since it was turned on that no notification named', async () => {
    const { p } = platform();
    const { c, kv } = control(p);
    expect(await c.missed([{ id: 'a', createdAt: 2000 }])).toBe(0); // off: nothing counted
    await c.turnOn('tok');
    await kv.set(SEEN_KEY, ['a']);
    expect(await c.missed([{ id: 'a', createdAt: 2000 }, { id: 'b', createdAt: 2000 }, { id: 'old', createdAt: 999 }])).toBe(1);
  });
});

describe('the link a notification opens', () => {
  it('reads #request=<id> and nothing else', () => {
    expect(requestFromHash('#request=prop_abc-1')).toBe('prop_abc-1');
    for (const h of ['', '#', '#request=', '#request=a b', '#request=<x>', '#other=1', `#request=${'a'.repeat(129)}`]) expect(requestFromHash(h), h).toBeNull();
  });
});
