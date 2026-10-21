/**
 * D1 — manifest-declared checks on a tool's approval card (ERP local-
 * production contract §7.2). Evaluated by the gateway over the call's bound
 * arguments plus the preview reads IT ran (preview.ts) — a check result is
 * system-derived, never something the AI supplies. Generic: no connector,
 * profile or vendor name here; everything comes from the manifest.
 *
 * The one security rule: a path that goes through a read's `attach` name is
 * resolved ONLY from that read's answer. Which names are attach names comes
 * from the manifest's DECLARATION, not from what ran — so an absent or failed
 * read reads as "missing", never falls back to an argument of the same name
 * (an AI could otherwise send `uid: {vies: {status: "valid"}}`).
 */
import {
  MAX_FOREACH_ELEMENTS,
  type CheckDeclaration,
  type CheckResult,
  type CheckStatus,
  type CheckValue,
  type PreviewDeclaration,
  type PreviewReadConfig,
} from './tool-gating-types';
import { isPresentForWhen, valueAtPath, structuredOrJsonText, type PreviewReadOutcome, type PreviewReadSection } from './preview';

export type { CheckDeclaration, CheckResult, CheckStatus };

/** A resolved value, or why there is none. */
type Resolved = { ok: true; value: unknown } | { ok: false; why: 'absent' | 'no_answer' };
const ABSENT: Resolved = { ok: false, why: 'absent' };
const NO_ANSWER: Resolved = { ok: false, why: 'no_answer' };

export interface CheckContext {
  args: Record<string, unknown>;
  /** The tool's preview declaration (attach names come from here). */
  declaration?: PreviewDeclaration;
  /** The reads that ran, in declared order (buildInternalPreview's `reads`). */
  sections?: PreviewReadSection[];
  /** For `{…|money}` in `detail` — a bound arg or `<attach>.<field>` path. */
  currencyField?: string;
}

interface Scope {
  ctx: CheckContext;
  reads: PreviewReadConfig[];
  /** forEach element: the arg name, its element, and its index among plain-object elements. */
  element?: { forEach: string; value: Record<string, unknown>; readIndex: number; position: number };
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fromOutcome(outcome: PreviewReadOutcome | undefined, rest: string[]): Resolved {
  if (!outcome || outcome.status !== 'ok') return outcome?.status === 'none' ? ABSENT : NO_ANSWER;
  const body = structuredOrJsonText(outcome.body);
  if (!body) return NO_ANSWER;
  const v = digNullAware(body, rest);
  return v === undefined ? ABSENT : { ok: true, value: v };
}

/**
 * Like valueAtPath, but an explicit `null` on the way is the answer `null`
 * (the connector said "none", e.g. `vies: null` = never checked) — distinct
 * from a field the answer does not have at all (undefined).
 */
function digNullAware(source: unknown, segs: string[]): unknown {
  let cur: unknown = source;
  for (const part of segs) {
    if (cur === null) return null;
    if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Resolve a check path (grammar in tool-gating-types.ts `CheckDeclaration`). */
export function resolveCheckPath(path: string, scope: Scope): Resolved {
  const { ctx, reads, element } = scope;
  const sections = ctx.sections ?? [];
  const bracket = path.indexOf('[]');
  if (bracket >= 0) {
    const arrayName = path.slice(0, bracket);
    const segs = path.slice(bracket + 3).split('.').filter(Boolean);
    if (!element || element.forEach !== arrayName || segs.length === 0) return ABSENT;
    const readIdx = reads.findIndex((r) => r.forEach === arrayName && r.attach === segs[0]);
    if (readIdx >= 0) {
      return fromOutcome(sections[readIdx]?.elements?.[element.readIndex], segs.slice(1));
    }
    const v = valueAtPath(element.value, segs.join('.'));
    return v === undefined ? ABSENT : { ok: true, value: v };
  }
  const segs = path.split('.');
  if (segs.length > 1) {
    const readIdx = reads.findIndex((r) => !r.forEach && r.attach === segs[0]);
    if (readIdx >= 0) return fromOutcome(sections[readIdx]?.result, segs.slice(1));
  }
  const v = valueAtPath(ctx.args, path);
  return v === undefined ? ABSENT : { ok: true, value: v };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

function inList(list: CheckValue[] | undefined, v: unknown): boolean {
  return Array.isArray(list) && list.some((x) => sameValue(x, v));
}

function show(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Status for one value against a declaration; `reason` when the gateway decided not_checked. */
function statusFor(decl: CheckDeclaration, value: unknown, scope: Scope): { status: CheckStatus; reason?: string } | Resolved {
  if (decl.compare) {
    let to: unknown = decl.compare.to;
    if (typeof decl.compare.to === 'string') {
      const r = resolveCheckPath(decl.compare.to, scope);
      if (!r.ok) return r;
      to = r.value;
    }
    if (value === null || to === null) return ABSENT;
    let result: boolean;
    switch (decl.compare.op) {
      case 'eq': result = sameValue(value, to); break;
      case 'ne': result = !sameValue(value, to); break;
      case 'gt':
      case 'lt':
        if (typeof value !== 'number' || typeof to !== 'number') {
          return { status: 'not_checked', reason: `unexpected value ${show(value)}` };
        }
        result = decl.compare.op === 'gt' ? value > to : value < to;
        break;
    }
    return { status: result ? (decl.onTrue ?? 'pass') : (decl.onFalse ?? 'fail') };
  }
  if (inList(decl.fail, value)) return { status: 'fail' };
  if (inList(decl.pass, value)) return { status: 'pass' };
  if (inList(decl.notChecked, value)) return { status: 'not_checked' };
  if (inList(decl.notice, value)) return { status: 'notice' };
  // Fail-visible: a value no list names is never silently a pass.
  return { status: 'not_checked', reason: `unexpected value ${show(value)}` };
}

function evaluateOne(decl: CheckDeclaration, scope: Scope): CheckResult | null {
  if (typeof decl.when === 'string') {
    const w = resolveCheckPath(decl.when, scope);
    if (!w.ok || !isPresentForWhen(w.value)) return null;
  } else if (decl.when !== undefined) {
    const w = resolveCheckPath(decl.when.path, scope);
    if (!w.ok || !inList(decl.when.in, w.value)) return null;
  }
  const base: CheckResult = {
    key: decl.key,
    label: decl.label,
    status: 'not_checked',
    ...(decl.blocking ? { blocking: true as const } : {}),
    ...(scope.element ? { index: scope.element.position } : {}),
  };
  const missing = (why: 'absent' | 'no_answer'): CheckResult | null => {
    if ((decl.missing ?? 'skip') === 'skip') return null;
    return { ...base, status: 'not_checked', reason: why === 'no_answer' ? 'no answer from the connector' : 'no value to check' };
  };
  const v = resolveCheckPath(decl.path, scope);
  if (!v.ok) return missing(v.why);
  const outcome = statusFor(decl, v.value, scope);
  if ('ok' in outcome) return outcome.ok ? null : missing(outcome.why);
  const detail = decl.detail !== undefined ? renderCheckDetail(decl.detail, scope) : null;
  const tested = v.value;
  const plain = tested === null || ['string', 'number', 'boolean'].includes(typeof tested);
  return {
    ...base,
    ...(plain ? { value: tested as CheckValue } : {}),
    status: outcome.status,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Every declared check's line(s), in declared order (a `forEach` check: one
 * line per element, in element order). A check whose `when` is absent, or
 * whose value is missing with `missing: "skip"`, yields no line.
 */
export function evaluateChecks(checks: CheckDeclaration[] | undefined, ctx: CheckContext): CheckResult[] {
  if (!checks || checks.length === 0) return [];
  const reads: PreviewReadConfig[] = ctx.declaration === undefined ? [] : Array.isArray(ctx.declaration) ? ctx.declaration : [];
  const out: CheckResult[] = [];
  for (const decl of checks) {
    if (!decl.forEach) {
      const r = evaluateOne(decl, { ctx, reads });
      if (r) out.push(r);
      continue;
    }
    const source = ctx.args[decl.forEach];
    const list = Array.isArray(source) ? source.slice(0, MAX_FOREACH_ELEMENTS) : [];
    // readIndex mirrors planPreviewReads: outcomes exist for plain-object elements only.
    let readIndex = 0;
    list.forEach((el, i) => {
      if (!isPlainRecord(el)) return;
      const r = evaluateOne(decl, { ctx, reads, element: { forEach: decl.forEach!, value: el, readIndex, position: i + 1 } });
      readIndex += 1;
      if (r) out.push(r);
    });
  }
  return out;
}

// ─── `detail` rendering — the summary grammar, plus `[]` paths and `{#}` ───

const PLACEHOLDER = /\{([^{}]+)\}/g;

function formatValue(v: unknown, fmt: string | undefined, currency: string | undefined): string {
  if (fmt === 'money') {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return show(v);
    return currency ? `${n.toFixed(2)} ${currency}` : n.toFixed(2);
  }
  if (fmt === 'percent') return `${show(v)}%`;
  if (fmt === 'date') {
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? show(v) : d.toISOString().slice(0, 10);
  }
  if (fmt === 'list' && Array.isArray(v)) return v.map(show).join(', ');
  const s = show(v);
  if (fmt === 'short' && s.length > 60) return `${s.slice(0, 59).trimEnd()}…`;
  return s;
}

function fillDetail(text: string, scope: Scope, currency: string | undefined): string | null {
  let missing = false;
  const out = text.replace(PLACEHOLDER, (_m, inner: string) => {
    const [path, fmt] = inner.split('|').map((x) => x.trim());
    if (path === '#') {
      if (!scope.element) { missing = true; return ''; }
      return String(scope.element.position);
    }
    const r = resolveCheckPath(path, scope);
    if (!r.ok || !isPresentForWhen(r.value) && r.value !== false) { missing = true; return ''; }
    return formatValue(r.value, fmt, currency);
  });
  return missing ? null : out;
}

/** Render a check's `detail`; null when a required (non-optional) value is missing. */
export function renderCheckDetail(template: string, scope: Scope): string | null {
  const curPath = scope.ctx.currencyField ?? 'currency';
  const cur = resolveCheckPath(curPath, scope);
  const currency = cur.ok && typeof cur.value === 'string' ? cur.value : undefined;
  // Optional parts `[ … ]` — but only OUTSIDE `{…}`: a placeholder path may
  // itself contain `[]` (`{lines[].unit_price|money}`).
  // Each segment is filled once (a rendered value is never re-parsed).
  const segments: Array<{ text: string; optional: boolean }> = [{ text: '', optional: false }];
  let depth = 0;
  for (const ch of template) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    const last = segments[segments.length - 1];
    if (depth === 0 && ch === '[' && !last.optional) { segments.push({ text: '', optional: true }); continue; }
    if (depth === 0 && ch === ']' && last.optional) { segments.push({ text: '', optional: false }); continue; }
    last.text += ch;
  }
  let out = '';
  for (const seg of segments) {
    const filled = fillDetail(seg.text, scope, currency);
    if (filled === null && !seg.optional) return null;
    out += filled ?? '';
  }
  // A dropped optional part can leave a dangling separator ("— reason").
  const clean = out.replace(/\s+/g, ' ').trim().replace(/^[—–,;:\s]+/, '').replace(/[—–,;:\s]+$/, '');
  return clean.length > 0 ? clean : null;
}

/** The results that refuse the call: a `fail` of a check declared `blocking`. */
export function blockingFailures(results: CheckResult[]): CheckResult[] {
  return results.filter((r) => r.blocking === true && r.status === 'fail');
}

/** One line per failed blocking check — label, then detail when there is one. */
export function blockingRefusalReason(failures: CheckResult[]): string {
  return failures
    .map((f) => `${f.label}${f.index !== undefined ? ` (line ${f.index})` : ''}: failed` +
      `${f.value !== undefined ? ` (${f.value === null ? 'none' : String(f.value)})` : ''}${f.detail ? ` — ${f.detail}` : ''}`)
    .join('; ');
}
