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
 *
 * WHAT THE PAGE SHOWS (RR7): signatures alone do not cover the visible page —
 * a forger could edit a number in a green box and leave the bundle intact.
 * `verify-drawn.ts` closes that: the page must re-draw from the bundle byte
 * for byte, and every drawn field is checked against its signed source
 * (bounds through `recomputeBoundsHash`), recomputed, or listed as not
 * checkable offline (archive/database values).
 */
import { Parser } from 'htmlparser2';
import { verifyTicketSignature, verifyMandateSignature, decodeMandateBlob, computeBoundsHash, type AgentProfile } from '@hap/core';
import { issuerFromPublicKeyHex } from '../issuer-from-hex';
import { checkDocumentReproduces, checkDrawnElements, type BoxCheck, type DocumentCheck } from './verify-drawn';
import { parseElements } from './parse-elements';
import { sanitizeReportHtml } from './sanitize';
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
  for (const el of reportElements(html)) {
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

/** The report's elements exactly as the gateway drew them: the raw html
 *  through the same two-tag sanitizer (sanitize.ts), so the ids match the
 *  drawn markup — content the gateway dropped (an sv-* inside sv-ai, a block
 *  outside the format) was never presented and is not checked. Glossary
 *  entries are not elements; the checker ignores them. */
function reportElements(html: string) {
  return parseElements(sanitizeReportHtml(html));
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
 *  `sv-badge-warn` / `sv-badge-bad` badge. A verified seal also names its
 *  source (`data-sv-source="signed|archive|database|computed"`, "✓ verified ·
 *  signed") — any badge carrying a source is a verified claim.
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
  interface Badge { classes: Set<string>; hasSource: boolean }
  interface Frame { id: string; depth: number; classes: Set<string>; badges: Badge[] }
  const open: Frame[] = [];
  const flaggedById = new Map<string, boolean>();
  let depth = 0;

  const classesOf = (attribs: Record<string, string>) => new Set((attribs.class ?? '').split(/\s+/).filter(Boolean));
  const settle = (f: Frame) => {
    const flagged =
      f.classes.has('sv-el-unverifiable') &&
      !f.classes.has('sv-el-verified') && !f.classes.has('sv-el-warning') &&
      f.badges.length > 0 &&
      f.badges.every(b =>
        b.classes.has('sv-badge-bad') && !b.classes.has('sv-badge-ok') && !b.classes.has('sv-badge-warn') &&
        !b.classes.has('sv-seal') && !b.hasSource);
    // Several drawn nodes with one id: flagged only if ALL are flagged.
    flaggedById.set(f.id, (flaggedById.get(f.id) ?? true) && flagged);
  };

  const parser = new Parser(
    {
      onopentag(_name, attribs) {
        depth++;
        const classes = classesOf(attribs);
        const hasSource = typeof attribs['data-sv-source'] === 'string';
        if (hasSource || [...classes].some(c => c.startsWith('sv-badge') || c === 'sv-seal')) {
          for (const f of open) f.badges.push({ classes, hasSource });
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
  /** Every bounds hash present — the mandate's, each attestation's signed
   *  `bounds_hash`, each of its tickets' signed `boundsHash`, and the one
   *  recomputed from the bundled bounds VALUES — agrees. 'n/a' when there is
   *  nothing to compare. */
  boundsHashMatches: boolean | 'n/a';
  /** The bundled bounds VALUES hash to a SIGNED bounds_hash (attestation or
   *  ticket) — so the limits a box draws are the signed ones. 'n/a' when the
   *  mandate carries no values. */
  boundsValuesProven: boolean | 'n/a';
  error?: string;
}

/**
 * The bounds hash of these VALUES, in the object's own key order — the same
 * canonical form hap-core's `computeBoundsHash` builds from a profile's
 * `boundsSchema.keyOrder` (`key=percent-encoded value` lines). The export
 * writes the values in the profile's key order (export-report.ts), so the
 * checker needs no profile; a reordered, added or dropped key yields a
 * different hash.
 */
export function recomputeBoundsHash(bounds: Record<string, string | number>): string {
  const keyOrder = Object.keys(bounds);
  const profile = {
    id: 'export-check',
    boundsSchema: {
      keyOrder,
      fields: Object.fromEntries(keyOrder.map(k => [k, { type: typeof bounds[k] === 'number' ? 'number' : 'string' }])),
    },
  } as unknown as AgentProfile;
  return computeBoundsHash(bounds, profile);
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
  /** The visible page is exactly what the bundle draws (verify-drawn.ts). */
  document: DocumentCheck;
  /** Every drawn box: which fields are checked against a signature, which
   *  are recomputed, which cannot be checked offline, and any mismatch. */
  boxes: BoxCheck[];
  /** Bundle-level inconsistencies (elements vs report, Proof panel). */
  drawnErrors: string[];
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
      const mandate = decodeMandateBlob(att.blob);
      await verifyMandateSignature(mandate, { trustedIssuers: [issuerFromPublicKeyHex(publicKeyHex)] });
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
      await verifyTicketSignature(receipt as any, {
        trustedIssuers: [issuerFromPublicKeyHex(bundle.authorityServer.publicKeyHex)],
      });
      tickets.push({ ticketId: id, referenced: referencedIds.has(id), present: true, signatureValid: true });
    } catch (err) {
      tickets.push({
        ticketId: id, referenced: referencedIds.has(id), present: true, signatureValid: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const authorizations: AuthorizationVerification[] = [];
  const boundsProven = new Set<string>();
  for (const [authorizationId, auth] of Object.entries(bundle.authorizations)) {
    const { valid: attestationValid, error: attestationError } = await checkAttestations(auth, bundle.authorityServer.publicKeyHex);

    // Every hash that commits to this mandate's bounds, signed or not.
    const hashes: Array<{ from: string; value: string; signed: boolean }> = [];
    if (auth.boundsHash) hashes.push({ from: 'the mandate record', value: auth.boundsHash, signed: false });
    for (const att of auth.attestations) {
      try {
        const bh = decodeMandateBlob(att.blob).payload.bounds_hash;
        if (bh) hashes.push({ from: 'the signed attestation', value: bh, signed: attestationValid });
      } catch {
        // undecodable — already an attestation error
      }
    }
    for (const r of byId.values()) {
      if (r.authorizationId === authorizationId && typeof r.boundsHash === 'string') {
        const t = tickets.find(x => x.ticketId === ticketId(r));
        hashes.push({ from: `signed ticket ${String(r.id ?? '')}`, value: r.boundsHash, signed: !!t?.signatureValid });
      }
    }
    let recomputed: string | undefined;
    let recomputeError: string | undefined;
    if (auth.bounds && Object.keys(auth.bounds).length > 0) {
      try {
        recomputed = recomputeBoundsHash(auth.bounds);
      } catch (err) {
        recomputeError = `The bounds values cannot be hashed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const all = [...hashes.map(h => h.value), ...(recomputed ? [recomputed] : [])];
    const boundsHashMatches: boolean | 'n/a' = all.length < 2 ? 'n/a' : all.every(v => v === all[0]);
    let boundsValuesProven: boolean | 'n/a' = 'n/a';
    if (auth.bounds && Object.keys(auth.bounds).length > 0) {
      boundsValuesProven = !!recomputed && boundsHashMatches !== false && hashes.some(h => h.signed && h.value === recomputed);
      if (boundsValuesProven === true) boundsProven.add(authorizationId);
    }
    const mismatch = hashes.find(h => h.value !== (recomputed ?? all[0]));
    const boundsError = recomputeError
      ?? (boundsHashMatches === false
        ? `Bounds hash mismatch: ${recomputed ? 'the hash of the bounds values in the file' : 'the mandate record'} does not match ${mismatch?.from ?? 'another hash'}.`
        : boundsValuesProven === false
          ? 'The bounds values in the file are not committed by any signed bounds_hash.'
          : undefined);

    authorizations.push({
      authorizationId,
      attestationValid,
      boundsHashMatches,
      boundsValuesProven,
      ...(attestationError ? { error: attestationError } : boundsError ? { error: boundsError } : {}),
    });
  }

  const ticketById = new Map(tickets.map(t => [t.ticketId, t]));
  const authById = new Map(authorizations.map(a => [a.authorizationId, a]));
  const presentedStates = opts.documentHtml !== undefined ? collectPresentedStates(opts.documentHtml) : new Map<string, PresentedState>();

  const elements: ElementVerification[] = [];
  for (const el of reportElements(bundle.report.html)) {
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
      } else if (authCheck.boundsHashMatches === false || authCheck.boundsValuesProven === false) {
        error = `The mandate for ticket ${ticketIds[0]}: ${authCheck.error ?? 'bounds not proven'}`;
      }
    }
    elements.push({ elementId: el.id, kind: el.kind, ticketIds, presented, backed: !error, ...(error ? { error } : {}) });
  }

  const keyFingerprint = fingerprintOf(bundle.authorityServer.publicKeyHex);
  const keyConfirmation = resolveKeyConfirmation(bundle.authorityServer.publicKeyHex, opts);

  // RR7: the visible page is exactly what the bundle draws, and every drawn
  // value is checked against its source (verify-drawn.ts).
  const document = checkDocumentReproduces(bundle, opts.documentHtml);
  const validTickets = new Map<string, Record<string, unknown>>();
  for (const t of tickets) if (t.signatureValid) validTickets.set(t.ticketId, byId.get(t.ticketId)!);
  const drawn = await checkDrawnElements(
    { bundle, validTickets, boundsProven },
    reportElements(bundle.report.html).map(e => ({ id: e.id, kind: e.kind, attrs: e.attrs })),
  );

  const allValid =
    tickets.filter(t => t.present).every(t => t.signatureValid) &&
    authorizations.every(a => a.attestationValid && a.boundsHashMatches !== false && a.boundsValuesProven !== false) &&
    elements.every(e => e.presented === 'not-verifiable' || e.backed) &&
    document.state !== 'mismatch' &&
    drawn.errors.length === 0 &&
    drawn.boxes.every(b => b.mismatches.length === 0);

  return { document, boxes: drawn.boxes, drawnErrors: drawn.errors, tickets, elements, authorizations, keyFingerprint, keyConfirmation, allValid };
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
