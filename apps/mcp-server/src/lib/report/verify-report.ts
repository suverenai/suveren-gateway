/**
 * The orchestrator: takes the AI's report HTML and a `ReportSources`
 * (receipt archive + a way to run each simulator's export CLI), and returns
 * a verified render model — work-plan "evidence-backed reports", step R5.
 *
 * Two passes over the parsed elements: everything except `sv-metric` first
 * (tickets, approvals, mandates, records, cases), then `sv-metric`, which is
 * defined ONLY over the report's own already-resolved `sv-case` elements
 * (plan: "computed by the gateway over the report's cases") — it cannot be
 * computed in the same pass as the cases it summarizes.
 */
import { REPORT_ELEMENTS } from '../report-brief';
import { sanitizeReportHtml } from './sanitize';
import { parseElements, type ParsedElement } from './parse-elements';
import { resolveTicketElement, resolveApprovalElement, resolveMandateElement } from './ticket-resolvers';
import { resolveRecord } from './record-resolvers';
import { resolveCaseElement, parseCaseAttrs, type CaseResolution } from './case-resolvers';
import { computeMetric, type CaseMetricInput } from './metric-resolvers';
import { parseTimestampSeconds } from './time';
import { isEmailExport } from './types';
import { formatActionLabel, formatDateTime, formatDuration, formatMetricValue, profileShortLabel, METRIC_LABELS } from './format';
import type {
  ExportSystem, ReportSources, VerifiedElement, VerifyReportResult,
  ProofSummary, CoverageSummary,
} from './types';

const KNOWN_KINDS = new Set<string>(REPORT_ELEMENTS);

type ExportOutcome = { ok: true; data: unknown } | { ok: false; reason: string };

export async function verifyReport(html: string, sources: ReportSources): Promise<VerifyReportResult> {
  const sanitized = sanitizeReportHtml(html);
  const parsed = parseElements(sanitized);

  // One export call per system per run (plan): cache by system, not by element.
  const exportCache = new Map<ExportSystem, Promise<ExportOutcome>>();
  function getExport(system: ExportSystem): Promise<ExportOutcome> {
    let p = exportCache.get(system);
    if (!p) {
      p = sources.runExport(system).then(
        data => ({ ok: true as const, data }),
        err => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }),
      );
      exportCache.set(system, p);
    }
    return p;
  }

  const elements: VerifiedElement[] = [];
  const caseElements: Array<{ el: VerifiedElement; resolution: CaseResolution }> = [];
  const metricParsed: ParsedElement[] = [];

  async function resolveOne(p: ParsedElement): Promise<VerifiedElement> {
    try {
      switch (p.kind) {
        case 'sv-ticket': {
          const r = await resolveTicketElement(sources.archive, p.attrs.ref ?? '');
          return { id: p.id, kind: p.kind, attrs: p.attrs, ...r };
        }
        case 'sv-approval': {
          const r = await resolveApprovalElement(sources.archive, p.attrs.ticket ?? '');
          return { id: p.id, kind: p.kind, attrs: p.attrs, ...r };
        }
        case 'sv-mandate': {
          const r = await resolveMandateElement(sources.archive, p.attrs.ticket ?? '');
          return { id: p.id, kind: p.kind, attrs: p.attrs, ...r };
        }
        case 'sv-record': {
          const system = p.attrs.system;
          if (system !== 'email' && system !== 'crm' && system !== 'erp') {
            return { id: p.id, kind: p.kind, attrs: p.attrs, status: 'unverifiable', reason: `Unknown system "${p.attrs.system ?? ''}".` };
          }
          const exp = await getExport(system);
          if (!exp.ok) {
            return { id: p.id, kind: p.kind, attrs: p.attrs, status: 'unverifiable', reason: `Could not read the ${system} simulator export: ${exp.reason}` };
          }
          const r = resolveRecord(system, exp.data, p.attrs.ref ?? '');
          return { id: p.id, kind: p.kind, attrs: p.attrs, ...r };
        }
        case 'sv-case': {
          const exp = await getExport('email');
          if (!exp.ok || !isEmailExport(exp.data)) {
            return {
              id: p.id, kind: p.kind, attrs: p.attrs, status: 'unverifiable',
              reason: `Could not read the email simulator export: ${!exp.ok ? exp.reason : 'unexpected shape'}`,
            };
          }
          const resolution = await resolveCaseElement(sources.archive, exp.data, p.attrs);
          const el: VerifiedElement = {
            id: p.id, kind: p.kind, attrs: p.attrs, status: resolution.status,
            ...(resolution.reason ? { reason: resolution.reason } : {}),
            ...(resolution.data ? { data: resolution.data as unknown as Record<string, unknown> } : {}),
          };
          caseElements.push({ el, resolution });
          return el;
        }
        default:
          return { id: p.id, kind: p.kind, attrs: p.attrs, status: 'unverifiable', reason: 'Unhandled element kind.' };
      }
    } catch (err) {
      return { id: p.id, kind: p.kind, attrs: p.attrs, status: 'unverifiable', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  for (const p of parsed) {
    if (!KNOWN_KINDS.has(p.kind)) {
      elements.push({
        id: p.id, kind: p.kind, attrs: p.attrs, status: 'unverifiable',
        reason: `Unknown element "${p.kind}" — not one of the six elements report-brief.ts defines.`,
      });
      continue;
    }
    if (p.kind === 'sv-metric') {
      metricParsed.push(p);
      continue;
    }
    elements.push(await resolveOne(p));
  }

  // Second pass: sv-metric, over the sv-cases already resolved above.
  //
  // A figure's STATUS must reflect how much of what it claims actually
  // verified — never "verified" by construction just because computeMetric()
  // can run on an empty list (median([]) === 0 is a real return value, not
  // evidence of zero completed cases). Caught in review 2026-10-05: a report
  // with no real archive drew "0 cases completed" with a green "✓ computed
  // by gateway" badge — indistinguishable from an honestly-computed zero.
  for (const p of metricParsed) {
    try {
      const kind = p.attrs.kind ?? '';
      const casesAttr = (p.attrs.cases ?? 'all').trim();
      // What the AI asked for: every case it defined ("all"), or a named
      // subset — counted distinct, so "cases="C1 C1"" doesn't inflate M.
      const requestedCount = casesAttr === 'all' ? caseElements.length : new Set(casesAttr.split(/\s+/).filter(Boolean)).size;
      let selected = caseElements.filter(c => c.resolution.status !== 'unverifiable' && c.resolution.data);
      if (casesAttr !== 'all') {
        const wanted = new Set(casesAttr.split(/\s+/).filter(Boolean));
        selected = selected.filter(c => wanted.has(c.resolution.data!.caseId));
      }
      const caseInputs: CaseMetricInput[] = selected.map(c => ({
        caseId: c.resolution.data!.caseId,
        startTime: c.resolution.data!.start.time,
        goalTime: c.resolution.data!.goal.time,
        totalDurationSeconds: c.resolution.data!.totalDurationSeconds,
        ticketIds: [c.resolution.data!.goal.ticketId, ...c.resolution.data!.steps.map(s => s.ticketId)],
        approvals: c.resolution.data!.approvals,
      }));
      const verifiedCount = caseInputs.length;

      if (verifiedCount === 0) {
        // Nothing to compute over — a number here would be indistinguishable
        // from a real zero. No `data`, per the unverifiable contract.
        elements.push({
          id: p.id, kind: p.kind, attrs: p.attrs, status: 'unverifiable',
          reason: requestedCount > 0
            ? `No verified cases (0 of ${requestedCount} requested) — no figure.`
            : 'No verified cases — no figure.',
        });
        continue;
      }

      const refusalTimes = kind === 'refusals' ? await collectRefusalTimes(getExport) : [];
      const value = computeMetric(kind, caseInputs, refusalTimes);
      const data = { kind, cases: casesAttr, value, caseCount: verifiedCount };
      if (verifiedCount < requestedCount) {
        // A real, honestly-computed figure — just not over everything asked
        // for. Shown with its value (not hidden), flagged so it is never
        // mistaken for the complete picture.
        elements.push({
          id: p.id, kind: p.kind, attrs: p.attrs, status: 'warning',
          reason: `Computed over ${verifiedCount} of ${requestedCount} requested cases — the rest did not verify.`,
          data,
        });
      } else {
        elements.push({ id: p.id, kind: p.kind, attrs: p.attrs, status: 'verified', data });
      }
    } catch (err) {
      elements.push({ id: p.id, kind: p.kind, attrs: p.attrs, status: 'unverifiable', reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const proof = buildProof(elements, caseElements);
  const coverage = await buildCoverage(caseElements, getExport, sources.archive, proof.ticketsReferenced);

  return { html: sanitized, elements, proof, coverage };
}

/** Every connector's refusals, fail-closed: a report must not silently
 *  undercount because one simulator's export could not be read — it marks
 *  the WHOLE `refusals` metric unverifiable instead (caller catches). */
async function collectRefusalTimes(getExport: (s: ExportSystem) => Promise<ExportOutcome>): Promise<number[]> {
  const times: number[] = [];
  for (const system of ['email', 'crm', 'erp'] as const) {
    const exp = await getExport(system);
    if (!exp.ok) throw new Error(`Could not read the ${system} simulator export: ${exp.reason}`);
    const refusals = (exp.data as { refusals?: Array<{ at: unknown }> }).refusals ?? [];
    for (const r of refusals) {
      const t = parseTimestampSeconds(r.at);
      if (t !== undefined) times.push(t);
    }
  }
  return times;
}

/**
 * The "Checked values" side panel's one-line-per-element summary — a manager
 * cross-checks these against the rendered report, so they carry the SAME
 * formatting as the drawn `sv-*` cards (render-report.ts): no unix seconds,
 * no raw tool names, no bare did:key (polish 2026-10-05). `owners`/`limits`
 * on a resolved mandate are already display-ready strings by the time they
 * reach here (ticket-resolvers.ts#resolveMandateElement).
 */
function summarize(el: VerifiedElement): string {
  const d = el.data ?? {};
  switch (el.kind) {
    case 'sv-ticket': {
      const actionLabel = typeof d.actionLabel === 'string' ? d.actionLabel : formatActionLabel(d.action);
      const timeLabel = typeof d.timeLabel === 'string' ? d.timeLabel : formatDateTime(d.time);
      return `${actionLabel} — ${timeLabel}`;
    }
    case 'sv-approval': {
      const who = typeof d.whoLabel === 'string' ? d.whoLabel : ((d.who as string[] | undefined)?.join(', ') ?? 'unknown');
      const waitLabel = typeof d.waitLabel === 'string' ? d.waitLabel : (typeof d.waitSeconds === 'number' ? formatDuration(d.waitSeconds) : 'unknown');
      return `Approval by ${who} — waited ${waitLabel}`;
    }
    case 'sv-mandate': {
      const profileLabel = typeof d.profileLabel === 'string' ? d.profileLabel : profileShortLabel(typeof d.profile === 'string' ? d.profile : undefined);
      const owners = Array.isArray(d.owners) && (d.owners as string[]).length > 0 ? (d.owners as string[]).join(', ') : 'unknown owner';
      return `Mandate: ${profileLabel} · ${owners}`;
    }
    case 'sv-record':
      return `${String(d.kind ?? 'record')} record checked`;
    case 'sv-case': {
      const steps = (d.steps as unknown[] | undefined)?.length ?? 0;
      return `Case ${String(d.caseId)}: ${steps} ${steps === 1 ? "step" : "steps"}, ${formatDuration(d.totalDurationSeconds)}`;
    }
    case 'sv-metric': {
      const kind = String(d.kind ?? '');
      const label = METRIC_LABELS[kind] ?? kind;
      return `${label} = ${formatMetricValue(kind, d.value)}`;
    }
    default:
      return el.id;
  }
}

function buildProof(
  elements: VerifiedElement[],
  caseElements: Array<{ el: VerifiedElement; resolution: CaseResolution }>,
): ProofSummary {
  const ticketsReferenced = new Set<string>();
  const signaturesValid = new Set<string>();
  let recordsChecked = 0;
  let unverifiableCount = 0;
  const verifiedValues: ProofSummary['verifiedValues'] = [];

  for (const el of elements) {
    if (el.status === 'unverifiable') unverifiableCount++;
    if (el.status === 'verified' || el.status === 'warning') {
      verifiedValues.push({ elementId: el.id, kind: el.kind, summary: summarize(el) });
    }

    if (el.kind === 'sv-ticket' && el.attrs.ref) {
      ticketsReferenced.add(el.attrs.ref);
      if (el.status !== 'unverifiable') signaturesValid.add(el.attrs.ref);
    }
    if ((el.kind === 'sv-approval' || el.kind === 'sv-mandate') && el.attrs.ticket) {
      ticketsReferenced.add(el.attrs.ticket);
      if (el.status !== 'unverifiable') signaturesValid.add(el.attrs.ticket);
    }
    if (el.kind === 'sv-record' && el.status === 'verified') {
      recordsChecked++;
    }
  }

  for (const { el, resolution } of caseElements) {
    const { goalId, stepIds } = parseCaseAttrs(el.attrs);
    for (const id of [goalId, ...stepIds]) {
      if (!id) continue;
      ticketsReferenced.add(id);
      // A case that didn't fail CLOSED (unverifiable) verified every one of
      // its own goal+step tickets by construction (resolveCaseElement calls
      // checkTicket on each before returning anything else).
      if (resolution.status !== 'unverifiable') signaturesValid.add(id);
    }
  }

  return {
    ticketsReferenced: [...ticketsReferenced],
    signaturesValid: signaturesValid.size,
    recordsChecked,
    unverifiableCount,
    verifiedValues,
  };
}

async function buildCoverage(
  caseElements: Array<{ el: VerifiedElement; resolution: CaseResolution }>,
  getExport: (s: ExportSystem) => Promise<ExportOutcome>,
  archive: ReportSources['archive'],
  referenced: string[],
): Promise<CoverageSummary> {
  const exp = await getExport('email');
  const emailExportError = !exp.ok
    ? exp.reason
    : !isEmailExport(exp.data)
      ? 'Email simulator export had an unexpected shape.'
      : undefined;
  const loadedCases = exp.ok && isEmailExport(exp.data)
    ? [...new Set(exp.data.inbox.map(m => m.case_id).filter((c): c is string => !!c))]
    : [];

  const covered = new Set(
    caseElements.map(c => c.resolution.startCaseId).filter((c): c is string => !!c),
  );
  const coveredCases = loadedCases.filter(c => covered.has(c));
  const missingCases = loadedCases.filter(c => !covered.has(c));

  // Ticket-level coverage: tickets carry no case id, so the AI names a case's
  // steps itself — this is what keeps it from leaving one out unnoticed.
  const loadedAt = exp.ok && isEmailExport(exp.data) ? exp.data.simulation_load?.loaded_at : undefined;
  const periodStart = loadedAt !== undefined ? (parseTimestampSeconds(loadedAt) ?? null) : null;
  const inPeriod = archive.getReceipts()
    .map(r => ({ id: String(r.receipt.id ?? ''), time: Number(r.receipt.timestamp ?? r.archivedAt) }))
    .filter(t => t.id && (periodStart === null || t.time >= periodStart))
    .sort((a, b) => a.time - b.time)
    .map(t => t.id);
  const referencedSet = new Set(referenced);
  const ticketsReferenced = inPeriod.filter(id => referencedSet.has(id));
  const ticketsNotReferenced = inPeriod.filter(id => !referencedSet.has(id));

  return {
    ...(emailExportError ? { emailExportError } : {}),
    loadedCases, coveredCases, missingCases, periodStart,
    ticketsInPeriod: inPeriod, ticketsReferenced, ticketsNotReferenced,
  };
}
