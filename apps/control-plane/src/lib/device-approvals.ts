/**
 * What the person approved, on ANY of their own devices, checked here before the one thing that raises Touch ID on their behalf runs:
 * creating or changing a mandate for an AI's proposal (`/internal/mandate`, called with only the internal secret).
 * Plan 20.21.6 "Approval from any own device" (replaces the in-memory `MandateApprovals` of the security fix F2).
 *
 * The approval is the device-signed COMMIT decision the Authority Server already stores (plan 4.2). Nothing is remembered
 * here. For a fingerprint (`approvalHash`) this takes, in order:
 *
 *   1. the committed proposals with that fingerprint and the stored decisions, from the Authority Server (a carrier only);
 *   2. each decision verified with hap-core `verifyDecision` against THIS gateway's OWN verified chain of the person
 *      (never keys or heads the Authority Server names): signature, `key_id` active at the head (so a removed device fails
 *      for good), named head, the person's root DID; `commit`; the action is the tool being run; the signed content hash
 *      is the fingerprint asked for; not older than 7 days (the decision's own time AND the Authority Server's);
 *   3. the content opened HERE with this computer's read key, and `sha256(canonical plaintext)` equal to the signed hash.
 *      The arguments come from this plaintext only, never from the caller and never from the Authority Server's say-so;
 *   4. the single use claimed on the Authority Server (`spend`, 10 minutes) and recorded in the local ledger BEFORE the touch.
 *      Released when the mandate was not issued; marked spent as soon as the Authority Server accepted the mandate.
 *
 * Any active device of the person's chain counts: this computer, another computer, the phone.
 *
 * `mandate_id` and `action_type` (two of the five members `verifyDecision` wants to see) are read from the decision itself,
 * after its `action` and `proposal_content_hash` were compared with what is run (plan 20.21.10 question 7). The signature
 * covers them: they are whatever the person's own gateway signed, and the Authority Server cannot change them.
 */

import { randomBytes } from 'node:crypto';
import type { Vault } from './vault';
import { deviceKeys, isDeviceKeysError } from './device-keys-lazy';
import { AsTlsMismatchError } from './as-tls-pin';
import { AsUnreachableError, asErrorCode, type DeviceAsClient } from './device-as-client';
import { loadOrGenerateKeyPair } from './e2e-key-manager';
import { computeProposalContentHash, decryptProposalContent, type ProposalContentWire } from './content-crypto';
import { GrantRefusal, type MandateGrants } from './mandate-grants';
import { PinRefusedError, type DevicePinStore } from './device-pin-store';

export type ApprovedTool = 'setup__create_mandate' | 'setup__change_mandate';
export const APPROVED_TOOLS: readonly ApprovedTool[] = ['setup__create_mandate', 'setup__change_mandate'];

/** Same age limit as the in-memory map had: an approval is good for 7 days. */
export const APPROVAL_TTL_SECONDS = 7 * 24 * 3600;
/** A decision dated later than this past "now" is not from a clock that can be trusted. */
const FUTURE_SKEW_SECONDS = 300;
const MAX_CANDIDATES = 20;
const HASH = /^sha256:[0-9a-f]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A refusal with a neutral code. */
export class ApprovalRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(code);
    this.message = message;
    this.name = 'ApprovalRefusal';
  }
}

export interface TakenApproval {
  /** The arguments the person approved, opened on this computer. */
  args: Record<string, unknown>;
  proposalId: string;
  /** The id the NEW mandate must get (named in the claim, so a lapsed claim cannot be taken over once that mandate is issued); for a change the id of the mandate being changed. */
  mandateId: string;
  /** The Authority Server accepted the mandate `mandateId`: the approval is spent for good (told to the Authority Server; see {@link settled}). */
  done: (mandateId?: string) => void;
  /** The mandate was NOT issued: the claim is given back so the person can try again within the time. A no-op after `done`. */
  release: () => Promise<void>;
  /** Resolves when the Authority Server was told (after `done`); never rejects. */
  settled: () => Promise<void>;
}

export interface DeviceApprovalsDeps {
  vault: Vault;
  client: DeviceAsClient;
  grants: MandateGrants;
  /** The ledger of proposal ids and decision nonces (`consume`). */
  pins: DevicePinStore;
  /** Epoch seconds. */
  now?: () => number;
}

interface Candidate { id: string; contentHash: string; tool: string; content: unknown; toolArgs: unknown; decisions: unknown[]; spent: boolean; claimed: boolean }

export class DeviceApprovals {
  private readonly now: () => number;
  constructor(private readonly d: DeviceApprovalsDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Take the approval for this tool and fingerprint and claim its single use, or throw {@link ApprovalRefusal}.
   * `code: 'approval_required'` means nothing was approved under that fingerprint (by this person, for this tool).
   */
  async take(tool: string, contentHash: unknown): Promise<TakenApproval> {
    if (!(APPROVED_TOOLS as readonly string[]).includes(tool) || typeof contentHash !== 'string' || !HASH.test(contentHash)) throw none();
    // this person's own verified chain, from the genesis on; a gateway that cannot verify it approves nothing
    let session: Awaited<ReturnType<MandateGrants['approvalSession']>>;
    try { session = await this.d.grants.approvalSession(); } catch (e) {
      if (e instanceof GrantRefusal) {
        throw new ApprovalRefusal(e.code === 'as_unreachable' || e.code === 'as_tls_mismatch' ? 502 : 403, 'approval_unverifiable', 'The approval could not be checked.', { reason: e.code });
      }
      throw e;
    }
    const candidates = await this.candidates(tool, contentHash, session.credential);
    let failure: ApprovalRefusal = none();
    for (const c of candidates) {
      try {
        return await this.takeCandidate(tool, contentHash, c, session);
      } catch (e) {
        if (!(e instanceof ApprovalRefusal)) throw e;
        // the most telling refusal wins: "already used" and "not by this person" say more than "nothing"
        if (e.code === 'approval_already_used' || failure.code === 'approval_required') failure = e;
      }
    }
    throw failure;
  }

  private async call(method: string, path: string, credential: string, body?: unknown) {
    try {
      return await this.d.client.call(method, path, { bearer: credential, ...(body !== undefined ? { body } : {}) });
    } catch (e) {
      if (e instanceof AsTlsMismatchError) throw new ApprovalRefusal(502, 'approval_unverifiable', 'The Authority Server connection did not match its pin.', { reason: 'as_tls_mismatch' });
      if (e instanceof AsUnreachableError) throw new ApprovalRefusal(502, 'approval_unverifiable', 'The Authority Server could not be reached.', { reason: 'as_unreachable' });
      throw e;
    }
  }

  private async candidates(tool: string, contentHash: string, credential: string): Promise<Candidate[]> {
    const r = await this.call('GET', `/api/proposals/committed?content_hash=${encodeURIComponent(contentHash)}&tool=${encodeURIComponent(tool)}`, credential);
    if (r.status === 404) return [];
    if (r.status !== 200 || !isObj(r.body) || !Array.isArray(r.body.proposals)) throw new ApprovalRefusal(502, 'approval_unverifiable', 'The Authority Server answered with something unexpected.', { reason: 'as_answer_invalid' });
    const out: Candidate[] = [];
    for (const e of r.body.proposals.slice(0, MAX_CANDIDATES)) {
      const p = isObj(e) ? e.proposal : null;
      // What the Authority Server names is only a lead: the proposal must be the one asked for, by tool and fingerprint; the decision is verified below.
      if (!isObj(e) || !isObj(p) || !str(p.id) || p.id.length > 128 || p.tool !== tool || p.contentHash !== contentHash || !isObj(e.decision)) continue;
      const spend = isObj(e.spend) ? e.spend.state : undefined;
      out.push({ id: p.id, contentHash, tool, content: p.content, toolArgs: p.toolArgs, decisions: [e.decision], spent: spend === 'spent', claimed: spend === 'claimed' });
    }
    return out;
  }

  private async takeCandidate(tool: string, contentHash: string, c: Candidate, s: Awaited<ReturnType<MandateGrants['approvalSession']>>): Promise<TakenApproval> {
    // The AS's own word that it is used is only a reason to stop early; its word that it is free is never relied on (the claim below decides).
    if (c.spent || c.claimed) throw new ApprovalRefusal(403, 'approval_already_used', 'This approval was already used.');
    const dk = await deviceKeys();
    const now = this.now();
    let signed: { nonce: string } | null = null;
    let refused: ApprovalRefusal = none();
    for (const stored of c.decisions) {
      if (!isObj(stored) || !isObj(stored.decision)) continue;
      const raw = stored.decision;
      // What is run must be what was signed, BEFORE the signed ids are read out of the decision.
      if (raw.action !== tool || raw.proposal_content_hash !== contentHash || raw.decision !== 'commit' || raw.proposal_id !== c.id) continue;
      if (!str(raw.mandate_id) || !str(raw.action_type)) continue;
      try {
        const verified = await dk.verifyDecision({ decision: raw, sig: stored.sig }, {
          chain: s.own,
          expect: { proposal_id: c.id, mandate_id: raw.mandate_id, action: tool, action_type: raw.action_type, proposal_content_hash: contentHash },
        });
        if (verified.decision !== 'commit') continue;
        if (!Number.isSafeInteger(verified.decided_at) || verified.decided_at > now + FUTURE_SKEW_SECONDS || verified.decided_at < now - APPROVAL_TTL_SECONDS) {
          refused = new ApprovalRefusal(403, 'approval_expired', 'The approval is too old.');
          continue;
        }
        const at = stored.stored_at;
        if (typeof at !== 'number' || !Number.isFinite(at) || at > now + FUTURE_SKEW_SECONDS || at < now - APPROVAL_TTL_SECONDS) {
          refused = new ApprovalRefusal(403, 'approval_expired', 'The approval is too old.');
          continue;
        }
        signed = { nonce: verified.nonce };
        break;
      } catch (e) {
        if (isDeviceKeysError(e)) { refused = new ApprovalRefusal(403, 'approval_not_signed_by_this_person', 'No device of this person signed this approval.', { reason: e.code }); continue; }
        throw e;
      }
    }
    if (!signed) throw refused;

    // The arguments: the content opened HERE, hashed again, equal to the signed hash.
    const args = await this.open(c, contentHash);
    if (!args) throw new ApprovalRefusal(403, 'approval_content_mismatch', 'The approved content could not be opened here, or is not what was approved.');

    // The local ledger first (it works without the network), then the claim on the Authority Server, both BEFORE any touch.
    try { this.d.pins.consume(c.id, [signed.nonce]); } catch (e) {
      if (e instanceof PinRefusedError) throw new ApprovalRefusal(403, 'approval_already_used', 'This approval was already used.');
      throw e;
    }
    // The claim NAMES the mandate it is for (the AS requires it). A new mandate gets the id chosen now; a change is of an existing mandate, whose
    // id is read from the AS and verified against this person's chain. A claim cannot be taken over once that mandate is issued.
    let mandateId: string;
    if (tool === 'setup__create_mandate') mandateId = randomBytes(18).toString('base64url');
    else {
      try { mandateId = await this.d.grants.mandateIdFor(String(args.mandate_id)); } catch (e) {
        if (e instanceof GrantRefusal) throw new ApprovalRefusal(e.code === 'as_unreachable' || e.code === 'as_tls_mismatch' ? 502 : 403, e.code === 'as_unreachable' || e.code === 'as_tls_mismatch' ? 'approval_unverifiable' : 'approval_other_mandate', 'The mandate named in the approval could not be found.', { reason: e.code });
        throw e;
      }
    }
    const claim = await this.call('POST', `/api/proposals/${encodeURIComponent(c.id)}/spend`, s.credential, { phase: 'claim', mandate_id: mandateId });
    if (claim.status >= 400) {
      const code = asErrorCode(claim.body);
      if (code === 'SPEND_CLAIMED' || code === 'SPEND_DONE') throw new ApprovalRefusal(403, 'approval_already_used', 'This approval was already used.');
      if (code === 'PROPOSAL_NOT_COMMITTED' || code === 'NO_DEVICE_DECISION' || claim.status === 404) throw none();
    }
    if (claim.status < 200 || claim.status >= 300) throw new ApprovalRefusal(502, 'approval_unverifiable', 'The Authority Server did not accept the claim.', { reason: 'as_answer_invalid' });

    let issued = false;
    let told: Promise<void> = Promise.resolve();
    const credential = s.credential;
    const id = c.id;
    return {
      args, proposalId: id, mandateId,
      done: (mandateId?: string) => {
        if (issued) return;
        issued = true;
        told = (async () => {
          if (typeof mandateId !== 'string') { console.error('[Control Plane] approval spend: no mandate id to record'); return; }
          // One retry: if the Authority Server is never told, the claim lapses after 10 minutes and the approval could run again.
          for (let i = 0; i < 2; i++) {
            try {
              const r = await this.call('POST', `/api/proposals/${encodeURIComponent(id)}/spend`, credential, { phase: 'done', mandate_id: mandateId });
              if (r.status >= 200 && r.status < 300) return;
            } catch { /* try again */ }
          }
          console.error('[Control Plane] approval spend could not be recorded on the Authority Server');
        })();
      },
      release: async () => {
        if (issued) return;
        try { await this.call('POST', `/api/proposals/${encodeURIComponent(id)}/release`, credential, {}); } catch { /* the claim lapses by itself */ }
      },
      settled: () => told,
    };
  }

  /** Open the content with this computer's read key; the plaintext must hash to the signed fingerprint. */
  private async open(c: Candidate, contentHash: string): Promise<Record<string, unknown> | null> {
    let plain: Record<string, unknown> | null = null;
    if (isObj(c.toolArgs)) plain = c.toolArgs;
    else if (isObj(c.content)) {
      const me = this.d.vault.getSessionUser();
      if (!me) return null;
      try {
        const kp = await loadOrGenerateKeyPair(this.d.vault);
        const text = await decryptProposalContent({ ...(c.content as unknown as ProposalContentWire), proposalContentHash: contentHash }, me.id, kp.privateKey, me.did);
        const parsed: unknown = JSON.parse(text);
        plain = isObj(parsed) ? parsed : null;
      } catch { return null; }
    }
    if (!plain || computeProposalContentHash(plain) !== contentHash) return null;
    return structuredClone(plain);
  }
}

function none(): ApprovalRefusal {
  return new ApprovalRefusal(403, 'approval_required', 'A mandate on this gateway is created only for what the person approved, and nothing was approved under that fingerprint.');
}
