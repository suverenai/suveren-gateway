/**
 * Build the `/gate-content` forward payload from an attest result.
 *
 * The MCP server resolves the authorization at the Authority Server by its
 * **per-ceremony id** (`authorization_id`), and keys the local gate content by
 * it — one grant, one entry, no fingerprint fallbacks (those were the
 * cross-contamination vector between same-bounds twins).
 *
 * Shared by the create flow (AgentReviewPage) and the extend/renew flow
 * (ExtendAuthModal) precisely so they cannot diverge.
 */
export interface AttestHashes {
  authorization_id?: string;
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
  authorizationId: string;
  boundsHash: string;
  contextHash: string;
  context: Record<string, string | number>;
  gateContent: Record<string, string>;
  path?: string;
}

export function buildGateForwardArgs(result: AttestHashes, fields: GateForwardFields): GateForwardArgs {
  // Lockstep guard: an attest result without an authorization_id means the
  // Authority Server predates per-ceremony identity. Storing gate content
  // under any other key would silently reintroduce the fingerprint-merge
  // bug, so fail loudly instead.
  if (!result.authorization_id) {
    throw new Error(
      'Attest result lacks authorization_id — the Authority Server predates ' +
      'per-ceremony identity. Update the Authority Server (lockstep deploy).',
    );
  }
  return {
    authorizationId: result.authorization_id,
    boundsHash: result.bounds_hash ?? fields.boundsHash,
    contextHash: fields.contextHash,
    context: fields.context,
    gateContent: fields.gateContent,
    ...(fields.path ? { path: fields.path } : {}),
  };
}
