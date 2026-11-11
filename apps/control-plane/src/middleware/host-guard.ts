/**
 * Host allowlist — DNS-rebinding guard.
 *
 * The gateway binds a local port and trusts the browser's same-origin policy to
 * keep other websites out. DNS rebinding defeats that: an attacker points their
 * own domain at 127.0.0.1, so the browser believes the request is same-origin
 * with `evil.example` while it actually reaches this server. Same-origin checks
 * pass; the `Host` header is what gives it away.
 *
 * Applied to EVERY route, first (index.ts): /auth, /internal, /api, /mcp, the
 * static UI. It started on /events only; a rebinding page could still drive
 * the rest (security review 2026-11, finding A2).
 *
 * Allowed: this machine's names (localhost, *.localhost), any IP literal (a
 * rebinding page's Host is always the attacker's domain NAME, never an IP —
 * same rule as the MCP server's agent port, mcp-server/src/lib/agent-access.ts),
 * the host of SUVEREN_CP_INTERNAL_URL (how the MCP server reaches us when the
 * two run in separate containers), and any name listed in
 * SUVEREN_ALLOWED_HOSTS — for a gateway reached under a real name (a reverse
 * proxy, a Docker service name, `mybox.local`). Comma-separated hostnames,
 * without port.
 */

import type { Request, Response, NextFunction } from 'express';

/** Strip the port, and the brackets IPv6 literals carry in a Host header. */
export function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  // [::1]:3402 → ::1
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  return trimmed.replace(/:\d+$/, '');
}

/**
 * Extra hostnames this gateway is legitimately reached at, from the
 * environment: SUVEREN_ALLOWED_HOSTS (comma-separated) and the host of
 * SUVEREN_CP_INTERNAL_URL.
 */
export function extraAllowedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const names = new Set<string>();
  for (const part of (env.SUVEREN_ALLOWED_HOSTS ?? '').split(',')) {
    const name = hostnameOf(part);
    if (name) names.add(name);
  }
  const internal = env.SUVEREN_CP_INTERNAL_URL?.trim();
  if (internal) {
    try {
      names.add(hostnameOf(new URL(internal).host));
    } catch { /* not a URL: nothing to add */ }
  }
  return names;
}

function isIpLiteral(name: string): boolean {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  // IPv6 (brackets already stripped by hostnameOf). A DNS name has no colon.
  return name.includes(':') && /^[0-9a-f:.]+$/.test(name);
}

export function isAllowedHost(
  hostHeader: string | undefined,
  extra: Set<string> = extraAllowedHosts(),
): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  // *.localhost is reserved for loopback (RFC 6761).
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (isIpLiteral(name)) return true;
  return extra.has(name);
}

const ENV_ALLOWED = extraAllowedHosts();

export function requireAllowedHost(req: Request, res: Response, next: NextFunction): void {
  if (!isAllowedHost(req.headers.host, ENV_ALLOWED)) {
    res.status(403).json({ error: 'Forbidden host' });
    return;
  }
  next();
}
