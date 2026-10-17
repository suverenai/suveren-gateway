/**
 * Inserted values — resolves an AI-supplied {@link InsertReference}
 * (`{placeholder, connector, kind, id}`) to a value READ from another
 * system (e.g. a Mollie payment link) and substitutes it into the action's
 * own text, BEFORE anything downstream of that text runs — content binding,
 * scope checks, the approval card (suveren-invoicing-plan.md §5/§7).
 *
 * The AI never types the value itself; it only names which placeholder to
 * fill and where to read the value from. Two checks make that safe:
 *   1. The source connector declares `values.<kind>` — the gateway always
 *      does the read itself, never trusts a value handed to it directly.
 *   2. `allowedHosts` — the read value must be an `https://` URL on a host
 *      the manifest declares for this value kind, so a compromised or
 *      misconfigured downstream connector cannot smuggle an arbitrary URL
 *      into a human-approved email under the guise of "the Mollie link".
 */

import type { IntegrationManager } from './integration-manager';
import { getManifest } from './manifest-loader';
import { readPreview } from './preview';
import { substitute } from './request-context';
import { getByDottedPath } from './read-gate';
import type { InsertReference } from './tool-gating-types';

export type InsertResolutionError =
  | { code: 'UNKNOWN_CONNECTOR'; message: string }
  | { code: 'UNDECLARED_KIND'; message: string }
  | { code: 'UNAVAILABLE'; message: string }
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'MALFORMED_RESULT'; message: string }
  | { code: 'NOT_HTTPS'; message: string }
  | { code: 'DISALLOWED_HOST'; message: string };

export interface ResolvedInsert {
  placeholder: string;
  value: string;
  connector: string;
  kind: string;
}

export type InsertResolutionResult =
  | { ok: true; insert: ResolvedInsert }
  | { ok: false; error: InsertResolutionError };

/** True when `host` equals `allowed` or is a subdomain of it. */
function hostAllowed(host: string, allowed: string): boolean {
  const h = host.toLowerCase();
  const a = allowed.toLowerCase();
  return h === a || h.endsWith(`.${a}`);
}

/** Resolves and validates ONE insert reference's value. */
export async function resolveInsertValue(
  integrationManager: IntegrationManager,
  ref: InsertReference,
): Promise<InsertResolutionResult> {
  const manifest = getManifest(ref.connector);
  if (!manifest) {
    return { ok: false, error: { code: 'UNKNOWN_CONNECTOR', message: `"${ref.connector}" is not a known connector.` } };
  }
  const valueConfig = manifest.values?.[ref.kind];
  if (!valueConfig) {
    return {
      ok: false,
      error: { code: 'UNDECLARED_KIND', message: `Connector "${ref.connector}" declares no insertable value kind "${ref.kind}".` },
    };
  }

  const args = substitute(valueConfig.args, { id: ref.id });
  const read = await readPreview(integrationManager, ref.connector, valueConfig.tool, args);
  if (read.status === 'not_found') {
    return { ok: false, error: { code: 'NOT_FOUND', message: read.message ?? `No value "${ref.kind}"/"${ref.id}" on "${ref.connector}".` } };
  }
  if (read.status !== 'ok') {
    return { ok: false, error: { code: 'UNAVAILABLE', message: read.message ?? `Connector "${ref.connector}" could not be reached.` } };
  }
  const body = read.body.structured;
  if (!body || typeof body !== 'object') {
    return { ok: false, error: { code: 'MALFORMED_RESULT', message: `Value read for "${ref.connector}:${ref.kind}" returned no structured result.` } };
  }
  const raw = getByDottedPath(body, valueConfig.path);
  if (typeof raw !== 'string' || !raw) {
    return { ok: false, error: { code: 'MALFORMED_RESULT', message: `Value read for "${ref.connector}:${ref.kind}" has nothing at "${valueConfig.path}".` } };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: { code: 'NOT_HTTPS', message: `Value "${raw}" is not a valid URL.` } };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: { code: 'NOT_HTTPS', message: `Value "${raw}" is not an https URL.` } };
  }
  if (!valueConfig.allowedHosts.some(h => hostAllowed(url.hostname, h))) {
    return {
      ok: false,
      error: {
        code: 'DISALLOWED_HOST',
        message: `Value "${raw}" is on host "${url.hostname}", which "${ref.connector}:${ref.kind}" does not allow (allowed: ${valueConfig.allowedHosts.join(', ')}).`,
      },
    };
  }

  return { ok: true, insert: { placeholder: ref.placeholder, value: raw, connector: ref.connector, kind: ref.kind } };
}

export type ApplyInsertsError =
  | { code: 'UNMATCHED_PLACEHOLDER'; placeholder: string; message: string }
  | { code: 'PLACEHOLDER_NOT_FOUND'; placeholder: string; message: string };

/** Every `{{...}}`-shaped token in a string, de-duplicated, in first-seen order. */
function placeholdersIn(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\{\{[^{}]+\}\}/g)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      found.push(m[0]);
    }
  }
  return found;
}

/**
 * Substitutes every resolved insert into the declared text fields.
 * Refuses (never silently ignores) on either mismatch direction:
 *   - a `{{placeholder}}` present in the text with no matching insert
 *     (`PLACEHOLDER_NOT_FOUND` is backwards from the caller's perspective —
 *     named for what's missing: an insert for it. See codes below.)
 *   - an insert reference whose placeholder appears in NONE of the fields.
 * Returns the substituted fields, so the caller can write them back into
 * the action's own args before anything downstream reads them.
 */
export function applyInserts(
  fields: Record<string, string>,
  inserts: ResolvedInsert[],
): { ok: true; fields: Record<string, string> } | { ok: false; error: ApplyInsertsError } {
  const allPlaceholders = new Set<string>();
  for (const text of Object.values(fields)) {
    for (const p of placeholdersIn(text)) allPlaceholders.add(p);
  }

  const insertByPlaceholder = new Map(inserts.map(i => [i.placeholder, i] as const));

  // Every placeholder actually IN the text must have a matching insert.
  for (const p of allPlaceholders) {
    if (!insertByPlaceholder.has(p)) {
      return {
        ok: false,
        error: {
          code: 'UNMATCHED_PLACEHOLDER',
          placeholder: p,
          message: `The text contains "${p}" but no "insert" entry names that placeholder.`,
        },
      };
    }
  }
  // Every declared insert must be used somewhere.
  for (const insert of inserts) {
    if (!allPlaceholders.has(insert.placeholder)) {
      return {
        ok: false,
        error: {
          code: 'PLACEHOLDER_NOT_FOUND',
          placeholder: insert.placeholder,
          message: `"insert" names placeholder "${insert.placeholder}", which does not appear in the text.`,
        },
      };
    }
  }

  const out: Record<string, string> = {};
  for (const [field, text] of Object.entries(fields)) {
    let replaced = text;
    for (const insert of inserts) {
      replaced = replaced.split(insert.placeholder).join(insert.value);
    }
    out[field] = replaced;
  }
  return { ok: true, fields: out };
}
