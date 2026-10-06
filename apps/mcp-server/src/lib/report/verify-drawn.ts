/**
 * The offline checker's second half (RR7): is every value the export file
 * SHOWS backed by the bundle — and how far back does that backing reach?
 *
 * Two steps, so neither has to parse styled HTML for meaning:
 *
 *  1. `checkDocumentReproduces` — the visible page must be EXACTLY what the
 *     bundle draws: the checker re-draws the whole file from the bundle
 *     (export-report.ts#buildExportDocument, in the bundle's own time zone,
 *     format.ts#withDrawingZone)
 *     and compares byte for byte. Any edit to the visible page — a digit in a
 *     box, a timestamp, an injected style that changes how a value reads, a
 *     fake green box — makes the two differ.
 *  2. `checkDrawnElements` — each drawn field in `bundle.elements` is checked
 *     against its source:
 *       - signed   — equal to the signed ticket, or to the signed mandate
 *                    attestation (bounds via the recomputed bounds_hash,
 *                    commitment mode, owners, profile, intent via its hash);
 *       - recomputed — a derived number recomputed from bundled inputs
 *                    (wait_s, a case's duration_s, a metric);
 *       - archive / database — values the bundle cannot back (an approval's
 *                    times and approver from the local archive, a record or a
 *                    case start from a connector's database). Listed per box
 *                    as "not checkable offline" — never passed as signed.
 *     Any difference between a drawn value and its signed source, or a
 *     recomputed number that does not come out the same, is a mismatch.
 */
import { computeIntentHash, decodeAttestationBlob, verifyAttestationSignature, type AttestationPayload } from '@hap/core';
import { checkedValueLine } from './render-report';
import { buildExportDocument } from './export-report';
import { computeMetric } from './metric-resolvers';
import { parseCaseAttrs } from './case-resolvers';
import { parseTimestampSeconds } from './time';
import { scrubForbidden } from './agent-view';
import { UNDISCLOSED_OWNER_LABEL, formatOwnerLabel, withDrawingZone } from './format';
import type { ExportBundle } from './export-types';
import type { VerifiedElement } from './types';
import type { ArchivedAuthorization } from '../receipt-archive';

export type FieldSource = 'signed' | 'recomputed' | 'archive' | 'database';

export interface BoxCheck {
  elementId: string;
  kind: string;
  /** Drawn fields equal to their signed source. */
  signed: string[];
  /** Drawn numbers recomputed from bundled inputs; `inputs` says where those
   *  inputs come from (a recomputed value is only as strong as its inputs). */
  recomputed: Array<{ field: string; inputs: FieldSource[] }>;
  /** Drawn fields the file cannot back offline — listed, never a failure. */
  notCheckable: Array<{ field: string; source: 'archive' | 'database' }>;
  /** A drawn value that differs from its source. Fails the check. */
  mismatches: string[];
}

export type DocumentCheck =
  | { state: 'match' }
  | { state: 'not-given' }
  | { state: 'mismatch'; error: string };

type Data = Record<string, unknown>;

// ─── 1. The visible page is exactly what the bundle draws ──────────────────

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function visibleText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Line endings, the HTML way: CRLF and a lone CR both become LF — exactly the
 * newline normalization every HTML parser applies to its input before
 * tokenizing (WHATWG "preprocessing the input stream"). Two strings equal
 * after this cannot render differently, so it can never hide an edit a reader
 * would see. It is applied to BOTH sides, because both can carry CR:
 *   - the file, when a download, a mail client, git (core.autocrlf) or an
 *     editor rewrote its line endings — a Windows user must be able to check a
 *     file exported on macOS, and the other way round;
 *   - the re-draw, because the report HTML the AI wrote (stored and bundled
 *     as-is) may itself contain CRLF — normalizing only the file made such an
 *     untouched export fail its own check on every OS.
 * Values the checker compares as DATA (tickets, bounds, the report HTML in
 * the embedded bundle) are not affected: inside the JSON proof block a CR is
 * the escape `\r`, which no line-ending rewrite touches.
 */
function normalizeNewlines(html: string): string {
  return html.replace(/\r\n?/g, '\n');
}

/** Re-draws the file from the bundle and requires byte equality (line
 *  endings normalized on both sides, see normalizeNewlines). On a
 *  difference, says where — in visible words. */
export function checkDocumentReproduces(bundle: ExportBundle, documentHtml: string | undefined): DocumentCheck {
  if (documentHtml === undefined) return { state: 'not-given' };
  if (!validTimeZone(bundle.timeZone)) {
    return { state: 'mismatch', error: `The file names an unknown drawing time zone "${bundle.timeZone}".` };
  }
  let expected: string;
  try {
    // buildExportDocument draws in bundle.timeZone itself (format.ts#withDrawingZone).
    expected = normalizeNewlines(buildExportDocument({ bundle }));
  } catch (err) {
    return { state: 'mismatch', error: `The page could not be re-drawn from the bundle: ${err instanceof Error ? err.message : String(err)}` };
  }
  const actual = normalizeNewlines(documentHtml);
  if (actual === expected) return { state: 'match' };
  let i = 0;
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
  const around = (s: string) => {
    const from = Math.max(0, s.lastIndexOf('<div', i));
    const close = s.indexOf('</div>', i);
    return visibleText(s.slice(from, close === -1 ? i + 200 : close + 6)).slice(0, 160);
  };
  return {
    state: 'mismatch',
    error:
      `The visible page differs from what the signed bundle draws (first difference at byte ${i}). ` +
      `File shows: "${around(actual)}" — the bundle draws: "${around(expected)}". ` +
      `Either the page was edited, or it was drawn by a different gateway version than this checker ` +
      `(the file says ${bundle.gatewayVersion}).`,
  };
}

// ─── 2. Every drawn field against its source ────────────────────────────────

interface Attestations {
  /** authorizationId -> first attestation's payload, signature verified. */
  first: Map<string, AttestationPayload | null>;
  /** did -> names disclosed at high assurance in ANY verified bundled blob. */
  names: Map<string, Set<string>>;
}

async function verifiedPayload(blob: string, publicKeyHex: string): Promise<AttestationPayload | null> {
  try {
    const att = decodeAttestationBlob(blob);
    await verifyAttestationSignature(att, publicKeyHex);
    return att.payload;
  } catch {
    return null;
  }
}

async function collectAttestations(bundle: ExportBundle): Promise<Attestations> {
  const key = bundle.authorityServer.publicKeyHex;
  const first = new Map<string, AttestationPayload | null>();
  const names = new Map<string, Set<string>>();
  const addNames = (p: AttestationPayload | null) => {
    for (const s of p?.subjects ?? []) {
      if (s.assurance === 'high' && s.disclose?.name) {
        if (!names.has(s.did)) names.set(s.did, new Set());
        names.get(s.did)!.add(s.disclose.name);
      }
    }
  };
  for (const [id, auth] of Object.entries(bundle.authorizations)) {
    let i = 0;
    for (const att of auth.attestations) {
      const p = await verifiedPayload(att.blob, key);
      if (i++ === 0) first.set(id, p);
      addNames(p);
    }
    if (auth.attestations.length === 0) first.set(id, null);
  }
  for (const blob of bundle.identityAttestations ?? []) addNames(await verifiedPayload(blob, key));
  return { first, names };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Order-insensitive equality of two flat value maps. */
function sameMap(a: Data | undefined, b: Data | undefined): boolean {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  return same(ka, kb) && ka.every(k => same((a ?? {})[k], (b ?? {})[k]));
}

export interface DrawnCheckContext {
  bundle: ExportBundle;
  /** Bundled tickets whose signature verified, by id. */
  validTickets: Map<string, Data>;
  /** authorizationIds whose bounds VALUES were proven by a signed bounds_hash. */
  boundsProven: Set<string>;
}

export async function checkDrawnElements(ctx: DrawnCheckContext, reportElements: Array<{ id: string; kind: string; attrs: Record<string, string> }>): Promise<{ boxes: BoxCheck[]; errors: string[] }> {
  const { bundle } = ctx;
  const errors: string[] = [];
  const att = await collectAttestations(bundle);

  // The bundle's elements must be the report's own elements (same id, kind
  // and attributes) — attributes decide what a box draws.
  const parsedById = new Map(reportElements.map(e => [e.id, e]));
  const seen = new Set<string>();
  for (const el of bundle.elements) {
    if (seen.has(el.id)) errors.push(`Element ${el.id} appears twice in the bundle.`);
    seen.add(el.id);
    const p = parsedById.get(el.id);
    if (!p || p.kind !== el.kind || !sameMap(p.attrs, el.attrs)) {
      errors.push(`Element ${el.id} in the bundle is not the report's own element (id, kind or attributes differ).`);
    }
  }

  // The Proof panel's "Checked values" and counts are drawn from
  // bundle.proof — they must follow from the elements themselves.
  errors.push(...checkProofSummary(bundle));

  const boxes: BoxCheck[] = [];
  for (const el of bundle.elements) {
    if (el.status === 'unverifiable' || !el.data) continue;
    const box: BoxCheck = { elementId: el.id, kind: el.kind, signed: [], recomputed: [], notCheckable: [], mismatches: [] };
    try {
      switch (el.kind) {
        case 'sv-ticket': checkTicketBox(ctx, att, el, box); break;
        case 'sv-mandate': checkMandateBox(ctx, att, el, box); break;
        case 'sv-approval': checkApprovalBox(el, box); break;
        case 'sv-record':
          for (const k of Object.keys(el.data)) box.notCheckable.push({ field: k, source: 'database' });
          break;
        case 'sv-case': checkCaseBox(ctx, el, box); break;
        case 'sv-metric': checkMetricBox(bundle, el, box); break;
        default: box.mismatches.push(`Unknown element kind "${el.kind}" drawn as verified.`);
      }
    } catch (err) {
      box.mismatches.push(`Could not check: ${err instanceof Error ? err.message : String(err)}`);
    }
    boxes.push(box);
  }
  return { boxes, errors };
}

function proofOf(elements: VerifiedElement[]) {
  const ticketsReferenced = new Set<string>();
  const signaturesValid = new Set<string>();
  let recordsChecked = 0;
  let unverifiableCount = 0;
  const verifiedValues: Array<{ elementId: string; kind: string; summary: string }> = [];
  for (const el of elements) {
    if (el.status === 'unverifiable') unverifiableCount++;
    else verifiedValues.push({ elementId: el.id, kind: el.kind, summary: checkedValueLine(el) });
    const ids: string[] = [];
    if (el.kind === 'sv-ticket' && el.attrs.ref) ids.push(el.attrs.ref);
    if ((el.kind === 'sv-approval' || el.kind === 'sv-mandate') && el.attrs.ticket) ids.push(el.attrs.ticket);
    if (el.kind === 'sv-case') {
      const { goalId, stepIds } = parseCaseAttrs(el.attrs);
      ids.push(...[goalId, ...stepIds].filter(Boolean));
    }
    for (const id of ids) {
      ticketsReferenced.add(id);
      if (el.status !== 'unverifiable') signaturesValid.add(id);
    }
    if (el.kind === 'sv-record' && el.status === 'verified') recordsChecked++;
  }
  return { ticketsReferenced, signaturesValid: signaturesValid.size, recordsChecked, unverifiableCount, verifiedValues };
}

function checkProofSummary(bundle: ExportBundle): string[] {
  // The summaries carry drawn timestamps — computed in the drawing zone.
  const p = validTimeZone(bundle.timeZone) ? withDrawingZone(bundle.timeZone, () => proofOf(bundle.elements)) : proofOf(bundle.elements);
  const errors: string[] = [];
  const b = bundle.proof;
  if (!same(b.verifiedValues, p.verifiedValues)) errors.push('The "Checked values" panel does not match the boxes.');
  if (!same([...new Set(b.ticketsReferenced)].sort(), [...p.ticketsReferenced].sort())) errors.push('The Proof panel\'s "Tickets referenced" does not match the report.');
  if (b.signaturesValid !== p.signaturesValid) errors.push('The Proof panel\'s "Signatures valid" does not match the boxes.');
  if (b.recordsChecked !== p.recordsChecked) errors.push('The Proof panel\'s "Records checked" does not match the boxes.');
  if (b.unverifiableCount !== p.unverifiableCount) errors.push('The Proof panel\'s "Not verifiable" count does not match the boxes.');
  return errors;
}

function receiptFor(ctx: DrawnCheckContext, id: string | undefined, box: BoxCheck): Data | undefined {
  const r = id ? ctx.validTickets.get(id) : undefined;
  if (!r) box.mismatches.push(`Ticket ${id ?? '(none)'} is not in the file with a valid signature.`);
  return r;
}

function signedField(box: BoxCheck, field: string, drawn: unknown, signed: unknown): void {
  if (same(drawn, signed)) box.signed.push(field);
  else box.mismatches.push(`${field}: the box shows ${JSON.stringify(drawn)}, the signed source says ${JSON.stringify(signed)}.`);
}

function checkTicketBox(ctx: DrawnCheckContext, att: Attestations, el: VerifiedElement, box: BoxCheck): void {
  const d = el.data!;
  const r = receiptFor(ctx, el.attrs.ref, box);
  if (!r) return;
  signedField(box, 'action', d.action, r.action);
  signedField(box, 'timestamp', d.time, r.timestamp);
  const full = (el.attrs.variant ?? '').trim().toLowerCase() === 'full';
  if (!full) return;
  if (d.actionType !== undefined || r.actionType !== undefined) signedField(box, 'actionType', d.actionType, r.actionType);
  signedField(box, 'profileId', d.profile, r.profileId);
  signedField(box, 'ticket', d.ticketId, r.id);
  if (sameMap(d.executionContext as Data, scrubForbidden(r.executionContext ?? {}) as Data)) {
    for (const k of Object.keys((d.executionContext ?? {}) as Data)) box.signed.push(k);
  } else {
    box.mismatches.push('The execution context the box shows differs from the signed ticket.');
  }
  const expectedUrl = `${ctx.bundle.authorityServer.url.replace(/\/+$/, '')}/r/${String(r.id ?? '')}`;
  if (d.checkUrl !== undefined && d.checkUrl !== expectedUrl) {
    box.mismatches.push(`The "Check on suveren.ai" link points to ${JSON.stringify(d.checkUrl)}, not ${expectedUrl}.`);
  }
  if (d.mandate) checkMandateFields(ctx, att, d.mandate as Data, r, box, 'mandate.');
  if (d.approval) {
    const a = d.approval as Data;
    for (const [k, f] of [['createdAt', 'approval.createdAt'], ['decidedAt', 'approval.decidedAt'], ['whoLabel', 'approval.committedBy']] as const) {
      if (a[k] !== undefined) box.notCheckable.push({ field: f, source: 'archive' });
    }
  }
}

function checkMandateBox(ctx: DrawnCheckContext, att: Attestations, el: VerifiedElement, box: BoxCheck): void {
  const r = receiptFor(ctx, el.attrs.ticket, box);
  if (!r) return;
  checkMandateFields(ctx, att, el.data!, r, box, '');
}

function checkMandateFields(ctx: DrawnCheckContext, att: Attestations, m: Data, r: Data, box: BoxCheck, prefix: string): void {
  const authorizationId = typeof r.authorizationId === 'string' ? r.authorizationId : '';
  const auth: ArchivedAuthorization | undefined = ctx.bundle.authorizations[authorizationId];
  if (!auth) {
    box.mismatches.push(`${prefix || 'mandate '}drawn, but the mandate ${authorizationId || '(none)'} is not in the file.`);
    return;
  }
  const payload = att.first.get(authorizationId) ?? null;

  // Bounds: drawn values = bundled values, and those are proven by a signed
  // bounds_hash (verify-export.ts recomputes it).
  const rawLimits = (m.rawLimits ?? {}) as Data;
  if (Object.keys(rawLimits).length > 0) {
    if (!sameMap(rawLimits, auth.bounds as Data | undefined)) {
      box.mismatches.push(`${prefix}limits: the box shows ${JSON.stringify(rawLimits)}, the mandate in the file says ${JSON.stringify(auth.bounds ?? {})}.`);
    } else if (!ctx.boundsProven.has(authorizationId)) {
      box.mismatches.push(`${prefix}limits: the bounds values are not proven by a signed bounds_hash.`);
    } else {
      for (const k of Object.keys(rawLimits)) box.signed.push(prefix + k);
    }
  }

  if (m.profile !== undefined) {
    if (!payload) box.mismatches.push('profileId: no verified mandate attestation in the file backs it.');
    else signedField(box, 'profileId', m.profile, payload.profile_id);
  }

  if (m.mode !== undefined || (Array.isArray(m.owners) && m.owners.length > 0)) {
    if (!payload) {
      box.mismatches.push(`${prefix}commitment_mode/owner: no verified mandate attestation in the file backs them.`);
    } else {
      if (m.mode !== undefined) signedField(box, `${prefix}commitment_mode`, m.mode, payload.commitment_mode);
      checkOwners(att, payload, Array.isArray(m.owners) ? m.owners : [], box, prefix);
    }
  }

  if (typeof m.intent === 'string' && m.intent) {
    if (auth.intent !== undefined && auth.intent !== m.intent) {
      box.mismatches.push('intent: the box shows a different text than the mandate in the file.');
    }
    const committed = payload?.gate_content_hashes?.intent;
    if (committed) {
      if (computeIntentHash(m.intent) === committed) box.signed.push('intent');
      else box.mismatches.push('intent: the text does not match the signed intent hash.');
    } else {
      box.notCheckable.push({ field: 'intent', source: 'archive' });
    }
  }
}

function checkOwners(att: Attestations, payload: AttestationPayload, labels: unknown[], box: BoxCheck, prefix: string): void {
  const dids = payload.resolved_owners ?? [];
  if (labels.length !== dids.length) {
    box.mismatches.push(`${prefix}owner: the box shows ${labels.length} owner(s), the signed mandate names ${dids.length}.`);
    return;
  }
  dids.forEach((did, i) => {
    const label = labels[i];
    const own = (payload.subjects ?? []).find(s => s.did === did);
    const ownName = own?.assurance === 'high' && own.disclose?.name ? own.disclose.name : undefined;
    const ok = ownName !== undefined
      ? label === ownName
      : label === formatOwnerLabel(did) || label === UNDISCLOSED_OWNER_LABEL || (typeof label === 'string' && !!att.names.get(did)?.has(label));
    if (ok) box.signed.push(`${prefix}owner`);
    else box.mismatches.push(`${prefix}owner: "${String(label)}" is not a name this owner disclosed in a signed attestation in the file.`);
  });
}

function checkApprovalBox(el: VerifiedElement, box: BoxCheck): void {
  const d = el.data!;
  for (const [k, f] of [['createdAt', 'createdAt'], ['decidedAt', 'decidedAt'], ['whoLabel', 'committedBy'], ['status', 'status']] as const) {
    if (d[k] !== undefined) box.notCheckable.push({ field: f, source: 'archive' });
  }
  if (typeof d.waitSeconds === 'number') {
    if (typeof d.createdAt === 'number' && typeof d.decidedAt === 'number' && d.decidedAt - d.createdAt === d.waitSeconds) {
      box.recomputed.push({ field: 'wait_s', inputs: ['archive'] });
    } else {
      box.mismatches.push(`wait_s: ${d.waitSeconds} is not decidedAt − createdAt.`);
    }
  }
}

function checkCaseBox(ctx: DrawnCheckContext, el: VerifiedElement, box: BoxCheck): void {
  const d = el.data!;
  const { goalId, stepIds } = parseCaseAttrs(el.attrs);
  const goal = (d.goal ?? {}) as Data;
  const steps = (Array.isArray(d.steps) ? d.steps : []) as Data[];
  const start = (d.start ?? {}) as Data;

  // Signed: the goal and every step, exactly the tickets the report names.
  if (goal.ticketId !== goalId) box.mismatches.push(`goal: the box shows ticket ${String(goal.ticketId)}, the report names ${goalId}.`);
  const gr = receiptFor(ctx, goalId, box);
  if (gr) {
    signedField(box, 'goal.action', goal.action, gr.action);
    signedField(box, 'goal.timestamp', goal.time, gr.timestamp);
  }
  if (!same(steps.map(s => s.ticketId), stepIds)) box.mismatches.push('steps: the box does not show exactly the step tickets the report names.');
  steps.forEach((s, i) => {
    const sr = receiptFor(ctx, String(s.ticketId ?? ''), box);
    if (!sr) return;
    signedField(box, `step[${i}].action`, s.action, sr.action);
    signedField(box, `step[${i}].timestamp`, s.time, sr.timestamp);
  });

  // Database (the case's start email, the test-data load) and archive
  // (approvals): shown, not checkable offline.
  box.notCheckable.push({ field: 'case_id', source: 'database' });
  if (start.receivedAt !== undefined || start.emailTime !== undefined) box.notCheckable.push({ field: 'received_at', source: 'database' });
  if (start.subject !== undefined) box.notCheckable.push({ field: 'subject', source: 'database' });
  if (start.sender !== undefined) box.notCheckable.push({ field: 'from_email', source: 'database' });
  if (start.loadedAt !== undefined) box.notCheckable.push({ field: 'simulation_load.loaded_at', source: 'database' });
  for (const a of (Array.isArray(d.approvals) ? d.approvals : []) as Data[]) {
    if (a.ticketId !== goalId && !stepIds.includes(String(a.ticketId))) box.mismatches.push(`An approval step names ticket ${String(a.ticketId)}, which is not in this case.`);
    box.notCheckable.push({ field: `approval(${String(a.ticketId)})`, source: 'archive' });
  }

  // Recomputed: the effective start and duration_s from the drawn inputs.
  const emailTime = start.receivedAt !== undefined ? parseTimestampSeconds(start.receivedAt) : (start.emailTime as number | undefined);
  const loadedAt = start.loadedAt !== undefined ? parseTimestampSeconds(start.loadedAt) : undefined;
  if (typeof emailTime !== 'number' || emailTime !== start.emailTime) {
    box.mismatches.push('received_at: the drawn date is not the start time the case uses.');
    return;
  }
  const startTime = loadedAt !== undefined ? Math.max(emailTime, loadedAt) : emailTime;
  const basis = loadedAt === undefined ? 'load-unknown' : emailTime >= loadedAt ? 'email' : 'loaded';
  if (start.time !== startTime || start.basis !== basis) box.mismatches.push('The case start is not max(received_at, simulation_load.loaded_at).');
  const goalTime = gr?.timestamp;
  if (typeof goalTime === 'number') {
    if (goalTime < startTime) box.mismatches.push('The goal ticket is timestamped before the case start.');
    for (const s of steps) {
      if (typeof s.time !== 'number' || s.time < startTime || s.time > goalTime) box.mismatches.push(`Step ${String(s.ticketId)} lies outside the case window.`);
    }
    const expected = basis === 'load-unknown' ? null : goalTime - startTime;
    if ((d.totalDurationSeconds ?? null) !== expected) {
      box.mismatches.push(`duration_s: the box shows ${JSON.stringify(d.totalDurationSeconds ?? null)}, recomputed ${JSON.stringify(expected)}.`);
    } else if (expected !== null) {
      box.recomputed.push({ field: 'duration_s', inputs: ['signed', 'database'] });
    }
  }
}

/** Where each metric's inputs come from (the case boxes it is computed over). */
const METRIC_INPUTS: Record<string, FieldSource[]> = {
  completed: ['signed', 'database'],
  'median-time': ['signed', 'database'],
  'average-time': ['signed', 'database'],
  'without-approval': ['archive'],
  approvals: ['archive'],
  'median-approval-wait': ['archive'],
  tickets: ['signed'],
};

function checkMetricBox(bundle: ExportBundle, el: VerifiedElement, box: BoxCheck): void {
  const d = el.data!;
  const kind = el.attrs.kind ?? '';
  if (d.kind !== kind) box.mismatches.push(`kind: the box shows ${JSON.stringify(d.kind)}, the report asks for ${JSON.stringify(kind)}.`);
  // The same selection verify-report.ts makes: the report's verified cases,
  // optionally a named subset.
  const allCases = bundle.elements.filter(e => e.kind === 'sv-case');
  const casesAttr = (el.attrs.cases ?? 'all').trim();
  const requested = casesAttr === 'all' ? allCases.length : new Set(casesAttr.split(/\s+/).filter(Boolean)).size;
  let selected = allCases.filter(c => c.status !== 'unverifiable' && c.data);
  if (casesAttr !== 'all') {
    const wanted = new Set(casesAttr.split(/\s+/).filter(Boolean));
    selected = selected.filter(c => wanted.has(String((c.data as Data).caseId)));
  }
  const caseIds = selected.map(c => String((c.data as Data).caseId));
  if (!same(d.caseIds ?? [], caseIds)) box.mismatches.push('cases: the box does not list the report\'s own verified cases.');
  const expectedStatus = selected.length < requested ? 'warning' : 'verified';
  if (el.status !== expectedStatus) box.mismatches.push(`The box is drawn as ${el.status}, but it covers ${selected.length} of ${requested} requested cases.`);
  if (kind === 'refusals') {
    box.notCheckable.push({ field: 'refusals', source: 'database' });
    return;
  }
  const inputs = selected.map(c => {
    const cd = c.data as Data;
    const goal = (cd.goal ?? {}) as Data;
    const start = (cd.start ?? {}) as Data;
    return {
      caseId: String(cd.caseId),
      startTime: Number(start.time),
      goalTime: Number(goal.time),
      totalDurationSeconds: (cd.totalDurationSeconds ?? null) as number | null,
      ticketIds: [String(goal.ticketId), ...((Array.isArray(cd.steps) ? cd.steps : []) as Data[]).map(s => String(s.ticketId))],
      approvals: ((Array.isArray(cd.approvals) ? cd.approvals : []) as Data[]).map(a => ({
        waitSeconds: typeof a.createdAt === 'number' && typeof a.decidedAt === 'number' ? a.decidedAt - a.createdAt : undefined,
      })),
    };
  });
  let value: number;
  try {
    value = computeMetric(kind, inputs);
  } catch (err) {
    box.mismatches.push(`The figure cannot be recomputed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (value === d.value) box.recomputed.push({ field: 'value', inputs: METRIC_INPUTS[kind] ?? ['signed'] });
  else box.mismatches.push(`value: the box shows ${JSON.stringify(d.value)}, recomputed from the case boxes ${JSON.stringify(value)}.`);
}
