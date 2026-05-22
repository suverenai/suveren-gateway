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

export class SPClient {
  private sessionCookie = '';
  private apiKey = '';

  constructor(private baseUrl: string) {}

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
    attestationHash: string;
    profileId: string;
    path: string;
    action: string;
    actionType?: string;
    executionContext: Record<string, unknown>;
    amount?: number;
    proposalId?: string;
    toolArgs?: Record<string, unknown>;
  }): Promise<{ receipt: Record<string, unknown> }> {
    const res = await this.fetch('/api/as/receipt', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok || body.approved === false) {
      // Extract first structured error for the message; keep full body on the error.
      const errors = body.errors as Array<Record<string, unknown>> | undefined;
      const first = errors?.[0];
      const message =
        (first?.message as string) ??
        (first?.code as string) ??
        (body.error as string) ??
        `SP receipt request failed: ${res.status}`;
      throw new SPReceiptError(message, res.status, body);
    }
    return { receipt: body.receipt as Record<string, unknown> };
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
