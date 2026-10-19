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
 *  - WHICH keys inside a nested array item/object show (second real-world
 *    follow-up, 2026-10-10): when the outputSchema declares `items.properties`
 *    for an array field (or `properties` for a nested object field), only
 *    those declared properties are shown, in declared order, labelled by
 *    their `title` — an internal id the schema never named (quote_id,
 *    item_id) is dropped rather than shown as noise. Without such a
 *    declaration for that specific field, every one of the nested object's
 *    OWN keys is still shown (today's behaviour, unchanged) — this is an
 *    allow-list that narrows, never a requirement that would otherwise hide
 *    data no schema ever spoke to.
 *  - Non-integer numbers display rounded to at most 2 decimals, no trailing
 *    zeros (44.44444444444444 → "44.44"), with the exact value available on
 *    hover (title attribute) — display only; integers and strings are never
 *    touched, and this never reaches the bound "Details" values, which stay
 *    exact (see ProposalArgs.tsx, unaffected by this module).
 *
 *  DL4 (Delegation outside simulation, temp/briefs/dl-delegation-brief.md —
 *  the two internal preview tools behind "What you would sign" / "Change"):
 *  — a top-level field that is a plain object whose OWN values are every one
 *    scalar (string/number/boolean/null — never itself an object or array)
 *    renders as a labelled SUB-LIST: one row per key, the key IS that row's
 *    label (schema `title`, else humanized) — not the one-line compact row
 *    above. Supersedes the prior pinned behaviour for this exact shape (a
 *    plain object of scalars at the top level always used to compact to one
 *    line); an object with any non-scalar value still compacts as before —
 *    unaffected, and so is a nested object compacted inside an ARRAY item's
 *    line (compactObjectLine), which this rule never reaches.
 *  — a top-level array whose every element is a STRING renders as a LIST
 *    (one line per string, via the same `lines` an array-of-objects already
 *    uses) rather than comma-joined on one line — a sentence-shaped value
 *    ("Sales is allowed by your Delegation mandate") read far worse joined
 *    with others than a short tag does. An array of any other scalar type
 *    (numbers, booleans, a mix) keeps the comma-joined compact value,
 *    unchanged.
 *  — a top-level STRING field whose schema property declares
 *    `contentMediaType: "text/x-diff"` renders line by line as `diffLines`
 *    (kind `'add'`/`'remove'`/`'context'` from the line's own leading `+`/
 *    `-`), for a unified diff of two texts (e.g. the proposed agent brief
 *    against the current one) — never a wall of raw diff text.
 *  — a schema property's own `description` carries through to the row as
 *    `description`, shown as a small note beside the label (used for
 *    "Written by the AI — becomes your words when you sign" on `intent`) —
 *    independent of the three rules above, applies to any field.
 */
import { humanizeKey, HIDDEN_ARG_KEYS } from './approval-view';
import type { PreviewBody, PreviewReadOutcome, PreviewReadSection, ToolDisplayHints } from './sp-client';
import { isDocumentPreviewBody, type DocumentPreviewData } from './document-preview';

/** One row of a labelled sub-list (DL4) — a nested object field whose own
 *  values are every one scalar. `label` is the nested key's own label
 *  (schema `title`, else humanized), never the outer field's. */
export interface PreviewSubRow {
  key: string;
  label: string;
  value: string;
  valueTitle?: string;
}

/** One line of a `text/x-diff` field (DL4), classified by its own leading
 *  character — `'+'` → add, `'-'` → remove (but not the unified-diff file
 *  headers `+++`/`---`, which are context), everything else → context. */
export interface PreviewDiffLine {
  text: string;
  kind: 'add' | 'remove' | 'context';
}

export interface PreviewFieldRow {
  key: string;
  label: string;
  /** Scalar or plain-object value, rendered as one line. Absent when `lines`,
   *  `sublist`, or `diffLines` is set — the four are mutually exclusive. */
  value?: string;
  /** Hover text for `value` — the same line with every number at full
   *  precision. Present only when rounding actually changed something. */
  valueTitle?: string;
  /** Array-of-objects, or (DL4) an array of strings: one line per item
   *  (never raw JSON, never comma-joined). */
  lines?: string[];
  /** Hover text per entry of `lines`, same length when present; an entry is
   *  undefined where that line needed no correction. */
  lineTitles?: Array<string | undefined>;
  /**
   * AU8 ("send_quote card gets the table rendering") — present ADDITIONALLY
   * whenever `lines` came from an array of OBJECTS (never for DL4's array-
   * of-strings case): the same data as a real table (columns from the
   * items' own keys). `RenderedPreviewView.tsx` prefers rendering this over
   * the compact `lines` rows when present; `lines`/`lineTitles` stay set
   * regardless, since `diffPreviewBodies`' `rowKey` compares on them.
   */
  table?: PreviewTable;
  /** DL4: a nested object field whose own values are every one scalar — one
   *  row per key, instead of `value`'s one-line compact row. */
  sublist?: PreviewSubRow[];
  /** DL4: a string field declared `contentMediaType: "text/x-diff"` — one
   *  entry per line of the diff text, instead of `value`. */
  diffLines?: PreviewDiffLine[];
  /** DL4: the schema property's own `description`, shown as a small note
   *  beside the label — independent of which of the above the row uses. */
  description?: string;
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

/** A JSON-Schema-shaped property declaration — only the bits this module
 *  reads: a display `title`, nested `properties` (object), or `items`
 *  (array, itself a property declaration for one element). */
interface JsonSchemaProperty {
  title?: string;
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  /** DL4: `"text/x-diff"` switches a string field to line-by-line diff rendering. */
  contentMediaType?: string;
  /** DL4: shown as a small note beside the label. */
  description?: string;
}
type JsonSchema = { properties?: Record<string, JsonSchemaProperty> };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Non-integer numbers round to at most 2 decimals (no trailing zeros —
 *  JS's own Number→string conversion drops them); integers and strings are
 *  never touched. `exact`=true skips the rounding, for the hover title. */
function formatScalar(v: unknown, exact = false): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (exact || Number.isInteger(v)) return String(v);
    return String(Math.round(v * 100) / 100);
  }
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

/**
 * A list inside a compact line: plain values joined; a list of records by
 * its count ("5 entries") — one line has no room for a table, and "—" would
 * claim the value is missing when it is not.
 */
function compactListValue(list: unknown[], exact: boolean): string {
  if (list.length === 0) return '—';
  if (list.every((x) => !isPlainObject(x) && !Array.isArray(x))) return list.map((x) => formatScalar(x, exact)).join(', ');
  return list.length === 1 ? '1 entry' : `${list.length} entries`;
}

/**
 * One compact line for an object: "Label: value · Label2: value2" — never
 * raw JSON. With a declared `properties` map, ONLY those keys show, in
 * their declared order, labelled by `title` — an id the schema never named
 * is dropped. Without one, every one of the object's OWN keys shows,
 * humanized (today's behaviour, unchanged — this allow-list only ever
 * narrows what a declared schema already named).
 */
function compactObjectLine(
  obj: Record<string, unknown>,
  declaredProps: Record<string, JsonSchemaProperty> | undefined,
  exact: boolean,
): string {
  const keys = declaredProps ? Object.keys(declaredProps).filter((k) => k in obj) : Object.keys(obj);
  if (keys.length === 0) return '—';
  return keys
    .map((k) => {
      const v = obj[k];
      const label = declaredProps?.[k]?.title ?? humanizeKey(k);
      const shown = isPlainObject(v)
        ? compactObjectLine(v, declaredProps?.[k]?.properties, exact)
        : Array.isArray(v) ? compactListValue(v, exact) : formatScalar(v, exact);
      return `${label}: ${shown}`;
    })
    .join(' · ');
}

/**
 * AU8 — a real table for an array of objects (e.g. quote lines): columns
 * from the declared item schema (in its own order), else the union of every
 * row's own keys, in first-seen order; a cell whose own value is a nested
 * object compacts the same way `compactObjectLine` always has (unchanged —
 * this never expands into a nested table).
 */
function tableForObjectArray(
  rows: Record<string, unknown>[],
  itemProps: Record<string, JsonSchemaProperty> | undefined,
): PreviewTable {
  const keys = itemProps
    ? Object.keys(itemProps).filter((k) => rows.some((r) => k in r))
    : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns = keys.map((k) => ({ key: k, label: itemProps?.[k]?.title ?? humanizeKey(k) }));
  const tableRows = rows.map((r) => ({
    cells: keys.map((k) => {
      const v = r[k];
      const display = isPlainObject(v) ? compactObjectLine(v, itemProps?.[k]?.properties, false) : formatScalar(v);
      const exact = isPlainObject(v) ? compactObjectLine(v, itemProps?.[k]?.properties, true) : formatScalar(v, true);
      return exact === display ? { value: display, sealed: false } : { value: display, valueTitle: exact, sealed: false };
    }),
  }));
  return { columns, rows: tableRows };
}

/**
 * Any value as ONE line of plain text — a record as "Label: value · …", a
 * list as joined values or a count of entries; never raw JSON. For views
 * with no room for a table (a ticket's Result rows).
 */
export function compactValue(v: unknown): string {
  if (isPlainObject(v)) return compactObjectLine(v, undefined, false);
  if (Array.isArray(v)) return compactListValue(v, false);
  return formatScalar(v);
}

/**
 * One argument value that is not a plain string/number, the way every view
 * shows it: a list of records → a table, one record → one compact line.
 * Null for anything else (the caller shows it as itself). Shape-driven only —
 * never by field or tool name.
 */
export function nestedValueView(value: unknown): { table: PreviewTable } | { text: string } | null {
  if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
    return { table: tableForObjectArray(value as Record<string, unknown>[], undefined) };
  }
  if (isPlainObject(value)) return { text: compactObjectLine(value, undefined, false) };
  return null;
}

/**
 * DL4: one line per entry of a unified diff, classified by its own leading
 * character — the file-header lines a real unified diff may carry (`+++`/
 * `---`) are context, never mistaken for a single changed line.
 */
function diffTextLines(text: string): PreviewDiffLine[] {
  return text.split('\n').map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) return { text: line, kind: 'add' };
    if (line.startsWith('-') && !line.startsWith('---')) return { text: line, kind: 'remove' };
    return { text: line, kind: 'context' };
  });
}

type RenderedValue = Pick<PreviewFieldRow, 'value' | 'valueTitle' | 'lines' | 'lineTitles' | 'sublist' | 'diffLines' | 'table'>;

function renderValue(value: unknown, fieldSchema: JsonSchemaProperty | undefined): RenderedValue {
  if (Array.isArray(value)) {
    if (value.length === 0) return { value: '—' };
    if (value.every((x) => !isPlainObject(x) && !Array.isArray(x))) {
      // DL4: a list of sentences reads far worse comma-joined than a short
      // tag does — every element a STRING renders one per line instead.
      if (value.every((x) => typeof x === 'string')) {
        return { lines: value as string[] };
      }
      const display = value.map((x) => formatScalar(x)).join(', ');
      const exact = value.map((x) => formatScalar(x, true)).join(', ');
      return exact === display ? { value: display } : { value: display, valueTitle: exact };
    }
    const itemProps = fieldSchema?.items?.properties;
    const displayLines = value.map((x) => (isPlainObject(x) ? compactObjectLine(x, itemProps, false) : formatScalar(x)));
    const exactLines = value.map((x) => (isPlainObject(x) ? compactObjectLine(x, itemProps, true) : formatScalar(x, true)));
    const lineTitles = displayLines.map((d, i) => (d === exactLines[i] ? undefined : exactLines[i]));
    // AU8 ("send_quote card gets the table rendering") — an array of OBJECTS
    // (e.g. quote lines) ADDITIONALLY gets a real table (columns from the
    // items' own keys, same labelling rule as `compactObjectLine`) — never
    // REPLACING `lines`/`lineTitles` above, so the stale-version diff
    // (`rowKey`, which compares on `.lines`) and every pinned test of the
    // existing compact-row behaviour stay exactly as they were; the table is
    // simply what the renderer SHOWS when a table fits better than one
    // joined line per item (RenderedPreviewView.tsx prefers it when present).
    const table = value.every(isPlainObject) ? tableForObjectArray(value as Record<string, unknown>[], itemProps) : undefined;
    return {
      lines: displayLines,
      ...(lineTitles.some((t) => t !== undefined) ? { lineTitles } : {}),
      ...(table ? { table } : {}),
    };
  }
  if (isPlainObject(value)) {
    // DL4: when every one of THIS object's own values is itself scalar, show
    // a labelled sub-list (one row per key) instead of compacting to one
    // line — a nested object whose values are objects/arrays still compacts
    // (unchanged), and this never applies inside an array item's own compact
    // line (compactObjectLine, used only there).
    const declaredProps = fieldSchema?.properties;
    const keys = declaredProps ? Object.keys(declaredProps).filter((k) => k in value) : Object.keys(value);
    if (keys.length > 0 && keys.every((k) => !isPlainObject(value[k]) && !Array.isArray(value[k]))) {
      const sublist: PreviewSubRow[] = keys.map((k) => {
        const v = value[k];
        const label = declaredProps?.[k]?.title ?? humanizeKey(k);
        const display = formatScalar(v);
        const exact = formatScalar(v, true);
        return exact === display ? { key: k, label, value: display } : { key: k, label, value: display, valueTitle: exact };
      });
      return { sublist };
    }
    const display = compactObjectLine(value, declaredProps, false);
    const exact = compactObjectLine(value, declaredProps, true);
    return exact === display ? { value: display } : { value: display, valueTitle: exact };
  }
  // DL4: a string declared `contentMediaType: "text/x-diff"` renders line by
  // line instead of as one block of text.
  if (typeof value === 'string' && fieldSchema?.contentMediaType === 'text/x-diff') {
    return { diffLines: diffTextLines(value) };
  }
  const display = formatScalar(value);
  const exact = formatScalar(value, true);
  return exact === display ? { value: display } : { value: display, valueTitle: exact };
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
export function resolveBodyObject(body: PreviewBody | undefined): { obj: Record<string, unknown>; schema?: JsonSchema } | null {
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
    const fieldSchema = props[key];
    const label = fieldSchema?.title ?? humanizeKey(key);
    const row: PreviewFieldRow = { key, label, ...renderValue(obj[key], fieldSchema) };
    if (fieldSchema?.description) row.description = fieldSchema.description;
    rows.push(row);
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
  if (r.lines) return `lines:${JSON.stringify(r.lines)}`;
  if (r.sublist) return `sublist:${JSON.stringify(r.sublist.map((s) => [s.key, s.value]))}`;
  if (r.diffLines) return `diffLines:${JSON.stringify(r.diffLines)}`;
  return `value:${r.value ?? ''}`;
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
 * any difference inside the array is a difference in that field. The same
 * schema-declared nested-property allow-list and number rounding that
 * `renderPreviewBody` applies carries through here too, since both build on
 * the same `allPreviewFields`.
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

// ─── AU8 — several reads per preview (temp/briefs/au8-brief.md) ───────────
// A multi-read preview's card ("What will be created") merges the action's
// own bound args with its declared reads into ONE generic view:
//  - a bound field with an ATTACHED (non-forEach) read -> an "identity" row
//    (the read's own name/title/label field, the raw bound id small and
//    grey, the read's other fields as context);
//  - a bound field that is a `forEach` source -> a TABLE, one row per bound
//    element, merging the element's own fields with its attached read;
//  - every other bound field -> shown as itself (money/percent/plain, per
//    the manifest's `display` hints);
//  - a read with NO attach -> its own section, below the ordered fields
//    (e.g. a CRM duplicate-contact check).
// Every value is marked sealed (bound) or system (read) by the CALLER
// (RenderedCreationView.tsx) from each row's own `sealed` flag — never
// guessed from shape here.

/** Resolves a `PreviewBody` to the array of plain objects it carries
 *  (structured, or text that parses as a JSON array of objects) — the
 *  shape a connector with no `structuredContent`/`outputSchema` of its own
 *  returns for a list tool (e.g. crm's `find_contacts`). Null for anything
 *  else (an object, free text, empty). */
function resolveBodyArray(body: PreviewBody | undefined): Record<string, unknown>[] | null {
  const structured = body?.structured;
  if (Array.isArray(structured) && structured.every(isPlainObject)) return structured as Record<string, unknown>[];
  if (body?.text) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return null;
    }
    if (Array.isArray(parsed) && parsed.every(isPlainObject)) return parsed as Record<string, unknown>[];
  }
  return null;
}

export interface PreviewTableColumn {
  key: string;
  label: string;
}
export interface PreviewTableCell {
  value: string;
  valueTitle?: string;
  /** True for a column built from the action's OWN bound value (sealed —
   *  approved and executed exactly so); false for one read from the system. */
  sealed: boolean;
}
export interface PreviewTableRow {
  cells: PreviewTableCell[];
}
export interface PreviewTable {
  columns: PreviewTableColumn[];
  rows: PreviewTableRow[];
  /** Present when the source list was capped (AU8: max 50 elements). */
  overflowNote?: string;
}

function cellFor(value: unknown): { value: string; valueTitle?: string } {
  const display = formatScalar(value);
  const exact = formatScalar(value, true);
  return exact === display ? { value: display } : { value: display, valueTitle: exact };
}

/** A read's own fields — resolved from its `outcome.body`, regardless of
 *  whether the connector declared a schema (see `resolveBodyObject`).
 *  Returns an EMPTY row set (never throws) for anything but 'ok'. */
function attachedFields(outcome: PreviewReadOutcome | undefined): PreviewFieldRow[] {
  if (!outcome || outcome.status !== 'ok') return [];
  return allPreviewFields(outcome.body);
}

/** One line of plain prose for an unresolved attach — never a raw error
 *  object; the connector's own sentence only when it answered with one. */
function unresolvedNote(outcome: PreviewReadOutcome | undefined): string {
  if (!outcome) return 'Not read.';
  switch (outcome.status) {
    // A connector answers every failed read as an error — "not found" or
    // not. Its own sentence says which (2026-10-18: "company file cannot be
    // read" was shown as "Not found in the system"), so show it when given.
    case 'not_found': return outcome.message ? `The system answered: ${outcome.message}` : 'Not found in the system.';
    case 'none': return 'Nothing to read.';
    default: return 'Not available right now.';
  }
}

export interface AttachedIdentity {
  /** The read's own name/title/label field (schema-driven: `name`, `title`,
   *  `label`, else the first string field) — undefined when unresolved. */
  name?: string;
  /** The bound value this read explains, always shown (small/grey) —
   *  formatted, never invented. */
  rawId: string;
  /** The read's other fields, as context — excludes whichever one became `name`. */
  context: PreviewFieldRow[];
  /** Present only when the read did not resolve (no `name`). */
  unresolved?: string;
}

/**
 * `rawId` is the bound value itself (e.g. `"cust-1"`) — always from the
 * action's own args, never from the read (decision: a system value never
 * REPLACES a bound one, only explains it). `opts.pathPrefix` (the top-level
 * bound key this attach resolves, e.g. `"customer_id"`) enables manifest
 * `labels`/`money`/`percent` on the context rows (path `"<prefix>.<key>"`)
 * — absent for a `forEach` element's attach (handled separately, inside the
 * table, which has its own `[]`-shaped paths).
 */
export function resolveAttachedIdentity(
  outcome: PreviewReadOutcome | undefined,
  rawId: unknown,
  opts?: { pathPrefix?: string; displayHints?: ToolDisplayHints; currency?: string },
): AttachedIdentity {
  const rows = attachedFields(outcome);
  if (rows.length === 0) {
    return { rawId: formatScalar(rawId), context: [], unresolved: unresolvedNote(outcome) };
  }
  // Schema-driven: name/title/label field, else the first field whose own
  // (unformatted) value is actually a string — a number merely rendered as
  // a string (e.g. list_price) never qualifies as "the name".
  const rawObj = outcome && outcome.status === 'ok' ? resolveBodyObject(outcome.body)?.obj : undefined;
  const nameRow = rows.find((r) => ['name', 'title', 'label'].includes(r.key))
    ?? rows.find((r) => typeof rawObj?.[r.key] === 'string' && !r.lines && !r.sublist && !r.diffLines);
  const prefix = opts?.pathPrefix;
  const context = rows
    // `id` is already shown as the (bound) raw id — never repeated as context.
    .filter((r) => r.key !== nameRow?.key && r.key !== 'id')
    .map((r) => {
      if (!prefix) return r;
      const path = `${prefix}.${r.key}`;
      const label = resolveLabel(opts?.displayHints, path, r.label);
      // Only reformat a SCALAR row whose path is actually money/percent-
      // hinted — reformatting every row from its raw value would lose
      // lines/sublist/diffLines for anything without a matching hint.
      if (!pathMatches(opts?.displayHints?.money, path) && !pathMatches(opts?.displayHints?.percent, path)) {
        return label === r.label ? r : { ...r, label };
      }
      const { value, valueTitle } = formatHinted(rawObj?.[r.key], opts?.displayHints, path, opts?.currency);
      return { ...r, label, value, valueTitle };
    });
  return { name: nameRow?.value, rawId: formatScalar(rawId), context };
}

/** Fields an {@link AttachedIdentity} always folds into name/rawId, never
 *  shown again as their own table column (see `buildForEachTable`). */
const IDENTITY_KEYS = new Set(['id', 'name', 'title', 'label']);

// ─── display hints: field paths (labels / money / percent / hidden) ───────
// See ToolDisplayHints.labels' doc comment (sp-client.ts) for the full path
// grammar — every hint here (`labels`, `money`, `percent`, `hidden`) is
// keyed by the exact same kind of path string.

function pathMatches(hints: string[] | undefined, path: string): boolean {
  return !!hints?.includes(path);
}

/** Manifest label for this exact path, else `fallback` (already resolved by
 *  the caller — schema title or humanized key, per field). */
function resolveLabel(hints: ToolDisplayHints | undefined, path: string, fallback: string): string {
  return hints?.labels?.[path] ?? fallback;
}

function formatMoney(value: unknown, currency: string | undefined): { value: string; valueTitle?: string } {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return cellFor(value);
  // Fixed 'en-US' grouping (not the runtime's locale) so "10,000.00 EUR"
  // reads the same regardless of where the gateway runs — the thousands
  // comma is the mockup's own formatting, not a locale feature.
  const amount = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const display = `${amount}${currency ? ` ${currency}` : ''}`;
  return { value: display };
}

function formatPercent(value: unknown): { value: string; valueTitle?: string } {
  if (typeof value !== 'number' && typeof value !== 'string') return cellFor(value);
  return { value: `${value} %` };
}

/** One bound (sealed) or system (read) value, formatted per `hints` for
 *  this exact path (money/percent), else plainly. `currency` is resolved by
 *  the caller (`resolveCurrency`) since this function never looks anything
 *  up itself. */
function formatHinted(
  value: unknown,
  hints: ToolDisplayHints | undefined,
  path: string,
  currency: string | undefined,
): { value: string; valueTitle?: string } {
  if (pathMatches(hints?.money, path)) return formatMoney(value, currency);
  if (pathMatches(hints?.percent, path)) return formatPercent(value);
  return cellFor(value);
}

function isHidden(hints: ToolDisplayHints | undefined, path: string): boolean {
  return pathMatches(hints?.hidden, path);
}

/**
 * Resolves `hints.currencyField` for every `money` path in one display
 * block: either a plain bound action-arg name (`"currency"`) or a dotted
 * path into a NON-forEach attach's own field (`"customer_id.currency"`).
 * `attachedBody(topKey)` resolves that attach's raw body — supplied by the
 * caller (`buildCreationView`), which already has every section's result.
 * Undefined (money still shows, just with no currency suffix) rather than
 * guessing when the field is absent or not a string.
 */
function resolveCurrency(
  hints: ToolDisplayHints | undefined,
  toolArgs: Record<string, unknown>,
  attachedBody: (topKey: string) => Record<string, unknown> | undefined,
): string | undefined {
  const field = hints?.currencyField;
  if (!field) return undefined;
  const dot = field.indexOf('.');
  if (dot < 0) {
    const v = toolArgs[field];
    return typeof v === 'string' ? v : undefined;
  }
  const v = attachedBody(field.slice(0, dot))?.[field.slice(dot + 1)];
  return typeof v === 'string' ? v : undefined;
}

// ─── forEach -> table ────────────────────────────────────────────────────

/**
 * Builds the table for a `forEach` read: one row per (capped) bound
 * element, columns = [the attach identity, if `section.attach` is set] +
 * [the element's own OTHER fields] + [the attached read's own OTHER
 * fields, when it resolved] — "columns from the element keys... labels from
 * the connector's schema titles/descriptions; fallback: humanized key".
 * `boundElements` is the action's OWN bound array (e.g. `lines`) — the
 * table always has exactly as many rows as bound elements the gateway
 * actually read for (capped at 50; `section.overflow` notes the rest).
 */
export function buildForEachTable(
  section: PreviewReadSection,
  boundElements: Record<string, unknown>[],
  displayHints: ToolDisplayHints | undefined,
  currency: string | undefined,
): PreviewTable {
  const forEachKey = section.forEach ?? '';
  const attach = section.attach;
  const outcomes = section.elements ?? [];
  const rowCount = Math.min(boundElements.length, outcomes.length);
  const bound = boundElements.slice(0, rowCount);
  const reads = outcomes.slice(0, rowCount);

  const boundKeys = [...new Set(bound.flatMap((el) => Object.keys(el)))]
    .filter((k) => k !== section.sourceArg)
    .filter((k) => !isHidden(displayHints, `${forEachKey}[].${k}`));

  // Schema-driven fallback label per attached key — the FIRST read that
  // resolved it wins (every element of the same read tool shares a schema).
  const attachedLabelFallback = new Map<string, string>();
  if (attach) {
    for (const r of reads) {
      for (const f of attachedFields(r)) if (!attachedLabelFallback.has(f.key)) attachedLabelFallback.set(f.key, f.label);
    }
  }
  const attachedKeys = attach
    ? [...attachedLabelFallback.keys()].filter((k) => !IDENTITY_KEYS.has(k))
    : [];

  const columns: PreviewTableColumn[] = [];
  if (attach) {
    columns.push({
      key: `__attach:${attach}`,
      label: resolveLabel(displayHints, `${forEachKey}[].${attach}`, humanizeKey(section.sourceArg ?? attach)),
    });
  }
  for (const k of boundKeys) columns.push({ key: `bound:${k}`, label: resolveLabel(displayHints, `${forEachKey}[].${k}`, humanizeKey(k)) });
  for (const k of attachedKeys) {
    columns.push({
      key: `attached:${k}`,
      label: resolveLabel(displayHints, `${forEachKey}[].${attach}.${k}`, attachedLabelFallback.get(k) ?? humanizeKey(k)),
    });
  }

  const rows: PreviewTableRow[] = bound.map((el, i) => {
    const outcome = reads[i];
    const cells: PreviewTableCell[] = [];
    if (attach) {
      const identity = resolveAttachedIdentity(outcome, section.sourceArg ? el[section.sourceArg] : undefined);
      const text = identity.name ? `${identity.name} (${identity.rawId})` : identity.unresolved ? `${identity.rawId} — ${identity.unresolved}` : identity.rawId;
      cells.push({ value: text, sealed: false });
    }
    for (const k of boundKeys) {
      const { value, valueTitle } = formatHinted(el[k], displayHints, `${forEachKey}[].${k}`, currency);
      cells.push({ value, valueTitle, sealed: true });
    }
    const rawObj = outcome && outcome.status === 'ok' ? resolveBodyObject(outcome.body)?.obj : undefined;
    for (const k of attachedKeys) {
      const raw = rawObj?.[k];
      const { value, valueTitle } = raw !== undefined ? formatHinted(raw, displayHints, `${forEachKey}[].${attach}.${k}`, currency) : { value: '—', valueTitle: undefined };
      cells.push({ value, valueTitle, sealed: false });
    }
    return { cells };
  });

  return {
    columns,
    rows,
    ...(section.overflow ? { overflowNote: `${section.overflow.total - section.overflow.shown} more not shown` } : {}),
  };
}

// ─── a read with no attach -> its own section ──────────────────────────────

export interface PreviewOwnSection {
  /** A generic heading built from the read tool's own name — never
   *  connector-specific copy. */
  heading: string;
  /** Present when the read's result is a list of objects. */
  table?: PreviewTable;
  /** Present when the read's result is a single object/text (or didn't
   *  resolve) — the same generic field-row rendering every preview uses. */
  body?: RenderedPreview;
  note?: string;
  /**
   * UI spec §15.1 — present when this read declared `kind: "document"`
   * AND its result's shape matches {@link isDocumentPreviewBody}. Renders
   * as the sealed "document as it will be issued" box
   * (`DocumentPreviewBox.tsx`) instead of `body`/`table`/`note` — mutually
   * exclusive with them.
   */
  document?: DocumentPreviewData;
}

function ownSectionHeading(tool: string): string {
  return `${humanizeKey(tool)} — from the system`;
}

/**
 * `null` is a valid return — see the `kind: 'document'` / `no_connector`
 * case below: the box is simply absent, per UI spec §15.1 ("when the
 * connector has no preview — e.g. simulation mode — the box is simply
 * absent"), never a note explaining its absence.
 */
export function buildOwnSection(section: PreviewReadSection): PreviewOwnSection | null {
  const heading = ownSectionHeading(section.tool);
  const outcome = section.result;
  if (section.kind === 'document') {
    if (outcome && outcome.status === 'ok') {
      const structured = resolveBodyObject(outcome.body)?.obj;
      if (structured && isDocumentPreviewBody(structured)) {
        return { heading, document: structured };
      }
      // Declared a document but the connector's answer doesn't match the
      // shape — degrade to a note rather than a broken box or a crash.
      return { heading, note: 'Could not show a preview — the connector’s answer was not in the expected shape.' };
    }
    if (outcome?.status === 'unavailable' && outcome.reason === 'no_connector') return null;
    return { heading, note: unresolvedNote(outcome) };
  }
  if (!outcome || outcome.status !== 'ok') {
    return { heading, note: unresolvedNote(outcome) };
  }
  const list = resolveBodyArray(outcome.body);
  if (list) {
    if (list.length === 0) return { heading, note: 'Nothing found.' };
    const keys = [...new Set(list.flatMap((o) => Object.keys(o)))];
    const columns = keys.map((k) => ({ key: k, label: humanizeKey(k) }));
    const rows = list.map((o) => ({ cells: keys.map((k) => ({ ...cellFor(o[k]), sealed: false })) }));
    return { heading, table: { columns, rows } };
  }
  return { heading, body: renderPreviewBody(outcome.body, { fields: section.fields }) };
}

// ─── the combined "creation" view ──────────────────────────────────────────

export type CreationRow =
  | { kind: 'identity'; key: string; label: string; identity: AttachedIdentity }
  | { kind: 'table'; key: string; label: string; table: PreviewTable }
  | { kind: 'scalar'; key: string; label: string; value: string; valueTitle?: string };

export interface CreationView {
  rows: CreationRow[];
  /** Reads with no attach — own sections, shown after the ordered rows. */
  sections: PreviewOwnSection[];
}

/**
 * Merges the action's bound args (`toolArgs`) with its declared reads
 * (`sections`) into one ordered view: `displayHints.order` first (fields
 * not listed are appended afterward, in their own key order); `hidden`
 * fields are dropped entirely; a field linked to an `attach` or `forEach`
 * read renders via that read (identity/table) instead of as a plain scalar.
 */
export function buildCreationView(
  toolArgs: Record<string, unknown>,
  sections: PreviewReadSection[],
  displayHints: ToolDisplayHints | undefined,
): CreationView {
  const byAttachKey = new Map(sections.filter((s) => s.attach && !s.forEach).map((s) => [s.attach!, s]));
  const byForEachKey = new Map(sections.filter((s) => s.forEach).map((s) => [s.forEach!, s]));
  const ownSections = sections.filter((s) => !s.attach && !s.forEach);

  // `resolveCurrency`'s dotted-path form reads a NON-forEach attach's own
  // raw body — resolved lazily (only when `currencyField` actually points
  // into one) from the same sections this view already has.
  const attachedBody = (topKey: string): Record<string, unknown> | undefined => {
    const result = byAttachKey.get(topKey)?.result;
    return result && result.status === 'ok' ? resolveBodyObject(result.body)?.obj : undefined;
  };
  const currencyStr = resolveCurrency(displayHints, toolArgs, attachedBody);

  const order = displayHints?.order ?? [];
  const allKeys = [...new Set([...order, ...Object.keys(toolArgs)])];

  const rows: CreationRow[] = [];
  for (const key of allKeys) {
    if (!(key in toolArgs)) continue;
    if (HIDDEN_ARG_KEYS.has(key) || isHidden(displayHints, key)) continue;
    const label = resolveLabel(displayHints, key, humanizeKey(key));

    const forEachSection = byForEachKey.get(key);
    if (forEachSection) {
      const elements = Array.isArray(toolArgs[key]) ? (toolArgs[key] as Record<string, unknown>[]) : [];
      rows.push({ kind: 'table', key, label, table: buildForEachTable(forEachSection, elements, displayHints, currencyStr) });
      continue;
    }

    const attachSection = byAttachKey.get(key);
    if (attachSection) {
      const identity = resolveAttachedIdentity(attachSection.result, toolArgs[key], { pathPrefix: key, displayHints, currency: currencyStr });
      rows.push({ kind: 'identity', key, label, identity });
      continue;
    }

    const raw = toolArgs[key];
    // A list of records (invoice lines) reads as a table; one record (a
    // service period) as one compact line — never "—" for a value that is
    // there, just not a plain string or number.
    const nested = nestedValueView(raw);
    if (nested && 'table' in nested) {
      rows.push({ kind: 'table', key, label, table: nested.table });
      continue;
    }
    if (nested && isPlainObject(raw)) {
      const exact = compactObjectLine(raw, undefined, true);
      rows.push({ kind: 'scalar', key, label, value: nested.text, ...(exact !== nested.text ? { valueTitle: exact } : {}) });
      continue;
    }
    if (Array.isArray(raw)) {
      rows.push({ kind: 'scalar', key, label, value: raw.length === 0 ? '—' : raw.map((x) => formatScalar(x)).join(', ') });
      continue;
    }

    const { value, valueTitle } = formatHinted(raw, displayHints, key, currencyStr);
    rows.push({ kind: 'scalar', key, label, value, valueTitle });
  }

  const builtSections = ownSections.map(buildOwnSection).filter((s): s is PreviewOwnSection => s !== null);
  return { rows, sections: builtSections };
}
