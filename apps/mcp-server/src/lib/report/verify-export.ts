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
import { Parser } from 'htmlparser2';
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

/** The ticket ids ONE parsed element names — same rules as
 *  `collectReferencedTicketIds`, per element. */
function ticketIdsOf(el: { kind: string; attrs: Record<string, string> }): string[] {
  if (el.kind === 'sv-ticket') return el.attrs.ref ? [el.attrs.ref] : [];
  if (el.kind === 'sv-approval' || el.kind === 'sv-mandate') return el.attrs.ticket ? [el.attrs.ticket] : [];
  if (el.kind === 'sv-case') {
    const { goalId, stepIds } = parseCaseAttrs(el.attrs);
    return [...(goalId ? [goalId] : []), ...stepIds];
  }
  return [];
}

const TICKET_BACKED_KINDS = new Set(['sv-ticket', 'sv-approval', 'sv-mandate', 'sv-case']);

/** How the gateway-drawn element markup in an exported file PRESENTS one
 *  element. Markers come from `render-report.ts`: every drawn element is a
 *  `<div class="sv-el sv-el-<status>" data-sv-id="<id>">` whose status is
 *  `verified` | `warning` | `unverifiable`, and carries a `sv-badge-ok` /
 *  `sv-badge-warn` / `sv-badge-bad` badge.
 *
 *  'not-verifiable' ONLY when every drawn node for that id has the
 *  `sv-el-unverifiable` class, no `sv-el-verified`/`sv-el-warning` class, at
 *  least one badge, and every badge is `sv-badge-bad`. Anything else —
 *  including no drawn node at all, or a class/badge that disagrees — is
 *  'verified' (the strict side): a forger may downgrade a claim, never
 *  upgrade one. */
export type PresentedState = 'verified' | 'not-verifiable';

const PROOF_SCRIPT_BLOCK_RE = /<script[^>]*id="suveren-proof"[^>]*>[\s\S]*?<\/script>/gi;

export function collectPresentedStates(documentHtml: string): Map<string, PresentedState> {
  // The embedded proof JSON carries the AI's raw html (sv-* tags, never drawn
  // divs) — drop it so nothing inside it can ever be read as drawn markup.
  const html = documentHtml.replace(PROOF_SCRIPT_BLOCK_RE, '');
  interface Frame { id: string; depth: number; classes: Set<string>; badges: Set<string>[] }
  const open: Frame[] = [];
  const flaggedById = new Map<string, boolean>();
  let depth = 0;

  const classesOf = (attribs: Record<string, string>) => new Set((attribs.class ?? '').split(/\s+/).filter(Boolean));
  const settle = (f: Frame) => {
    const flagged =
      f.classes.has('sv-el-unverifiable') &&
      !f.classes.has('sv-el-verified') && !f.classes.has('sv-el-warning') &&
      f.badges.length > 0 &&
      f.badges.every(b => b.has('sv-badge-bad') && !b.has('sv-badge-ok') && !b.has('sv-badge-warn'));
    // Several drawn nodes with one id: flagged only if ALL are flagged.
    flaggedById.set(f.id, (flaggedById.get(f.id) ?? true) && flagged);
  };

  const parser = new Parser(
    {
      onopentag(_name, attribs) {
        depth++;
        const classes = classesOf(attribs);
        if ([...classes].some(c => c.startsWith('sv-badge'))) {
          for (const f of open) f.badges.push(classes);
        }
        const id = attribs['data-sv-id'];
        if (typeof id === 'string' && id) open.push({ id, depth, classes, badges: [] });
      },
      onclosetag() {
        while (open.length > 0 && open[open.length - 1].depth >= depth) settle(open.pop()!);
        depth--;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  while (open.length > 0) settle(open.pop()!);

  const states = new Map<string, PresentedState>();
  for (const [id, flagged] of flaggedById) states.set(id, flagged ? 'not-verifiable' : 'verified');
  return states;
}

export interface ElementVerification {
  /** `${kind}-${n}` — same id scheme as parse-elements.ts / render-report.ts. */
  elementId: string;
  kind: string;
  ticketIds: string[];
  /** How the gateway-drawn markup in the file shows this element (strict:
   *  'verified' unless clearly drawn as not verifiable). */
  presented: PresentedState;
  /** Every named ticket is in the bundle with a valid signature (and, for
   *  sv-mandate, its mandate is bundled and consistent with the ticket).
   *  Mandate data is required ONLY here: since RR5 the bundle carries a
   *  mandate only when the report places it with an sv-mandate, and every
   *  other ticket travels bare — its own signature is its proof. */
  backed: boolean;
  error?: string;
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
  /** The WHOLE exported file, whose gateway-drawn element markup says which
   *  elements the file presents as verified (`collectPresentedStates`).
   *  Omitted → every element counts as presented-as-verified (strict). */
  documentHtml?: string;
}

export interface VerifyExportResult {
  tickets: TicketVerification[];
  /** Every ticket/approval/mandate/case element in the report. */
  elements: ElementVerification[];
  authorizations: AuthorizationVerification[];
  keyFingerprint: string;
  keyConfirmation: KeyConfirmation;
  /** (a) every BUNDLED ticket signature and every authorization check
   *  passed, AND (b) every element presented as verified is backed. A
   *  reference with no backing is fine only when the drawn element shows it
   *  as not verifiable. Independent of whether the key itself was confirmed. */
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

  const ticketById = new Map(tickets.map(t => [t.ticketId, t]));
  const authById = new Map(authorizations.map(a => [a.authorizationId, a]));
  const presentedStates = opts.documentHtml !== undefined ? collectPresentedStates(opts.documentHtml) : new Map<string, PresentedState>();

  const elements: ElementVerification[] = [];
  for (const el of parseElements(bundle.report.html)) {
    if (!TICKET_BACKED_KINDS.has(el.kind)) continue;
    const ticketIds = ticketIdsOf(el);
    const presented: PresentedState = presentedStates.get(el.id) ?? 'verified';
    let error: string | undefined;
    if (ticketIds.length === 0) error = 'Names no ticket.';
    for (const id of ticketIds) {
      if (error) break;
      const t = ticketById.get(id);
      if (!t || !t.present) error = `Ticket ${id} is not in the bundle.`;
      else if (!t.signatureValid) error = `Ticket ${id} has an invalid signature.`;
    }
    if (!error && el.kind === 'sv-mandate') {
      const receipt = byId.get(ticketIds[0])!;
      const authorizationId = typeof receipt.authorizationId === 'string' ? receipt.authorizationId : undefined;
      const auth = authorizationId ? bundle.authorizations[authorizationId] : undefined;
      const authCheck = authorizationId ? authById.get(authorizationId) : undefined;
      if (!auth || !authCheck) error = `The mandate for ticket ${ticketIds[0]} is not in the bundle.`;
      else if (!authCheck.attestationValid) error = `The mandate for ticket ${ticketIds[0]} has an invalid attestation.`;
      else if (auth.boundsHash && typeof receipt.boundsHash === 'string' && auth.boundsHash !== receipt.boundsHash) {
        error = `The mandate's boundsHash does not match ticket ${ticketIds[0]}.`;
      }
    }
    elements.push({ elementId: el.id, kind: el.kind, ticketIds, presented, backed: !error, ...(error ? { error } : {}) });
  }

  const keyFingerprint = fingerprintOf(bundle.authorityServer.publicKeyHex);
  const keyConfirmation = resolveKeyConfirmation(bundle.authorityServer.publicKeyHex, opts);

  const allValid =
    tickets.filter(t => t.present).every(t => t.signatureValid) &&
    authorizations.every(a => a.attestationValid && a.boundsHashMatches !== false) &&
    elements.every(e => e.presented === 'not-verifiable' || e.backed);

  return { tickets, elements, authorizations, keyFingerprint, keyConfirmation, allValid };
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
