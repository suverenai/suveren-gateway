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
import { ReceiptArchive, type ArchivedAttestation } from './receipt-archive';
import { ExecutionJournal } from './execution-journal';
import { ProposalSubmissionStore } from './proposal-submission-store';
import { MCPGatekeeper } from './gatekeeper';
import { ReportStore } from './report/report-store';

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
   * Archive a signed receipt into the local receipt archive — the subject's
   * own durable copy of the evidence (see receipt-archive.ts).
   *
   * Best-effort by contract: the AS has already issued the receipt and holds
   * the authoritative copy, so an archive failure logs loudly but MUST NOT
   * block the execution it documents.
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
    try {
      // Store the AS pubkey alongside so the entry verifies offline even if
      // the AS later disappears. Best-effort: cached 5 min, usually free —
      // EXCEPT a pin mismatch, which must not be swallowed here. By the time
      // archiveReceipt runs, ticket-verify.ts has already required a clean
      // getPublicKey() to get this far in the normal call path; a mismatch
      // surfacing here regardless means something call this out of order,
      // and archiving a receipt from a server whose key we no longer trust
      // silently would misrepresent it as verified evidence.
      let asPublicKey: string | undefined;
      try {
        asPublicKey = await this.cache.getPublicKey();
      } catch (err) {
        if (err instanceof AsKeyMismatchError) throw err;
        /* any other failure — archive without it, still verifiable via any saved key */
      }

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
      // AsKeyMismatchError is not an archive-write failure — it means the
      // gateway no longer trusts this Authority Server's key, which callers
      // (tool-proxy.ts, commitments.ts) must react to (refuse + lock), so it
      // must not be swallowed into a log line like a disk-write hiccup.
      if (err instanceof AsKeyMismatchError) throw err;
      console.error(
        '[Suveren MCP] Receipt archive write failed (execution proceeds — AS retains authoritative copy):',
        err,
      );
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
