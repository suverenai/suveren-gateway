import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createEventsHandler } from '../routes/events';
import { eventBus } from '../lib/event-bus';
import { isAllowedHost, hostnameOf, requireAllowedHost } from '../middleware/host-guard';

function fakeRes() {
  const headers: Record<string, string> = {};
  const writes: string[] = [];
  const res = {
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
    getHeader: (k: string) => headers[k.toLowerCase()],
    flushHeaders: () => {},
    write: (chunk: string) => { writes.push(chunk); return true; },
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
  return { res, headers, writes };
}

function fakeReq(host?: string) {
  const handlers: Record<string, () => void> = {};
  const req = {
    headers: host ? { host } : {},
    on: (ev: string, cb: () => void) => { handlers[ev] = cb; },
  } as unknown as Request;
  return { req, close: () => handlers.close?.() };
}

describe('/events SSE stream', () => {
  it('never writes a payload to the wire, even when one is emitted', () => {
    const { res, writes } = fakeRes();
    const { req, close } = fakeReq('localhost:3402');
    createEventsHandler()(req, res);

    // The bus allows a payload. The stream must drop it: this frame is read by
    // anything that ever gets access to the stream, so it carries presence only.
    eventBus.emit('proposal-added', { title: 'Refund €4,000 to acme', amount: 4000 });

    const frame = writes.join('');
    expect(frame).toContain('event: proposal-added');
    expect(frame).toContain('data: null');
    expect(frame).not.toContain('4000');
    expect(frame).not.toContain('acme');
    close();
  });

  it('sets no CORS header — the absence is what blocks cross-origin reads', () => {
    const { res, headers } = fakeRes();
    const { req, close } = fakeReq('localhost:3402');
    createEventsHandler()(req, res);

    expect(headers['access-control-allow-origin']).toBeUndefined();
    expect(headers['content-type']).toBe('text/event-stream');
    close();
  });

  it('unsubscribes on disconnect so listeners do not leak', () => {
    const before = eventBus.listenerCount;
    const { res } = fakeRes();
    const { req, close } = fakeReq('localhost:3402');
    createEventsHandler()(req, res);
    expect(eventBus.listenerCount).toBe(before + 1);
    close();
    expect(eventBus.listenerCount).toBe(before);
  });
});

describe('host guard (DNS rebinding)', () => {
  it('strips ports and IPv6 brackets', () => {
    expect(hostnameOf('localhost:3402')).toBe('localhost');
    expect(hostnameOf('[::1]:3402')).toBe('::1');
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1');
  });

  it('allows the hosts a local gateway is legitimately reached at', () => {
    for (const h of ['localhost:3402', '127.0.0.1:3400', '[::1]:3402', 'gateway.localhost', '192.168.1.20:3400']) {
      expect(isAllowedHost(h), h).toBe(true);
    }
  });

  it('rejects an attacker domain resolving to loopback', () => {
    for (const h of ['evil.example', 'evil.example:3402', 'rebind.attacker.com', undefined]) {
      expect(isAllowedHost(h), String(h)).toBe(false);
    }
  });

  it('403s the request before auth is considered', () => {
    const { res } = fakeRes();
    const { req } = fakeReq('evil.example');
    const next = vi.fn();
    requireAllowedHost(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('passes a legitimate host through to the next middleware', () => {
    const { res } = fakeRes();
    const { req } = fakeReq('localhost:3402');
    const next = vi.fn();
    requireAllowedHost(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
