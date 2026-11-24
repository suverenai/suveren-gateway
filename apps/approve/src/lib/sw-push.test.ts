/**
 * The service worker's push handling (public/sw.js), run in a sandbox with stand-ins for the worker globals:
 * what it shows for a push, what it records, and where a tap takes the person.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { P } from '../texts';

type Handler = (e: unknown) => void;

function loadWorker() {
  const handlers: Record<string, Handler> = {};
  const shown: { title: string; opts: { body: string; data: { ids: string[] }; tag: string; actions?: unknown } }[] = [];
  const stored = new Map<string, unknown>();
  const opened: string[] = [];
  const messages: unknown[] = [];
  let windows: { url: string; focus: () => Promise<void>; postMessage: (m: unknown) => void }[] = [];
  const subscribed: unknown[] = [];
  // A tiny IndexedDB stand-in: one store, get/put, completes asynchronously.
  const indexedDB = {
    open() {
      const r: Record<string, unknown> = {};
      setTimeout(() => {
        r.result = {
          close() {},
          transaction() {
            const tx: Record<string, unknown> = {};
            tx.objectStore = () => ({
              get(key: string) { const q: Record<string, unknown> = {}; setTimeout(() => { q.result = stored.get(key); (q.onsuccess as () => void)?.(); }); return q; },
              put(v: unknown, key: string) { stored.set(key, v); setTimeout(() => (tx.oncomplete as () => void)?.(), 1); },
            });
            return tx;
          },
        };
        (r.onsuccess as () => void)?.();
      });
      return r;
    },
  };
  const self = {
    location: { origin: 'https://approve.example' },
    addEventListener: (t: string, h: Handler) => { handlers[t] = h; },
    registration: {
      showNotification: async (title: string, opts: never) => { shown.push({ title, opts }); },
      // The notice still on screen is the last one shown under the tag (each replaces the one before).
      getNotifications: async ({ tag }: { tag: string }) => { const last = shown.at(-1); return last && last.opts.tag === tag ? [{ data: last.opts.data }] : []; },
      pushManager: { subscribe: async (o: unknown) => { subscribed.push(o); return {}; } },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (u: string) => { opened.push(u); },
      claim: async () => {},
    },
  };
  vm.runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), { self, indexedDB, caches: {}, fetch, URL, Request: class {}, setTimeout, Promise, Array, String, JSON });
  const fire = async (type: string, e: Record<string, unknown>) => {
    let p: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...e, waitUntil: (x: Promise<unknown>) => { p = x; } });
    await p;
  };
  const push = (body: unknown) => fire('push', { data: { json: () => (typeof body === 'string' ? JSON.parse(body) : body) } });
  return { push, fire, shown, stored, opened, messages, subscribed, setWindows: (w: typeof windows) => { windows = w; } };
}

describe('public/sw.js: push', () => {
  it('one id: the generic one-request text, no action, and the id recorded', async () => {
    const w = loadWorker();
    await w.push({ ids: ['prop_1'] });
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe(P.pushTitle);
    expect(w.shown[0].opts.body).toBe(P.pushOne);
    expect(w.shown[0].opts.actions).toBeUndefined();
    expect(w.stored.get('push:seen')).toEqual(['prop_1']);
  });

  it('an open app is told at once, so it reads its list now and not at its next refresh (e2e: the card came ~5 s after the notice)', async () => {
    const w = loadWorker();
    const told: unknown[] = [];
    let focused = 0;
    w.setWindows([
      { url: 'https://approve.example/', focus: async () => { focused++; }, postMessage: (m) => told.push(m) },
      { url: 'https://elsewhere.example/', focus: async () => { focused++; }, postMessage: (m) => told.push({ wrongOrigin: m }) },
    ]);
    await w.push({ ids: ['prop_9'] });
    // no ids in the message (the app reads them with its own session), never focused (the notice is still the person's to tap)
    expect(told).toEqual([{ t: 'pushed' }]);
    expect(focused).toBe(0);
    expect(w.shown).toHaveLength(1);
  });

  it('several ids: the count text, and every id recorded once', async () => {
    const w = loadWorker();
    await w.push({ ids: ['a'] });
    await w.push({ ids: ['a', 'b', 'c'] });
    expect(w.shown[1].opts.body).toBe(P.pushMany(3));
    expect(w.shown[1].opts.data.ids).toEqual(['a', 'b', 'c']);
    expect(w.stored.get('push:seen')).toEqual(['a', 'b', 'c']);
  });

  it('a message it cannot read still shows the generic notice (a push must show one) and records nothing odd', async () => {
    const w = loadWorker();
    await w.push({ ids: ['<script>', 42, 'ok'] });
    await w.fire('push', { data: { json: () => { throw new Error('not json'); } } });
    expect(w.shown.map((s) => s.opts.body)).toEqual([P.pushOne, P.pushOne]);
    expect(w.stored.get('push:seen')).toEqual(['ok']);
  });

  it('L2: a new notice replacing one still shown carries its ids: the count and a tap cover both', async () => {
    const w = loadWorker();
    await w.push({ ids: ['first'] });
    await w.push({ ids: ['second'] });
    expect(w.shown[1].opts.body).toBe(P.pushMany(2));
    expect(w.shown[1].opts.data.ids).toEqual(['first', 'second']);
    await w.fire('notificationclick', { notification: { close: () => {}, data: w.shown[1].opts.data } });
    expect(w.opened).toEqual(['/']);
  });

  it('a request the app found no longer waiting is left out of the merged notice: one waiting reads as one (lock screen said 2, 2026-11-24)', async () => {
    const w = loadWorker();
    await w.push({ ids: ['decided'] });
    // The app read its list after the person decided: it recorded the id as done (src/lib/push.ts settle).
    w.stored.set('push:done', ['decided']);
    await w.push({ ids: ['waiting'] });
    expect(w.shown[1].opts.body).toBe(P.pushOne);
    expect(w.shown[1].opts.data.ids).toEqual(['waiting']);
  });

  it('L3: a replaced subscription is made again with the same server key and the app is marked to send it', async () => {
    const w = loadWorker();
    const key = new Uint8Array([4, 1, 2]).buffer;
    await w.fire('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: key } }, newSubscription: null });
    expect(w.subscribed).toEqual([{ userVisibleOnly: true, applicationServerKey: key }]);
    expect(w.stored.get('push:resync')).toBe(true);
    await w.fire('pushsubscriptionchange', { oldSubscription: null, newSubscription: {} });
    expect(w.subscribed).toHaveLength(1);
  });

  it('a tap opens the app at the one request, or at the list; an open window is focused and told instead', async () => {
    const w = loadWorker();
    const close = () => {};
    await w.fire('notificationclick', { notification: { close, data: { ids: ['prop_1'] } } });
    await w.fire('notificationclick', { notification: { close, data: { ids: ['a', 'b'] } } });
    expect(w.opened).toEqual(['/#request=prop_1', '/']);
    const told: unknown[] = [];
    let focused = 0;
    w.setWindows([{ url: 'https://approve.example/', focus: async () => { focused++; }, postMessage: (m) => told.push(m) }]);
    await w.fire('notificationclick', { notification: { close, data: { ids: ['prop_2'] } } });
    expect(focused).toBe(1);
    expect(told).toEqual([{ t: 'open-request', id: 'prop_2' }]);
    expect(w.opened).toHaveLength(2);
  });
});

describe('device notices (the device list changed, a recovery was started, a new identity was asked for)', () => {
  it('each kind shows its own fixed text under its own tag, never anything from the message, and a tap opens Devices', async () => {
    const w = loadWorker();
    await w.fire('push', { data: { json: () => ({ notice: 'devices-changed', label: '<script>x</script>' }) } });
    await w.fire('push', { data: { json: () => ({ notice: 'recovery-started' }) } });
    await w.fire('push', { data: { json: () => ({ notice: 'identity-reset' }) } });
    expect(w.shown.map((s) => s.opts.body)).toEqual([P.pushDevicesChanged, P.pushRecoveryStarted, P.pushIdentityReset]);
    expect(w.shown.every((s) => s.opts.tag === 'suveren-devices' && !JSON.stringify(s.opts).includes('script'))).toBe(true);
    await w.fire('notificationclick', { notification: { close() {}, data: { devices: true } } });
    expect(w.opened).toEqual(['/#devices']);
  });

  it('an unknown notice kind is a request notice (the generic text), not a device notice', async () => {
    const w = loadWorker();
    await w.fire('push', { data: { json: () => ({ notice: 'something-else' }) } });
    expect(w.shown[0].opts.body).toBe(P.pushOne);
  });
});
