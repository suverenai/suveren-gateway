/**
 * Pre-flight for remote MCP connectors bridged through `mcp-remote`.
 *
 * `mcp-remote` sends the configured Authorization header; when the remote
 * answers 401 it does not fail — it falls back to OAuth and OPENS THE
 * SYSTEM BROWSER on the remote's login page, then waits (our handshake guard
 * times it out after 30 s). Mollie with a stale or rejected token therefore
 * popped a Mollie login window on every gateway start and every vault
 * unlock, with nothing to say why.
 *
 * So before spawning, ask the remote the same first question ourselves —
 * one `initialize` POST with the same header. 401/403 → refuse to start,
 * with a message naming the cause. Anything else (2xx, other 4xx, network
 * error) → proceed; the real client handles those as before. The preflight
 * can only prevent a browser popup, never block a connector that would have
 * worked.
 */

export interface RemotePreflightTarget {
  url: string;
  authorization: string;
}

const AUTH_HEADER_RE = /^authorization:\s*(.+)$/i;

/**
 * Extract the remote URL and the Authorization header value from an
 * `mcp-remote` argv (after `${VAR}` interpolation). Returns null when the
 * command is not mcp-remote or carries no Authorization header — there is
 * nothing to pre-check then.
 */
export function remotePreflightTarget(command: string, args: readonly string[]): RemotePreflightTarget | null {
  const bin = command.split(/[\\/]/).pop() ?? command;
  if (bin !== 'mcp-remote') return null;
  const url = args.find(a => /^https?:\/\//i.test(a));
  if (!url) return null;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--header') continue;
    const m = AUTH_HEADER_RE.exec(args[i + 1]);
    if (m) return { url, authorization: m[1].trim() };
  }
  return null;
}

/** A bare scheme with no credential ("Bearer", "Bearer ") — the vault value was empty. */
export function isBlankCredential(authorization: string): boolean {
  return authorization.split(/\s+/).filter(Boolean).length < 2;
}

export type PreflightVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * One `initialize` POST with the connector's own header. Decides on the
 * status code alone; the body is never read.
 */
export async function preflightRemoteAuth(
  target: RemotePreflightTarget,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<PreflightVerdict> {
  const host = safeHost(target.url);
  if (isBlankCredential(target.authorization)) {
    return {
      ok: false,
      reason: `no credential configured for ${host} — the saved token is empty. Not started: the remote would open a browser login instead.`,
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(target.url, {
      method: 'POST',
      headers: {
        Authorization: target.authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'suveren-gateway-preflight', version: '0' },
        },
      }),
      signal: ctrl.signal,
    });
    // Drain without reading — some servers hold the stream open otherwise.
    res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: `${host} rejected the configured credential (HTTP ${res.status}). Not started: the remote would open a browser login instead. Re-enter the token under Integrations.`,
      };
    }
    return { ok: true };
  } catch {
    // Unreachable / timeout: not an auth verdict. Let the real client try.
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
