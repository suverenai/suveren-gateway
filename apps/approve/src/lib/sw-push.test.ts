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
    registration: { showNotification: async (title: string, opts: never) => { shown.push({ title, opts }); } },
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
  return { push, fire, shown, stored, opened, messages, setWindows: (w: typeof windows) => { windows = w; } };
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

  it('several ids: the count text, and every id recorded once', async () => {
    const w = loadWorker();
    await w.push({ ids: ['a'] });
    await w.push({ ids: ['a', 'b', 'c'] });
    expect(w.shown[1].opts.body).toBe(P.pushMany(3));
    expect(w.stored.get('push:seen')).toEqual(['a', 'b', 'c']);
  });

  it('a message it cannot read still shows the generic notice (a push must show one) and records nothing odd', async () => {
    const w = loadWorker();
    await w.push({ ids: ['<script>', 42, 'ok'] });
    await w.fire('push', { data: { json: () => { throw new Error('not json'); } } });
    expect(w.shown.map((s) => s.opts.body)).toEqual([P.pushOne, P.pushOne]);
    expect(w.stored.get('push:seen')).toEqual(['ok']);
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
