/**
 * Host allowlist — DNS-rebinding guard.
 *
 * The gateway binds a local port and trusts the browser's same-origin policy to
 * keep other websites out. DNS rebinding defeats that: an attacker points their
 * own domain at 127.0.0.1, so the browser believes the request is same-origin
 * with `evil.example` while it actually reaches this server. Same-origin checks
 * pass; the `Host` header is what gives it away.
 *
 * Applied to `/events` because that stream reveals when a human is being asked
 * to approve something. Cheap enough to apply more widely later.
 */

import type { Request, Response, NextFunction } from 'express';

/** Hostnames that legitimately reach a locally-bound gateway. */
const ALLOWED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

/** Strip the port, and the brackets IPv6 literals carry in a Host header. */
export function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  // [::1]:3402 → ::1
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  return trimmed.replace(/:\d+$/, '');
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader);
  if (ALLOWED_HOSTNAMES.has(name)) return true;
  // Docker and LAN access bind real addresses; allow private ranges so a
  // gateway reached at 192.168.x.y from your own machine keeps working.
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  // *.localhost is reserved for loopback (RFC 6761).
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  return false;
}

export function requireAllowedHost(req: Request, res: Response, next: NextFunction): void {
  if (!isAllowedHost(req.headers.host)) {
    res.status(403).json({ error: 'Forbidden host' });
    return;
  }
  next();
}
