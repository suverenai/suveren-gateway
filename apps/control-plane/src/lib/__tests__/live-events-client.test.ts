/**
 * The gateway's live connection (0.46.1, DEC-107): hello → up + one catch-up read; changes pass through only as known
 * kinds with a plain id; a 404 means "keep polling" and is re-checked after 5 minutes; a planned end reconnects at
 * once without dropping to "down"; a failure drops to "down" and backs off; a lock closes the stream.
 */
import { describe, it, expect } from 'vitest';
import { LiveEventsClient, parseChange, NOT_OFFERED_RECHECK_MS, type LiveKind } from '../live-events-client';

function sse(frames: string[], opts: { keepOpen?: boolean } = {}): { res: Response; push: (f: string) => void; close: () => void } {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; for (const f of frames) c.enqueue(enc.encode(f)); if (!opts.keepOpen) c.close(); } });
  return { res: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }), push: (f) => ctl.enqueue(enc.encode(f)), close: () => ctl.close() };
}
const HELLO = 'retry: 1000\nevent: hello\ndata: {"mode":"listen","maxStreamS":240}\n\n';
const tick = () => new Promise((r) => setTimeout(r, 10));

function harness(opens: Array<() => Response | Promise<Response>>, ready = () => true) {
  const changes: Array<[LiveKind, string | null]> = [];
  const status: boolean[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const client = new LiveEventsClient({
    ready,
    open: async () => {
      const f = opens[Math.min(i++, opens.length - 1)];
      return f();
    },
    onChange: (k, id) => changes.push([k, id]),
    onStatus: (up) => status.push(up),
    sleep: async (ms) => { sleeps.push(ms); await tick(); if (sleeps.length > 8) client.stop(); },
  });
  return { client, changes, status, sleeps, opened: () => i };
}

describe('LiveEventsClient', () => {
  it('hello → up and one catch-up read; a change passes through as kind + id', async () => {
    const s = sse([HELLO, 'event: change\ndata: {"t":"proposal","i":"abc123"}\n\n', ':ka\n\n'], { keepOpen: true });
    const h = harness([() => s.res]);
    h.client.start();
    await tick(); await tick();
    expect(h.status).toEqual([true]);
    expect(h.changes).toEqual([['resync', null], ['proposal', 'abc123']]);
    h.client.stop();
    expect(h.status).toEqual([true, false]);
  });

  it('a 404 keeps polling: never up, re-checked after 5 minutes', async () => {
    const h = harness([() => new Response('{"error":"Not found"}', { status: 404 })]);
    h.client.start();
    await tick(); await tick();
    expect(h.status).toEqual([]);
    expect(h.sleeps[0]).toBe(NOT_OFFERED_RECHECK_MS);
    h.client.stop();
  });

  it('a planned end reconnects without going down, and reads once to catch up', async () => {
    let n = 0;
    const h = harness([() => { n++; return sse([HELLO], { keepOpen: n > 1 }).res; }]);
    h.client.start();
    for (let k = 0; k < 10 && h.opened() < 2; k++) await tick();
    await tick();
    expect(h.opened()).toBe(2);
    expect(h.status).toEqual([true]); // never false in between
    expect(h.changes.filter(([k]) => k === 'resync')).toHaveLength(2);
    h.client.stop();
  });

  it('a planned reconnect sends the last version and skips the catch-up when the AS says nothing changed', async () => {
    let n = 0;
    const sinces: Array<number | undefined> = [];
    const changes: string[] = [];
    const client = new LiveEventsClient({
      ready: () => true,
      open: async (_s, since) => {
        sinces.push(since);
        n++;
        if (n === 1) return sse(['event: hello\ndata: {"v":5,"catchUp":true}\n\n', 'event: change\ndata: {"t":"proposal","i":"p1","v":7}\n\n']).res;
        return sse(['event: hello\ndata: {"v":7,"catchUp":false}\n\n'], { keepOpen: true }).res;
      },
      onChange: (k) => changes.push(k),
      onStatus: () => {},
      sleep: async () => { await tick(); },
    });
    client.start();
    for (let k = 0; k < 20 && n < 2; k++) await tick();
    await tick();
    expect(sinces).toEqual([undefined, 7]);
    expect(changes).toEqual(['resync', 'proposal']); // no second resync
    client.stop();
  });

  it('a failure goes down and backs off', async () => {
    const h = harness([() => { throw new Error('ECONNREFUSED'); }]);
    h.client.start();
    for (let k = 0; k < 5; k++) await tick();
    expect(h.status).toEqual([]);
    expect(h.sleeps.slice(0, 3)).toEqual([1_000, 2_000, 5_000]);
    h.client.stop();
  });

  it('a locked gateway does not connect', async () => {
    const h = harness([() => sse([HELLO]).res], () => false);
    h.client.start();
    for (let k = 0; k < 3; k++) await tick();
    expect(h.opened()).toBe(0);
    h.client.stop();
  });
});

describe('parseChange', () => {
  it('passes only known kinds and plain ids', () => {
    expect(parseChange('{"t":"mandates","i":"authz_1-2"}')).toEqual({ kind: 'mandates', id: 'authz_1-2', v: undefined });
    expect(parseChange('{"t":"mandates","i":"a","v":12}')).toEqual({ kind: 'mandates', id: 'a', v: 12 });
    expect(parseChange('{"t":"evil","i":"x"}')).toBeNull();
    expect(parseChange('{"t":"proposal","i":"<script>"}')).toEqual({ kind: 'proposal', id: null, v: undefined });
    expect(parseChange('not json')).toBeNull();
  });
});
