/**
 * SP API Client — fetches attestations, public key, and pending attestations from the SP.
 *
 * In container mode, the control-plane pushes the session cookie to the MCP server
 * via the internal /internal/configure endpoint. All SP requests include this cookie.
 */

export interface SPAttestationResponse {
  domain: string;
  blob: string;
  expires_at: number;
}

export interface SPAttestationsResult {
  frame_hash: string;
  bounds_hash?: string;   // v0.4
  context_hash?: string;  // v0.4
  attestations: (SPAttestationResponse & { commitment?: string })[];
  complete: boolean;
  frame?: Record<string, string | number>;
  bounds?: Record<string, string | number>;  // v0.4
  profile_id?: string;
  path?: string;
  required_domains?: string[];
  attested_domains?: string[];
  deferred_commitment_domains?: string[];
}

export interface SPProposal {
  id: string;
  frameHash: string;
  profileId: string;
  path: string;
  pendingDomains: string[];
  committedBy: Record<string, { userId: string; at: number }>;
  rejectedBy: { domain: string; userId: string; at: number } | null;
  tool: string;
  toolArgs: Record<string, unknown>;
  executionContext: Record<string, string | number>;
  status: 'pending' | 'committed' | 'rejected' | 'expired' | 'executed';
  executionResult: unknown | null;
  createdAt: number;
  expiresAt: number;
  // Phase 6 fields
  pendingApprovers?: string[];
  approvedBy?: Record<string, { receiptId: string; at: number }>;
  approverRejectedBy?: { userId: string; reason?: string; at: number };
  createdBy?: string;
}

/** Phase 6: FrameMetadata as returned from SP, used for above-cap detection. */
export interface SPFrameMetadata {
  frameHash: string;
  boundsHash?: string;
  profileId: string;
  aboveCap?: boolean;
  approversFrozen?: string[];
  createdBy?: string;
  groupId?: string | null;
}

export interface SPPendingItem {
  frame_hash: string;
  profile_id: string;
  path: string;
  frame: Record<string, string | number>;
  required_domains: string[];
  attested_domains: string[];
  missing_domains: string[];
  created_at: string;
  earliest_expiry: string | null;
  remaining_seconds: number | null;
}

export class SPReceiptError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SPReceiptError';
  }
}

/**
 * Retry policy for the receipt pre-flight. Only engaged when the caller
 * supplies an `idempotencyKey` — retrying without one risks double-counting,
 * so a missing key keeps the old single-attempt behaviour. Delays are kept
 * small (this is on the hot path before every gated tool call) and are
 * injectable so tests can run with zero backoff.
 */
export interface ReceiptRetryConfig {
  /** Total attempts including the first. 1 disables retries. */
  maxAttempts: number;
  /** Backoff before attempt N (1-indexed for retries: delays[0] precedes attempt 2). */
  delaysMs: number[];
}

const DEFAULT_RECEIPT_RETRY: ReceiptRetryConfig = {
  maxAttempts: 3,
  delaysMs: [100, 300],
};

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export class SPClient {
  private sessionCookie = '';
  private apiKey = '';
  private readonly receiptRetry: ReceiptRetryConfig;

  constructor(
    private baseUrl: string,
    receiptRetry: Partial<ReceiptRetryConfig> = {},
  ) {
    this.receiptRetry = { ...DEFAULT_RECEIPT_RETRY, ...receiptRetry };
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  setSessionCookie(cookie: string): void {
    this.sessionCookie = cookie;
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string>),
    };

    if (this.sessionCookie) {
      headers['Cookie'] = this.sessionCookie;
    }

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    return globalThis.fetch(url, {
      ...init,
      headers,
    });
  }

  /**
   * Get SP public key.
   */
  async getPublicKey(): Promise<string> {
    const res = await this.fetch('/api/as/pubkey');
    if (!res.ok) throw new Error(`SP pubkey request failed: ${res.status}`);
    const data = await res.json() as { publicKey: string };
    return data.publicKey;
  }

  /**
   * Get all attestations for a frame hash.
   */
  async getAttestations(frameHash: string): Promise<SPAttestationsResult> {
    const res = await this.fetch(`/api/attestations?frame_hash=${encodeURIComponent(frameHash)}`);
    if (!res.ok) throw new Error(`SP attestations request failed: ${res.status}`);
    return res.json() as Promise<SPAttestationsResult>;
  }

  /**
   * Get pending attestations for a domain.
   */
  async getPendingAttestations(domain: string): Promise<SPPendingItem[]> {
    const res = await this.fetch(`/api/attestations/pending?domain=${encodeURIComponent(domain)}`);
    if (!res.ok) throw new Error(`SP pending request failed: ${res.status}`);
    return res.json() as Promise<SPPendingItem[]>;
  }

  /**
   * Request a signed receipt from the SP.
   *
   * v0.4:
   * - For automatic-mode attestations, this is the pre-flight check before
   *   tool execution — the SP enforces bounds/limits and returns a signed
   *   receipt on success.
   * - For review-mode attestations, the gateway first submits a proposal,
   *   waits for domain owners to commit, then calls postReceipt with the
   *   `proposalId` (and the original `toolArgs`). The SP verifies the
   *   proposal match, atomically transitions it to `executed`, and signs a
   *   receipt bound to the proposal.
   *
   * Response envelope (v0.4):
   *   { approved: true, receipt: {...} }                     — on success
   *   { approved: false, errors: [{code, message, ...}] }    — on rejection
   *
   * Errors throw SPReceiptError with the structured `errors` array in `body`.
   */
  async postReceipt(data: {
    /** v0.5: the bare content address. The AS scopes the per-user storage key
     *  server-side from this + the authenticated user. (`attestationHash` and
     *  `path` are retired and rejected by v0.5 ASs.) */
    boundsHash: string;
    profileId: string;
    action: string;
    actionType?: string;
    executionContext: Record<string, unknown>;
    amount?: number;
    proposalId?: string;
    toolArgs?: Record<string, unknown>;
    /**
     * v0.4 M3 — replay protection. A stable key for THIS logical tool call,
     * generated once by the caller and reused across retries. The AS dedups
     * on it: if a transient failure hides a response after the AS already
     * committed, the retry returns the original receipt instead of counting
     * a second time. Supplying it also enables the retry loop below; without
     * it we fall back to a single attempt (retrying blind would double-count).
     */
    idempotencyKey?: string;
    /**
     * v0.5 Content Provenance (optional). A content fingerprint the Gatekeeper
     * computed from the action's content per the profile's content_binding. The
     * AS signs it into the receipt verbatim and NEVER receives the content
     * itself — only this hash. Omitted when the profile declares no binding.
     */
    contentHash?: string;
    /** How to reproduce {@link contentHash}. Required iff contentHash is set. */
    contentBinding?: { version: string; kind: 'jcs' | 'text' };
  }): Promise<{ receipt: Record<string, unknown> }> {
    const body = JSON.stringify(data);
    // Retries are only safe when the AS can dedup them. No key → one shot.
    const maxAttempts = data.idempotencyKey ? this.receiptRetry.maxAttempts : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isLast = attempt === maxAttempts;

      let res: Response;
      try {
        res = await this.fetch('/api/as/receipt', { method: 'POST', body });
      } catch (err) {
        // Network-level failure (connection refused, reset, DNS). The request
        // may or may not have reached the AS — but because it carried the
        // idempotency key, retrying is safe: a committed receipt comes back
        // unchanged, an un-received one is processed for the first time.
        lastError = err;
        if (isLast) throw err;
        await sleep(this.receiptRetry.delaysMs[attempt - 1] ?? 0);
        continue;
      }

      const respBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      // 5xx is a transient server fault — retry with the same key.
      if (res.status >= 500 && !isLast) {
        lastError = new SPReceiptError(
          `SP receipt request failed: ${res.status}`,
          res.status,
          respBody,
        );
        await sleep(this.receiptRetry.delaysMs[attempt - 1] ?? 0);
        continue;
      }

      // Any 4xx (limit exceeded, approval_required, mismatch, not-authorized)
      // is a definitive answer from the AS — fail closed, never retry.
      if (!res.ok || respBody.approved === false) {
        const errors = respBody.errors as Array<Record<string, unknown>> | undefined;
        const first = errors?.[0];
        const message =
          (first?.message as string) ??
          (first?.code as string) ??
          (respBody.error as string) ??
          `SP receipt request failed: ${res.status}`;
        throw new SPReceiptError(message, res.status, respBody);
      }

      return { receipt: respBody.receipt as Record<string, unknown> };
    }

    // Unreachable in practice — the loop either returns, throws, or continues.
    throw lastError ?? new Error('postReceipt: retries exhausted');
  }

  /**
   * Submit a proposal for deferred commitment review.
   * Phase 6: accepts optional pendingApprovers and createdBy for above-cap routing.
   */
  async submitProposal(data: {
    frameHash: string;
    profileId: string;
    path: string;
    pendingDomains: string[];
    tool: string;
    toolArgs: Record<string, unknown>;
    executionContext: Record<string, string | number>;
    // Phase 6
    pendingApprovers?: string[];
    createdBy?: string;
  }): Promise<{ proposal: SPProposal }> {
    const res = await this.fetch('/api/proposals', {
      method: 'POST',
      body: JSON.stringify({
        frame_hash: data.frameHash,
        profile_id: data.profileId,
        path: data.path,
        pending_domains: data.pendingDomains,
        tool: data.tool,
        tool_args: data.toolArgs,
        execution_context: data.executionContext,
        // Phase 6
        ...(data.pendingApprovers && data.pendingApprovers.length > 0
          ? { pending_approvers: data.pendingApprovers }
          : {}),
        ...(data.createdBy ? { created_by: data.createdBy } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error((body.error as string) ?? `SP proposal submission failed: ${res.status}`);
    }
    return res.json() as Promise<{ proposal: SPProposal }>;
  }

  /**
   * Phase 6: Fetch frame metadata for an authority by its boundsHash / frameHash.
   * Used to read aboveCap and approversFrozen at action time.
   */
  async getFrameMetadata(frameHash: string): Promise<SPFrameMetadata | null> {
    const res = await this.fetch(`/api/as/frame/${encodeURIComponent(frameHash)}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return res.json() as Promise<SPFrameMetadata>;
  }

  /**
   * Get proposals that have been fully committed and are ready for execution.
   */
  async getCommittedProposals(): Promise<SPProposal[]> {
    const res = await this.fetch('/api/proposals?status=committed');
    if (!res.ok) throw new Error(`SP committed proposals request failed: ${res.status}`);
    const data = await res.json() as { proposals: SPProposal[] };
    return data.proposals;
  }

  // NOTE: v0.3 used POST /api/proposals/{id}/resolve with action: 'executed'
  // to mark a proposal as executed after the gateway ran the tool. In v0.4
  // the committed→executed transition is atomic with receipt issuance, so
  // this helper was removed. Use postReceipt({ proposalId }) instead.
}
