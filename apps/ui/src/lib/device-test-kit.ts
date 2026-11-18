/** Test helper: a transport that answers the control plane's device routes from a table, and records every call. */
import { DeviceClient } from './device-client';

export interface FakeAnswer { status?: number; body?: unknown }
export type FakeRoutes = Record<string, FakeAnswer | ((init?: RequestInit) => FakeAnswer) | Array<FakeAnswer>>;

export function fakeClient(routes: FakeRoutes): { client: DeviceClient; calls: Array<{ path: string; init?: RequestInit }> } {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const counters = new Map<string, number>();
  const client = new DeviceClient(async (path, init) => {
    calls.push({ path, init });
    const key = path.split('?')[0];
    let a = routes[key];
    if (Array.isArray(a)) {
      const i = counters.get(key) ?? 0;
      counters.set(key, i + 1);
      a = a[Math.min(i, a.length - 1)];
    } else if (typeof a === 'function') a = a(init);
    if (!a) return new Response(JSON.stringify({ code: 'bad_request' }), { status: 404 });
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { client, calls };
}

export const refuse = (status: number, code: string, extra: Record<string, unknown> = {}): FakeAnswer => ({ status, body: { error: code, code, message: 'placeholder', ...extra } });
