/**
 * Who may connect to the agent-facing MCP endpoints (`/sse`, `/messages`, `/mcp`).
 *
 * Every tool call an agent makes runs under the signed-in human's mandates, so
 * "who can open an MCP session" is the same question as "who can act as this
 * person's agent". Until 0.19.x the server listened on 0.0.0.0 with no check at
 * all — any machine on the network could connect. The rules now:
 *
 * - **Bind address.** `SUVEREN_BIND_HOST`, default `127.0.0.1`: only this
 *   machine can reach the port. The Docker image sets `0.0.0.0` (a container
 *   must listen on its own interface; docker-compose publishes the port on the
 *   host's loopback only).
 * - **Token.** When `SUVEREN_MCP_TOKEN` is set, opening a session needs it —
 *   `Authorization: Bearer <token>` or, for clients that cannot send headers,
 *   `?token=<token>`. Later requests of that session are tied to it by the
 *   session id (a random UUID the client only learns by opening the session).
 * - **Network exposure without a token is refused at startup** — outside a
 *   container, where exposure is decided by how the port is published.
 * - **Host header.** Without a token, the Host header must name this machine
 *   (or be an IP literal). That stops DNS rebinding: a web page whose own
 *   domain resolves to 127.0.0.1 reaches the port, but its Host header gives
 *   it away. With a token the token is the check — a rebinding page does not
 *   know it.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export const DEFAULT_BIND_HOST = '127.0.0.1';

export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SUVEREN_BIND_HOST?.trim();
  return raw ? raw : DEFAULT_BIND_HOST;
}

export function isLoopbackBind(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function resolveAgentToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.SUVEREN_MCP_TOKEN?.trim() ?? '';
}

/**
 * Startup check. Returns the reason the server must not start, or null.
 * A container is exempt: inside it, 0.0.0.0 is the only workable bind, and
 * whether the port reaches the network is decided where it is published.
 */
export function bindRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const host = resolveBindHost(env);
  if (isLoopbackBind(host)) return null;
  if (resolveAgentToken(env)) return null;
  if (env.SUVEREN_CONTAINER === '1') return null;
  return (
    `SUVEREN_BIND_HOST=${host} would let other machines connect as this person's agent, ` +
    `but SUVEREN_MCP_TOKEN is not set. Set a token (long and random), or remove SUVEREN_BIND_HOST ` +
    `to listen on this machine only.`
  );
}

/** Strip the port, and the brackets IPv6 literals carry in a Host header. */
export function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  return trimmed.replace(/:\d+$/, '');
}

/**
 * A Host header a DNS-rebinding page cannot produce: this machine's names, or
 * an IP literal (a rebinding page's Host is always the attacker's domain name).
 * Mirrors apps/control-plane/src/middleware/host-guard.ts, minus its private-
 * range restriction — any IP literal is rebinding-safe.
 */
export function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader);
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  if (name.includes(':')) return true; // IPv6 literal (brackets already stripped)
  return false;
}

function presentedToken(req: Request): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const q = req.query.token;
  return typeof q === 'string' ? q : '';
}

function sameToken(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Middleware for the agent-facing routes. `opensSession` is true for requests
 * that create a session (GET /sse, POST /mcp without a session id) — those
 * need the token when one is configured.
 */
export function agentAccess(
  token: string,
  opensSession: (req: Request) => boolean,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      if (!isLocalHost(req.headers.host)) {
        res.status(403).json({ error: 'Forbidden host' });
        return;
      }
      next();
      return;
    }
    if (opensSession(req) && !sameToken(presentedToken(req), token)) {
      res.status(401).json({ error: 'Missing or wrong gateway token' });
      return;
    }
    next();
  };
}
