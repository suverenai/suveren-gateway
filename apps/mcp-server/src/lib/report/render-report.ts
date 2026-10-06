/**
 * Draws the six `sv-*` elements into static HTML — work-plan "evidence-backed
 * reports", step R5 (gateway frame half). Takes the SANITIZED html a
 * `VerifyReportResult` already carries plus its resolved `elements`, and
 * returns a new HTML string where every `sv-*` tag (known or not) is replaced
 * by gateway-drawn markup. The AI's own free HTML around it is untouched.
 *
 * Why re-parse rather than reuse `parse-elements.ts`'s output directly: that
 * module reports WHICH elements exist and their attributes, not WHERE they
 * sit in the string. This module needs exact character spans to splice
 * replacement markup in, so it runs its own lightweight pass with the same
 * `${kind}-${n}` id scheme (`parse-elements.ts`'s doc comment is the single
 * source of truth for that scheme — keep both in sync) and matches found
 * spans back to the already-resolved `VerifiedElement`s by id.
 *
 * Security: this output is inserted into the iframe `srcdoc` verbatim by the
 * UI, in a sandbox WITHOUT `allow-scripts`/`allow-same-origin` — but the
 * values drawn here (intent text, email subject lines, …) still come from
 * local files on disk, so every value is HTML-escaped before insertion. No
 * script survives from the AI's own markup either: it was already removed by
 * `sanitize-html` (sanitize.ts) before this module ever sees it.
 */
import { Parser } from 'htmlparser2';
import type { VerifiedElement } from './types';
import { formatActionLabel, formatDateTime, formatDuration, formatCurrency, formatMetricValue, METRIC_LABELS } from './format';
import { parseTimestampSeconds } from './time';
import { sanitizeReportHtml } from './sanitize';

interface Span {
  id: string;
  kind: string;
  start: number;
  end: number; // exclusive
}

/** Finds the exact `[start, end)` character span of every `sv-*` element in
 *  `html`, in document order, with the SAME `${kind}-${n}` id `parse-elements.ts`
 *  assigns (0-based count of that kind, in open-tag order). Assumes `sv-*`
 *  elements do not nest inside one another (true for every element the brief
 *  defines) — a close tag is matched to the most recently opened `sv-*` of
 *  the SAME name; an unmatched close (malformed AI output) is ignored rather
 *  than throwing, since a report with a dangling tag should still render
 *  everything else.
 */
function findElementSpans(html: string): Span[] {
  const spans: Span[] = [];
  const seenCount = new Map<string, number>();
  const openStack: Array<{ tag: string; id: string; start: number }> = [];
  let parserRef: Parser | undefined;

  const parser = new Parser(
    {
      onparserinit(p) {
        parserRef = p;
      },
      onopentag(name) {
        if (!name.startsWith('sv-') || !parserRef) return;
        const n = seenCount.get(name) ?? 0;
        seenCount.set(name, n + 1);
        openStack.push({ tag: name, id: `${name}-${n}`, start: parserRef.startIndex });
      },
      onclosetag(name) {
        if (!name.startsWith('sv-') || !parserRef) return;
        // Pop the innermost open sv-* of the SAME name — handles both a
        // normal close and htmlparser2's synthesized close for a
        // self-closing tag (recognizeSelfClosing below).
        const idx = [...openStack].reverse().findIndex(o => o.tag === name);
        if (idx === -1) return; // dangling close tag — ignore, don't crash the render
        const realIdx = openStack.length - 1 - idx;
        const [open] = openStack.splice(realIdx, 1);
        spans.push({ id: open.id, kind: open.tag, start: open.start, end: parserRef.endIndex + 1 });
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();

  return spans.sort((a, b) => a.start - b.start);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function badge(status: VerifiedElement['status'], okLabel: string): string {
  if (status === 'verified') return `<span class="sv-badge sv-badge-ok">✓ ${escapeHtml(okLabel)}</span>`;
  if (status === 'warning') return `<span class="sv-badge sv-badge-warn">⚠ verified with a note</span>`;
  return `<span class="sv-badge sv-badge-bad">✗ not verifiable</span>`;
}

function unverifiableCard(el: VerifiedElement): string {
  return (
    `<div class="sv-el sv-el-unverifiable" data-sv-id="${escapeHtml(el.id)}">` +
    `<div class="sv-el-row"><b>Not verifiable</b>${badge('unverifiable', '')}</div>` +
    `<div class="sv-el-reason">${escapeHtml(el.reason ?? 'This reference could not be checked.')}</div>` +
    `</div>`
  );
}

function renderTicket(el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const href = typeof d.checkUrl === 'string' ? d.checkUrl : undefined;
  const actionLabel = typeof d.actionLabel === 'string' ? d.actionLabel : formatActionLabel(d.action);
  const timeLabel = typeof d.timeLabel === 'string' ? d.timeLabel : formatDateTime(d.time);
  const profileLabel = typeof d.profileLabel === 'string' ? d.profileLabel : escapeHtml(d.profile ?? '');
  // The raw ticket id is a technical value, not something a manager reads on
  // the card itself — it lives in the detail panel's "Technical details"
  // only (ticket-details.ts / ReportsPage.tsx already surface it there).
  // Both links are wrapped in ONE <span> so the row's flexbox never sees the
  // " · " joiner as its own text-node flex item (polish 2026-10-05: that
  // produced a stray, orphaned "·" spaced across the row by
  // `justify-content: space-between`). No in-frame "Details" link any more
  // (2026-10-06): it was a `target="_top"` full page load of `/reports?…`,
  // and the SPA keeps its API key in memory only, so every click logged the
  // user out. Details open from the gateway's own side panel instead
  // (ReportsPage.tsx). The public check link opens a new tab — the iframe
  // sandbox allows popups for exactly this.
  const links = [
    href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Check on suveren.ai ↗</a>` : '',
  ].filter(Boolean);
  return (
    `<div class="sv-el sv-el-${el.status}" data-sv-id="${escapeHtml(el.id)}">` +
    `<div class="sv-el-row"><b>${escapeHtml(actionLabel)}</b>${badge(el.status, 'signature valid')}</div>` +
    `<div class="sv-el-row"><span>${escapeHtml(profileLabel)} · ${escapeHtml(timeLabel)}</span></div>` +
    (links.length > 0 ? `<div class="sv-el-row"><span>${links.join(' · ')}</span></div>` : '') +
    `</div>`
  );
}

function renderApproval(el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const who = typeof d.whoLabel === 'string' ? d.whoLabel : (Array.isArray(d.who) ? (d.who as string[]).join(', ') : 'unknown');
  const asked = typeof d.createdAtLabel === 'string' ? d.createdAtLabel : 'unknown';
  const approved = typeof d.decidedAtLabel === 'string' ? d.decidedAtLabel : 'unknown';
  const waited = typeof d.waitLabel === 'string' ? d.waitLabel : 'unknown';
  return (
    `<div class="sv-el sv-el-${el.status}" data-sv-id="${escapeHtml(el.id)}">` +
    `<div class="sv-el-row"><b>Approval</b>${badge(el.status, 'from ticket archive')}</div>` +
    `<div class="sv-el-row"><span>asked ${escapeHtml(asked)} · approved ${escapeHtml(approved)} by ${escapeHtml(who)} (${escapeHtml(waited)})</span></div>` +
    `</div>`
  );
}

function renderMandate(el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const profileLabel = typeof d.profileLabel === 'string' ? d.profileLabel : String(d.profile ?? '');
  const owners = Array.isArray(d.owners) && (d.owners as string[]).length > 0 ? (d.owners as string[]).join(', ') : 'unknown owner';
  const limits = Array.isArray(d.limits) && (d.limits as string[]).length > 0 ? (d.limits as string[]).join(' · ') : '';
  return (
    `<div class="sv-el sv-el-${el.status}" data-sv-id="${escapeHtml(el.id)}">` +
    `<div class="sv-el-row"><b>${escapeHtml(profileLabel)} · ${escapeHtml(owners)}</b>${badge(el.status, 'matches ticket')}</div>` +
    (limits ? `<div class="sv-el-row">${escapeHtml(limits)}${d.mode ? ` · ${escapeHtml(d.mode)}` : ''}</div>` : '') +
    (d.intent ? `<div class="sv-el-intent">Intent: “${escapeHtml(d.intent)}”</div>` : '') +
    `</div>`
  );
}

const RECORD_FIELD_ORDER = [
  'subject', 'from_email', 'from_name', 'to_json', 'received_at',
  'number', 'status', 'net_total', 'customer_id',
  'causingReceiptId', 'message',
];

const RECORD_TIME_FIELDS = new Set(['received_at', 'created_at', 'sent_at']);

function renderRecordField(key: string, d: Record<string, unknown>): string {
  if (key === 'net_total') {
    const currency = typeof d.currency === 'string' ? d.currency : undefined;
    return `<div class="sv-el-row"><span>Value</span><span>${escapeHtml(formatCurrency(d.net_total, currency))}</span></div>`;
  }
  if (RECORD_TIME_FIELDS.has(key)) {
    const t = parseTimestampSeconds(d[key]);
    const display = t !== undefined ? formatDateTime(t) : d[key];
    return `<div class="sv-el-row"><span>${escapeHtml(key)}</span><span>${escapeHtml(display)}</span></div>`;
  }
  return `<div class="sv-el-row"><span>${escapeHtml(key)}</span><span>${escapeHtml(d[key])}</span></div>`;
}

function renderRecord(el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const kind = String(d.kind ?? 'record');
  const rows = RECORD_FIELD_ORDER
    .filter(k => d[k] !== undefined && d[k] !== null && d[k] !== '')
    .slice(0, 5)
    .map(k => renderRecordField(k, d))
    .join('');
  return (
    `<div class="sv-el sv-el-${el.status}" data-sv-id="${escapeHtml(el.id)}">` +
    `<div class="sv-el-row"><b>${escapeHtml(kind)} record</b>${badge(el.status, 'in simulator database')}</div>` +
    rows +
    `</div>`
  );
}

interface CaseStepLike { ticketId: string; time: number; action?: unknown }
interface CaseApprovalLike {
  ticketId: string;
  whoLabel?: string;
  who?: string[];
  createdAt?: number;
  createdAtLabel?: string;
  decidedAt?: number;
  decidedAtLabel?: string;
  waitLabel?: string;
}

/** One ticket-carrying node in the case timeline — a step or the goal.
 *  `kind` drives both the small caption ("ticket"/"goal") and the CSS hook
 *  the goal already had (`sv-step-goal`). A plain `<div>` — never a link out
 *  of the frame (see renderTicket); the side panel's case detail lists the
 *  same steps as buttons. */
function renderCaseTicketStep(node: CaseStepLike, isGoal: boolean): string {
  const cls = isGoal ? 'sv-step sv-step-goal' : 'sv-step';
  const kind = isGoal ? 'goal' : 'ticket';
  const inner = `<div class="sv-step-k">${kind}</div><div class="sv-step-t">${escapeHtml(formatActionLabel(node.action))}</div>${formatDateTime(node.time)}`;
  return `<div class="${cls}">${inner}</div>`;
}

/** The approval as its OWN step in the timeline, between the request and the
 *  decision it belongs to (polish 2026-10-05: "SHOW APPROVALS as their own
 *  step ... for any step/goal ticket that has an archived approval"). Not a
 *  link (an approval is not itself a ticket to open) — its ticket's own step,
 *  rendered immediately before it, carries the "Details" link. */
function renderCaseApprovalStep(approval: CaseApprovalLike): string {
  const who = approval.whoLabel ?? (Array.isArray(approval.who) ? approval.who.join(', ') : 'unknown');
  const asked = approval.createdAtLabel ?? 'unknown';
  const decided = approval.decidedAtLabel ?? 'unknown';
  const waited = approval.waitLabel ?? 'unknown';
  return (
    `<div class="sv-step sv-step-approval">` +
    `<div class="sv-step-k">approval</div><div class="sv-step-t">Approval</div>` +
    `<div class="sv-step-sub">asked ${escapeHtml(asked)} · approved ${escapeHtml(decided)} by ${escapeHtml(who)} (${escapeHtml(waited)})</div>` +
    `</div>`
  );
}

/** The case's start node. Its time is the EFFECTIVE start (case-resolvers.ts:
 *  max(email date, test-data load)); when the email carries an earlier date
 *  (a test package backdates its mails), that date is shown separately as
 *  "Email dated …" so nobody reads it as the case start. */
function renderCaseStartStep(start: { time: number; emailTime?: number; basis?: string }): string {
  let sub = '';
  if (start.basis === 'loaded' && typeof start.emailTime === 'number') {
    sub = `<div class="sv-step-sub">Email dated ${escapeHtml(formatDateTime(start.emailTime))} · timed from when the test data was loaded</div>`;
  } else if (start.basis === 'load-unknown') {
    sub = `<div class="sv-step-sub">Email dated ${escapeHtml(formatDateTime(start.emailTime ?? start.time))} · start time not verifiable</div>`;
  }
  const time = start.basis === 'load-unknown' ? '' : escapeHtml(formatDateTime(start.time));
  return `<div class="sv-step sv-step-start"><div class="sv-step-k">start</div><div class="sv-step-t">Email in</div>${time}${sub}</div>`;
}

function renderCase(el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const steps: CaseStepLike[] = Array.isArray(d.steps) ? (d.steps as CaseStepLike[]) : [];
  const goal = d.goal as CaseStepLike | undefined;
  const approvalsByTicket = new Map<string, CaseApprovalLike>();
  if (Array.isArray(d.approvals)) {
    for (const a of d.approvals as CaseApprovalLike[]) {
      approvalsByTicket.set(a.ticketId, a);
    }
  }
  const start = d.start as { time: number; emailTime?: number; basis?: string } | undefined;
  const startStep = start ? { time: start.time, html: renderCaseStartStep(start) } : undefined;

  // Every ticket-carrying node, PLUS its own archived approval (if any) as a
  // separate timeline item — sorted together by time, not grouped by ticket.
  // An approval is always asked/decided BEFORE the ticket it gates actually
  // executes, so it belongs immediately before that ticket in the timeline,
  // not after (polish 2026-10-05, second pass: the first version always drew
  // a ticket's approval right after its own card, which put the goal's
  // approval dead last — "Email in → Quote created → Reply sent → Approval"
  // reads as if the approval happened AFTER the reply was already sent).
  const ticketNodes: Array<{ node: CaseStepLike; isGoal: boolean }> = [
    ...steps.map(s => ({ node: s, isGoal: false })),
    ...(goal ? [{ node: goal, isGoal: true }] : []),
  ];

  const items: Array<{ time: number; html: string }> = [];
  if (startStep) items.push(startStep);
  for (const { node, isGoal } of ticketNodes) {
    const approval = approvalsByTicket.get(node.ticketId);
    if (approval) {
      // Clamp to at most the ticket's own time: a real approval always
      // precedes execution, but this also guarantees correct placement
      // (immediately before, via the stable sort below) even if clock skew
      // ever put a recorded decidedAt a beat after the ticket's timestamp.
      const approvalTime = Math.min(approval.decidedAt ?? approval.createdAt ?? node.time, node.time);
      items.push({ time: approvalTime, html: renderCaseApprovalStep(approval) });
    }
    items.push({ time: node.time, html: renderCaseTicketStep(node, isGoal) });
  }
  // Array.prototype.sort is a STABLE sort (guaranteed since ES2019) — an
  // approval pushed immediately before its own ticket above keeps that exact
  // order when their times are equal, which is what "right before its
  // ticket" requires at the tie.
  items.sort((a, b) => a.time - b.time);
  const stepHtml = items.map(i => i.html).join('');

  return (
    `<div class="sv-el sv-el-${el.status}" data-sv-id="${escapeHtml(el.id)}">` +
    `<div class="sv-el-row"><b>Case ${escapeHtml(d.caseId)} · ${typeof d.totalDurationSeconds === 'number' ? formatDuration(d.totalDurationSeconds) : 'time not verifiable'}</b>${badge(el.status, 'assembled by gateway')}</div>` +
    (el.status === 'warning' && el.reason ? `<div class="sv-el-warn">${escapeHtml(el.reason)}</div>` : '') +
    (typeof d.totalDurationSeconds !== 'number' ? `<div class="sv-el-warn">${escapeHtml(d.timeUnverifiableReason ?? 'Case time not verifiable.')}</div>` : '') +
    `<div class="sv-tl">${stepHtml}</div>` +
    `</div>`
  );
}

function renderMetric(el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const kind = String(d.kind ?? '');
  const label = METRIC_LABELS[kind] ?? kind;
  const display = formatMetricValue(kind, d.value);
  return (
    `<div class="sv-el sv-el-${el.status} sv-el-metric" data-sv-id="${escapeHtml(el.id)}">` +
    `<div class="sv-big">${escapeHtml(display)}</div>` +
    `<div class="sv-el-row"><span>${escapeHtml(label)} (${escapeHtml(d.caseCount ?? 0)} case${d.caseCount === 1 ? '' : 's'})</span>${badge(el.status, 'computed by gateway')}</div>` +
    (el.status === 'warning' && el.reason ? `<div class="sv-el-warn">${escapeHtml(el.reason)}</div>` : '') +
    `</div>`
  );
}

function renderElement(el: VerifiedElement): string {
  switch (el.kind) {
    case 'sv-ticket': return renderTicket(el);
    case 'sv-approval': return renderApproval(el);
    case 'sv-mandate': return renderMandate(el);
    case 'sv-record': return renderRecord(el);
    case 'sv-case': return renderCase(el);
    case 'sv-metric': return renderMetric(el);
    default: return unverifiableCard(el);
  }
}

/** CSS for the drawn elements — scoped under `sv-` class names so it cannot
 *  collide with the AI's own styling, and responsive per the brief's own
 *  requirement ("it must read well ... in a narrow side panel"): case
 *  timelines stack vertically under ~480px. Inserted once per document. */
export const DRAWN_ELEMENT_STYLES = `
.sv-el { border:1px solid #e5e5e5; border-radius:10px; padding:10px 12px; margin:10px 0; font:13px/1.5 system-ui, sans-serif; background:#fff; }
.sv-el-unverifiable { outline:2px solid #b91c1c; outline-offset:2px; }
.sv-el-verified, .sv-el-warning { outline:2px solid #15803d; outline-offset:2px; }
.sv-el-row { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; margin:2px 0; }
.sv-el-reason, .sv-el-warn { color:#b45309; font-size:12px; margin-top:4px; }
.sv-el-intent { color:#666; font-size:12px; margin-top:4px; }
.sv-badge { display:inline-flex; gap:4px; font-size:10.5px; font-weight:600; padding:1px 7px; border-radius:999px; white-space:nowrap; }
.sv-badge-ok { color:#15803d; background:#ecfdf3; }
.sv-badge-warn { color:#b45309; background:#fff7e6; }
.sv-badge-bad { color:#b91c1c; background:#fdecea; }
.sv-big { font-size:24px; font-weight:700; }
.sv-tl { display:flex; flex-wrap:wrap; gap:10px 16px; padding:6px 0; }
.sv-step { min-width:100px; border:1px solid #e5e5e5; border-radius:8px; padding:6px 8px; font-size:11.5px; text-decoration:none; color:inherit; flex-shrink:0; }
.sv-step-k { font-size:9.5px; text-transform:uppercase; color:#666; }
.sv-step-t { font-weight:600; font-size:12px; }
.sv-step-sub { color:#666; white-space:normal; }
/* The approval step's text ("asked ... approved ... by ... (duration)") is
 * longer than a ticket step's — without a width to wrap against, a
 * flex item with flex-shrink:0 takes its one-line content width instead of
 * wrapping, which reads as the text being cut off at the container's visible
 * edge (polish 2026-10-05, second pass). */
.sv-step-approval { max-width:240px; white-space:normal; }
.sv-step-start { max-width:240px; white-space:normal; }
@media (max-width: 480px) {
  .sv-tl { flex-direction:column; overflow-x:visible; }
  .sv-step { min-width:0; }
  .sv-step-approval { max-width:none; }
  .sv-step-start { max-width:none; }
  .sv-el-row { flex-direction:column; gap:2px; }
}
`;

/** The label every report carries for the AI's own free content (review
 *  SR5, 2026-10-06) — exported so the UI legend, the export header and the
 *  tests all use the same words. */
export const AI_ANALYSIS_LABEL = 'AI analysis — not verified';
export const AI_LEGEND_TEXT =
  'Boxes with a green ✓ are drawn and checked by the gateway, and each one is listed under “Checked values”. ' +
  'Everything else is the AI\'s own analysis and is not verified.';

/**
 * The gateway-drawn banner at the top of the report body. Styled INLINE with
 * `!important`: an inline important declaration wins over any author
 * stylesheet rule, so the AI's own `<style>` cannot hide or restyle it by
 * selector. (It could still cover it with an overlay of its own — which is
 * why the Reports page also draws the same legend OUTSIDE the frame, where
 * the AI's markup cannot reach at all.) The class is `sv-`-prefixed and the
 * sanitizer strips every `sv-*` class from the AI's own markup, so the AI
 * cannot draw a second, fake one with the same class.
 */
export function aiLegendBanner(): string {
  const box = 'display:block !important;visibility:visible !important;opacity:1 !important;position:relative !important;' +
    'transform:none !important;clip-path:none !important;filter:none !important;z-index:2147483647 !important;' +
    'margin:0 0 12px 0 !important;padding:8px 12px !important;border:1px solid #d4d4d8 !important;border-left:4px solid #a1a1aa !important;' +
    'border-radius:8px !important;background:#f4f4f5 !important;color:#3f3f46 !important;font:12.5px/1.45 system-ui, sans-serif !important;' +
    'text-align:left !important;max-width:none !important;width:auto !important;height:auto !important;';
  const strong = 'display:inline !important;visibility:visible !important;font-weight:700 !important;color:#18181b !important;font-size:inherit !important;';
  return `<div class="sv-ai-legend" role="note" style="${box}"><b style="${strong}">${escapeHtml(AI_ANALYSIS_LABEL)}.</b> ${escapeHtml(AI_LEGEND_TEXT)}</div>`;
}

/**
 * Replaces every `sv-*` element in `html` with gateway-drawn markup for the
 * matching `VerifiedElement` (matched by id — see `findElementSpans`'s doc
 * comment). Prepends `DRAWN_ELEMENT_STYLES` and the "AI analysis — not
 * verified" banner once. Elements present in `html` but missing from
 * `elements` (should not happen — both come from the same `verifyReport()`
 * call) render as a generic "not verifiable" card rather than throwing, so a
 * mismatch degrades visibly instead of crashing the page.
 *
 * The same output serves the live Reports page and the standalone export:
 * neither has any link out of the report except the public "Check on
 * suveren.ai" link (a new tab).
 */
export function renderReportHtml(rawHtml: string, elements: VerifiedElement[]): string {
  // `rawHtml` is normally already sanitized (VerifyReportResult.html). Run it
  // through the sanitizer again anyway (idempotent): a report stored by an
  // older gateway was sanitized before `sv-*` classes were stripped from AI
  // markup, and must not draw fake gateway boxes until its next re-check.
  const html = sanitizeReportHtml(rawHtml);
  const byId = new Map(elements.map(e => [e.id, e]));
  const spans = findElementSpans(html);

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += html.slice(cursor, span.start);
    const el = byId.get(span.id) ?? { id: span.id, kind: span.kind, attrs: {}, status: 'unverifiable' as const, reason: 'No verification result for this element.' };
    out += renderElement(el);
    cursor = span.end;
  }
  out += html.slice(cursor);

  const styleTag = `<style data-sv-drawn-styles="1">${DRAWN_ELEMENT_STYLES}</style>${aiLegendBanner()}`;
  if (/<body[^>]*>/i.test(out)) {
    return out.replace(/<body([^>]*)>/i, (m) => `${m}${styleTag}`);
  }
  return styleTag + out;
}
