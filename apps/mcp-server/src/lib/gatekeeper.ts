/**
 * MCP Gatekeeper Wrapper — integrates hap-core Gatekeeper with attestation cache and execution log.
 */

import { verify, type GatekeeperRequest, type GatekeeperResult } from '@hap/core';
import { AttestationCache, AsKeyMismatchError, type CachedAuthorization } from './attestation-cache';
import { notifyControlPlane } from './cp-notify';

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
      // No mandate at all for this path, locally — the closest canonical
      // fit is MANDATE_NOT_FOUND (protocol.md -> Error Codes: "no mandate
      // blob is stored for this authorization"). `DOMAIN_NOT_COVERED` is
      // not a canonical v0.7 code (CHANGELOG.md -> "Removed (no alias)").
      return {
        result: {
          approved: false,
          errors: [{
            code: 'MANDATE_NOT_FOUND',
            message: `No active authorization for "${authorizationPath}". A decision owner must grant authority via the Authority UI.`,
          }],
        },
        authorization: null,
      };
    }

    if (!auth.complete) {
      const missing = auth.requiredDomains.filter(d => !auth.attestedDomains.includes(d));
      // A required owner's mandate is missing — protocol.md -> Multi-Owner
      // Coverage Rule names exactly this COVERAGE_INSUFFICIENT.
      return {
        result: {
          approved: false,
          errors: [{
            code: 'COVERAGE_INSUFFICIENT',
            message: `Authorization "${authorizationPath}" is pending. Missing domains: ${missing.join(', ')}`,
          }],
        },
        authorization: auth,
      };
    }

    // Get the pinned Authority Server's did:key — pinned at pairing (see
    // as-pairing.ts). A mismatch here means the AS this URL now resolves to
    // is not the one we paired with, which is exactly the case pinning
    // exists to catch: refuse this action AND lock the gateway, the same
    // fail-closed shape as a session that ended mid-flight (session-lock.ts),
    // rather than quietly trusting whatever key just answered.
    //
    // hap-core 0.12's `verify()` no longer takes a raw public key — it
    // resolves the verification key from each mandate's own `issuer` DID and
    // only ACCEPTS the ones named in `trustedIssuers` (protocol.md -> *Ticket
    // Verification* step 1, applied identically to mandates). Passing the
    // did:key derived from our pinned hex preserves the same property: a
    // mandate whose issuer does not decode to exactly that key is rejected.
    let trustedIssuer: string;
    try {
      trustedIssuer = await this.cache.getTrustedIssuer();
    } catch (err) {
      if (err instanceof AsKeyMismatchError) {
        void notifyControlPlane('as-key-mismatch');
        return {
          result: {
            approved: false,
            // No dedicated GatekeeperError code exists for this (hap-core's
            // union predates gateway-side key pinning) — INVALID_SIGNATURE is
            // the closest fit: it's exactly the claim being made here ("we
            // will not trust a signature made under this key").
            errors: [{ code: 'INVALID_SIGNATURE', message: err.message }],
          },
          authorization: auth,
        };
      }
      throw err;
    }

    const resolvedBounds = override?.bounds ?? auth.bounds ?? auth.frame;
    const resolvedScope = override?.context ?? auth.context;

    // Ensure profile is present with the full URI — needed for profile resolution.
    // The bounds may have the short name ('customers') or full URI; use full URI from auth.
    const bounds = { ...resolvedBounds, profile: auth.profileId };

    // Scope carries the declared allowed set (e.g., allowed_recipients).
    // hap-core's checkScopeConstraints compares execution values against it
    // to enforce subset/enum constraints. Required locally per spec — the AS
    // only holds scope_hash and cannot enforce scope constraints.
    const request: GatekeeperRequest = {
      bounds,
      mandates: auth.attestations.map(a => a.blob),
      execution,
      scope: resolvedScope,
      // Identifies the grant whose bounds are being checked. hap-core reads it
      // only to scope a cumulative lookup, which no longer happens here (see
      // below); it is kept because it belongs to the request, not to the
      // dropped check. It cannot go inside `bounds`: that is validated against
      // the profile's boundsSchema, which declares no `path` field in any
      // shipped profile, so an extra key there fails with "Unknown field".
      path: auth.path,
    };

    // NO execution log is passed, deliberately — so hap-core runs the local
    // checks and skips the cumulative ones.
    //
    // Per-transaction bounds, enum bounds and scope constraints are enforced
    // here (the AS holds only `scope_hash` and cannot inspect plaintext
    // scope, so the last of those is ours alone). Cumulative bounds
    // (`cumulative_sum`, `cumulative_count`) are the AS's job ALONE: it holds
    // the ticket history, and it is the only party that can refuse before a
    // ticket exists. Our 31-day local log is display-only — checking it here
    // would be a second, drifting copy of the source of truth, and it fails in
    // both directions (a pruned or fresh log under-counts; a log holding
    // executions the AS never counted over-counts and blocks work the grant
    // allows). protocol.md → "Executor Gating, Scope vs Bounds, Display-Only
    // Logs": "v0.4 reference implementations that re-checked cumulative bounds
    // locally before calling the AS MUST drop the local check."
    //
    // hap-core skips a cumulative bound when no log is supplied (it `break`s
    // out of the case) — it does not fail closed on the missing log, so the
    // call proceeds to the AS pre-flight, which is what refuses it.
    const result = await verify(request, { trustedIssuers: [trustedIssuer] });
    return { result, authorization: auth };
  }
}
