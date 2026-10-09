/**
 * A REAL, verifiably-signed scenario for report-verifier tests: a real
 * `ReceiptArchive` (temp dir, plaintext — no vault key involved), real
 * Ed25519-signed tickets (reuses `test/helpers/real-receipt.ts`) and real
 * Ed25519-signed mandate blobs, signed through hap-core's own
 * `signMandate`/`encodeMandateBlob` — the same functions `verifyMandateSignature`
 * checks against — so nothing about the cryptography here is mocked, only
 * the Authority Server's HTTP round-trip is replaced by writing the archive
 * directly.
 *
 * v0.7: a mandate carries exactly one `mandate_owners` entry (Mandate rule
 * 7) — multi-owner coverage is multiple SEPARATE attestation blobs, one per
 * domain, not a `resolved_domains` map inside one blob. `owners` here is
 * therefore a single DID; a scenario that needs a domain -> DID link sets
 * `domain` (the ARCHIVED attestation's own field — see identity.ts), which
 * defaults to 'default'.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign as cryptoSign } from 'node:crypto';
import { canonicalize, encodeMandateBlob, computeIntentHash, type Mandate, type MandatePayload } from '@hap/core';
import { ReceiptArchive } from '../../../src/lib/receipt-archive';
import { recomputeBoundsHash } from '../../../src/lib/report/verify-export';
import { testReceiptKeypair, makeSignedReceipt, type TestReceiptKeypair } from '../../helpers/real-receipt';

export const AS_URL = 'https://as.example';

/**
 * Signs a mandate payload the same way the real Authority Server does
 * (`suveren-as/src/lib/keys.ts`: JCS-canonical bytes, Ed25519) — base64url,
 * like every other v0.7 signature (README.md: "strict base64url ... not
 * silently repaired"). Hand-rolled with node:crypto rather than hap-core's
 * own (async) `signMandate` so this stays synchronous — `addTicket` below is
 * called synchronously throughout the test suite.
 */
export function signMandatePayload(payload: MandatePayload, kp: TestReceiptKeypair): Mandate {
  const bytes = Buffer.from(canonicalize(payload), 'utf-8');
  const signature = cryptoSign(null, bytes, kp.privateKey).toString('base64url');
  return { header: { typ: 'HAP-mandate', alg: 'EdDSA' }, payload, signature };
}

export interface ScenarioAuthorization {
  authorizationId: string;
  profileId: string;
  bounds?: Record<string, string | number>;
  boundsHash?: string;
  /** Scope (context) values + hash, archived like the gateway does. */
  context?: Record<string, string | number>;
  contextHash?: string;
  intent?: string;
  commitmentMode?: 'automatic' | 'review' | 'review_above_cap';
  /** The single mandate_owners DID for this mandate (v0.7: exactly one). */
  owners?: string[];
  /** Signed identity overlay (v0.6 subjects) — a name only at assurance "high". */
  subjects?: MandatePayload['subjects'];
  /** The ARCHIVED attestation's own `domain` field (in team mode the domain
   *  is the approver's account id) — defaults to 'default'. Replaces the
   *  removed per-payload `resolved_domains` map. */
  domain?: string;
}

export function buildScenario() {
  const dir = mkdtempSync(join(tmpdir(), 'suveren-report-verifier-test-'));
  const kp = testReceiptKeypair();
  const archive = new ReceiptArchive(dir);

  /** Archives a ticket (and, the first time for a given authorizationId, its
   *  mandate) exactly as `shared-state.ts#archiveReceipt` does. */
  function addTicket(opts: {
    id: string;
    action: string;
    authorizationId: string;
    timestamp?: number;
    extra?: Record<string, unknown>;
    proposal?: Record<string, unknown>;
    authorization?: ScenarioAuthorization;
    /** Archive this ticket under a DIFFERENT (wrong) AS key — for the
     *  "bad signature" test. */
    signWithKeypair?: TestReceiptKeypair;
    /** Store no asPublicKey at all — pre-field legacy entry. */
    omitAsPublicKey?: boolean;
  }) {
    const signingKp = opts.signWithKeypair ?? kp;
    // Like the real Authority Server: with bounds VALUES, the bounds hash IS
    // their canonical hash (the explicit `boundsHash` is used only without
    // values, e.g. a pre-values legacy entry).
    const authorization: ScenarioAuthorization | undefined = opts.authorization
      ? { ...opts.authorization, ...(opts.authorization.bounds ? { boundsHash: recomputeBoundsHash(opts.authorization.bounds) } : {}) }
      : undefined;
    const receipt = makeSignedReceipt(signingKp, {
      id: opts.id,
      action: opts.action,
      authorizationId: opts.authorizationId,
      profileId: opts.authorization?.profileId ?? 'test-profile',
      boundsHash: authorization?.boundsHash,
      timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
      ...opts.extra,
    });

    let attestations: Array<{ domain: string; blob: string; expiresAt: number }> = [];
    if (authorization) {
      const ownerDid = authorization.owners?.[0] ?? 'did:key:zOwner1';
      const payload: MandatePayload = {
        mandate_id: `mandate-${authorization.authorizationId}`,
        version: '0.7',
        profile_id: authorization.profileId,
        bounds_hash: authorization.boundsHash ?? 'sha256:test',
        scope_hash: authorization.contextHash ?? 'sha256:test',
        execution_context_hash: 'sha256:test',
        profile_hash: 'sha256:test',
        // Always signed with the archive's main key (`kp`), independent of
        // `signWithKeypair` — that override is for the TICKET's own "wrong
        // key" test case, exactly as before this rewrite.
        issuer: kp.issuer,
        mandate_owners: [{ did: ownerDid }],
        // Like a real mandate ceremony: the intent is committed by its hash.
        gate_content_hashes: authorization.intent ? { intent: computeIntentHash(authorization.intent) } : {},
        commitment_mode: authorization.commitmentMode ?? 'automatic',
        ...(authorization.subjects ? { subjects: authorization.subjects } : {}),
        issued_at: Math.floor(Date.now() / 1000) - 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600 * 24,
      };
      const mandate = signMandatePayload(payload, kp);
      attestations = [{ domain: authorization.domain ?? 'default', blob: encodeMandateBlob(mandate), expiresAt: payload.expires_at }];
    }

    archive.record({
      receipt,
      authorizationId: opts.authorizationId,
      asUrl: AS_URL,
      asPublicKey: opts.omitAsPublicKey ? undefined : kp.publicKeyHex,
      proposal: opts.proposal,
      authorization: authorization
        ? {
            profileId: authorization.profileId,
            boundsHash: authorization.boundsHash,
            bounds: authorization.bounds,
            ...(authorization.context ? { context: authorization.context } : {}),
            ...(authorization.contextHash ? { contextHash: authorization.contextHash } : {}),
            intent: authorization.intent,
            attestations,
          }
        : undefined,
    });

    return receipt;
  }

  return { dir, kp, archive, addTicket };
}
