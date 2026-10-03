/**
 * Corporate HTTP(S) proxy support — pure decision logic shared by every
 * outbound call site that must honour `HTTP_PROXY` / `HTTPS_PROXY` /
 * `NO_PROXY` (upper or lower case) while never proxying a loopback target.
 *
 * Deliberately has NO network code and NO dependency on `undici` or
 * `node:http(s)` — every function here is a pure predicate over strings, so
 * it can be (and is) unit-tested directly, per doc/engineering.md's rung-4
 * guidance ("pure predicates ... anything with no observable side effect").
 * The actual dispatcher/agent construction that USES this decision lives in
 * `as-tls-pin.ts` (fetch paths) and `proxy-https-agent.ts` (the
 * control-plane's native `/api` reverse proxy).
 *
 * Mirrors `apps/mcp-server/src/lib/proxy-env.ts`. Keep the two in step.
 */

/** A loopback target can never be reached THROUGH an external corporate
 *  proxy (the proxy has no route back to the caller's own machine) — so
 *  loopback is bypassed unconditionally, independent of `NO_PROXY`. This is
 *  what keeps control-plane ↔ MCP-server internal calls (127.0.0.1) off the
 *  proxy even when an operator's shell exports `HTTPS_PROXY` for everything
 *  else, and it is also why a local dev Authority Server
 *  (`http://localhost:4100`) is never routed through a proxy either. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h);
}

/** Case-insensitive, lower-case-wins read of the proxy environment — the
 *  same precedence curl/undici use: if BOTH `http_proxy` and `HTTP_PROXY`
 *  are set, the lower-case one wins (never merged). */
export function readProxyEnv(): { http?: string; https?: string; noProxy: string } {
  const http = process.env.http_proxy || process.env.HTTP_PROXY || undefined;
  const https = process.env.https_proxy || process.env.HTTPS_PROXY || undefined;
  const noProxy = process.env.no_proxy ?? process.env.NO_PROXY ?? '';
  return { http, https, noProxy };
}

/**
 * `NO_PROXY` semantics: a comma/space-separated list of hostnames (each
 * optionally with a leading `.`/`*.` for suffix matching and/or a trailing
 * `:port`), or a bare `*` meaning "never proxy anything". Mirrors undici's
 * `EnvHttpProxyAgent` matching (same wildcard/suffix/port rules) so the
 * fetch-based call sites and the control-plane's native `/api` agent never
 * disagree about what counts as "excluded from the proxy".
 */
export function matchesNoProxy(hostname: string, port: number, noProxy: string): boolean {
  const entries = noProxy.split(/[,\s]+/).filter(Boolean);
  if (entries.length === 0) return false;
  if (entries.includes('*')) return true;
  const h = hostname.toLowerCase();
  for (const raw of entries) {
    const m = raw.match(/^(.+):(\d+)$/);
    const entryHost = (m ? m[1] : raw).replace(/^\*?\./, '').toLowerCase();
    const entryPort = m ? Number(m[2]) : 0;
    if (entryPort && entryPort !== port) continue;
    if (h === entryHost || h.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

/**
 * The ONE decision point: which proxy URL (if any) should be used to reach
 * `targetUrl`. Returns `undefined` when the call must go direct — a
 * loopback target, a target excluded by `NO_PROXY`, or no relevant proxy
 * variable set at all.
 */
export function selectProxyUrl(targetUrl: string | URL): string | undefined {
  const url = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
  if (isLoopbackHostname(url.hostname)) return undefined;

  const { http, https, noProxy } = readProxyEnv();
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (matchesNoProxy(url.hostname, port, noProxy)) return undefined;

  // HTTPS_PROXY for https:// targets, falling back to HTTP_PROXY if that's
  // the only one set (same fallback undici's EnvHttpProxyAgent documents).
  // HTTP_PROXY for http:// targets — HTTPS_PROXY never applies to a plain
  // http:// target.
  return url.protocol === 'https:' ? https ?? http : http;
}
