/**
 * What an EMPTY value of a list scope field allows — the one place the gateway
 * says it. The enforcement (apps/mcp-server attachment-policy.ts, plus hap-core's
 * generic scope check) and the mandate change card (mandate-change.ts) both read
 * it here, so the card's More/Less can never disagree with what the gateway does.
 *
 * The rules, as enforced:
 *  - hap-core's generic `subset` check skips a mandate whose value is empty: no
 *    restriction, so an empty list allows ANYTHING. A field with
 *    `constraint.requiredFor` follows the same rule: it only refuses a call that
 *    hides the value while the mandate SETS one; an empty mandate value is still
 *    unrestricted.
 *  - a list of document sources is fail-closed: the gateway refuses every
 *    attachment whose source the mandate does not list, so an empty list allows
 *    NOTHING (no attachments).
 *
 * A document-source list is recognised by the format its profile declares
 * (`format: "connector:kind"`), never by its field name: email@0.9 calls it
 * `allowed_attachment_sources`, and any other profile may declare one under
 * another name.
 *
 * A test (apps/mcp-server/test/scope-empty-rule.test.ts) runs the real
 * enforcement for every list field of every shipped profile and compares it
 * with {@link emptyScopeMeans}. Pure, no node imports: the browser bundle uses it.
 */

/** The profile field `format` of a list of document sources: comma-separated `connector:kind` pairs. */
export const DOCUMENT_SOURCES_FORMAT = 'connector:kind';

export type EmptyMeans = 'anything' | 'nothing';

/** True for a scope field that lists document sources — by its declared format, never by its name. */
export function isDocumentSourcesField(def: unknown): boolean {
  return !!def && typeof def === 'object' && (def as { format?: unknown }).format === DOCUMENT_SOURCES_FORMAT;
}

/** The slice of a profile {@link documentSourcesField} reads — AgentProfile fits. */
export interface ScopeSchemaLike {
  scopeSchema?: { fields?: Record<string, unknown> };
}

/**
 * The name of the profile's document-source scope field: the first scope field
 * (in declaration order) whose format is {@link DOCUMENT_SOURCES_FORMAT}.
 * Undefined when the profile declares none — such a profile carries no
 * attachments at all.
 */
export function documentSourcesField(profile: ScopeSchemaLike | undefined): string | undefined {
  for (const [name, def] of Object.entries(profile?.scopeSchema?.fields ?? {})) {
    if (isDocumentSourcesField(def)) return name;
  }
  return undefined;
}

/** What an empty value of this list scope field allows, exactly as the gateway enforces it. */
export function emptyScopeMeans(def: unknown): EmptyMeans {
  return isDocumentSourcesField(def) ? 'nothing' : 'anything';
}
