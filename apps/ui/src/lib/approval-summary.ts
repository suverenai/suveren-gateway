/**
 * The approval's one-sentence summary (UI spec §4.2.1 / §6.1 / §12.2), built by
 * the gateway from a template the connector MANIFEST declares per tool
 * (`toolGating.overrides[tool].summary`) and the proposal's sealed values —
 * never AI-written text. No template, or a required value missing → the plain
 * action name (`humanizeKey(tool)`), never half a sentence.
 *
 * Template syntax (validated at load time — mcp-server manifest-loader.ts
 * `invalidSummaryReason`, same grammar):
 *   {path}               the value at `path` (dotted; arrays by index not supported)
 *   {a,b}                the first of `a`, `b` that has a value
 *   {path|money}         amount, in the currency of display.currencyField or `currency`
 *   {path|percent}       "5%"
 *   {path|list}          an array as "a, b +2"
 *   {path|short}         shortened to 60 characters
 *   {path|date}          an ISO date/time as a short local date
 *   {path|ref}           an id, named when the card's attached read resolved it: "Name (id)"
 *   [ … ]                an optional part: dropped when any value inside is empty
 */
import { humanizeKey, splitTool } from './approval-view';
import type { IntegrationManifest } from './sp-client';

const MAX_LEN = 140;
const SHORT_LEN = 60;
const PLACEHOLDER = /\{([^{}]+)\}/g;

export type SummaryFormat = 'money' | 'percent' | 'list' | 'short' | 'date' | 'ref';
const FORMATS: readonly SummaryFormat[] = ['money', 'percent', 'list', 'short', 'date', 'ref'];
/** Resolves a bound arg to the name the card's own read gave it (preview-store.ts). */
export type RefName = (argPath: string) => string | undefined;

interface Override { summary?: string; display?: { currencyField?: string } }

function overrideFor(tool: string, manifests: IntegrationManifest[] | undefined): Override | undefined {
  const { integrationId, toolName } = splitTool(tool);
  const m = manifests?.find((x) => x.id === integrationId);
  return (m?.toolGating?.overrides?.[toolName] ?? undefined) as Override | undefined;
}

function at(args: Record<string, unknown>, path: string): unknown {
  let cur: unknown = args;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function format(v: unknown, fmt: SummaryFormat | undefined, currency: string | undefined, locale?: string): string {
  if (fmt === 'money') {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return String(v);
    if (currency && /^[A-Za-z]{3}$/.test(currency)) {
      try { return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(n); } catch { /* fall through */ }
    }
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
  }
  if (fmt === 'percent') return `${v}%`;
  if (fmt === 'date') {
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  }
  if (Array.isArray(v)) {
    const items = v.map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x)));
    return items.length > 2 ? `${items.slice(0, 2).join(', ')} +${items.length - 2}` : items.join(', ');
  }
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (fmt === 'short' && s.length > SHORT_LEN) return `${s.slice(0, SHORT_LEN - 1).trimEnd()}…`;
  return s;
}

/** Fill every {…} in `text`; null when one has no value. */
function fill(text: string, args: Record<string, unknown>, currency: string | undefined, locale?: string, refName?: RefName): string | null {
  let missing = false;
  const out = text.replace(PLACEHOLDER, (_m, inner: string) => {
    const [paths, fmt] = inner.split('|').map((x) => x.trim());
    const value = paths.split(',').map((p) => at(args, p.trim())).find(present);
    if (!present(value)) { missing = true; return ''; }
    if (fmt === 'ref') {
      const name = refName?.(paths.split(',')[0].trim());
      // A long id (a UUID) is shortened in the sentence; the card shows it in full.
      const id = String(value);
      const shortId = id.length > 12 ? `${id.slice(0, 8)}…` : id;
      return name ? `${name} (${shortId})` : id;
    }
    return format(value, fmt as SummaryFormat | undefined, currency, locale);
  });
  return missing ? null : out;
}

/** Render a template against sealed args. Null when a required value is missing. */
export function renderSummary(
  template: string,
  args: Record<string, unknown>,
  opts: { currencyField?: string; locale?: string; refName?: RefName } = {},
): string | null {
  const cur = at(args, opts.currencyField ?? 'currency');
  const currency = typeof cur === 'string' ? cur : undefined;
  // Optional parts first: [ … ] vanishes when anything inside is empty.
  const withOptional = template.replace(/\[([^[\]]*)\]/g, (_m, inner: string) => fill(inner, args, currency, opts.locale, opts.refName) ?? '');
  const out = fill(withOptional, args, currency, opts.locale, opts.refName);
  if (out === null) return null;
  const clean = out.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_LEN ? `${clean.slice(0, MAX_LEN - 1).trimEnd()}…` : clean;
}

/**
 * The summary for a proposal's tool + sealed args: the manifest template when
 * declared and complete, else the plain action name ("Create contact").
 * `args` null (not decrypted yet / not readable) → the action name.
 */
export function approvalSummary(
  tool: string,
  args: Record<string, unknown> | null | undefined,
  manifests: IntegrationManifest[] | undefined,
  locale?: string,
  refName?: RefName,
): string {
  const fallback = humanizeKey(splitTool(tool).toolName);
  const o = overrideFor(tool, manifests);
  if (!o?.summary || !args) return fallback;
  return renderSummary(o.summary, args, { currencyField: o.display?.currencyField, locale, refName }) ?? fallback;
}

/**
 * The manifest's summary sentence for a tool + its sealed args, or null when
 * there is no template, no args, or a required value is missing — unlike
 * `approvalSummary`, no fallback, so a ticket keeps its own past-tense label.
 */
export function sealedSummary(
  tool: string,
  args: Record<string, unknown> | null | undefined,
  manifests: IntegrationManifest[] | undefined,
  locale?: string,
): string | null {
  const o = overrideFor(tool, manifests);
  if (!o?.summary || !args) return null;
  return renderSummary(o.summary, args, { currencyField: o.display?.currencyField, locale });
}

/** Load-time grammar check, shared in spirit with the mcp-server loader. */
export function summaryTemplateProblem(template: unknown): string | null {
  if (typeof template !== 'string' || template.trim().length === 0) return 'must be a non-empty string';
  if (template.length > 200) return 'must be at most 200 characters';
  const depth = (open: string, close: string) => {
    let d = 0;
    for (const ch of template) {
      if (ch === open) { d += 1; if (d > 1) return false; }
      if (ch === close) { d -= 1; if (d < 0) return false; }
    }
    return d === 0;
  };
  if (!depth('{', '}')) return 'has unbalanced or nested { }';
  if (!depth('[', ']')) return 'has unbalanced or nested [ ]';
  for (const m of template.matchAll(PLACEHOLDER)) {
    const [paths, fmt, extra] = m[1].split('|').map((x) => x.trim());
    if (extra !== undefined) return `{${m[1]}} has more than one format`;
    if (!paths.split(',').every((p) => /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(p.trim()))) return `{${m[1]}} has an invalid field path`;
    if (fmt !== undefined && !FORMATS.includes(fmt as SummaryFormat)) return `{${m[1]}} has unknown format "${fmt}"`;
  }
  return null;
}
