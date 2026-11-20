/**
 * The phone's calls to the Authority Server, typed, over the one {@link Transport}. Every answer is a {@link Result}: the
 * screens never read a raw body, and the server's `message` is never shown (the words are in texts.ts, chosen by `code`).
 *
 * Routes that exist today (suveren-as stage C): chain, challenge, session, proposals. Routes the phone needs that the Authority
 * Server does NOT have yet are marked PROPOSED: the enrolment-code `genesis` with a passkey registration, phone sign-in with a
 * check, the pairing mailbox, the phone's passkey registration with an `add`. See the hand-over report.
 */
import type { Transport, Reply } from './transport';
import { asErrorCode, UnreachableError } from './transport';

export type Result<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; code: string; status: number };

const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** A refusal's code: the envelope `{ approved:false, errors:[{ code }] }`, the plain `{ code }` of the older routes, else a code from the status. */
export function refusalCode(reply: Reply): string {
  const fromEnvelope = asErrorCode(reply.body);
  if (fromEnvelope) return fromEnvelope;
  const plain = (reply.body as { code?: unknown } | null)?.code;
  if (typeof plain === 'string' && CODE_SHAPE.test(plain)) return plain;
  if (reply.status === 401) return 'UNAUTHENTICATED';
  if (reply.status === 429) return 'RATE_LIMITED';
  return reply.status >= 500 ? 'AS_ERROR' : 'REFUSED';
}

export interface ChainAnswer {
  root_did: string;
  entries: unknown[];
  head: { seq: number; hash: string };
  pending_identity_reset?: { id: string; effective_at: number };
}

export interface SessionAnswer {
  token: string;
  expires_at: number;
  user: { id: string; name?: string; email?: string; did: string };
  head: { seq: number; hash: string };
}

// The mailbox's shapes are the shared package's (the gateway's control plane speaks the same ones).
import type { MailboxMessage, MailboxAnswer } from '@suveren/pairing';
export type { MailboxMessage, MailboxAnswer };

export class AsApi {
  constructor(private readonly t: Transport) {}

  private async go<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: { body?: unknown; bearer?: string } = {}): Promise<Result<T>> {
    let reply: Reply;
    try {
      reply = await this.t.call(method, path, opts);
    } catch (e) {
      if (e instanceof UnreachableError) return { ok: false, code: 'as_unreachable', status: 0 };
      throw e;
    }
    if (reply.status >= 200 && reply.status < 300) return { ok: true, data: (reply.body ?? {}) as T, status: reply.status };
    return { ok: false, code: refusalCode(reply), status: reply.status };
  }

  // ─── chain and session (exist) ───────────────────────────────────────────────

  challenge(keyId: string) {
    return this.go<{ nonce: string; expires_at: number; aud: string }>('POST', '/api/devices/challenge', { body: { key_id: keyId } });
  }

  /** `check` is the phone's passkey assertion over the sign-in's object hash. PROPOSED: the Authority Server refuses a phone sign-in today (`PHONE_SIGNIN_NOT_AVAILABLE`). */
  openSession(signin: unknown, sig: string, check: unknown) {
    return this.go<SessionAnswer>('POST', '/api/devices/session', { body: { signin, sig, check } });
  }

  endSession(bearer: string) {
    return this.go<{ ended: boolean }>('DELETE', '/api/devices/session', { bearer });
  }

  chain(rootDid: string, bearer: string, since?: number) {
    const q = `did=${encodeURIComponent(rootDid)}${since !== undefined ? `&since=${since}` : ''}`;
    return this.go<ChainAnswer>('GET', `/api/devices/chain?${q}`, { bearer });
  }

  /** `genesis` from a phone: the entry, the one-time enrolment code and the passkey registration (plan 3.2 rule 2a). The passkey member is PROPOSED. */
  genesis(entry: unknown, enrolmentCode: string, passkey: unknown) {
    return this.go<{ head: { seq: number; hash: string } }>('POST', '/api/devices/chain', { body: { entry, enrolment_code: enrolmentCode, passkey } });
  }

  /** `add` by a granting device (the phone admitting a computer). */
  appendEntry(entry: unknown, bearer: string, extra: Record<string, unknown> = {}) {
    return this.go<{ head: { seq: number; hash: string } }>('POST', '/api/devices/chain', { body: { entry, ...extra }, bearer });
  }

  /**
   * Stage a `rotate-root` for the email confirmation (the recovery hand-off, `return: "app"`: no port, no state, no PKCE; the
   * phone reads the chain itself afterwards). No session: the entry carries its own proof.
   */
  stageRecovery(entry: unknown) {
    return this.go<{ handoff_id?: unknown; expires_at?: unknown }>('POST', '/api/devices/recovery/handoffs', { body: { entry, return: 'app' } });
  }

  // ─── pairing mailbox (PROPOSED: not built in the Authority Server) ─────────────

  createMailbox(pairingId: string, expiresAt: number, bearer: string) {
    return this.go<Record<string, never>>('POST', '/api/devices/pairings', { body: { pairing_id: pairingId, expires_at: expiresAt }, bearer });
  }

  readMailbox(pairingId: string) {
    return this.go<MailboxAnswer>('GET', `/api/devices/pairings/${encodeURIComponent(pairingId)}`);
  }

  postMessage(pairingId: string, message: MailboxMessage) {
    return this.go<Record<string, never>>('POST', `/api/devices/pairings/${encodeURIComponent(pairingId)}/messages`, { body: message });
  }

  /**
   * The new phone's passkey registration, for the computer that admits it (the plan has no place for it in `open`; see
   * the hand-over, open question). PROPOSED: the Authority Server holds it under the pairing id until the admitter's `add` arrives.
   */
  postPairingPasskey(pairingId: string, passkey: unknown) {
    return this.go<Record<string, never>>('POST', `/api/devices/pairings/${encodeURIComponent(pairingId)}/passkey`, { body: passkey });
  }

  // ─── proposals (exist; a phone session may read and decide them) ───────────────

  listPending(domain: string, bearer: string) {
    return this.go<{ proposals: unknown[] }>('GET', `/api/proposals?domain=${encodeURIComponent(domain)}`, { bearer });
  }

  listForApprover(bearer: string) {
    return this.go<{ proposals: unknown[] }>('GET', '/api/proposals?approver=me', { bearer });
  }

  proposal(id: string, bearer: string) {
    return this.go<{ proposal: unknown }>('GET', `/api/proposals/${encodeURIComponent(id)}`, { bearer });
  }

  // ─── what the card needs besides the proposal (stage D2) ───────────────────────────────

  /**
   * The signed mandates of one authorization (`GET /api/mandates?authorization_id=`). PROPOSED for a phone session: `approveAppMayCall`
   * refuses it today. The phone reads `mandates[].blob` and `revoked` only; everything else in the answer is ignored.
   */
  mandates(authorizationId: string, bearer: string) {
    return this.go<{ mandates?: unknown[]; revoked?: unknown }>('GET', `/api/mandates?authorization_id=${encodeURIComponent(authorizationId)}`, { bearer });
  }

  /** The grants stored for a mandate (`GET /api/mandates/:id/grants`: a device session of `approve-app` is allowed today). The phone verifies each. */
  grants(mandateId: string, bearer: string) {
    return this.go<{ grants?: unknown[] }>('GET', `/api/mandates/${encodeURIComponent(mandateId)}/grants`, { bearer });
  }

  /** Gives prepared for this person's devices that hold no grant yet (`GET /api/mandates/prepared`), each with this phone's own wrap. */
  prepared(bearer: string) {
    return this.go<{ prepared?: unknown[] }>('GET', '/api/mandates/prepared', { bearer });
  }

  /** This person's own authorizations (`GET /api/mandates/mine`; a phone session may since D3, device keys on): the gateway's list. */
  mine(bearer: string) {
    return this.go<{ mandates?: unknown[] }>('GET', '/api/mandates/mine', { bearer });
  }

  /** The sealed bodies of a mandate's versions (`GET /api/mandates/:id/body`), each with this phone's own wrap. */
  mandateBodies(mandateId: string, bearer: string) {
    return this.go<{ bodies?: unknown[] }>('GET', `/api/mandates/${encodeURIComponent(mandateId)}/body`, { bearer });
  }

  /** Store this phone's grant (`POST /api/mandates/:id/grants`, plan 4.4): `{ grant, sig, check }`. The AS verifies it against the chain. */
  postGrant(mandateId: string, body: unknown, bearer: string) {
    return this.go<{ grant_hash?: unknown; mandate_version?: unknown }>('POST', `/api/mandates/${encodeURIComponent(mandateId)}/grants`, { body, bearer });
  }

  /** The gateways' signed receipts of a mandate's grants (`GET /api/mandates/:id/receipts`, DEC-23). The phone verifies each. */
  receipts(mandateId: string, bearer: string) {
    return this.go<{ receipts?: unknown[] }>('GET', `/api/mandates/${encodeURIComponent(mandateId)}/receipts`, { bearer });
  }

  /** A profile by id (`GET /api/profiles/:id`): public, no session needed, so none is sent. The phone checks its hash against the signed mandate. */
  profile(profileId: string) {
    return this.go<unknown>('GET', `/api/profiles/${encodeURIComponent(profileId)}`);
  }

  /** A signed decision (`POST /api/proposals/:id/(approve|reject|resolve|withdraw)`); a phone session is allowed to. */
  decide(proposalId: string, route: 'approve' | 'reject' | 'resolve' | 'withdraw', body: unknown, bearer: string) {
    return this.go<Record<string, unknown>>('POST', `/api/proposals/${encodeURIComponent(proposalId)}/${route}`, { body, bearer });
  }
}
