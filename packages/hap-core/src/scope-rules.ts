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
 *  - the attachment sources are fail-closed: the gateway refuses every
 *    attachment whose source the mandate does not list, so an empty list allows
 *    NOTHING (no attachments).
 *
 * A test (apps/mcp-server/test/scope-empty-rule.test.ts) runs the real
 * enforcement for every list field of every shipped profile and compares it
 * with {@link emptyScopeMeans}. Pure, no node imports: the browser bundle uses it.
 */

/** The email scope field listing the document sources a mandate may attach (`connector:kind`). */
export const ATTACHMENT_SOURCES_FIELD = 'allowed_attachment_sources';

/** List scope fields the gateway enforces fail-closed: empty allows nothing. */
const EMPTY_ALLOWS_NOTHING: ReadonlySet<string> = new Set([ATTACHMENT_SOURCES_FIELD]);

export type EmptyMeans = 'anything' | 'nothing';

/** What an empty value of this list scope field allows, exactly as the gateway enforces it. */
export function emptyScopeMeans(field: string): EmptyMeans {
  return EMPTY_ALLOWS_NOTHING.has(field) ? 'nothing' : 'anything';
}
