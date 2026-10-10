/**
 * Rendering the system's "before it runs" read (AU3/AU5, work-plan.md
 * "Added 2026-10-09"). Pure and unit-tested — the component that shows the
 * preview box only maps this output to JSX, never parses `PreviewBody`
 * itself (see decision 4 in temp/briefs/au3-au5-brief.md: generic,
 * data-driven, no per-connector code).
 *
 * Generic by construction:
 *  - Labels come from the read tool's own output schema (`title`), in the
 *    schema's own declared property order; without a schema, from the
 *    structured result's own keys, in their own order.
 *  - Nested arrays/objects (e.g. quote lines) become compact one-line-per-item
 *    rows built from the item's OWN keys — never raw JSON in the main view.
 *  - Free text that happens to be a JSON object (a third-party server
 *    answering with text-only, no schema) is treated the same as a
 *    structured result with no schema.
 *  - Only the top-level FIELD LIST folds past `limit` ("All fields (n)") —
 *    never a value's own content. This app's approval surfaces never
 *    truncate what a person approves (see ApproverProposalCard, ProposalArgs).
 */
import { humanizeKey } from './approval-view';
import type { PreviewBody } from './sp-client';

export interface PreviewFieldRow {
  key: string;
  label: string;
  /** Scalar or plain-object value, rendered as one line. Absent when `lines` is set. */
  value?: string;
  /** Array-of-objects: one compact line per item (never raw JSON). */
  lines?: string[];
}

export interface RenderedPreview {
  kind: 'empty' | 'structured' | 'text';
  /** First `limit` top-level fields, in schema/declared order. */
  fields: PreviewFieldRow[];
  /** Everything past `limit` — the "All fields (n)" expansion. */
  moreFields: PreviewFieldRow[];
  /** Total top-level field count (fields.length + moreFields.length). */
  totalFields: number;
  /** kind 'text' only: the plain-text body, shown in full. */
  text?: string;
}

type JsonSchema = { properties?: Record<string, { title?: string }> };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '—';
}

/** One compact line for an object: "Label: value · Label2: value2" — the
 *  object's OWN keys, in their own order; never raw JSON. */
function compactObjectLine(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return '—';
  return entries
    .map(([k, v]) => `${humanizeKey(k)}: ${isPlainObject(v) ? compactObjectLine(v) : formatScalar(v)}`)
    .join(' · ');
}

function renderValue(value: unknown): Pick<PreviewFieldRow, 'value' | 'lines'> {
  if (Array.isArray(value)) {
    if (value.length === 0) return { value: '—' };
    if (value.every((x) => !isPlainObject(x) && !Array.isArray(x))) {
      return { value: value.map(formatScalar).join(', ') };
    }
    return { lines: value.map((x) => (isPlainObject(x) ? compactObjectLine(x) : formatScalar(x))) };
  }
  if (isPlainObject(value)) {
    return { value: compactObjectLine(value) };
  }
  return { value: formatScalar(value) };
}

function rowsFromObject(obj: Record<string, unknown>, schema: JsonSchema | undefined): PreviewFieldRow[] {
  const props = schema?.properties ?? {};
  // Schema's declared order first, then anything the result carries that the
  // schema didn't name (so an undeclared field is still shown, never hidden).
  const order = [...new Set([...Object.keys(props), ...Object.keys(obj)])];
  const rows: PreviewFieldRow[] = [];
  for (const key of order) {
    if (!(key in obj)) continue;
    const label = props[key]?.title ?? humanizeKey(key);
    rows.push({ key, label, ...renderValue(obj[key]) });
  }
  return rows;
}

/**
 * Parses `text` as a JSON OBJECT (not an array, not a bare scalar) — the
 * shape a third-party server's text-only answer takes when it is actually
 * structured data. Anything else (invalid JSON, an array, a scalar, plain
 * prose) is left for the plain-text path.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

/** Default number of top-level fields shown before folding into "All fields (n)". */
export const DEFAULT_PREVIEW_FIELD_LIMIT = 6;

export function renderPreviewBody(
  body: PreviewBody | undefined,
  limit: number = DEFAULT_PREVIEW_FIELD_LIMIT,
): RenderedPreview {
  const structured = body?.structured && Object.keys(body.structured).length > 0 ? body.structured : undefined;
  const fromText = !structured && body?.text ? parseJsonObject(body.text) : null;
  const obj = structured ?? fromText ?? undefined;

  if (obj) {
    // A schema only applies to the genuinely structured result — text that
    // merely parses as JSON has no declared schema of its own.
    const schema = structured ? (body?.outputSchema as JsonSchema | undefined) : undefined;
    const rows = rowsFromObject(obj, schema);
    return {
      kind: 'structured',
      fields: rows.slice(0, limit),
      moreFields: rows.slice(limit),
      totalFields: rows.length,
    };
  }

  const text = body?.text;
  if (text && text.trim().length > 0) {
    return { kind: 'text', fields: [], moreFields: [], totalFields: 0, text };
  }

  return { kind: 'empty', fields: [], moreFields: [], totalFields: 0 };
}
