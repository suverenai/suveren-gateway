/**
 * GET /api/evidence/* — local evidence for the Receipts page.
 *
 * The audit page shows receipts fetched from the Authority Server, but the AS
 * holds only hashes of the things a person actually wants to read: the grant's
 * context and the intent behind it. Those live HERE, on the machine, and this
 * router is how the UI joins the two without either side leaving its trust
 * domain (local values never travel to the AS; the AS copy stays authoritative
 * for the receipt itself).
 *
 * Two shapes, deliberately split by cost:
 *  - `/authorizations` — small per-grant map, fetched once per page load.
 *  - `/receipt/:id`    — one verbatim archive entry, fetched only when the
 *                        reader opens the complete receipt.
 */

import { Router, type Request, type Response } from 'express';
import { getLocalEvidence } from '../lib/mcp-bridge';
import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { verifyTicketSignature, encodeDidKey, canonicalize } from '@hap/core';

/**
 * hap-core 0.12's verifyTicketSignature resolves the verification key from
 * the ticket's own `issuer` did:key, restricted via `trustedIssuers` — it no
 * longer takes a raw key (protocol.md -> *Ticket Verification* step 1). The
 * archive stores the AS's raw hex key at archive time (`asPublicKey`); this
 * derives the equivalent did:key to pass as the sole trusted issuer, so a
 * ticket claiming a DIFFERENT issuer still fails, exactly as a raw-key
 * comparison would have.
 */
function issuerFromPublicKeyHex(publicKeyHex: string): string {
  return encodeDidKey(Buffer.from(publicKeyHex, 'hex'));
}

/**
 * Signature status for one archived receipt.
 *
 *  - `valid`        — Ed25519 checked here, against the issuer key archived at
 *                     issuance. No Authority Server involved: this is the
 *                     holder-side verification the protocol is built around.
 *  - `invalid`      — the signature did NOT check out. Loud, never silent: it
 *                     means the stored receipt does not match what was signed.
 *  - `unverifiable` — no issuer key was archived with it, so there is nothing
 *                     to check against. Distinct from `invalid`; conflating the
 *                     two would either cry tamper or imply a check that never ran.
 */
export type SignatureStatus = 'valid' | 'valid-legacy' | 'invalid' | 'unverifiable';

/** Ed25519 SPKI DER prefix for a raw 32-byte public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * A ticket issued before the v0.7 wire switch (gateway <= 0.19, until
 * 2026-10-09): no `issuer` field, and the signature is standard base64 over
 * the JCS of every other field. hap-core 0.12 verifies only the v0.7 shape,
 * so without this every pre-switch ticket in a person's archive read as
 * "Signature check FAILED" although its signature is genuine.
 *
 * Only the absence of `issuer` selects this path; it is still a real Ed25519
 * check against the key archived at issuance, so a forged or altered ticket
 * fails here exactly as it would under the v0.7 rule.
 */
export function isPreV07Ticket(receipt: Record<string, unknown>): boolean {
  return receipt.issuer === undefined || receipt.issuer === null;
}

export function verifyPreV07TicketSignature(receipt: Record<string, unknown>, asPublicKeyHex: string): boolean {
  const { signature, ...signed } = receipt;
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(asPublicKeyHex)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(asPublicKeyHex, 'hex')]), format: 'der', type: 'spki',
    });
    const sig = Buffer.from(signature, 'base64');
    if (sig.length !== 64) return false;
    return verifyEd25519(null, Buffer.from(canonicalize(signed), 'utf8'), key, sig);
  } catch {
    return false;
  }
}

interface ArchiveEntryShape {
  receipt?: { id?: unknown };
  asPublicKey?: string;
}

/** Verify every archived receipt locally, keyed by receipt id. */
async function verifyAll(
  receipts: Array<Record<string, unknown>>,
): Promise<Record<string, SignatureStatus>> {
  const out: Record<string, SignatureStatus> = {};
  for (const raw of receipts) {
    const e = raw as ArchiveEntryShape;
    const id = typeof e.receipt?.id === 'string' ? e.receipt.id : undefined;
    if (!id) continue;
    if (!e.asPublicKey) {
      out[id] = 'unverifiable';
      continue;
    }
    const receipt = e.receipt as Record<string, unknown>;
    if (isPreV07Ticket(receipt)) {
      out[id] = verifyPreV07TicketSignature(receipt, e.asPublicKey) ? 'valid-legacy' : 'invalid';
      continue;
    }
    try {
      // Throws on failure; returns void on success.
      await verifyTicketSignature(e.receipt as never, { trustedIssuers: [issuerFromPublicKeyHex(e.asPublicKey)] });
      out[id] = 'valid';
    } catch {
      out[id] = 'invalid';
    }
  }
  return out;
}

/** Per-grant local values a receipt card can display. */
interface LocalAuthorization {
  authorizationId: string;
  profileId?: string;
  boundsHash?: string;
  contextHash?: string;
  bounds?: Record<string, string | number>;
  context?: Record<string, string | number>;
  intent?: string;
  /** True when this came from the receipt archive (evidence), not just the live gate store. */
  archived: boolean;
}

interface ArchiveShape {
  receipts?: Array<Record<string, unknown>>;
  authorizations?: Array<Record<string, unknown>>;
  gates?: Array<Record<string, unknown>>;
}

/**
 * Merge the two local stores into one per-grant view. The receipt archive wins
 * (it is the durable evidence copy and carries bounds); the gate store fills
 * gaps for grants that exist on this device but have not executed yet.
 */
function mergeAuthorizations(evidence: ArchiveShape): Record<string, LocalAuthorization> {
  const out: Record<string, LocalAuthorization> = {};

  for (const raw of evidence.authorizations ?? []) {
    const a = raw as Record<string, unknown>;
    const id = a.authorizationId as string;
    if (!id) continue;
    out[id] = {
      authorizationId: id,
      profileId: a.profileId as string | undefined,
      boundsHash: a.boundsHash as string | undefined,
      contextHash: a.contextHash as string | undefined,
      bounds: a.bounds as Record<string, string | number> | undefined,
      context: a.context as Record<string, string | number> | undefined,
      intent: a.intent as string | undefined,
      archived: true,
    };
  }

  for (const raw of evidence.gates ?? []) {
    const g = raw as Record<string, unknown>;
    const id = g.authorizationId as string;
    if (!id) continue;
    const gateContent = (g.gateContent ?? {}) as { intent?: string };
    const existing = out[id];
    if (!existing) {
      out[id] = {
        authorizationId: id,
        profileId: g.profileId as string | undefined,
        boundsHash: g.boundsHash as string | undefined,
        contextHash: g.contextHash as string | undefined,
        context: g.context as Record<string, string | number> | undefined,
        intent: gateContent.intent,
        archived: false,
      };
      continue;
    }
    // Fill only what the archive entry lacks — never overwrite evidence.
    existing.intent ??= gateContent.intent;
    existing.context ??= g.context as Record<string, string | number> | undefined;
    existing.contextHash ??= g.contextHash as string | undefined;
  }

  return out;
}

export function createEvidenceRouter(): Router {
  const router = Router();

  router.get('/authorizations', async (_req: Request, res: Response) => {
    try {
      const evidence = (await getLocalEvidence()) as ArchiveShape;
      res.json({
        authorizations: mergeAuthorizations(evidence),
        // Verified here, on this machine, so the card's badge reports a check
        // that actually ran rather than the issuer vouching for itself.
        signatures: await verifyAll(evidence.receipts ?? []),
      });
    } catch (err) {
      // The MCP server holds these stores; if it is down or the vault is
      // locked, say so rather than returning {} — an empty map would render
      // as "this grant has no intent", which is a different claim.
      res.status(503).json({
        error: 'Local evidence unavailable',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/receipt/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const evidence = (await getLocalEvidence()) as ArchiveShape;
      const entry = (evidence.receipts ?? []).find(
        r => ((r as { receipt?: { id?: unknown } }).receipt?.id) === id,
      );
      if (!entry) {
        // Not an error: receipts predating the local archive, or executed on
        // another device, legitimately have no local copy.
        res.status(404).json({ error: 'No local copy of this receipt' });
        return;
      }
      const authorizationId = (entry as { authorizationId?: string }).authorizationId;
      const authorization = authorizationId
        ? mergeAuthorizations(evidence)[authorizationId] ?? null
        : null;
      const signature = (await verifyAll([entry]))[id] ?? 'unverifiable';
      res.json({ entry, authorization, signature });
    } catch (err) {
      res.status(503).json({
        error: 'Local evidence unavailable',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
