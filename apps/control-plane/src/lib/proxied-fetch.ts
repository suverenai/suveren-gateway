/**
 * `fetch`, but routed through a corporate proxy when one applies to the
 * target URL (see `proxy-env.ts`) — for the outbound calls in this app that
 * are NOT the Authority Server: the update checker (ghcr.io /
 * registry.npmjs.org) and the AI assistant proxy (a user-configured
 * endpoint — Ollama, LM Studio, OpenAI-compatible, or similar). Neither has
 * a pin-tls concern, so this is a plain proxy-aware `fetch`, not
 * `fetchAs`'s pinned/capturing machinery (as-tls-pin.ts) — that stays the
 * Authority Server's alone.
 *
 * A loopback target (e.g. a local Ollama at `http://127.0.0.1:11434`) is
 * never proxied, independent of `HTTP_PROXY`/`HTTPS_PROXY` — see
 * `proxy-env.ts`'s `isLoopbackHostname`. That matters here specifically: a
 * corporate proxy has no route back to the caller's own machine, so without
 * this a configured local AI assistant would break the moment a proxy is
 * set, even though nothing about it should be proxied at all.
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { selectProxyUrl } from './proxy-env';

export function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxyUrl = selectProxyUrl(url);
  if (!proxyUrl) return fetch(url, init);

  const dispatcher = new ProxyAgent({ uri: proxyUrl });
  const pending = undiciFetch(url, { ...(init as Record<string, unknown>), dispatcher }) as unknown as Promise<Response>;
  // Close the per-call dispatcher once the request settles, without making
  // the caller wait for it — mirrors `closeAfter` in as-tls-pin.ts (undici's
  // `Dispatcher.close()` itself waits for a still-streaming body to finish,
  // so this never cuts a response short; it only stops the dispatcher from
  // being silently abandoned, leaking a socket per call forever).
  pending.catch(() => {}).finally(() => { void dispatcher.close().catch(() => {}); });
  return pending;
}
