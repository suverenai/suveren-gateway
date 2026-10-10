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
 *  - WHICH top-level fields are shown first (real-world follow-up, a real
 *    erp get_quote answer with 15 fields): a manifest MAY declare
 *    `preview.fields` — an explicit, ordered allow-list always shown first,
 *    regardless of value. Without one, every field that HAS a value (not
 *    null/""/[]) is shown, in schema/declared order — no fixed count. Either
 *    way, "All fields (n)" folds the complete list, including empty ones —
 *    nothing is ever truly hidden, only de-prioritized.
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
  /** The fields shown first — manifest-declared `fields`, else every field
   *  with a value, in schema/declared order. */
  fields: PreviewFieldRow[];
  /** Everything else — the "All fields (n)" expansion, incl. empty fields. */
  moreFields: PreviewFieldRow[];
  /** Total top-level field count (fields.length + moreFields.length). */
  totalFields: number;
  /** kind 'text' only: the plain-text body, shown in full. */
  text?: string;
}

/** Caller-supplied rendering options — currently just the manifest's
 *  declared `preview.fields` (see tool-gating-types.ts ToolPreviewConfig). */
export interface RenderOptions {
  fields?: string[];
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

/** null/undefined/""/[] read as "nothing here" — everything else (incl. 0
 *  and false) is a real value worth showing without being asked for by name. */
function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
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

/** Resolves a `PreviewBody` to the object it carries (structured, or text
 *  that parses as a JSON object) plus its schema — or null when the body is
 *  genuinely free text (or empty). A schema only ever applies to a
 *  genuinely structured result; text that merely parses as JSON has no
 *  declared schema of its own. */
function resolveBodyObject(body: PreviewBody | undefined): { obj: Record<string, unknown>; schema?: JsonSchema } | null {
  const structured = body?.structured && Object.keys(body.structured).length > 0 ? body.structured : undefined;
  if (structured) return { obj: structured, schema: body?.outputSchema as JsonSchema | undefined };
  const fromText = body?.text ? parseJsonObject(body.text) : null;
  if (fromText) return { obj: fromText };
  return null;
}

/** EVERY top-level field of a structured (or JSON-in-text) body, in schema
 *  property order (then anything the result carries the schema didn't
 *  name) — no folding, no field-presence filtering. Used both by
 *  `renderPreviewBody` and by `diffPreviewBodies`, so the two can never
 *  disagree about what a "field" is. */
export function allPreviewFields(body: PreviewBody | undefined): PreviewFieldRow[] {
  const resolved = resolveBodyObject(body);
  if (!resolved) return [];
  const { obj, schema } = resolved;
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

export function renderPreviewBody(body: PreviewBody | undefined, opts?: RenderOptions): RenderedPreview {
  const resolved = resolveBodyObject(body);

  if (resolved) {
    const allRows = allPreviewFields(body);
    const declared = opts?.fields;

    let shown: PreviewFieldRow[];
    if (declared && declared.length > 0) {
      // Manifest-declared order, always shown regardless of value — the
      // integration said these are the fields that matter for this action.
      const byKey = new Map(allRows.map((r) => [r.key, r]));
      shown = declared.map((k) => byKey.get(k)).filter((r): r is PreviewFieldRow => r !== undefined);
    } else {
      // No declaration: every field that HAS a value, in schema order — not
      // a fixed count, so a 15-field answer shows its real total, whatever
      // that is, and nothing meaningful is buried under "All fields".
      shown = allRows.filter((r) => hasValue(resolved.obj[r.key]));
    }

    const shownKeys = new Set(shown.map((r) => r.key));
    const moreFields = allRows.filter((r) => !shownKeys.has(r.key));

    return { kind: 'structured', fields: shown, moreFields, totalFields: allRows.length };
  }

  const text = body?.text;
  if (text && text.trim().length > 0) {
    return { kind: 'text', fields: [], moreFields: [], totalFields: 0, text };
  }

  return { kind: 'empty', fields: [], moreFields: [], totalFields: 0 };
}

// ─── Stale-version compare (AU3 decision 2026-10-10 follow-up) ────────────
// Showing the first N fields of "revision 1" and "revision 2" side by side
// is useless when the difference lives in field #9 of 15 (e.g. the quote's
// lines) — both columns look identical. Show ONLY what actually differs.

export interface PreviewDiff {
  /** Only the rows that differ, from the approved body. Empty when `unchanged`. */
  approved: RenderedPreview;
  /** The same rows from the current body. Empty when `unchanged`. */
  current: RenderedPreview;
  /** True when nothing differs besides the excluded (version) field. */
  unchanged: boolean;
}

function rowKey(r: PreviewFieldRow | undefined): string {
  if (!r) return '';
  return r.lines ? `lines:${JSON.stringify(r.lines)}` : `value:${r.value ?? ''}`;
}

function toRendered(rows: PreviewFieldRow[]): RenderedPreview {
  return { kind: rows.length > 0 ? 'structured' : 'empty', fields: rows, moreFields: [], totalFields: rows.length };
}

/**
 * Compares every top-level field of two reads of the SAME record (the
 * approved body vs. the current one) and keeps only what differs —
 * `excludeKey` (the manifest's declared version field, e.g. `revision`) is
 * dropped from the comparison because it is EXPECTED to differ; it is not
 * itself the change being shown. Arrays (e.g. quote lines) compare and
 * render as whole rows (one line per item) rather than element-by-element —
 * any difference inside the array is a difference in that field.
 *
 * Free-text (non-structured) bodies fall back to a whole-text compare: no
 * fields to diff, so it is either identical (`unchanged`) or shown in full
 * on both sides.
 */
export function diffPreviewBodies(
  approved: PreviewBody | undefined,
  current: PreviewBody | undefined,
  opts?: RenderOptions & { excludeKey?: string },
): PreviewDiff {
  const approvedResolved = resolveBodyObject(approved);
  const currentResolved = resolveBodyObject(current);

  if (!approvedResolved && !currentResolved) {
    const a = approved?.text ?? '';
    const b = current?.text ?? '';
    if (a === b) return { approved: toRendered([]), current: toRendered([]), unchanged: true };
    return {
      approved: { kind: 'text', fields: [], moreFields: [], totalFields: 0, text: a },
      current: { kind: 'text', fields: [], moreFields: [], totalFields: 0, text: b },
      unchanged: false,
    };
  }

  const approvedByKey = new Map(allPreviewFields(approved).map((r) => [r.key, r]));
  const currentByKey = new Map(allPreviewFields(current).map((r) => [r.key, r]));
  const allKeys = [...new Set([...approvedByKey.keys(), ...currentByKey.keys()])];

  const diffKeys = allKeys.filter((k) => {
    if (k === opts?.excludeKey) return false;
    return rowKey(approvedByKey.get(k)) !== rowKey(currentByKey.get(k));
  });

  // Respect a declared field order for the diff rows too, when given.
  const order = opts?.fields && opts.fields.length > 0
    ? [...opts.fields.filter((k) => diffKeys.includes(k)), ...diffKeys.filter((k) => !opts.fields!.includes(k))]
    : diffKeys;

  const approvedRows = order.map((k) => approvedByKey.get(k)).filter((r): r is PreviewFieldRow => r !== undefined);
  const currentRows = order.map((k) => currentByKey.get(k)).filter((r): r is PreviewFieldRow => r !== undefined);

  return { approved: toRendered(approvedRows), current: toRendered(currentRows), unchanged: diffKeys.length === 0 };
}
