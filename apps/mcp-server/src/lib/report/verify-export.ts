/**
 * Offline verifier for an "Export with proof" file (work-plan R6) — the logic
 * behind `suveren-gateway verify-report <file>`. Framework-agnostic and
 * network-free BY ITSELF (the one network call, `--online`, is made by the
 * CLI caller and handed in as `onlineKeyHex` — see `report-verify-cli.ts`)
 * so this module works identically bundled into the npm CLI, the Windows
 * installer payload, and a plain vitest run.
 *
 * TRUST ANCHOR — read before relying on this module's output anywhere:
 * `bundle.authorityServer.publicKeyHex` is a key EMBEDDED IN THE FILE BEING
 * CHECKED. A forger can embed their own key and self-sign every ticket and
 * attestation to match it — every check in `verifyExportBundle()` would then
 * report "valid" even though nothing was ever vouched for by the real
 * Authority Server. Internal validity (signatures/references all consistent
 * with the embedded key) is necessary but NOT sufficient; the embedded key
 * itself must be independently confirmed — against a value the caller
 * already trusts (`--key`) or a live fetch of the real Authority Server
 * (`--online`) — before the file means anything. `keyConfirmation` on the
 * result is deliberately a SEPARATE field from `allValid` for exactly this
 * reason; `report-verify-cli.ts` turns the combination into the three exit
 * codes documented there.
 */
import { verifyReceiptSignature, verifyAttestationSignature, decodeAttestationBlob } from '@hap/core';
import { parseElements } from './parse-elements';
import { parseCaseAttrs } from './case-resolvers';
import { fingerprintOf } from '../as-pairing';
import type { ArchivedAuthorization } from '../receipt-archive';
import type { ExportBundle } from './export-types';

/** Every ticket id the AI's original report html names, via an `sv-ticket`,
 *  `sv-approval`, `sv-mandate`, or `sv-case` (goal + steps) element — derived
 *  independently from the bundle's OWN html, never from its `proof` summary
 *  (which could itself have been tampered with alongside everything else). */
export function collectReferencedTicketIds(html: string): Set<string> {
  const ids = new Set<string>();
  for (const el of parseElements(html)) {
    if (el.kind === 'sv-ticket' && el.attrs.ref) ids.add(el.attrs.ref);
    if ((el.kind === 'sv-approval' || el.kind === 'sv-mandate') && el.attrs.ticket) ids.add(el.attrs.ticket);
    if (el.kind === 'sv-case') {
      const { goalId, stepIds } = parseCaseAttrs(el.attrs);
      if (goalId) ids.add(goalId);
      for (const s of stepIds) ids.add(s);
    }
  }
  return ids;
}

export interface TicketVerification {
  ticketId: string;
  /** Named by an sv-ticket/sv-approval/sv-mandate/sv-case element in the report. */
  referenced: boolean;
  /** Exists among `bundle.tickets`. */
  present: boolean;
  signatureValid: boolean;
  error?: string;
}

export interface AuthorizationVerification {
  authorizationId: string;
  /** Every attestation blob archived for this mandate verified against the
   *  bundle's Authority Server key. False (never silently skipped) when the
   *  mandate has no archived attestation at all. */
  attestationValid: boolean;
  /** 'n/a' when neither side carries a boundsHash to compare — the same
   *  graceful degradation `ticket-resolvers.ts#resolveMandateElement` uses. */
  boundsHashMatches: boolean | 'n/a';
  error?: string;
}

export type KeyConfirmation =
  | { state: 'unconfirmed' }
  | { state: 'confirmed'; source: 'provided' | 'online' }
  | { state: 'mismatch'; source: 'provided' | 'online'; expectedFingerprint: string };

export interface VerifyExportOptions {
  /** `--key <hex>` — a value the caller already trusts (e.g. read aloud over
   *  the phone from the Authority Server operator, or pinned previously). */
  expectedKeyHex?: string;
  /** `--online` — the CLI's own live fetch of `<asUrl>/api/as/pubkey`, handed
   *  in so this module stays network-free. */
  onlineKeyHex?: string;
}

export interface VerifyExportResult {
  tickets: TicketVerification[];
  authorizations: AuthorizationVerification[];
  keyFingerprint: string;
  keyConfirmation: KeyConfirmation;
  /** Every ticket signature AND every authorization check passed —
   *  independent of whether the key itself was confirmed. */
  allValid: boolean;
}

function ticketId(receipt: Record<string, unknown>): string {
  return typeof receipt.id === 'string' ? receipt.id : '';
}

async function checkAttestations(
  auth: ArchivedAuthorization,
  publicKeyHex: string,
): Promise<{ valid: boolean; error?: string }> {
  if (auth.attestations.length === 0) {
    return { valid: false, error: 'No archived mandate attestation for this authorization.' };
  }
  for (const att of auth.attestations) {
    try {
      const attestation = decodeAttestationBlob(att.blob);
      await verifyAttestationSignature(attestation, publicKeyHex);
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { valid: true };
}

export async function verifyExportBundle(bundle: ExportBundle, opts: VerifyExportOptions = {}): Promise<VerifyExportResult> {
  const byId = new Map(bundle.tickets.map(t => [ticketId(t as Record<string, unknown>), t as Record<string, unknown>]));
  const referencedIds = collectReferencedTicketIds(bundle.report.html);
  const allIds = new Set<string>([...referencedIds, ...byId.keys()]);

  const tickets: TicketVerification[] = [];
  for (const id of allIds) {
    const receipt = byId.get(id);
    if (!receipt) {
      tickets.push({ ticketId: id, referenced: referencedIds.has(id), present: false, signatureValid: false, error: 'Not present in the bundle.' });
      continue;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await verifyReceiptSignature(receipt as any, bundle.authorityServer.publicKeyHex);
      tickets.push({ ticketId: id, referenced: referencedIds.has(id), present: true, signatureValid: true });
    } catch (err) {
      tickets.push({
        ticketId: id, referenced: referencedIds.has(id), present: true, signatureValid: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const authorizations: AuthorizationVerification[] = [];
  for (const [authorizationId, auth] of Object.entries(bundle.authorizations)) {
    const { valid: attestationValid, error: attestationError } = await checkAttestations(auth, bundle.authorityServer.publicKeyHex);

    let boundsHashMatches: boolean | 'n/a' = 'n/a';
    const representative = [...byId.values()].find(r => r.authorizationId === authorizationId);
    if (auth.boundsHash && representative && typeof representative.boundsHash === 'string') {
      boundsHashMatches = auth.boundsHash === representative.boundsHash;
    }

    authorizations.push({
      authorizationId,
      attestationValid,
      boundsHashMatches,
      ...(attestationError ? { error: attestationError } : boundsHashMatches === false ? { error: `boundsHash does not match ticket ${representative?.id ?? 'unknown'}.` } : {}),
    });
  }

  const keyFingerprint = fingerprintOf(bundle.authorityServer.publicKeyHex);
  const keyConfirmation = resolveKeyConfirmation(bundle.authorityServer.publicKeyHex, opts);

  const allValid =
    tickets.every(t => t.signatureValid) &&
    authorizations.every(a => a.attestationValid && a.boundsHashMatches !== false);

  return { tickets, authorizations, keyFingerprint, keyConfirmation, allValid };
}

function resolveKeyConfirmation(actualKeyHex: string, opts: VerifyExportOptions): KeyConfirmation {
  const normalize = (h: string) => h.trim().toLowerCase();
  if (opts.expectedKeyHex !== undefined) {
    if (normalize(opts.expectedKeyHex) === normalize(actualKeyHex)) return { state: 'confirmed', source: 'provided' };
    return { state: 'mismatch', source: 'provided', expectedFingerprint: fingerprintOf(opts.expectedKeyHex) };
  }
  if (opts.onlineKeyHex !== undefined) {
    if (normalize(opts.onlineKeyHex) === normalize(actualKeyHex)) return { state: 'confirmed', source: 'online' };
    return { state: 'mismatch', source: 'online', expectedFingerprint: fingerprintOf(opts.onlineKeyHex) };
  }
  return { state: 'unconfirmed' };
}
