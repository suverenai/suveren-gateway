/**
 * How a tool call's arguments become execution-context fields under a connector manifest's `executionMapping`.
 *
 * ONE implementation for both sides of a decision: the MCP server builds the execution context of a call with it, and the phone
 * approval app rebuilds the context from the decrypted arguments and the mapping sealed in the card context (device-keys plan 8,
 * "what the app verifies before it offers a decision") and compares. Two copies would drift, and a drifted copy would show a
 * mismatch where there is none, or hide one.
 *
 * Pure: no node imports, no runtime import of hap-core. Generic: argument names, field names and transforms come from the
 * manifest, never from this file.
 */

/** The list transforms: the only ones several arguments may share a field through. THE one copy (the manifest types re-export it). */
export const LIST_TRANSFORMS: readonly string[] = ['length', 'join', 'join_domains'];

/** One entry of a mapping (a manifest's `executionMapping` value is a field name, one entry or a list of entries). */
export type MappingEntry = { field: string; divisor?: number; transform?: string; item?: string; format?: string };
export type MappingValue = string | MappingEntry | MappingEntry[];

/** An argument's items as strings, read by the mapping's declared `item` — the same reading `applyMapping` does. */
export function listItems(m: MappingEntry, value: unknown): string[] {
  const coerce = (v: unknown): string => {
    if (m.item && typeof v === 'object' && v !== null && m.item in v) {
      return String((v as Record<string, unknown>)[m.item]);
    }
    return String(v);
  };
  return Array.isArray(value) ? value.map(coerce) : [coerce(value)];
}

/**
 * Apply a single mapping entry to produce an execution context field.
 * Handles divisor, transform, and direct copy.
 */
export function applyMapping(
  m: { field: string; divisor?: number; transform?: string; item?: string },
  value: unknown,
  execution: Record<string, string | number>,
): void {
  if (m.divisor) {
    const numValue = typeof value === 'number' ? value : Number(value);
    execution[m.field] = numValue / m.divisor;
    return;
  }
  // An item that is an object (Google Calendar attendees are `{ email,
  // displayName?, ... }`) is read by the property the manifest names in
  // `item` — the join / join_domains transforms only know flat strings. An
  // object without a declared `item` stringifies to "[object Object]", which
  // no scope accepts: fail-closed, never a guessed property.
  const arr = listItems(m, value);
  switch (m.transform) {
    case 'length':
      execution[m.field] = arr.length;
      break;
    case 'join':
      execution[m.field] = arr.join(',');
      break;
    case 'join_domains': {
      const domains = [...new Set(arr.map(email => {
        const at = email.lastIndexOf('@');
        return at >= 0 ? email.substring(at + 1).toLowerCase() : email.toLowerCase();
      }))].sort();
      execution[m.field] = domains.join(',');
      break;
    }
    default:
      execution[m.field] = typeof value === 'number' ? value : String(value);
  }
}

/**
 * The execution-context fields a tool call's arguments produce under the
 * manifest's `executionMapping`. An absent or null argument produces nothing.
 *
 * Several arguments that map to the same field through a list transform
 * (`length`, `join`, `join_domains`) COMBINE: their items are gathered first,
 * in mapping order, and the transform runs once over all of them — the count
 * is the sum, the lists the union. So an email's `cc` is counted and
 * scope-checked together with its `to`, instead of one overwriting the other.
 * Every other mapping (direct copy, divisor) applies as before; the manifest
 * loader refuses one of those shared by two arguments.
 */
export function mapExecutionArgs(
  executionMapping: Record<string, MappingValue>,
  args: Record<string, unknown>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const lists = new Map<string, { transform: string; items: string[] }>();
  for (const [argName, mapping] of Object.entries(executionMapping)) {
    const value = args[argName];
    if (value === undefined || value === null) continue;
    if (typeof mapping === 'string') {
      // Direct mapping: argName → contextField
      out[mapping] = typeof value === 'number' ? value : String(value);
      continue;
    }
    const entries: MappingEntry[] = Array.isArray(mapping) ? mapping : [mapping];
    for (const m of entries) {
      if (m.transform && LIST_TRANSFORMS.includes(m.transform) && !m.divisor) {
        // Gather this argument's items (read by its own declared `item`);
        // the transform runs once below, over every argument on this field.
        const acc = lists.get(m.field) ?? { transform: m.transform, items: [] };
        acc.items.push(...listItems(m, value));
        lists.set(m.field, acc);
      } else {
        applyMapping(m, value, out);
      }
    }
  }
  for (const [field, { transform, items }] of lists) applyMapping({ field, transform }, items, out);
  return out;
}

// ─── numeric fields that arrive as a string ───────────────────────────────────────────────────

/**
 * Parse a numeric string for a numeric execution-context field. Accepts only a PLAIN decimal: optional leading "-", digits, optional
 * "." + digits. Rejects exponents, hex, empty or padded strings, thousands separators and the non-finite literals. `undefined` on
 * anything that fails, so the caller leaves the original string in place.
 */
export function parseNumericString(value: string): number | undefined {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The field names a profile's own `executionContextSchema` declares as `source: 'declared'` and `constraint.type: 'number'`. */
export function declaredNumericFields(profile: unknown): Set<string> {
  const out = new Set<string>();
  const fields = (profile as { executionContextSchema?: { fields?: Record<string, { source?: string; constraint?: { type?: string } }> } } | null | undefined)?.executionContextSchema?.fields;
  if (!fields) return out;
  for (const [name, def] of Object.entries(fields)) {
    if (def?.source === 'declared' && def.constraint?.type === 'number') out.add(name);
  }
  return out;
}

/** In place: a string in a declared numeric field becomes the number it plainly is; anything else is left as it is. */
export function coerceNumericFields(profile: unknown, execution: Record<string, string | number>): void {
  for (const field of declaredNumericFields(profile)) {
    const value = execution[field];
    if (typeof value !== 'string') continue;
    const parsed = parseNumericString(value);
    if (parsed !== undefined) execution[field] = parsed;
  }
}
