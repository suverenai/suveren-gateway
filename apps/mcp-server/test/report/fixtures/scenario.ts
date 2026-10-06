/**
 * A REAL, verifiably-signed scenario for report-verifier tests: a real
 * `ReceiptArchive` (temp dir, plaintext — no vault key involved), real
 * Ed25519-signed tickets (reuses `test/helpers/real-receipt.ts`) and real
 * Ed25519-signed attestation blobs, built the same way hap-core's own
 * `verifyAttestationSignature`/`verifyReceiptSignature` check them — nothing
 * about the cryptography here is mocked, only the Authority Server's HTTP
 * round-trip is replaced by writing the archive directly.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign as cryptoSign } from 'node:crypto';
import { canonicalize, encodeAttestationBlob, type Attestation, type AttestationPayload } from '@hap/core';
import { ReceiptArchive } from '../../../src/lib/receipt-archive';
import { testReceiptKeypair, makeSignedReceipt, type TestReceiptKeypair } from '../../helpers/real-receipt';

export const AS_URL = 'https://as.example';

/** Signs an attestation PAYLOAD the same way the real Authority Server does
 *  (`suveren-as/src/lib/keys.ts`: JCS-canonical bytes, Ed25519, plain base64 —
 *  NOT base64url, unlike receipts; see hap-core's `verifyAttestationSignature`). */
export function signAttestationPayload(payload: AttestationPayload, kp: TestReceiptKeypair): Attestation {
  const bytes = Buffer.from(canonicalize(payload), 'utf-8');
  const signature = cryptoSign(null, bytes, kp.privateKey).toString('base64');
  return { header: { typ: 'HAP-attestation', alg: 'EdDSA' }, payload, signature };
}

export interface ScenarioAuthorization {
  authorizationId: string;
  profileId: string;
  bounds?: Record<string, string | number>;
  boundsHash?: string;
  intent?: string;
  commitmentMode?: 'automatic' | 'review' | 'review_above_cap';
  owners?: string[]; // resolved_owners DIDs
  /** Signed identity overlay (v0.6 subjects) — a name only at assurance "high". */
  subjects?: AttestationPayload['subjects'];
  /** Signed domain -> owner DID map (in team mode the domain is the approver's account id). */
  resolvedDomains?: Array<{ domain: string; did: string }>;
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
    const receipt = makeSignedReceipt(signingKp, {
      id: opts.id,
      action: opts.action,
      authorizationId: opts.authorizationId,
      profileId: opts.authorization?.profileId ?? 'test-profile',
      boundsHash: opts.authorization?.boundsHash,
      timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
      ...opts.extra,
    });

    let authorization: ScenarioAuthorization | undefined = opts.authorization;
    let attestations: Array<{ domain: string; blob: string; expiresAt: number }> = [];
    if (authorization) {
      const payload: AttestationPayload = {
        attestation_id: `att-${authorization.authorizationId}`,
        version: '0.6',
        profile_id: authorization.profileId,
        bounds_hash: authorization.boundsHash,
        execution_context_hash: 'sha256:test',
        gate_content_hashes: {},
        resolved_owners: authorization.owners ?? ['did:key:zOwner1'],
        commitment_mode: authorization.commitmentMode ?? 'automatic',
        ...(authorization.subjects ? { subjects: authorization.subjects } : {}),
        ...(authorization.resolvedDomains ? { resolved_domains: authorization.resolvedDomains } : {}),
        issued_at: Math.floor(Date.now() / 1000) - 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600 * 24,
      };
      const attestation = signAttestationPayload(payload, kp);
      attestations = [{ domain: 'default', blob: encodeAttestationBlob(attestation), expiresAt: payload.expires_at }];
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
            intent: authorization.intent,
            attestations,
          }
        : undefined,
    });

    return receipt;
  }

  return { dir, kp, archive, addTicket };
}
