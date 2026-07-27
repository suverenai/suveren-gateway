/**
 * MCP Gatekeeper Wrapper — integrates hap-core Gatekeeper with attestation cache and execution log.
 */

import { verify, type GatekeeperRequest, type GatekeeperResult, type ExecutionLogQuery } from '@hap/core';
import { AttestationCache, type CachedAuthorization } from './attestation-cache';

/** Minimal subset of CachedAuthorization / EnrichedAuthorization needed for context override. */
interface AuthContextOverride {
  bounds?: Record<string, string | number>;
  context?: Record<string, string | number>;
}

export class MCPGatekeeper {
  constructor(
    private cache: AttestationCache,
    private executionLog?: ExecutionLogQuery,
  ) {}

  /**
   * Verify an execution request against a cached authorization.
   *
   * @param authorizationPath - The execution path (e.g., "payment-routine")
   * @param execution - The agent's execution values
   * @param override - Optional v0.4 fields (bounds, context) from the enriched auth / gate store,
   *                   used when the context is not present on the SP-cached auth itself.
   * @returns Gatekeeper result + the authorization if found
   */
  async verifyExecution(
    authorizationPath: string,
    execution: Record<string, string | number>,
    override?: AuthContextOverride,
  ): Promise<{
    result: GatekeeperResult;
    authorization: CachedAuthorization | null;
  }> {
    // Look up authorization in cache
    const auth = this.cache.getAuthorization(authorizationPath);

    if (!auth) {
      return {
        result: {
          approved: false,
          errors: [{
            code: 'DOMAIN_NOT_COVERED',
            message: `No active authorization for "${authorizationPath}". A decision owner must grant authority via the Authority UI.`,
          }],
        },
        authorization: null,
      };
    }

    if (!auth.complete) {
      const missing = auth.requiredDomains.filter(d => !auth.attestedDomains.includes(d));
      return {
        result: {
          approved: false,
          errors: [{
            code: 'DOMAIN_NOT_COVERED',
            message: `Authorization "${authorizationPath}" is pending. Missing domains: ${missing.join(', ')}`,
          }],
        },
        authorization: auth,
      };
    }

    // Get SP public key
    const publicKeyHex = await this.cache.getPublicKey();

    const resolvedBounds = override?.bounds ?? auth.bounds ?? auth.frame;
    const resolvedContext = override?.context ?? auth.context;

    // Ensure profile is present with the full URI — needed for profile resolution.
    // The bounds may have the short name ('customers') or full URI; use full URI from auth.
    const frame = { ...resolvedBounds, profile: auth.profileId };

    // Context carries the declared allowed set (e.g., allowed_recipients).
    // hap-core's checkContextConstraints compares execution values against it
    // to enforce subset/enum/pattern constraints. Required locally per spec —
    // the SP only holds context_hash and cannot enforce context constraints.
    // `path` is widened locally so this compiles against the currently
    // PUBLISHED hap-core. NOTE: the local cumulative gate stays inert until a
    // hap-core carrying the request-path fix is published and consumed here —
    // the older verify() simply ignores the field.
    const request: GatekeeperRequest & { path?: string } = {
      frame,
      attestations: auth.attestations.map(a => a.blob),
      execution,
      context: resolvedContext,
      // Scopes the local cumulative check to the same (profileId, path) key the
      // ExecutionLog records under (see tool-proxy's record call). It cannot go
      // inside `frame`: that is validated against the profile's boundsSchema,
      // which declares no `path` field in any shipped profile, so an extra key
      // there fails verification with "Unknown field". Omitting it entirely —
      // the previous behaviour — made every cumulative lookup return zero, so
      // the local gate never fired and the AS was doing all the enforcing.
      path: auth.path,
    };

    const result = await verify(request, publicKeyHex, undefined, this.executionLog);
    return { result, authorization: auth };
  }
}
