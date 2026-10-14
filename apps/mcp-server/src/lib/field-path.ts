/**
 * AU10 §8.1 — field helpers (doc/au10-request-context.md §8.1). Resolves a
 * {@link FieldPath} (a plain dotted path, unchanged, or a {@link FieldPathObject}
 * — `path`/`where`/`pick`/`parse`) against a connector's read result.
 *
 * Generic — no connector name in code. Written for Gmail's header-list shape
 * (`payload.headers` = `[{name, value}, ...]`) but usable by any connector
 * whose read result needs the same "pick the row whose field matches, then
 * take one of its fields" shape.
 */
import { getByDottedPath } from './read-gate';
import type { FieldPath, FieldPathParse } from './tool-gating-types';

/** Case-insensitive for strings (doc §8.1); exact for everything else. */
function matchesWhere(element: unknown, where: Record<string, string | number | boolean>): boolean {
  if (element === null || typeof element !== 'object' || Array.isArray(element)) return false;
  const row = element as Record<string, unknown>;
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (typeof expected === 'string' && typeof actual === 'string') {
      return expected.toLowerCase() === actual.toLowerCase();
    }
    return actual === expected;
  });
}

/** RFC 5322 `"Name" <a@b>` or a bare address — doc §8.1's `address.name` /
 *  `address.email`. A bare address has no name: `address.name` resolves to
 *  undefined rather than the whole string. */
function parseAddress(value: string, which: 'address.name' | 'address.email'): string | undefined {
  const m = value.match(/^(.*?)<([^<>]+)>\s*$/);
  if (m) {
    const email = m[2].trim();
    if (which === 'address.email') return email || undefined;
    const name = m[1].trim().replace(/^"(.*)"$/, '$1').trim();
    return name || undefined;
  }
  if (which === 'address.email') return value.trim() || undefined;
  return undefined;
}

/** ms since 1970 (number or numeric string) -> ISO timestamp — doc §8.1's `epoch-ms`. */
function parseEpochMs(value: unknown): string | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return new Date(n).toISOString();
}

function applyParse(value: unknown, parse: FieldPathParse): unknown {
  if (value === undefined || value === null) return undefined;
  if (parse === 'epoch-ms') return parseEpochMs(value);
  if (typeof value !== 'string') return undefined;
  return parseAddress(value, parse);
}

/**
 * Resolves one {@link FieldPath} against `record`. A plain string behaves
 * exactly as `getByDottedPath` always has. An object: read `path`; if `where`
 * is set, the value at `path` must be a list — the first element matching
 * every `where` field wins (no match -> undefined, never a guess); `pick`
 * then reads one field of that element (or of the plain `path` value, when
 * there was no `where`); `parse` reshapes the result last.
 */
export function resolveFieldPath(record: unknown, fieldPath: FieldPath | undefined): unknown {
  if (fieldPath === undefined) return undefined;
  if (typeof fieldPath === 'string') return getByDottedPath(record, fieldPath);

  let value = getByDottedPath(record, fieldPath.path);
  if (fieldPath.where) {
    if (!Array.isArray(value)) return undefined;
    value = value.find((el) => matchesWhere(el, fieldPath.where!));
    if (value === undefined) return undefined;
  }
  if (fieldPath.pick !== undefined) {
    value = getByDottedPath(value, fieldPath.pick);
  }
  if (fieldPath.parse) {
    value = applyParse(value, fieldPath.parse);
  }
  return value;
}
