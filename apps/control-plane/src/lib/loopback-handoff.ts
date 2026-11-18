/**
 * The gateway's half of a hand-off to the person's system browser (RFC 8252 loopback
 * redirect, PKCE S256 RFC 7636): `state`, the PKCE verifier, the port, the page session
 * that started it, a lifetime, and the outcome. The same shape as Connect in
 * lib/device-setup.ts, kept separate so that Connect stays as it is.
 *
 * What authorises the callback is `state`: 32 random bytes kept only here, tied to ONE
 * page session, valid once, valid for a short time. A callback is checked where the work
 * is done (DeviceRecovery.callback), never by the path it came in on.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type HandoffStatus = 'waiting' | 'authorised' | 'failed';

export class LoopbackHandoff {
  private readonly state = randomBytes(32);
  /** What the Authority Server keeps of the state: base64url(sha256(utf8(state))), fixed at stage time. */
  readonly stateHash = createHash('sha256').update(this.state.toString('base64url'), 'utf8').digest('base64url');
  /** The PKCE verifier. Never leaves this process except in the redeem call to the Authority Server. */
  readonly verifier = randomBytes(32).toString('base64url');
  readonly challenge = createHash('sha256').update(this.verifier, 'ascii').digest('base64url');
  /** Set the moment a callback with the right state arrives: a state works once. */
  private used = false;
  status: HandoffStatus = 'waiting';
  failure?: { code: string; asCode?: string };
  /** The id the Authority Server gave the staged entry. */
  handoffId = '';

  constructor(
    readonly port: number,
    readonly sessionId: string,
    /** Epoch ms. */
    public expiresAt: number,
  ) {}

  get stateText(): string { return this.state.toString('base64url'); }

  /**
   * Take the one use of this state. True only for the right state, once, before the end.
   * The check and the marking happen in one synchronous step, before any await of the caller.
   */
  take(given: unknown, nowMs: number): boolean {
    if (typeof given !== 'string' || given.length > 128) return false;
    let g: Buffer;
    try { g = Buffer.from(given, 'base64url'); } catch { return false; }
    if (g.length !== this.state.length || !timingSafeEqual(g, this.state)) return false;
    if (this.used || this.expiresAt <= nowMs) return false;
    this.used = true;
    return true;
  }

  expired(nowMs: number): boolean { return this.status === 'waiting' && this.expiresAt <= nowMs; }
}
