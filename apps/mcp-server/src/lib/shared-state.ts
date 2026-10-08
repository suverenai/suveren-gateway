/**
 * Shared State — singleton that lives at the HTTP server level, reused across MCP connections.
 *
 * Holds one SPClient, one AttestationCache, and one GateStore.
 */

import { SPClient } from './sp-client';
import { AttestationCache, AsKeyMismatchError, type CachedAuthorization } from './attestation-cache';
import { GateStore, type GateContent, type GateEntry } from './gate-store';
import { ExecutionLog } from './execution-log';
import { DenialLog } from './denial-log';
import { ReceiptArchive, ArchiveWriteError, type ArchivedAttestation } from './receipt-archive';
import { ExecutionJournal } from './execution-journal';
import { ProposalSubmissionStore } from './proposal-submission-store';
import { MCPGatekeeper } from './gatekeeper';
import { ReportStore } from './report/report-store';
import { PROTOCOL_VERSION } from '@hap/core';

export interface EnrichedAuthorization extends CachedAuthorization {
  gateContent: GateContent | null;
  // v0.4 fields merged from gate store (may override cache values)
  context?: Record<string, string | number>;
  contextHash?: string;
}

export class SharedState {
  readonly spClient: SPClient;
  readonly cache: AttestationCache;
  readonly gateStore: GateStore;
  readonly executionLog: ExecutionLog;
  readonly denialLog: DenialLog;
  readonly receiptArchive: ReceiptArchive;
  /** The one current evidence-backed report the user's AI has written —
   *  see report/report-store.ts. Vault-encrypted, like the stores above. */
  readonly reportStore: ReportStore;
  /** Which tickets this Gatekeeper has executed — the "one execution per ticket" half of exactly-once. */
  readonly executionJournal: ExecutionJournal;
  /** What THIS gateway submitted for each review-mode proposal it created —
   *  see ticket-verify.ts / commitments.ts. */
  readonly proposalSubmissions: ProposalSubmissionStore;
  readonly gatekeeper: MCPGatekeeper;

  /**
   * V7 — set by {@link checkAsCompat} (called once at process start, and
   * again whenever the AS URL this process pairs with changes — which, in
   * practice, only happens across a restart; see bin/http.ts's
   * `repairIfAsUrlChanged`). Non-null means the AS this gateway is paired
   * with does not list {@link PROTOCOL_VERSION} among its
   * `supportedVersions` — every gated tool call MUST refuse with this
   * message rather than reach the AS at all (checked in tool-proxy.ts,
   * before anything else). `null` until the first check completes, which
   * reads the SAME as "compatible" — fail-closed behaviour starts only
   * once a check has actually run and failed, not merely "has not run
   * yet" (the compat endpoint is best-effort: an AS that is briefly
   * unreachable at boot must not permanently brick the gateway).
   */
  asVersionRefusal: string | null = null;

  /**
   * @param dataDir Passed to the AttestationCache so it can enforce AS key
   *   pinning (as-pairing.ts), and to the SPClient so it can enforce opt-in
   *   TLS pinning (as-tls-pin.ts). Optional for backward compat with
   *   existing constructions/tests that pass only a URL — those get
   *   unpinned trust-on-first-use behavior, same as before pinning existed.
   */
  constructor(spUrl: string, gateStorePath?: string, dataDir?: string) {
    this.spClient = new SPClient(spUrl, undefined, dataDir);
    this.cache = new AttestationCache(this.spClient, dataDir);
    this.gateStore = new GateStore(gateStorePath);
    this.executionLog = new ExecutionLog(gateStorePath);
    this.denialLog = new DenialLog(gateStorePath);
    this.receiptArchive = new ReceiptArchive(gateStorePath);
    this.reportStore = new ReportStore(gateStorePath);
    this.executionJournal = new ExecutionJournal(gateStorePath);
    this.proposalSubmissions = new ProposalSubmissionStore(gateStorePath);
    // The execution log is deliberately NOT handed to the Gatekeeper: it is a
    // display-only record (see gatekeeper.ts), and the AS is the sole
    // cumulative enforcer.
    this.gatekeeper = new MCPGatekeeper(this.cache);
  }

  /**
   * V7 — call once at startup (and again if the AS URL this process pairs
   * with changes). Fetches GET /api/as/compat and sets
   * {@link asVersionRefusal} when the AS does not support this package's
   * protocol version. A network failure (AS unreachable at boot) does NOT
   * set a refusal — that is a connectivity problem every gated call
   * already surfaces on its own merits (SPReceiptError etc.); this check
   * exists to catch the specific, otherwise-silent-until-first-tool-call
   * case of a genuinely incompatible AS, not to duplicate "AS is down".
   */
  async checkAsCompat(): Promise<void> {
    let compat: { protocolVersion?: unknown; supportedVersions?: unknown };
    try {
      compat = await this.spClient.getCompat();
    } catch {
      return; // unreachable — not this check's concern; leave any prior result as-is
    }
    // A pre-v0.7 AS's /api/as/compat has no `supportedVersions` field at
    // all (its own response shape predates this check) — read defensively
    // rather than crashing (`undefined.includes` on a floating,
    // fire-and-forget promise is an UNHANDLED REJECTION, which modern Node
    // treats as fatal: this previously took the whole process down against
    // a real pre-migration AS, every other in-flight request included).
    // Missing/malformed is exactly as incompatible as a list that doesn't
    // name our version — both get the same clear refusal.
    const supported = Array.isArray(compat.supportedVersions) ? compat.supportedVersions : [];
    if (!supported.includes(PROTOCOL_VERSION)) {
      this.asVersionRefusal = supported.length > 0
        ? `This Authority Server supports protocol version(s) [${supported.join(', ')}], not ${PROTOCOL_VERSION}. ` +
          'Update the gateway or the Authority Server so the two agree, then restart. No gated action can run until then.'
        : `This Authority Server's /api/as/compat does not name a supportedVersions list (it answered ` +
          `${JSON.stringify(compat.protocolVersion ?? 'unknown')}), so it cannot be confirmed to support ` +
          `protocol ${PROTOCOL_VERSION}. Update the gateway or the Authority Server, then restart. No gated action can run until then.`;
      console.error(`[Suveren MCP] ${this.asVersionRefusal}`);
    } else {
      this.asVersionRefusal = null;
    }
  }

  /**
   * Archive a signed receipt into the local receipt archive — the subject's
   * own durable copy of the evidence (see receipt-archive.ts).
   *
   * FAIL-CLOSED (V8, reversed from the original "best-effort" contract):
   * callers MUST call this BEFORE executing the downstream tool, and MUST
   * NOT execute it if this throws. The AS's copy of the TICKET is
   * authoritative, but this archive is the subject's ONLY copy of the
   * intent/context plaintext the ticket's hashes commit to, and of the
   * issuer key needed to verify it offline — an execution that ran with no
   * way to produce that evidence later is worse than one that was refused
   * up front.
   *
   * @throws AsKeyMismatchError when the pinned key is unavailable or
   *   mismatched (propagated as-is — callers already react to this
   *   specifically: refuse + lock, not a generic archive failure).
   * @throws ArchiveWriteError for every other failure to produce a complete,
   *   verifiable entry (no public key resolved, or the write itself failed).
   */
  async archiveReceipt(
    receipt: Record<string, unknown>,
    opts: {
      authorizationId: string;
      profileId?: string;
      boundsHash?: string;
      contextHash?: string;
      bounds?: Record<string, string | number>;
      context?: Record<string, string | number>;
      intent?: string;
      attestations?: ArchivedAttestation[];
      /** Review path — the proposal this receipt executed (what was approved). */
      proposal?: Record<string, unknown>;
      /** The preimage of the receipt's contentHash — what actually ran. */
      boundContent?: Record<string, unknown> | string;
    },
  ): Promise<void> {
    // Store the AS pubkey alongside so the entry verifies offline even if
    // the AS later disappears. By the time archiveReceipt runs,
    // ticket-verify.ts has already required a clean getPublicKey() to get
    // this far in the normal call path, so this is normally free (5 min
    // cache) — but REQUIRED now (asPublicKey is no longer optional on the
    // archive entry): an entry with no issuer key can never be verified, so
    // failing to resolve one fails the whole write, not just that one field.
    let asPublicKey: string;
    try {
      asPublicKey = await this.cache.getPublicKey();
    } catch (err) {
      if (err instanceof AsKeyMismatchError) throw err;
      throw new ArchiveWriteError(
        `Could not resolve the Authority Server's public key to archive this receipt against: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      this.receiptArchive.record({
        receipt,
        authorizationId: opts.authorizationId,
        asUrl: this.spClient.url,
        asPublicKey,
        proposal: opts.proposal,
        boundContent: opts.boundContent,
        authorization: opts.profileId
          ? {
              profileId: opts.profileId,
              boundsHash: opts.boundsHash,
              contextHash: opts.contextHash ?? this.gateStore.get(opts.authorizationId)?.contextHash,
              bounds: opts.bounds,
              context: opts.context,
              // Fall back to the gate store — the review path's cached auth
              // carries no gate content.
              intent: opts.intent ?? this.gateStore.get(opts.authorizationId)?.gateContent?.intent,
              attestations: opts.attestations ?? [],
            }
          : undefined,
      });
    } catch (err) {
      throw new ArchiveWriteError(`Receipt archive write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  setGateContent(
    path: string,
    authorizationId: string,
    profileId: string,
    content: GateContent,
    opts?: {
      boundsHash?: string;
      contextHash?: string;
      context?: Record<string, string | number>;
      contextLabels?: Record<string, Record<string, string>>;
    },
  ): void {
    // Key the entry by the per-ceremony id — twins can never collide.
    this.gateStore.set(authorizationId, {
      authorizationId,
      boundsHash: opts?.boundsHash,
      contextHash: opts?.contextHash,
      path,
      profileId,
      gateContent: content,
      context: opts?.context,
      contextLabels: opts?.contextLabels,
      storedAt: new Date().toISOString(),
    });
  }

  getGateContent(path: string): GateEntry | null {
    return this.gateStore.get(path);
  }

  /**
   * Join active+complete cached authorizations with gate content from the GateStore.
   * v0.4: also merges context/contextHash from gate store if not present on cached auth.
   */
  getEnrichedAuthorizations(): EnrichedAuthorization[] {
    const authorizations = this.cache.getAllAuthorizations();

    return authorizations
      .map(auth => {
        // Gate content is keyed by the per-ceremony id — one grant, one entry,
        // no fallbacks (fingerprint/path fallbacks were the cross-contamination
        // vector between same-bounds twins).
        const gateEntry = this.gateStore.get(auth.authorizationId) ?? null;

        return {
          ...auth,
          gateContent: gateEntry?.gateContent ?? null,
          context: auth.context ?? gateEntry?.context,
          contextHash: auth.contextHash ?? gateEntry?.contextHash,
        };
      })
      .filter(auth => auth.gateContent !== null);
  }
}
