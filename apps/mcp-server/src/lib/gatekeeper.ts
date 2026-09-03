/**
 * MCP Gatekeeper Wrapper — integrates hap-core Gatekeeper with attestation cache and execution log.
 */

import { verify, type GatekeeperRequest, type GatekeeperResult } from '@hap/core';
import { AttestationCache, type CachedAuthorization } from './attestation-cache';

/** Minimal subset of CachedAuthorization / EnrichedAuthorization needed for context override. */
interface AuthContextOverride {
  bounds?: Record<string, string | number>;
  context?: Record<string, string | number>;
}

export class MCPGatekeeper {
  /**
   * No ExecutionLog dependency by construction. The local record is
   * display-only (protocol.md → "Executor Gating, Context vs Bounds,
   * Display-Only Logs"), so the Gatekeeper must not be able to read it: with
   * no log in scope, a local cumulative check cannot be reintroduced by
   * accident. `SharedState.executionLog` stays — it feeds the UI's consumption
   * display and nothing else.
   */
  constructor(private cache: AttestationCache) {}

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
    const request: GatekeeperRequest = {
      frame,
      attestations: auth.attestations.map(a => a.blob),
      execution,
      context: resolvedContext,
      // Identifies the grant whose bounds are being checked. hap-core reads it
      // only to scope a cumulative lookup, which no longer happens here (see
      // below); it is kept because it belongs to the request, not to the
      // dropped check. It cannot go inside `frame`: that is validated against
      // the profile's boundsSchema, which declares no `path` field in any
      // shipped profile, so an extra key there fails with "Unknown field".
      path: auth.path,
    };

    // NO execution log is passed, deliberately — so hap-core runs the local
    // checks and skips the cumulative ones.
    //
    // Per-transaction bounds, enum bounds and context constraints are enforced
    // here (the AS holds only `context_hash` and cannot inspect plaintext
    // context, so the last of those is ours alone). Cumulative bounds
    // (`cumulative_sum`, `cumulative_count`) are the AS's job ALONE: it holds
    // the receipt history, and it is the only party that can refuse before a
    // receipt exists. Our 31-day local log is display-only — checking it here
    // would be a second, drifting copy of the source of truth, and it fails in
    // both directions (a pruned or fresh log under-counts; a log holding
    // executions the AS never counted over-counts and blocks work the grant
    // allows). protocol.md → "Executor Gating, Context vs Bounds, Display-Only
    // Logs": "v0.4 reference implementations that re-checked cumulative bounds
    // locally before calling the AS MUST drop the local check."
    //
    // hap-core skips a cumulative bound when no log is supplied (it `break`s
    // out of the case) — it does not fail closed on the missing log, so the
    // call proceeds to the AS pre-flight, which is what refuses it.
    const result = await verify(request, publicKeyHex);
    return { result, authorization: auth };
  }
}
