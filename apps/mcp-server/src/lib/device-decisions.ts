/**
 * Device decisions, checked by the gateway BEFORE a committed proposal runs
 * (device-keys plan 4.2, section 7 row `committed-executor.ts, ticket-verify.ts`;
 * build step 12, computer part).
 *
 * A proposal that the Authority Server calls "committed" runs only if every decision
 * it rests on is on file as a device decision that this gateway has verified itself:
 *
 *   - WHO may decide comes from the SIGNED mandate: the owner (`mandate_owners[0].did`)
 *     and the signed `above_cap_approvers`. Never from an account id, a user table or any
 *     other word of the Authority Server. A decision by any other DID counts for nothing.
 *   - WHICH KEYS may sign for them comes from that person's device chain, fetched from the
 *     Authority Server but verified here from the genesis on with hap-core (`verifyChain`),
 *     against the root DID the mandate names and against the head this gateway pinned the
 *     last time. A shorter chain (rollback) or another hash at the same number (fork)
 *     is refused; a key is never taken from the Authority Server's word.
 *   - WHAT was decided is rebuilt by this gateway from its own data: the proposal id, the
 *     tool and the fingerprint of the content it resolved and is about to run, the signed
 *     `mandate_id`, and the action type of its own submission (`verifyDecision` requires all
 *     five to be equal). A decision for another proposal, another content or another
 *     action is refused; so is a `reject` or `withdraw` where a `commit` is needed.
 *   - HOW MANY is the mandate's own rule (the same one hap-core's `approvalsSufficient` applies
 *     to approval signatures): the owner for a `review` mandate, and for an above-cap
 *     proposal as many distinct signed approvers as `above_cap_approvals` says.
 *
 * A "committed" state with no device decision does NOT run. This gateway has a device chain
 * (asked of the control plane) or it does not: without one, and with SUVEREN_DEVICE_KEYS off,
 * nothing here runs and the executor behaves exactly as before.
 *
 * Refusals are neutral codes plus a short text that names the reason. They never carry a
 * signature, a nonce, a key or content.
 */

import { decodeMandateBlob, capsExceeded, type AgentProfile } from '@hap/core';
import type { ChainState, Decision } from '@hap/core/device-keys';
import type { CachedAuthorization } from './attestation-cache';
import type { SPProposal } from './sp-client';
import type { GrantCheck, GrantGate } from './mandate-grants';

export type DeviceKeys = typeof import('@hap/core/device-keys');
let loaded: Promise<DeviceKeys> | null = null;
/** hap-core's device-keys module, loaded on first use: a gateway that never reaches this code never needs it. */
export function deviceKeys(): Promise<DeviceKeys> {
  return (loaded ??= import('@hap/core/device-keys'));
}
function isDeviceKeysError(e: unknown): e is Error & { code: string } {
  return e instanceof Error && e.name === 'DeviceKeysError' && typeof (e as { code?: unknown }).code === 'string';
}

export function deviceKeysEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUVEREN_DEVICE_KEYS === 'on';
}

// ─── The signed mandate ─────────────────────────────────────────────────

export interface SignedMandateFacts {
  mandateId: string;
  version: string;
  commitmentMode: string | undefined;
  ownerDid: string;
  /** The signed `above_cap_approvers`. */
  deciders: string[];
  /** The signed `above_cap_approvals` (v0.8); undefined when the mandate does not say. */
  aboveCapApprovals: number | undefined;
  /** The signed `above_cap_caps`; undefined when the mandate carries none. */
  aboveCapCaps: Record<string, number> | undefined;
}

/**
 * The facts of the most recently issued decodable mandate of a grant: the one the
 * Authority Server checks a proposal against (`latestMandatePayloadFor`). Only the
 * SIGNED payload is read.
 */
export function signedMandateFacts(attestations: ReadonlyArray<{ blob: string }> | undefined, mandateId?: string): SignedMandateFacts | undefined {
  let best: SignedMandateFacts | undefined;
  let bestAt = -Infinity;
  for (const a of attestations ?? []) {
    if (!a?.blob) continue;
    try {
      const p = decodeMandateBlob(a.blob).payload;
      const ownerDid = p.mandate_owners?.[0]?.did;
      if (typeof p.mandate_id !== 'string' || !p.mandate_id || typeof p.version !== 'string' || typeof ownerDid !== 'string') continue;
      // the mandate the proposal was submitted under, when this gateway knows it: never "the newest issued"
      if (mandateId !== undefined && p.mandate_id !== mandateId) continue;
      const at = typeof p.issued_at === 'number' ? p.issued_at : 0;
      if (at < bestAt) continue;
      bestAt = at;
      best = {
        mandateId: p.mandate_id,
        version: p.version,
        commitmentMode: typeof p.commitment_mode === 'string' ? p.commitment_mode : undefined,
        ownerDid,
        deciders: Array.isArray(p.above_cap_approvers) ? p.above_cap_approvers.filter((d): d is string => typeof d === 'string') : [],
        aboveCapApprovals: typeof p.above_cap_approvals === 'number' ? p.above_cap_approvals : undefined,
        aboveCapCaps: p.above_cap_caps && typeof p.above_cap_caps === 'object' ? p.above_cap_caps : undefined,
      };
    } catch {
      // undecodable: names nobody
    }
  }
  return best;
}

// ─── What the control plane holds ───────────────────────────────────────

export interface Head { seq: number; hash: string }

export class PinRefused extends Error {
  constructor(readonly reason: 'rollback' | 'fork' | 'own_chain' | 'full' | 'proposal_id_reused' | 'nonce_reused') {
    super(reason);
    this.name = 'PinRefused';
  }
}

/** The control plane's answers about device keys (control-plane routes/internal-device.ts). It holds the memory, not the checking. */
export interface DeviceCpClient {
  chainState(): Promise<{ state: 'none' | 'present' | 'unreadable'; rootDid?: string }>;
  getPin(did: string): Promise<Head | null>;
  /**
   * Pin this person's chain head. The control plane fetches and verifies the chain ITSELF before it moves the pin (and decides which
   * pins to protect); what this process verified is not taken on its word.
   */
  advancePin(did: string): Promise<void>;
  /** Has a device chain ever been reported for this account on this computer (sticky)? */
  chainSeen(): Promise<boolean>;
  markChainSeen(): Promise<void>;
  /** This proposal runs on these decisions (their nonces): refused for a reused proposal id or nonce. */
  consume(proposalId: string, nonces: string[]): Promise<void>;
  /** A mandate grant was verified here: remember its version (a lower one is refused later, a revoke is final). Throws {@link GrantRefused}. */
  observeGrant(mandateId: string, version: number, grantHash: string, op: 'grant' | 'change' | 'revoke'): Promise<{ receiptNeeded: boolean }>;
  /** Answer a verified grant with this computer's signed receipt (once). */
  sendReceipt(mandateId: string, version: number, grantHash: string): Promise<void>;
  /** Is this DID a person this gateway's owner compared by identity code and accepted (or is it their own)? */
  ownerConfirmed(did: string): Promise<boolean>;
  /**
   * The sealed body (scope and intent) of a verified grant, opened by the control plane with this computer's own key (plan 20.19).
   * Untrusted until {@link checkBody} compared it with the hashes of the mandate. Throws {@link BodyRefused}.
   */
  openBody(mandateId: string, version: number, grantHash: string): Promise<{ scope: Record<string, string | number>; intent: string }>;
}

/** The sealed body of a mandate did not arrive (`body_not_received`) or could not be accepted; anything else is an error of asking. */
export class BodyRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BodyRefused';
  }
}

/** The control plane refused to remember a grant: a lower version than one seen, another grant of the same version, or a revoked mandate. */
export class GrantRefused extends Error {
  constructor(readonly reason: 'lower_version' | 'same_version_other_grant' | 'revoked') {
    super(reason);
    this.name = 'GrantRefused';
  }
}

/** The control plane answered and said NO (a refusal with its code): never a reason to keep what was honoured. Not a transient failure. */
export class CpRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CpRefused';
  }
}

function cpBase(): string {
  return process.env.SUVEREN_CP_INTERNAL_URL ?? `http://127.0.0.1:${process.env.SUVEREN_CP_PORT ?? '3402'}`;
}

/** The control plane over loopback with the shared internal secret. Env is read per call. */
export const controlPlaneDevice: DeviceCpClient = {
  async chainState() {
    const body = await cpCall('GET', '/internal/device-chain');
    const state = (body as { state?: unknown }).state;
    if (state !== 'none' && state !== 'present' && state !== 'unreadable') throw new Error('unreadable answer');
    const rootDid = (body as { rootDid?: unknown }).rootDid;
    return { state, ...(typeof rootDid === 'string' ? { rootDid } : {}) };
  },
  async getPin(did) {
    const body = await cpCall('POST', '/internal/device-pin/get', { did });
    const h = (body as { head?: { seq?: unknown; hash?: unknown } | null }).head;
    if (h === null) return null;
    if (!h || typeof h.seq !== 'number' || typeof h.hash !== 'string') throw new Error('unreadable answer');
    return { seq: h.seq, hash: h.hash };
  },
  async advancePin(did) {
    await cpCall('POST', '/internal/device-pin/advance', { did });
  },
  async chainSeen() {
    const body = await cpCall('GET', '/internal/mandate-grant/chain-seen');
    return (body as { seen?: unknown }).seen === true;
  },
  async markChainSeen() {
    await cpCall('POST', '/internal/mandate-grant/chain-seen', {});
  },
  async consume(proposalId, nonces) {
    await cpCall('POST', '/internal/device-ledger/consume', { proposalId, nonces });
  },
  async observeGrant(mandateId, version, grantHash, op) {
    const body = await cpCall('POST', '/internal/mandate-grant/observe', { mandateId, version, grantHash, op });
    return { receiptNeeded: (body as { receiptNeeded?: unknown }).receiptNeeded === true };
  },
  async ownerConfirmed(did) {
    const body = await cpCall('POST', '/internal/mandate-grant/owner-known', { did });
    return (body as { known?: unknown }).known === true;
  },
  async openBody(mandateId, version, grantHash) {
    const body = await cpCall('POST', '/internal/mandate-grant/body', { mandateId, version, grantHash }) as { scope?: unknown; intent?: unknown };
    if (typeof body.intent !== 'string' || typeof body.scope !== 'object' || body.scope === null || Array.isArray(body.scope)) throw new Error('unreadable answer');
    return { scope: body.scope as Record<string, string | number>, intent: body.intent };
  },
  async sendReceipt(mandateId, version, grantHash) {
    await cpCall('POST', '/internal/mandate-grant/receipt', { mandateId, version, grantHash });
  },
};

async function cpCall(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const secret = process.env.SUVEREN_INTERNAL_SECRET ?? '';
  if (!secret) throw new Error('no control plane connection');
  const res = await fetch(`${cpBase()}${path}`, {
    method,
    headers: { 'X-Internal-Secret': secret, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  const parsed = (await res.json().catch(() => ({}))) as { code?: unknown; error?: unknown };
  if (!res.ok && parsed.error === 'body_refused' && typeof parsed.code === 'string') throw new BodyRefused(parsed.code);
  if (res.status === 409 && (parsed.code === 'lower_version' || parsed.code === 'same_version_other_grant' || parsed.code === 'revoked')) throw new GrantRefused(parsed.code);
  if (res.status === 409 && (parsed.code === 'rollback' || parsed.code === 'fork' || parsed.code === 'own_chain' || parsed.code === 'full'
    || parsed.code === 'proposal_id_reused' || parsed.code === 'nonce_reused')) throw new PinRefused(parsed.code);
  // 4xx with a code (403 chain_fork, grant_invalid, owner_unknown, grant_not_held, ...) is a refusal; 401 (no secret), 423 (locked),
  // 5xx, timeouts and network errors are failures to ASK and stay plain errors.
  if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 408 && res.status !== 423 && res.status !== 429
    && typeof parsed.code === 'string') throw new CpRefused(parsed.code);
  if (!res.ok) throw new Error(`control plane answered ${res.status}`);
  return parsed;
}

// ─── The check ──────────────────────────────────────────────────────────

export type DeviceCheck =
  | { ok: true; skipped?: true }
  | { ok: false; code: string; text: string };

const refuse = (code: string, text: string): DeviceCheck => ({ ok: false, code, text });

export interface DeviceCheckInput {
  /** The Authority Server client: this gateway's own device session. */
  sp: {
    getProposalById(id: string): Promise<SPProposal | null>;
    getDeviceChain(did: string): Promise<{ entries: unknown[]; head: Head | null } | null>;
  };
  cp: DeviceCpClient;
  /** The grant this proposal runs under, as the attestation cache holds it. */
  auth: Pick<CachedAuthorization, 'attestations'> | undefined;
  /** Where the grant is fetched again when the cache no longer holds it. */
  loadAuth?: () => Promise<Pick<CachedAuthorization, 'attestations'> | null | undefined>;
  proposal: Pick<SPProposal, 'id' | 'tool' | 'pendingApprovers' | 'approvedBy' | 'authorizationId'>;
  /** This gateway's own record of the action type (never the Authority Server's). */
  actionType: string | undefined;
  /** The fingerprint of the content THIS gateway resolved and is about to run. */
  proposalContentHash: string;
  /**
   * Device keys (plan 4.4, step 13): the mandate this proposal runs under must stand on its owner's device grant; who may decide
   * is then read from the GRANTED mandate only. Required: a caller without a gate does not compile.
   */
  grantGate: GrantGate;
  /** The signed `mandate_id` this gateway recorded when it submitted the proposal (its own submission record). */
  mandateId?: string;
  /** Why the authorization is not in the cache, when a check refused it (so the refusal names the reason, not "unavailable"). */
  whyMissing?: () => { code: string; text: string } | undefined;
  /**
   * What this gateway ran the proposal's checks on: its execution context (already compared with its own submission record) and
   * the profile. With a granted mandate they decide, from the SIGNED caps, whether the proposal is above the cap.
   */
  executionContext?: Record<string, unknown>;
  profile?: AgentProfile;
  /** Signed identities (owner and approvers) of every mandate cached now: their pins are never evicted. */
  protectedDids?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Is every decision this proposal rests on a device decision this gateway verified?
 * `{ ok: true, skipped: true }` when this gateway has no device chain (or the switch is off).
 */
export async function checkDeviceDecisions(i: DeviceCheckInput): Promise<DeviceCheck> {
  if (!deviceKeysEnabled(i.env)) return { ok: true, skipped: true };

  let own: Awaited<ReturnType<DeviceCpClient['chainState']>>;
  try {
    own = await i.cp.chainState();
  } catch {
    // Switch on and the control plane silent: it is not known whether this gateway has a chain. Fail closed.
    return refuse('device_state_unavailable', 'the control plane did not say whether this gateway has a device chain.');
  }
  if (own.state === 'none') return { ok: true, skipped: true };
  if (own.state !== 'present') return refuse('device_chain_unreadable', 'this gateway\'s stored device chain cannot be read.');

  let auth: Pick<CachedAuthorization, 'attestations'> | null | undefined = i.auth;
  if (!auth && i.loadAuth) { try { auth = await i.loadAuth(); } catch { auth = undefined; } }
  // Device keys: only a mandate that stands on its owner's grant says who may decide. The blobs that do not are not read.
  let attestations: ReadonlyArray<{ blob: string }> | undefined = auth?.attestations;
  let granted = false;
  if (auth) {
    let g: GrantCheck;
    try { g = await i.grantGate({ authorizationId: i.proposal.authorizationId, attestations: auth.attestations }); } catch { g = { ok: false, code: 'device_state_unavailable', text: 'the grant of the mandate could not be checked.' }; }
    if (!g.ok) return refuse(g.code, g.text);
    if (!g.skipped) { granted = true; attestations = auth.attestations.filter(a => g.granted.some(x => x.blob === a.blob)); }
  } else {
    const why = i.whyMissing?.();
    if (why) return refuse(why.code, why.text);
  }
  if (granted && i.mandateId === undefined && new Set((attestations ?? []).map(a => { try { return decodeMandateBlob(a.blob).payload.mandate_id; } catch { return undefined; } })).size > 1) {
    return refuse('mandate_ambiguous', 'more than one granted mandate stands under this authorization and the proposal does not say which.');
  }
  const facts = signedMandateFacts(attestations, i.mandateId);
  if (!facts) return refuse('mandate_unavailable', 'the signed mandate this proposal runs under is not available, so who may decide it is not known.');
  if (!i.actionType) return refuse('action_type_unknown', 'this gateway has no action type for the proposal, so a decision on it cannot be checked.');

  // The AS's copy of the decisions on file. Only `{ decision, sig }` is read.
  let fresh: SPProposal | null;
  try {
    fresh = await i.sp.getProposalById(i.proposal.id);
  } catch {
    return refuse('proposal_unavailable', 'the Authority Server did not give the decisions on file for this proposal.');
  }
  if (!fresh || fresh.id !== i.proposal.id) return refuse('proposal_unavailable', 'the Authority Server did not give the decisions on file for this proposal.');
  const stored = Array.isArray(fresh.deviceDecisions) ? fresh.deviceDecisions : [];

  // Who may decide: the signed identities, nobody else.
  const signedDids = new Set<string>([facts.ownerDid, ...facts.deciders]);
  // Whether the proposal is above the cap. The Authority Server's unsigned flags (`pendingApprovers`, `approvedBy`) beside the signed
  // mode can only ADD the requirement. Under a GRANTED mandate (step 13) the caps are the owner's own signed words: the proposal is
  // above the cap when its execution context (the one this gateway compared with its own submission) exceeds them, so an
  // Authority Server that hides the flag can no longer waive the above-cap approvers of a `review` mandate. Where the caps
  // cannot be computed here the stricter reading counts. Without a grant (switch off, no chain) it is as before.
  let aboveCap = facts.commitmentMode === 'review_above_cap'
    || (i.proposal.pendingApprovers?.length ?? 0) > 0
    || Object.keys(i.proposal.approvedBy ?? {}).length > 0
    || Object.keys(fresh.approvedBy ?? {}).length > 0
    || (fresh.pendingApprovers?.length ?? 0) > 0;
  if (granted && !aboveCap && facts.aboveCapCaps) {
    if (!i.profile || !i.executionContext) aboveCap = facts.deciders.length > 0;
    else {
      try { aboveCap = capsExceeded(i.executionContext, { above_cap_caps: facts.aboveCapCaps }, i.profile).length > 0; } catch { aboveCap = true; }
    }
  }
  const needOwner = facts.commitmentMode !== 'review_above_cap';
  const requiredApprovers = aboveCap
    ? (facts.version === '0.7' ? facts.deciders.length : (facts.aboveCapApprovals ?? 1))
    : 0;

  const dk = await deviceKeys();
  const chains = new Map<string, { ok: true; state: ChainState } | { ok: false; check: DeviceCheck }>();
  const chainOf = async (did: string) => {
    let c = chains.get(did);
    if (!c) { c = await verifiedChain(i, dk, did); chains.set(did, c); }
    return c;
  };

  const goodBy = new Set<string>();
  const nonceBy = new Map<string, string>();
  const reasons = new Map<string, string>();
  for (const entry of stored) {
    const env = entry as { decision?: unknown; sig?: unknown };
    const did = (env.decision as { approver_did?: unknown } | null)?.approver_did;
    if (typeof did !== 'string' || !signedDids.has(did)) continue;
    if (goodBy.has(did)) continue;
    const chain = await chainOf(did);
    if (!chain.ok) { reasons.set(did, chain.check.ok ? 'chain' : chain.check.code); continue; }
    try {
      const d: Decision = await dk.verifyDecision(
        { decision: env.decision, sig: env.sig },
        {
          chain: chain.state,
          expect: {
            proposal_id: i.proposal.id,
            mandate_id: facts.mandateId,
            action: i.proposal.tool,
            action_type: i.actionType,
            proposal_content_hash: i.proposalContentHash,
          },
        },
      );
      if (d.decision !== 'commit') { reasons.set(did, 'not_a_commit'); continue; }
      goodBy.add(did);
      nonceBy.set(did, d.nonce);
    } catch (e) {
      reasons.set(did, isDeviceKeysError(e) ? e.code : 'invalid');
    }
  }

  const why = (did: string): string => {
    const r = reasons.get(did);
    return r ? `its device decision was refused (${r})` : 'no device decision of theirs is on file';
  };

  if (needOwner && !goodBy.has(facts.ownerDid)) {
    const chain = chains.get(facts.ownerDid);
    if (chain && !chain.ok && !chain.check.ok) return chain.check;
    return refuse('decision_missing_owner', `the Mandate Owner has no verified device decision for this proposal: ${why(facts.ownerDid)}.`);
  }
  if (requiredApprovers > 0) {
    const approversGood = facts.deciders.filter(d => d !== facts.ownerDid && goodBy.has(d)).length;
    if (approversGood < requiredApprovers) {
      // A broken chain of a signed approver is named as that, not as "missing".
      for (const d of facts.deciders) {
        const chain = chains.get(d);
        if (chain && !chain.ok && !chain.check.ok) return chain.check;
      }
      return refuse('decision_missing_approvers', `${approversGood} of ${requiredApprovers} required above-cap approvers have a verified device decision for this proposal.`);
    }
  }
  if (!needOwner && requiredApprovers === 0) return refuse('decision_missing_owner', 'nobody is named to have decided this proposal.');
  // Replay: the proposal id and each decision's nonce are recorded (sealed, in the control plane) before anything runs.
  try {
    await i.cp.consume(i.proposal.id, [...nonceBy.values()]);
  } catch (e) {
    if (e instanceof PinRefused && e.reason === 'proposal_id_reused') return refuse('proposal_id_reused', 'this proposal id was already used with other decisions.');
    if (e instanceof PinRefused && e.reason === 'nonce_reused') return refuse('decision_replayed', 'a decision of this proposal was already used for another proposal.');
    return refuse('device_state_unavailable', 'the control plane could not record the decisions this proposal runs on.');
  }
  return { ok: true };
}

/** What reading a person's chain needs: the Authority Server's copy, this gateway's pins. */
export interface ChainReader {
  sp: { getDeviceChain(did: string): Promise<{ entries: unknown[]; head: Head | null } | null> };
  cp: DeviceCpClient;
  protectedDids?: string[];
}

/** The person's chain, verified here from the genesis on against the root DID the mandate names and the head pinned before. */
export async function verifiedChain(i: ChainReader, dk: DeviceKeys, did: string): Promise<{ ok: true; state: ChainState } | { ok: false; check: DeviceCheck }> {
  let pin: Head | null;
  try {
    pin = await i.cp.getPin(did);
  } catch {
    return { ok: false, check: refuse('device_state_unavailable', 'the control plane did not give the chain head it pinned for an approver.') };
  }
  let got;
  try {
    got = await i.sp.getDeviceChain(did);
  } catch {
    return { ok: false, check: refuse('chain_unavailable', 'the Authority Server did not give an approver\'s device chain.') };
  }
  // DEC-52: an account is never on both. A gateway with a chain accepts a decision only from a chain.
  if (!got) return { ok: false, check: refuse('approver_has_no_chain', 'an approver the mandate names has no device chain, so no device decision of theirs can be checked.') };
  let state: ChainState;
  try {
    state = await dk.verifyChain({ expectedRootDid: did, entries: got.entries, storedHead: pin });
  } catch (e) {
    if (isDeviceKeysError(e)) {
      if (e.code === 'ROLLBACK') return { ok: false, check: refuse('chain_rollback', 'an approver\'s device chain is shorter than the one this gateway verified before.') };
      if (e.code === 'FORK') return { ok: false, check: refuse('chain_fork', 'an approver\'s device chain differs from the one this gateway verified before.') };
      return { ok: false, check: refuse('chain_invalid', `an approver's device chain does not verify (${e.code}).`) };
    }
    throw e;
  }
  // The head the Authority Server names must be the head the verified entries end in.
  if (!got.head || got.head.seq !== state.head.seq || got.head.hash !== state.head.hash) {
    return { ok: false, check: refuse('chain_head_mismatch', 'the Authority Server named another chain head than its entries end in.') };
  }
  try {
    await i.cp.advancePin(did);
  } catch (e) {
    // This computer's own head is moved by sign-in only; the chain was verified against it above.
    if (e instanceof PinRefused && e.reason === 'own_chain') return { ok: true, state };
    if (e instanceof PinRefused && (e.reason === 'rollback' || e.reason === 'fork')) return { ok: false, check: refuse(e.reason === 'rollback' ? 'chain_rollback' : 'chain_fork', 'an approver\'s device chain moved against the head this gateway pinned.') };
    if (e instanceof CpRefused) return { ok: false, check: refuse(e.code, 'the control plane refused to pin an approver\'s chain head.') };
    return { ok: false, check: refuse('device_state_unavailable', 'the control plane could not pin an approver\'s chain head.') };
  }
  return { ok: true, state };
}

// ─── What a device-signed decision must name (asked by the control plane) ──

export interface ProposalFactsDeps {
  /**
   * The mandate must stand on its owner's device grant before a decision is signed under it (plan 4.4). Required: a caller that
   * does not pass one does not compile. With the switch off or no chain of this gateway it answers `skipped` at once.
   */
  grants: (i: { authorizationId: string; attestations: ReadonlyArray<{ blob: string }> }) => Promise<GrantCheck>;
  /** The grant as this gateway's attestation cache holds it, fetched again when it does not. */
  auth: (authorizationId: string) => Promise<Pick<CachedAuthorization, 'attestations'> | null | undefined>;
  /** This gateway's own record of a proposal it submitted. */
  submission: (proposalId: string) => { actionType?: string; tool?: string; authorizationId?: string; mandateId?: string } | undefined;
  /**
   * Read-only fetch of a grant's signed mandates from the Authority Server, for ONE proposal this gateway
   * does not hold the grant for (an approver's gateway never holds the owner's mandate). Never stored in the
   * tool-use cache. The caller checks the answer names the grant asked for.
   */
  fetchAuth?: (authorizationId: string) => Promise<Pick<CachedAuthorization, 'attestations'> | null | undefined>;
  /** The action type a connector's manifest declares for a namespaced tool. */
  manifestActionType: (tool: string) => string | undefined;
}

/**
 * The two facts of a decision that the Authority Server's proposal read does not carry
 * (`mandate_id`, `action_type`), from this gateway's own data: the signed mandate, its own
 * submission record, the manifest. Never from the page and never from the AS's word.
 */
export async function resolveProposalFacts(
  d: ProposalFactsDeps,
  q: {
    proposalId: string; authorizationId: string; tool: string;
    /** The action type stored with the proposal at the Authority Server (validated there against the profile). */
    reportedActionType?: string;
    /** The person's root DID: a decision is signed only by the owner or a signed approver of the mandate. */
    approverDid?: string;
  },
): Promise<{ ok: true; mandateId: string; actionType: string } | { ok: false; code: 'mandate_unavailable' | 'action_type_unknown' | 'action_type_mismatch' | 'proposal_mismatch' | 'not_a_signed_decider' | 'mandate_not_granted' }> {
  // What the Authority Server reports about a proposal this gateway submitted must be what it submitted.
  const sub = d.submission(q.proposalId);
  if (sub && ((sub.tool !== undefined && sub.tool !== q.tool) || (sub.authorizationId !== undefined && sub.authorizationId !== q.authorizationId))) {
    return { ok: false, code: 'proposal_mismatch' };
  }
  let auth;
  try { auth = await d.auth(q.authorizationId); } catch { auth = undefined; }
  if (!auth && d.fetchAuth) { try { auth = await d.fetchAuth(q.authorizationId); } catch { auth = undefined; } }
  // Device keys: under a mandate its owner's device did not grant, no decision is offered. Only the blobs that stand on a verified grant count.
  let attestations = auth?.attestations;
  if (auth) {
    let g: GrantCheck;
    try { g = await d.grants({ authorizationId: q.authorizationId, attestations: auth.attestations }); } catch { g = { ok: false, code: 'device_state_unavailable', text: '' }; }
    if (!g.ok) return { ok: false, code: 'mandate_not_granted' };
    if (!g.skipped) attestations = auth.attestations.filter(a => g.granted.some(x => x.blob === a.blob));
  }
  // Read from the signed payload only, exactly as the executor reads it.
  const facts = signedMandateFacts(attestations, sub?.mandateId);
  if (!facts) return { ok: false, code: 'mandate_unavailable' };
  if (q.approverDid !== undefined && q.approverDid !== facts.ownerDid && !facts.deciders.includes(q.approverDid)) {
    return { ok: false, code: 'not_a_signed_decider' };
  }
  // Own submission record first, then what the proposal stores, then a manifest this gateway happens to have.
  // Any two that are present must agree; the signature binds the result and the owner's executor checks it
  // against its own record.
  const known = [sub?.actionType, q.reportedActionType, d.manifestActionType(q.tool)].filter((a): a is string => typeof a === 'string' && a.length > 0);
  if (new Set(known).size > 1) return { ok: false, code: 'action_type_mismatch' };
  const actionType = known[0];
  if (typeof actionType !== 'string' || !actionType) return { ok: false, code: 'action_type_unknown' };
  return { ok: true, mandateId: facts.mandateId, actionType };
}

/** The owner and signed approvers of every mandate in the attestation cache: whose pins must survive an eviction. */
export function signedDidsOfCache(cache: { getAllAuthorizations?: () => Array<{ attestations?: ReadonlyArray<{ blob: string }> }> } | undefined): string[] {
  if (!deviceKeysEnabled()) return [];
  const out = new Set<string>();
  try {
    for (const a of cache?.getAllAuthorizations?.() ?? []) {
      const f = signedMandateFacts(a.attestations);
      if (f) { out.add(f.ownerDid); for (const d of f.deciders) out.add(d); }
    }
  } catch { /* the pins just are not protected */ }
  return [...out].slice(0, 256);
}
