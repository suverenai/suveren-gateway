/**
 * Build the `/gate-content` forward payload from an attest result.
 *
 * The MCP server resolves the attestation at the Authority Server by its
 * **per-user storage key** (`frame_hash` = `${boundsHash}:${userId}`), so the
 * forward MUST carry `frameHash`. Sending only `boundsHash` (the bare content
 * fingerprint) fails the AS lookup → the forward 404s with
 * "Failed to forward gate content to MCP server".
 *
 * This is shared by the create flow (AgentReviewPage) and the extend flow
 * (ExtendAuthModal) precisely so they cannot diverge — the extend flow once
 * omitted `frameHash` and broke (the popup stuck on that error).
 */
export interface AttestHashes {
  frame_hash?: string;
  bounds_hash?: string;
}

export interface GateForwardFields {
  /** Locally computed bounds hash (fallback when the result omits one). */
  boundsHash: string;
  contextHash: string;
  context: Record<string, string | number>;
  gateContent: Record<string, string>;
  /** Optional; included only when present. */
  path?: string;
}

export interface GateForwardArgs {
  frameHash: string;
  boundsHash: string;
  contextHash: string;
  context: Record<string, string | number>;
  gateContent: Record<string, string>;
  path?: string;
}

export function buildGateForwardArgs(result: AttestHashes, fields: GateForwardFields): GateForwardArgs {
  return {
    // The per-user storage key the AS lookup needs. Prefer the result's
    // frame_hash; fall back to bounds_hash, then the locally computed hash.
    frameHash: result.frame_hash ?? result.bounds_hash ?? fields.boundsHash,
    boundsHash: result.bounds_hash ?? fields.boundsHash,
    contextHash: fields.contextHash,
    context: fields.context,
    gateContent: fields.gateContent,
    ...(fields.path ? { path: fields.path } : {}),
  };
}
