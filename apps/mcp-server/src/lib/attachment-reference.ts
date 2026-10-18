/**
 * Attachment/insert references — the AI-facing shape for "a document or a
 * system-read value, named by pointer" (suveren-invoicing-plan.md §6/§7).
 *
 * The AI never carries file bytes or types a value it read from another
 * system; it only names `{connector, kind, id}` (an attachment reference) or
 * `{placeholder, connector, kind, id}` (an insert reference — same shape,
 * plus which `{{placeholder}}` in its own text to fill). Two independent
 * refusals enforce this:
 *   1. Schema — `withAttachmentAndInsertSchema` REPLACES/ADDS the relevant
 *      argument's schema with exactly these fields, `additionalProperties:
 *      false`, before the AI ever sees the tool (integration-manager.ts).
 *   2. Shape — a schema is advice an agent may ignore (the same reasoning
 *      `blockedArgs` documents), so `validateDocumentReference`/
 *      `validateInsertReference` re-check the actual call and refuse any
 *      extra key (e.g. a smuggled `contentBase64`) rather than silently
 *      dropping it.
 */

import type { DocumentReference, InsertReference } from './tool-gating-types';

const REF_KEYS = ['connector', 'kind', 'id'] as const;
const INSERT_KEYS = ['placeholder', 'connector', 'kind', 'id'] as const;

/** JSON Schema for one attachment reference — connector/kind/id only. */
export const ATTACHMENT_REFERENCE_SCHEMA = {
  type: 'object',
  description:
    'A reference to a document already known to a connector — never file bytes. ' +
    'The gateway fetches, shows, and seals the file; it is never carried here.',
  properties: {
    connector: { type: 'string', description: 'The integration id that can provide this document (e.g. "erp").' },
    kind: { type: 'string', description: 'The document kind that connector declares (e.g. "invoice-pdf").' },
    id: { type: 'string', description: 'The id of the specific record (e.g. the invoice id).' },
  },
  required: ['connector', 'kind', 'id'],
  additionalProperties: false,
} as const;

/** JSON Schema for one insert reference — same as above, plus `placeholder`. */
export const INSERT_REFERENCE_SCHEMA = {
  type: 'object',
  description:
    'A value read from another system to insert into this text — never typed here. ' +
    'The gateway reads it, checks its source, and replaces the placeholder before sending.',
  properties: {
    placeholder: { type: 'string', description: 'The exact {{placeholder}} token in the text to replace.' },
    connector: { type: 'string', description: 'The integration id that can provide this value (e.g. "mollie").' },
    kind: { type: 'string', description: 'The value kind that connector declares (e.g. "payment-link").' },
    id: { type: 'string', description: 'The id of the specific record (e.g. the payment link id).' },
  },
  required: ['placeholder', 'connector', 'kind', 'id'],
  additionalProperties: false,
} as const;

/**
 * Replaces/adds the attachments argument's schema (reference-only array) and
 * adds an `insert` argument's schema, per the tool's resolved gating
 * (tool-gating-types.ts `attachmentsArg`/`insertFields`). A no-op when
 * neither is declared. Called once, at tool discovery (integration-
 * manager.ts) — same stage as `withoutBlockedArgs`/`withSourceLink`.
 */
export function withAttachmentAndInsertSchema(
  schema: Record<string, unknown>,
  gating: { attachmentsArg?: string; insertFields?: string[] } | undefined,
): Record<string, unknown> {
  if (!gating?.attachmentsArg && !gating?.insertFields?.length) return schema;
  const props = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
  if (gating.attachmentsArg) {
    props[gating.attachmentsArg] = {
      type: 'array',
      description: 'Attachments by reference only — see items.',
      items: ATTACHMENT_REFERENCE_SCHEMA,
    };
  }
  if (gating.insertFields?.length) {
    props.insert = {
      type: 'array',
      description: 'Values to insert into this call’s text by reference only — see items.',
      items: INSERT_REFERENCE_SCHEMA,
    };
  }
  return { ...schema, properties: props };
}

export type ReferenceShapeError =
  | { code: 'NOT_AN_ARRAY'; message: string }
  | { code: 'NOT_AN_OBJECT'; index: number; message: string }
  | { code: 'EXTRA_FIELD'; index: number; field: string; message: string }
  | { code: 'MISSING_FIELD'; index: number; field: string; message: string };

function validateOne<K extends string>(
  value: unknown,
  index: number,
  keys: readonly K[],
): { ok: true; value: Record<K, string> } | { ok: false; error: ReferenceShapeError } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      error: { code: 'NOT_AN_OBJECT', index, message: `item ${index} must be an object with exactly ${keys.join(', ')}` },
    };
  }
  const obj = value as Record<string, unknown>;
  const extra = Object.keys(obj).filter(k => !(keys as readonly string[]).includes(k));
  if (extra.length > 0) {
    return {
      ok: false,
      error: {
        code: 'EXTRA_FIELD',
        index,
        field: extra[0],
        message:
          `item ${index} carries "${extra[0]}", which this reference does not accept. ` +
          `Only ${keys.join(', ')} are allowed — a reference never carries file bytes or a typed value.`,
      },
    };
  }
  for (const k of keys) {
    if (typeof obj[k] !== 'string' || (obj[k] as string).length === 0) {
      return {
        ok: false,
        error: { code: 'MISSING_FIELD', index, field: k, message: `item ${index}.${k} must be a non-empty string` },
      };
    }
  }
  return { ok: true, value: obj as Record<K, string> };
}

/**
 * Validates an incoming `attachments` argument value as an array of
 * {@link DocumentReference}. Returns the array or the FIRST shape error
 * found — refused, never dropped silently.
 */
export function validateDocumentReferences(
  value: unknown,
): { ok: true; refs: DocumentReference[] } | { ok: false; error: ReferenceShapeError } {
  if (value === undefined) return { ok: true, refs: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: { code: 'NOT_AN_ARRAY', message: 'attachments must be an array of references' } };
  }
  const refs: DocumentReference[] = [];
  for (let i = 0; i < value.length; i++) {
    const r = validateOne(value[i], i, REF_KEYS);
    if (!r.ok) return r;
    refs.push(r.value);
  }
  return { ok: true, refs };
}

/**
 * Validates an incoming `insert` argument value as an array of
 * {@link InsertReference}. Same refusal discipline as
 * {@link validateDocumentReferences}.
 */
export function validateInsertReferences(
  value: unknown,
): { ok: true; refs: InsertReference[] } | { ok: false; error: ReferenceShapeError } {
  if (value === undefined) return { ok: true, refs: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: { code: 'NOT_AN_ARRAY', message: 'insert must be an array of references' } };
  }
  const refs: InsertReference[] = [];
  for (let i = 0; i < value.length; i++) {
    const r = validateOne(value[i], i, INSERT_KEYS);
    if (!r.ok) return r;
    refs.push(r.value);
  }
  return { ok: true, refs };
}
