/**
 * Page session — what a browser holds after it unlocked a gateway that has an
 * unlock password (device-keys plan, section 7 "page session", DEC-47, 20.8).
 *
 * Two secrets, both required on every request:
 *  - an `HttpOnly; SameSite=Strict` cookie with no Domain (host-only), and
 *  - a token the page keeps in memory and sends as a header.
 * Cookies are scoped by host, not by port, so a page on another port of
 * `localhost` receives the cookie; the header token is what such a page does
 * not have. The cookie alone never authorises anything.
 *
 * The control plane enforces the limits, never the page:
 *  - 1 hour without use,
 *  - 12 hours after the last verified check (whatever the use),
 *  - the process restarting (memory only, nothing on disk),
 *  - the vault locking, and a lock / sleep / user-switch signal from the OS.
 *
 * Only a request made on a person's action counts as use. Polling, event
 * streams and status calls must not keep a session open: see
 * {@link classifyRequest}.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'suveren_page_session';
export const SESSION_HEADER = 'x-suveren-session';

export const IDLE_LIMIT_MS = 60 * 60 * 1000;
export const MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** Why a session is not valid. Neutral codes — wording is the maintainer's. */
export type SessionRefusal = 'session_missing' | 'session_invalid' | 'session_idle' | 'session_expired';

export type OsSessionSignal = 'screen-lock' | 'sleep' | 'user-switch';

interface Stamp { mono: number; wall: number }

interface Entry {
  cookieHash: Buffer;
  tokenHash: Buffer;
  /** Last verified check (the unlock, for now). The 12-hour limit counts from here. */
  checkedAt: Stamp;
  lastUseAt: Stamp;
  watchers: Set<() => void>;
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

export interface OpenedSession {
  /** Goes into the Set-Cookie header. */
  cookie: string;
  /** Goes to the page, which keeps it in memory and sends it as a header. */
  token: string;
}

export interface SessionClock {
  /** Never goes backwards; may stand still while the computer sleeps. */
  mono: () => number;
  /** Wall clock; may be set back by anyone with the rights to, and jumps over a sleep. */
  wall: () => number;
}

const realClock: SessionClock = {
  mono: () => Number(process.hrtime.bigint() / 1_000_000n),
  wall: () => Date.now(),
};

export class PageSessions {
  private entries = new Map<string, Entry>(); // key: hex of cookieHash
  private readonly clock: SessionClock;

  /**
   * Time is measured on BOTH clocks and the larger elapsed time counts: turning
   * the wall clock back does not extend a session (the monotonic clock still
   * moves), and a sleep that stops the monotonic clock does not either (the
   * wall clock jumped). `now` moves both together, for tests.
   */
  constructor(opts: { now?: () => number; clock?: SessionClock } = {}) {
    this.clock = opts.clock ?? (opts.now ? { mono: opts.now, wall: opts.now } : realClock);
  }

  private stamp(): Stamp { return { mono: this.clock.mono(), wall: this.clock.wall() }; }
  private elapsed(since: Stamp): number {
    return Math.max(this.clock.mono() - since.mono, this.clock.wall() - since.wall);
  }

  open(): OpenedSession {
    const cookie = randomBytes(32).toString('base64url');
    const token = randomBytes(32).toString('base64url');
    const t = this.stamp();
    const cookieHash = sha(cookie);
    this.entries.set(cookieHash.toString('hex'), {
      cookieHash, tokenHash: sha(token), checkedAt: t, lastUseAt: t, watchers: new Set(),
    });
    return { cookie, token };
  }

  /** Stable id of the session a cookie belongs to (for binding a confirmation to it), or null. */
  idOf(cookie: string | undefined): string | null {
    if (!cookie) return null;
    const k = sha(cookie).toString('hex');
    return this.entries.has(k) ? k : null;
  }

  /**
   * Check a request's two secrets and the time limits. `counts` says whether
   * this request is a person's action; only then does the idle clock restart.
   * An expired session is ended on the spot.
   */
  validate(cookie: string | undefined, token: string | undefined, counts: boolean): { ok: true } | { ok: false; reason: SessionRefusal } {
    if (!cookie || !token) return { ok: false, reason: 'session_missing' };
    const key = sha(cookie).toString('hex');
    const e = this.entries.get(key);
    if (!e) return { ok: false, reason: 'session_invalid' };
    const presented = sha(token);
    if (presented.length !== e.tokenHash.length || !timingSafeEqual(presented, e.tokenHash)) {
      return { ok: false, reason: 'session_invalid' };
    }
    if (this.elapsed(e.checkedAt) >= MAX_LIFETIME_MS) {
      this.end(key);
      return { ok: false, reason: 'session_expired' };
    }
    if (this.elapsed(e.lastUseAt) >= IDLE_LIMIT_MS) {
      this.end(key);
      return { ok: false, reason: 'session_idle' };
    }
    if (counts) e.lastUseAt = this.stamp();
    return { ok: true };
  }

  /** The cookie alone, for a request that cannot carry the header (a window opened by the page). Same time limits. */
  validateCookie(cookie: string | undefined, counts: boolean): { ok: true } | { ok: false; reason: SessionRefusal } {
    if (!cookie) return { ok: false, reason: 'session_missing' };
    const key = sha(cookie).toString('hex');
    const e = this.entries.get(key);
    if (!e) return { ok: false, reason: 'session_invalid' };
    if (this.elapsed(e.checkedAt) >= MAX_LIFETIME_MS) { this.end(key); return { ok: false, reason: 'session_expired' }; }
    if (this.elapsed(e.lastUseAt) >= IDLE_LIMIT_MS) { this.end(key); return { ok: false, reason: 'session_idle' }; }
    if (counts) e.lastUseAt = this.stamp();
    return { ok: true };
  }

  /** A verified check happened on this session: the 12-hour limit restarts. */
  recordCheck(cookie: string): void {
    const e = this.entries.get(sha(cookie).toString('hex'));
    if (e) { const t = this.stamp(); e.checkedAt = t; e.lastUseAt = t; }
  }

  /** Call `onEnd` once when this session ends (idle, 12 hours, a lock). Returns a function that stops watching. */
  watch(cookie: string, onEnd: () => void): () => void {
    const e = this.entries.get(sha(cookie).toString('hex'));
    if (!e) { onEnd(); return () => {}; }
    e.watchers.add(onEnd);
    return () => { e.watchers.delete(onEnd); };
  }

  private end(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    for (const w of e.watchers) { try { w(); } catch { /* a watcher must not keep a session open */ } }
  }

  /** End every session past a limit, now (so an open stream does not outlive its session). */
  expireDue(): void {
    for (const [k, e] of [...this.entries]) {
      if (this.elapsed(e.checkedAt) >= MAX_LIFETIME_MS || this.elapsed(e.lastUseAt) >= IDLE_LIMIT_MS) this.end(k);
    }
  }

  endAll(): void {
    for (const k of [...this.entries.keys()]) this.end(k);
  }

  /** Number of open sessions, for tests and diagnostics. */
  count(): number {
    return this.entries.size;
  }
}

/**
 * The hook the operating system's signal will call: the screen locked, the
 * computer went to sleep, or another user took over the desktop. Ends every
 * page session; the vault key stays (the agent keeps working inside its
 * mandates), and the person opens a new session with the unlock password.
 *
 * What still needs building: a thing that DETECTS those events and calls this.
 * macOS: NSWorkspace / distributed notifications (com.apple.screenIsLocked,
 * willSleepNotification, sessionDidResignActive); Windows: WTS session-change
 * (WTS_SESSION_LOCK, WTS_CONSOLE_DISCONNECT) and WM_POWERBROADCAST suspend;
 * Linux: logind PrepareForSleep / Session Lock. Node has no API for any of
 * them, so it belongs in the native helper (step 5a), which then calls
 * `POST /internal/os-signal` (routes/internal-os-signal.ts). Not verified on
 * a real machine.
 */
export function createOsSignalHook(sessions: PageSessions, log: (m: string) => void = m => console.error(m)) {
  return function onOsSignal(signal: OsSessionSignal): void {
    sessions.endAll();
    log(`[Control Plane] Page session ended: ${signal}`);
  };
}

// ─── Which requests count as use ─────────────────────────────────────────

/**
 * Reads of a proposal's own card: the person opened it. These are GETs, so
 * they are named; every other GET is passive.
 */
const CARD_OPEN_GET = [
  /^\/proposal-status\/[^/]+\/(preview|request-context)$/,
  /^\/proposal-status\/[^/]+\/attachment-preview\/[^/]+$/,
];

/**
 * 'use' — a person's action: a decision, a form, a card opened.
 * 'passive' — anything the page does by itself: the event stream, status
 * calls, list refreshes and every other read.
 *
 * Deliberately a short list of what counts rather than a list of what does
 * not: a new polling endpoint must not silently keep a session open. Every
 * write (POST, PUT, PATCH, DELETE) is an action — the page does not poll
 * with those.
 */
export function classifyRequest(method: string, path: string): 'use' | 'passive' {
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') return 'use';
  if (m === 'GET' && CARD_OPEN_GET.some(re => re.test(path))) return 'use';
  return 'passive';
}

// ─── Origin and Host ─────────────────────────────────────────────────────

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

function hostnameOf(host: string): string {
  const t = host.trim().toLowerCase();
  const b = t.match(/^\[([^\]]+)\](?::\d+)?$/);
  return b ? b[1] : t.replace(/:\d+$/, '');
}

/**
 * Host must name this machine's loopback; an Origin, when present, must be
 * exactly this server's own (scheme://host:port as the Host header says), so
 * a page on another port or site is refused. A request that changes something
 * must carry an Origin: browsers always send one on those.
 */
export function checkOriginAndHost(method: string, host: string | undefined, origin: string | undefined): boolean {
  if (!host || !LOOPBACK_NAMES.has(hostnameOf(host))) return false;
  const m = method.toUpperCase();
  if (origin === undefined) return m === 'GET' || m === 'HEAD';
  return origin === `http://${host}` || origin === `https://${host}`;
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** `Set-Cookie` value: HttpOnly, SameSite=Strict, host-only (no Domain), a browser-session cookie. */
export function sessionCookieHeader(cookie: string): string {
  return `${SESSION_COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Strict`;
}
