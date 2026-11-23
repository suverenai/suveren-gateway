/**
 * The service worker's answer to opening the app after an update (public/sw.js, fetch handler), run in a sandbox with a cache and a
 * network stand-in: v1 is installed (its page and files cached), v2 is served — the next open runs v2 (dev lane 2026-11-23: a closed and
 * reopened app ran the old build once, and the person decided with old code). Without a network, the cached page still opens.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

type FetchHandler = (e: { request: Req; respondWith: (p: Promise<Res>) => void; waitUntil: (p: Promise<unknown>) => void }) => void;
interface Req { url: string; method: string; mode?: string }
interface Res { ok: boolean; body: string; clone: () => Res }

const res = (body: string): Res => ({ ok: true, body, clone() { return res(body); } });

function worker(network: { online: boolean; files: Record<string, string> }) {
  let onFetch: FetchHandler | undefined;
  const store = new Map<string, Res>();
  const keyOf = (r: Req | string) => (typeof r === 'string' ? new URL(r, 'https://approve.example').pathname : new URL(r.url).pathname);
  const caches = {
    open: async () => ({
      match: async (r: Req) => store.get(keyOf(r)),
      put: async (r: Req, v: Res) => { store.set(keyOf(r), v); },
    }),
    keys: async () => [],
    delete: async () => true,
  };
  const fetched: Array<{ path: string; cache?: string }> = [];
  const fetchFn = async (r: Req, init?: { cache?: string }) => {
    fetched.push({ path: keyOf(r), cache: init?.cache });
    if (!network.online) throw new TypeError('offline');
    const body = network.files[keyOf(r)];
    return body === undefined ? { ok: false, body: '', clone() { return this; } } : res(body);
  };
  class Request { url: string; method = 'GET'; mode?: string; constructor(u: string) { this.url = new URL(u, 'https://approve.example').toString(); } }
  const self = {
    location: { origin: 'https://approve.example' },
    addEventListener: (t: string, h: FetchHandler) => { if (t === 'fetch') onFetch = h; },
    registration: {}, clients: { claim: async () => {} },
  };
  vm.runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), { self, caches, fetch: fetchFn, URL, Request, setTimeout, Promise, Array, String, JSON, indexedDB: {} });
  const ask = async (path: string, mode?: string): Promise<string> => {
    let out: Promise<Res> | undefined;
    const pending: Promise<unknown>[] = [];
    onFetch!({ request: { url: `https://approve.example${path}`, method: 'GET', mode }, respondWith: (p) => { out = p; }, waitUntil: (p) => { pending.push(p); } });
    const r = await out!;
    await Promise.all(pending);
    return r.body;
  };
  return { ask, store, fetched };
}

describe('public/sw.js: opening the app after an update', () => {
  it('v1 installed, v2 served: the next open runs v2 (the page from the network first, without the browser cache)', async () => {
    const net = { online: true, files: { '/': '<script src="/assets/index-v1.js">', '/assets/index-v1.js': 'v1' } as Record<string, string> };
    const w = worker(net);
    expect(await w.ask('/', 'navigate')).toContain('index-v1.js');
    expect(await w.ask('/assets/index-v1.js')).toBe('v1');
    // the update is served
    net.files = { '/': '<script src="/assets/index-v2.js">', '/assets/index-v2.js': 'v2' };
    const page = await w.ask('/#request=p1', 'navigate');
    expect(page).toContain('index-v2.js');
    expect(await w.ask('/assets/index-v2.js')).toBe('v2');
    expect(w.fetched.filter((f) => f.path === '/').every((f) => f.cache === 'no-store')).toBe(true);
  });

  it('without a network the last page this phone had still opens', async () => {
    const net = { online: true, files: { '/': '<p>v1</p>' } as Record<string, string> };
    const w = worker(net);
    await w.ask('/', 'navigate');
    net.online = false;
    expect(await w.ask('/', 'navigate')).toBe('<p>v1</p>');
  });
});
