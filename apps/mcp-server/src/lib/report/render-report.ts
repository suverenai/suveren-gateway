/**
 * Draws a report under the TWO-TAG RULE (work-plan "regular reporting",
 * decision 5, RR6). Input: the SANITIZED html (sanitize.ts — a flat list of
 * `sv-ai` blocks, verified elements, `sv-row`s and at most one
 * `sv-glossary`) plus the resolved `elements`. Output: static HTML in which
 *
 *   - every `sv-ai` block sits in a grey dashed frame labelled "AI analysis —
 *     not verified", CLIPPED to that frame (`contain: paint; overflow:
 *     hidden; position: relative; isolation: isolate`) so nothing the AI
 *     draws can overlay a label, a border or a verified box;
 *   - every verified element is a solid green box with the seal "✓ verified ·
 *     <signed|archive|database|computed>", containing ONLY signed field names
 *     and their values verbatim, in a monospace key/value layout. The only
 *     transformations: timestamps in one readable deterministic format
 *     (format.ts#formatTimestamp), and computed values shown raw with their
 *     field name and the formula over visible signed fields. No labels, no
 *     translations, no connecting words — the gateway's frame (border, seal,
 *     public-check link) is the only non-source text;
 *   - `sv-row` is a responsive row that stacks on a phone;
 *   - the AI's glossary appears ONLY as a gloss (`<ruby>`, translation above
 *     the raw value, which always stays visible) on field names and fixed
 *     words that are actually in the rendered boxes — never on numbers,
 *     timestamps or ids, which have no gloss call site at all — and only when
 *     the reader switches translation on.
 *
 * The human-readable wording (formatActionLabel, "Quote created", …) lives on
 * only in the gateway UI around the report (side panel "Checked values",
 * detail panel) — never inside a verified box.
 *
 * Security: the output goes into a sandboxed, script-free, CSP-locked iframe
 * (live page) or a CSP-locked file (export). Every value drawn here comes from
 * local files, so every value is HTML-escaped.
 */
import { parseDocument } from 'htmlparser2';
import type { VerifiedElement } from './types';
import { formatTimestamp } from './format';
import { sanitizeReport, STRUCTURE_TAGS } from './sanitize';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Gloss (AI translation) ─────────────────────────────────────────────────

/** off: no gloss markup at all (default). on: glosses shown. toggle: gloss
 *  markup present but hidden until a CSS-only switch is checked (export). */
export type GlossMode = 'off' | 'on' | 'toggle';

export interface RenderOptions {
  gloss?: GlossMode;
}

interface Ctx {
  mode: GlossMode;
  terms: Map<string, string>;
  /** Glossary keys actually drawn as a gloss somewhere. */
  used: Set<string>;
}

/** A fixed word may carry a gloss; a number, a timestamp, an id never does.
 *  Field names always qualify (they are the schema's words). */
export function isGlossableWord(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 120) return false;
  if (!/[A-Za-z]/.test(v)) return false; // numbers, amounts, plain dates
  if (/\d{4,}/.test(v)) return false; // timestamps, long ids
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) return false; // uuid
  if (/^(rcpt|authz|tkt|msg|q|o)[_-]/i.test(v)) return false; // id prefixes
  if (/@.+\./.test(v) && !/@\d/.test(v)) return false; // email addresses
  return true;
}

function glossed(ctx: Ctx, raw: string, cls: string): string {
  const base = `<span class="${cls}">${escapeHtml(raw)}</span>`;
  if (ctx.mode === 'off') return base;
  const gloss = ctx.terms.get(raw);
  if (gloss === undefined) return base;
  ctx.used.add(raw);
  return `<ruby class="sv-gloss">${base}<rt>${escapeHtml(gloss)}</rt></ruby>`;
}

/** A signed field name (glossable). */
function key(ctx: Ctx, name: string): string {
  return glossed(ctx, name, 'sv-k');
}

/** A fixed string value — glossable only if it is a word. */
function word(ctx: Ctx, value: unknown): string {
  const s = String(value ?? '');
  if (!isGlossableWord(s)) return val(value);
  return glossed(ctx, s, 'sv-v');
}

/** Any other value — numbers, timestamps, ids, names, free text: never glossed. */
function val(value: unknown): string {
  return `<span class="sv-v">${escapeHtml(value)}</span>`;
}

function ts(value: unknown): string {
  return val(formatTimestamp(value));
}

function kv(k: string, v: string, extra = ''): string {
  return `<div class="sv-kv${extra}">${k}${v}</div>`;
}

function scalar(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Raw computed number: integers as is, fractions to at most 4 decimals. */
function rawNumber(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10000) / 10000);
}

function formula(text: string): string {
  return `<span class="sv-f">= ${escapeHtml(text)}</span>`;
}

const TIME_KEY_RE = /(^|_|\.)(at|timestamp)$|At$|_at$/;

// ─── Seal + card frame ──────────────────────────────────────────────────────

export type SealSource = 'signed' | 'archive' | 'database' | 'computed';

const SOURCE_BY_KIND: Record<string, SealSource> = {
  'sv-ticket': 'signed',
  'sv-mandate': 'signed',
  'sv-approval': 'archive',
  'sv-record': 'database',
  'sv-case': 'computed',
  'sv-metric': 'computed',
};

function seal(status: VerifiedElement['status'], source: SealSource): string {
  if (status === 'verified') {
    return `<span class="sv-badge sv-badge-ok sv-seal" data-sv-source="${source}">✓ verified · ${source}</span>`;
  }
  if (status === 'warning') {
    return `<span class="sv-badge sv-badge-warn sv-seal" data-sv-source="${source}">⚠ verified · ${source} · with a note</span>`;
  }
  return `<span class="sv-badge sv-badge-bad">✗ not verifiable</span>`;
}

function card(el: VerifiedElement, body: string, opts: { compact?: boolean; head?: string } = {}): string {
  const source = SOURCE_BY_KIND[el.kind] ?? 'computed';
  const note = el.status === 'warning' && el.reason ? `<div class="sv-note">${escapeHtml(el.reason)}</div>` : '';
  if (opts.compact) {
    return (
      `<div class="sv-el sv-el-${el.status} sv-compact" data-sv-id="${escapeHtml(el.id)}">` +
      `<div class="sv-vline"><div class="sv-kv-row">${body}</div>${seal(el.status, source)}</div>${note}</div>`
    );
  }
  return (
    `<div class="sv-el sv-el-${el.status}" data-sv-id="${escapeHtml(el.id)}">` +
    `<div class="sv-vhead">${opts.head ?? '<span></span>'}${seal(el.status, source)}</div>` +
    note + body + `</div>`
  );
}

function unverifiableCard(el: VerifiedElement): string {
  return (
    `<div class="sv-el sv-el-unverifiable" data-sv-id="${escapeHtml(el.id)}">` +
    `<div class="sv-vhead"><span class="sv-k">${escapeHtml(el.kind)}</span>${seal('unverifiable', 'computed')}</div>` +
    `<div class="sv-reason">${escapeHtml(el.reason ?? 'This reference could not be checked.')}</div>` +
    `</div>`
  );
}

// ─── Elements ───────────────────────────────────────────────────────────────

type Data = Record<string, unknown>;

function checkLink(href: unknown): string {
  return typeof href === 'string' && href
    ? `<div class="sv-link"><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Check on suveren.ai ↗</a></div>`
    : '';
}

function contextRows(ctx: Ctx, entries: Data, indent = false): string {
  return Object.entries(entries)
    .map(([k, v]) => {
      const s = scalar(v);
      if (s === undefined) return '';
      return kv(key(ctx, k), typeof v === 'string' ? word(ctx, v) : val(s), indent ? ' sv-in' : '');
    })
    .join('');
}

function mandateRows(ctx: Ctx, m: Data, indent: boolean): string {
  const rows: string[] = [];
  const rawLimits = (m.rawLimits ?? {}) as Data;
  rows.push(contextRows(ctx, rawLimits, indent));
  if (typeof m.mode === 'string') rows.push(kv(key(ctx, 'commitment_mode'), word(ctx, m.mode), indent ? ' sv-in' : ''));
  for (const o of Array.isArray(m.owners) ? (m.owners as unknown[]) : []) {
    rows.push(kv(key(ctx, 'owner'), val(o), indent ? ' sv-in' : ''));
  }
  return rows.join('');
}

function approvalRows(ctx: Ctx, a: Data, prefix: string, indent: boolean): string {
  const cls = indent ? ' sv-in' : '';
  const rows: string[] = [];
  if (a.createdAt !== undefined) rows.push(kv(key(ctx, `${prefix}createdAt`), ts(a.createdAt), cls));
  if (a.decidedAt !== undefined) rows.push(kv(key(ctx, `${prefix}decidedAt`), ts(a.decidedAt), cls));
  if (typeof a.whoLabel === 'string') rows.push(kv(key(ctx, `${prefix}committedBy`), val(a.whoLabel), cls));
  return rows.join('');
}

function group(ctx: Ctx, name: string, rows: string): string {
  if (!rows) return '';
  return `<div class="sv-group"><div class="sv-group-label">${key(ctx, name)}</div>${rows}</div>`;
}

function renderTicket(ctx: Ctx, el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const variant = (el.attrs.variant ?? '').trim().toLowerCase();
  if (variant !== 'full') {
    return card(el, kv(key(ctx, 'action'), word(ctx, d.action)) + kv(key(ctx, 'timestamp'), ts(d.time)), { compact: true });
  }
  const body =
    kv(key(ctx, 'action'), word(ctx, d.action)) +
    (d.actionType !== undefined ? kv(key(ctx, 'actionType'), word(ctx, d.actionType)) : '') +
    kv(key(ctx, 'profileId'), word(ctx, d.profile)) +
    contextRows(ctx, (d.executionContext ?? {}) as Data) +
    (d.mandate ? group(ctx, 'mandate', mandateRows(ctx, d.mandate as Data, true)) : '') +
    (d.approval ? group(ctx, 'approval', approvalRows(ctx, d.approval as Data, '', true)) : '') +
    kv(key(ctx, 'timestamp'), ts(d.time)) +
    kv(key(ctx, 'ticket'), val(d.ticketId)) +
    checkLink(d.checkUrl);
  return card(el, body);
}

function renderApproval(ctx: Ctx, el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const wait = typeof d.waitSeconds === 'number'
    ? kv(key(ctx, 'wait_s'), val(rawNumber(d.waitSeconds)) + formula('decidedAt − createdAt'))
    : '';
  const status = typeof d.status === 'string' ? kv(key(ctx, 'status'), word(ctx, d.status)) : '';
  return card(el, approvalRows(ctx, d, '', false) + status + wait);
}

function renderMandate(ctx: Ctx, el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const body =
    kv(key(ctx, 'profileId'), word(ctx, d.profile)) +
    mandateRows(ctx, d, false) +
    (typeof d.intent === 'string' && d.intent ? kv(key(ctx, 'intent'), `<span class="sv-v sv-text">${escapeHtml(d.intent)}</span>`, ' sv-block') : '');
  return card(el, body);
}

/** Keys the record resolver adds around the connector's own row — not
 *  source fields, never drawn. Long free text (`body`) is left out. */
const RECORD_SKIP = new Set(['kind', 'folder', 'causingReceiptId', 'body', 'lines', 'cc_json']);
/** Fixed-vocabulary record fields whose values are words. */
const RECORD_WORD_FIELDS = new Set(['status', 'tool', 'currency']);

function renderRecord(ctx: Ctx, el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const rows = Object.entries(d)
    .filter(([k]) => !RECORD_SKIP.has(k))
    .map(([k, v]) => {
      const s = scalar(v);
      if (s === undefined) return '';
      if (TIME_KEY_RE.test(k)) return kv(key(ctx, k), ts(v));
      if (RECORD_WORD_FIELDS.has(k)) return kv(key(ctx, k), word(ctx, s));
      return kv(key(ctx, k), val(s));
    })
    .join('');
  return card(el, rows);
}

interface CaseStepLike { ticketId: string; time: number; action?: unknown }
interface CaseApprovalLike { ticketId: string; whoLabel?: string; createdAt?: number; decidedAt?: number }
interface CaseStartLike {
  time: number; emailTime?: number; basis?: string;
  subject?: string; sender?: string; receivedAt?: string; loadedAt?: string;
}

function step(tag: string, rows: string, cls = ''): string {
  return `<div class="sv-step${cls}"><span class="sv-step-tag">${escapeHtml(tag)}</span>${rows}</div>`;
}

function stepKv(k: string, v: string): string {
  return `<div class="sv-kv sv-kv-col">${k}${v}</div>`;
}

function renderCase(ctx: Ctx, el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const steps: CaseStepLike[] = Array.isArray(d.steps) ? (d.steps as CaseStepLike[]) : [];
  const goal = d.goal as CaseStepLike | undefined;
  const approvalsByTicket = new Map<string, CaseApprovalLike>();
  for (const a of Array.isArray(d.approvals) ? (d.approvals as CaseApprovalLike[]) : []) approvalsByTicket.set(a.ticketId, a);
  const start = d.start as CaseStartLike | undefined;

  const items: Array<{ time: number; html: string }> = [];
  if (start) {
    const rows =
      stepKv(key(ctx, 'received_at'), ts(start.receivedAt ?? start.emailTime)) +
      (start.subject !== undefined ? stepKv(key(ctx, 'subject'), val(start.subject)) : '') +
      (start.sender !== undefined ? stepKv(key(ctx, 'from_email'), val(start.sender)) : '') +
      (start.basis === 'loaded' && start.loadedAt !== undefined
        ? stepKv(key(ctx, 'simulation_load.loaded_at'), ts(start.loadedAt))
        : '');
    items.push({ time: start.time, html: step('database', rows) });
  }
  const ticketNodes: Array<{ node: CaseStepLike; isGoal: boolean }> = [
    ...steps.map(s => ({ node: s, isGoal: false })),
    ...(goal ? [{ node: goal, isGoal: true }] : []),
  ];
  for (const { node, isGoal } of ticketNodes) {
    const approval = approvalsByTicket.get(node.ticketId);
    if (approval) {
      // An approval precedes the action it approved: clamped to at most the
      // ticket's own time, then kept right before it by the stable sort.
      const t = Math.min(approval.decidedAt ?? approval.createdAt ?? node.time, node.time);
      const rows =
        (approval.createdAt !== undefined ? stepKv(key(ctx, 'approval.createdAt'), ts(approval.createdAt)) : '') +
        (approval.decidedAt !== undefined ? stepKv(key(ctx, 'approval.decidedAt'), ts(approval.decidedAt)) : '') +
        (approval.whoLabel !== undefined ? stepKv(key(ctx, 'approval.committedBy'), val(approval.whoLabel)) : '');
      items.push({ time: t, html: step('archive', rows) });
    }
    const rows = stepKv(key(ctx, 'action'), word(ctx, node.action)) + stepKv(key(ctx, 'timestamp'), ts(node.time));
    items.push({ time: node.time, html: step(isGoal ? 'signed · goal' : 'signed', rows, isGoal ? ' sv-step-goal' : '') });
  }
  items.sort((a, b) => a.time - b.time);

  const duration = typeof d.totalDurationSeconds === 'number'
    ? kv(key(ctx, 'duration_s'), val(rawNumber(d.totalDurationSeconds)) + formula('goal.timestamp − max(start.received_at, simulation_load.loaded_at)'))
    : `<div class="sv-note">${escapeHtml(String(d.timeUnverifiableReason ?? 'duration_s not verifiable'))}</div>`;
  const head = kv(key(ctx, 'case_id'), val(d.caseId));
  return card(el, duration + `<div class="sv-tl">${items.map(i => i.html).join('')}</div>`, { head });
}

/** Field name + formula per metric kind — the formula names only signed or
 *  verified fields visible in the case boxes. */
export const METRIC_FIELDS: Record<string, { name: string; formula: string }> = {
  completed: { name: 'cases_completed', formula: 'count(case.goal verified)' },
  'median-time': { name: 'median_duration_s', formula: 'median(case.duration_s)' },
  'average-time': { name: 'average_duration_s', formula: 'mean(case.duration_s)' },
  'without-approval': { name: 'without_approval_ratio', formula: 'count(case.approvals = 0) / count(case)' },
  approvals: { name: 'approvals', formula: 'count(case.approval)' },
  'median-approval-wait': { name: 'median_approval_wait_s', formula: 'median(approval.decidedAt − approval.createdAt)' },
  tickets: { name: 'tickets', formula: 'count(distinct case.goal, case.steps)' },
  refusals: { name: 'refusals', formula: 'count(refusal.at in [case.start, case.goal])' },
};

function renderMetric(ctx: Ctx, el: VerifiedElement): string {
  if (el.status === 'unverifiable' || !el.data) return unverifiableCard(el);
  const d = el.data;
  const kind = String(d.kind ?? '');
  const f = METRIC_FIELDS[kind] ?? { name: kind, formula: '' };
  const caseIds = Array.isArray(d.caseIds) ? (d.caseIds as unknown[]).map(String) : [];
  const body =
    `<div class="sv-kv sv-metric">${key(ctx, f.name)}${val(rawNumber(d.value))}${f.formula ? formula(f.formula) : ''}</div>` +
    (caseIds.length > 0 ? kv(key(ctx, 'cases'), val(caseIds.join(' '))) : '');
  return card(el, body);
}

function renderElement(ctx: Ctx, el: VerifiedElement): string {
  switch (el.kind) {
    case 'sv-ticket': return renderTicket(ctx, el);
    case 'sv-approval': return renderApproval(ctx, el);
    case 'sv-mandate': return renderMandate(ctx, el);
    case 'sv-record': return renderRecord(ctx, el);
    case 'sv-case': return renderCase(ctx, el);
    case 'sv-metric': return renderMetric(ctx, el);
    default: return unverifiableCard(el);
  }
}

// ─── Styles, labels, legend ─────────────────────────────────────────────────

/** The frame label on every AI block, and the words the UI/export reuse. */
export const AI_ANALYSIS_LABEL = 'AI analysis — not verified';
export const VERIFIED_LEGEND_TEXT = 'Green = verified by the gateway — raw signed fields only';
export const AI_LEGEND_TEXT = 'Grey dashed = the AI\'s own analysis, not verified';
export const GLOSS_LEGEND_TEXT = '= translation by the AI, not verified';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** CSS for everything the gateway draws. Light theme only (the frame and the
 *  export are white). No AI stylesheet exists (sanitize.ts: inline styles
 *  only), so nothing the AI writes can select these classes. */
export const DRAWN_ELEMENT_STYLES = `
.sv-report { font:14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color:#111; max-width:900px; }
.sv-legend { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:center; font-size:12px; color:#555; border-bottom:1px solid #e5e5e5; padding:0 0 8px; margin:0 0 10px; }
.sv-legend-chip { display:inline-flex; align-items:center; gap:6px; }
.sv-sw { width:11px; height:11px; border-radius:3px; display:inline-block; flex:none; }
.sv-sw-v { background:#ecfdf3; border:2px solid #15803d; }
.sv-sw-a { border:2px dashed #9a9a9a; }
.sv-gloss-swatch { font-style:italic; color:#666; border-bottom:1px dotted #666; }
.sv-el { border:2px solid #15803d; border-radius:10px; background:#fff; padding:12px 14px; margin:12px 0; min-width:0; }
.sv-el.sv-compact { padding:8px 12px; }
.sv-el-warning { border-color:#b45309; }
.sv-el-unverifiable { border:2px solid #b91c1c; background:#fff; }
.sv-vhead { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:4px; }
.sv-vline { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
.sv-kv-row { display:flex; gap:4px 16px; flex-wrap:wrap; }
.sv-kv { font-family:${MONO}; font-size:12.5px; display:flex; gap:7px; flex-wrap:wrap; align-items:flex-end; margin:3px 0; line-height:1.5; min-width:0; }
.sv-kv.sv-in { padding-left:14px; }
.sv-kv.sv-block { flex-direction:column; align-items:flex-start; gap:0; }
.sv-k { color:#666; }
.sv-v { color:#111; font-weight:600; word-break:break-word; overflow-wrap:anywhere; }
.sv-text { font-weight:400; white-space:pre-wrap; }
.sv-f { color:#444; font-weight:400; }
.sv-metric { font-size:13px; }
.sv-group { margin:6px 0 2px; }
.sv-group-label { font-family:${MONO}; font-size:11px; color:#666; }
.sv-badge { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; font:600 10.5px/1.6 system-ui, sans-serif; border-radius:999px; padding:1px 8px; }
.sv-badge-ok { color:#15803d; background:#ecfdf3; }
.sv-badge-warn { color:#b45309; background:#fff7e6; }
.sv-badge-bad { color:#b91c1c; background:#fdecea; }
.sv-note, .sv-reason { color:#b45309; font-size:12px; margin:2px 0 4px; }
.sv-reason { color:#b91c1c; }
.sv-link { margin-top:4px; }
.sv-link a { color:#1d4ed8; text-decoration:none; font-size:12px; }
.sv-row { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:10px; margin:12px 0; }
.sv-row > .sv-el { margin:0; }
.sv-tl { display:flex; gap:16px; overflow-x:auto; padding:10px 2px 4px; margin-top:6px; }
.sv-step { width:180px; min-width:180px; flex:none; border:1px solid #e5e5e5; border-radius:8px; padding:9px 9px 7px; position:relative; background:#fafafa; }
.sv-step-goal { border-color:#15803d; }
.sv-step .sv-kv-col { flex-direction:column; gap:0; align-items:flex-start; margin:1px 0; font-size:11px; }
.sv-step .sv-kv-col .sv-k { font-size:9.5px; }
.sv-step:not(:last-child)::after { content:"\\2192"; position:absolute; right:-14px; top:38%; color:#888; font-size:12px; }
.sv-step-tag { position:absolute; top:-8px; right:8px; background:#fff; border:1px solid #e5e5e5; color:#666; font:9px/1.5 system-ui, sans-serif; padding:0 6px; border-radius:999px; }
.sv-ai-wrap { margin:14px 0 12px; }
.sv-ai-label { display:inline-flex; align-items:center; background:#eee; color:#555; font:600 10.5px/1.6 system-ui, sans-serif; padding:1px 8px; border-radius:999px; margin:0 0 6px 10px; }
.sv-ai-block { position:relative; isolation:isolate; contain:paint; overflow:hidden; border:2px dashed #9a9a9a; border-radius:10px; background:#fafafa; padding:14px; }
.sv-ai-content { font-size:13.5px; overflow-wrap:anywhere; }
.sv-ai-content img, .sv-ai-content svg { max-width:100%; height:auto; }
ruby.sv-gloss { ruby-position:over; }
ruby.sv-gloss rt { font:italic 400 14.5px/1.4 system-ui, sans-serif; color:#666; border-bottom:1px dotted #666; }
.sv-gloss-toggle-mode ruby.sv-gloss rt { display:none; }
@media (max-width: 480px) {
  .sv-tl { flex-direction:column; overflow:visible; }
  .sv-step { width:auto; min-width:0; margin-bottom:6px; }
  .sv-step:not(:last-child)::after { content:"\\2193"; right:auto; left:10px; top:auto; bottom:-17px; }
}
`;

/** CSS that switches glosses ON — inlined when the mode is 'on', and keyed to
 *  the export's CSS-only checkbox in 'toggle' mode (export-report.ts). */
export const GLOSS_ON_STYLES = `
ruby.sv-gloss { font-size:11.5px; }
`;

function legend(showGloss: boolean): string {
  return (
    `<div class="sv-legend" role="note">` +
    `<span class="sv-legend-chip"><span class="sv-sw sv-sw-v"></span>${escapeHtml(VERIFIED_LEGEND_TEXT)}</span>` +
    `<span class="sv-legend-chip"><span class="sv-sw sv-sw-a"></span>${escapeHtml(AI_LEGEND_TEXT)}</span>` +
    (showGloss ? `<span class="sv-legend-chip"><span class="sv-gloss-swatch">Abc</span>&nbsp;${escapeHtml(GLOSS_LEGEND_TEXT)}</span>` : '') +
    `</div>`
  );
}

// ─── Document walk ──────────────────────────────────────────────────────────

interface DomNode {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
  startIndex: number | null;
  endIndex: number | null;
}

interface Walk {
  html: string;
  nodes: DomNode[];
}

function walkTopLevel(sanitized: string): Walk {
  const doc = parseDocument(sanitized, {
    withStartIndices: true, withEndIndices: true, recognizeSelfClosing: true, decodeEntities: true,
  }) as unknown as DomNode;
  return { html: sanitized, nodes: (doc.children ?? []).filter(n => n.type === 'tag') };
}

function readGlossary(walk: Walk): { lang: string; terms: Map<string, string> } | undefined {
  const g = walk.nodes.find(n => n.name === 'sv-glossary');
  if (!g) return undefined;
  const terms = new Map<string, string>();
  for (const t of g.children ?? []) {
    if (t.type !== 'tag' || t.name !== 'sv-term') continue;
    const k = t.attribs?.key ?? '';
    const text = (t.children ?? []).map(c => (c as { data?: string }).data ?? '').join('');
    if (k && !terms.has(k)) terms.set(k, text);
  }
  return { lang: g.attribs?.lang ?? '', terms };
}

function innerOf(walk: Walk, node: DomNode): string {
  const children = node.children ?? [];
  if (children.length === 0) return '';
  const start = children[0].startIndex;
  const end = children[children.length - 1].endIndex;
  return start !== null && end !== null ? walk.html.slice(start, end + 1) : '';
}

function drawBody(walk: Walk, elements: VerifiedElement[], ctx: Ctx): string {
  const byId = new Map(elements.map(e => [e.id, e]));
  const seen = new Map<string, number>();
  const nextEl = (node: DomNode): string => {
    const kind = node.name ?? '';
    const n = seen.get(kind) ?? 0;
    seen.set(kind, n + 1);
    const id = `${kind}-${n}`;
    const el = byId.get(id) ?? { id, kind, attrs: node.attribs ?? {}, status: 'unverifiable' as const, reason: 'No verification result for this element.' };
    return renderElement(ctx, el);
  };

  const parts: string[] = [];
  for (const node of walk.nodes) {
    const name = node.name ?? '';
    if (name === 'sv-ai') {
      parts.push(
        `<div class="sv-ai-wrap"><span class="sv-ai-label">${escapeHtml(AI_ANALYSIS_LABEL)}</span>` +
        `<div class="sv-ai-block"><div class="sv-ai-content">${innerOf(walk, node)}</div></div></div>`,
      );
    } else if (name === 'sv-row') {
      const cells = (node.children ?? []).filter(c => c.type === 'tag' && (c.name ?? '').startsWith('sv-') && !STRUCTURE_TAGS.has(c.name ?? ''));
      parts.push(`<div class="sv-row">${cells.map(nextEl).join('')}</div>`);
    } else if (name === 'sv-glossary') {
      continue;
    } else if (name.startsWith('sv-')) {
      parts.push(nextEl(node));
    }
  }
  return parts.join('\n');
}

export interface GlossaryUsage {
  lang: string;
  /** Keys drawn as a gloss in at least one verified box. */
  applied: string[];
  /** Keys the gateway refused, with the reason (sanitizer refusals included). */
  rejected: Array<{ key: string; reason: string }>;
}

const NOT_IN_BOXES =
  'not a field name or fixed word in your verified boxes (numbers, timestamps and ids are never translated)';

/**
 * Which glossary entries the gateway will show, and which it refused — for
 * write_report's answer to the AI and for the UI's switch (only shown when a
 * gloss exists). `undefined` when the report has no glossary.
 */
export function glossaryUsage(rawHtml: string, elements: VerifiedElement[]): GlossaryUsage | undefined {
  const sanitized = sanitizeReport(rawHtml);
  const walk = walkTopLevel(sanitized.html);
  const g = readGlossary(walk);
  if (!g && sanitized.notes.rejectedTerms.length === 0) return undefined;
  const ctx: Ctx = { mode: 'on', terms: g?.terms ?? new Map(), used: new Set() };
  drawBody(walk, elements, ctx);
  const rejected = [...sanitized.notes.rejectedTerms];
  for (const k of ctx.terms.keys()) if (!ctx.used.has(k)) rejected.push({ key: k, reason: NOT_IN_BOXES });
  return { lang: g?.lang ?? '', applied: [...ctx.used], rejected };
}

/**
 * Draws the report. `rawHtml` is normally already sanitized
 * (VerifyReportResult.html); it is sanitized again here anyway (idempotent),
 * so a report stored by an older gateway is held to the current rule too.
 * Elements present in the html but missing from `elements` render as "not
 * verifiable" rather than throwing.
 */
export function renderReportHtml(rawHtml: string, elements: VerifiedElement[], opts: RenderOptions = {}): string {
  const mode: GlossMode = opts.gloss ?? 'off';
  const walk = walkTopLevel(sanitizeReport(rawHtml).html);
  const g = readGlossary(walk);
  const ctx: Ctx = { mode, terms: g?.terms ?? new Map(), used: new Set() };
  const body = drawBody(walk, elements, ctx);
  const showGloss = mode !== 'off' && ctx.used.size > 0;
  const styles = `<style data-sv-drawn-styles="1">${DRAWN_ELEMENT_STYLES}${mode === 'on' ? GLOSS_ON_STYLES : ''}</style>`;
  const langAttr = showGloss && g?.lang ? ` data-sv-gloss-lang="${escapeHtml(g.lang)}"` : '';
  const cls = mode === 'toggle' ? 'sv-report sv-gloss-toggle-mode' : 'sv-report';
  return `${styles}<div class="${cls}"${langAttr}>${legend(showGloss)}${body}</div>`;
}
