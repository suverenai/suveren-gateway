/**
 * Attachment source policy — "which document sources/kinds a mandate may
 * attach" (suveren-invoicing-plan.md §6, item 4: "New email-profile limit:
 * which sources/kinds may be attached").
 *
 * The field is recognised by its declared format, `connector:kind`
 * (@hap/core/scope-rules), never by its name: email@0.9 declares it as
 * `allowed_attachment_sources` (comma-separated `connector:kind`,
 * empty/absent = no attachments), and any other profile that declares a
 * scope field with that format takes part the same way, whatever it calls
 * it. A mandate on a profile with no such field (email <=0.8) refuses every
 * attachment by construction: {@link attachmentSourcesFieldDeclared} is
 * false for it, so {@link isAttachmentSourceAllowed} always returns
 * `allowed: false` below, regardless of what the caller passes as
 * `allowedSourcesValue`.
 *
 * Deliberately NOT relying solely on hap-core's generic scope `subset`
 * check (gatekeeper.ts's `checkScopeConstraints`): that check SKIPS
 * enforcement when the mandate's own scope value is absent/empty
 * (`if (boundValue === undefined || boundValue === '') continue;`) — correct
 * for `allowed_recipients`/`allowed_domains` (optional, "no restriction"
 * when unset) but wrong here, where absence must mean "no attachments
 * allowed," never "unrestricted." This module is the explicit, fail-closed
 * backstop; tool-proxy.ts ALSO sets the execution-context field of the
 * same name (email@0.9: `allowed_attachment_sources`) so the generic subset check runs too, as
 * defence in depth, for every mandate that DOES set the scope value.
 */

import { documentSourcesField, emptyScopeMeans, DOCUMENT_SOURCES_FORMAT } from '@hap/core/scope-rules';

/** The shape of a profile this module needs — narrower than hap-core's full `Profile`. */
export interface AttachmentPolicyProfileLike {
  scopeSchema?: { fields?: Record<string, unknown> };
}

/**
 * The name of the profile's attachment-source scope field: the one it declares
 * with `format: "connector:kind"` (@hap/core/scope-rules) — recognised by that
 * format, never by its name. Undefined when the profile declares none.
 */
export function attachmentSourcesField(profile: AttachmentPolicyProfileLike | undefined): string | undefined {
  return documentSourcesField(profile);
}

/** True once a profile declares an attachment-source scope field. */
export function attachmentSourcesFieldDeclared(profile: AttachmentPolicyProfileLike | undefined): boolean {
  return attachmentSourcesField(profile) !== undefined;
}

/**
 * A mandate's value of its profile's attachment-source field — the string as
 * signed, or undefined when the profile declares no such field or the mandate
 * leaves it unset.
 */
export function attachmentSourcesValue(
  profile: AttachmentPolicyProfileLike | undefined,
  context: Record<string, unknown> | undefined,
): string | undefined {
  const field = attachmentSourcesField(profile);
  if (!field) return undefined;
  const v = context?.[field];
  return typeof v === 'string' ? v : undefined;
}

export interface AttachmentSourceCheck {
  allowed: boolean;
  reason: string;
}

/**
 * Checks ONE attachment reference's `connector:kind` against the profile's
 * declared allow-list (comma-separated, same convention as
 * `allowed_recipients`/`allowed_domains` — see email/0.8.profile.json). Pure:
 * takes the profile shape and the mandate's resolved scope VALUE directly
 * (never calls `getProfile`/reads an authorization itself), so it is
 * testable against a hypothetical future profile without touching
 * hap-profiles.
 */
export function isAttachmentSourceAllowed(
  profileId: string,
  profile: AttachmentPolicyProfileLike | undefined,
  allowedSourcesValue: string | undefined,
  ref: { connector: string; kind: string },
): AttachmentSourceCheck {
  const field = attachmentSourcesField(profile);
  if (!field) {
    return {
      allowed: false,
      reason:
        `Profile "${profileId}" does not yet declare an attachment-source field (format "${DOCUMENT_SOURCES_FORMAT}") — no mandate can ` +
        `authorize an attachment — a mandate on a newer email profile that lists the source is needed.`,
    };
  }
  const allowedSet = new Set(
    (allowedSourcesValue ?? '').split(',').map(s => s.trim()).filter(Boolean),
  );
  const key = `${ref.connector}:${ref.kind}`;
  // An empty list allows nothing (scope-rules.ts): the same rule the card shows.
  if (allowedSet.size === 0 && emptyScopeMeans(profile?.scopeSchema?.fields?.[field]) !== 'nothing') {
    return { allowed: true, reason: '' };
  }
  if (!allowedSet.has(key)) {
    return {
      allowed: false,
      reason: `"${key}" is not in this mandate's "${field}" (${allowedSourcesValue || '(none)'}).`,
    };
  }
  return { allowed: true, reason: '' };
}

/**
 * The candidate mandates that allow EVERY attachment reference of a call.
 * Used before a mandate is selected: with several mandates for the same
 * profile family (e.g. an old email@0.8 and a new email@0.9 that lists the
 * source), selection must only consider the ones that can carry the
 * attachments — found 2026-10-18 on the first real invoice email, where an
 * email@0.8 mandate was picked and the call refused although an email@0.9
 * mandate allowed it. `refusal` is the first candidate's reason when none do.
 */
export function candidatesAllowingAttachments<A extends { profileId: string; context?: Record<string, unknown> }>(
  candidates: A[],
  refs: Array<{ connector: string; kind: string }>,
  profileOf: (profileId: string) => AttachmentPolicyProfileLike | undefined,
): { allowed: A[]; refusal?: string } {
  if (refs.length === 0) return { allowed: candidates };
  let refusal: string | undefined;
  const allowed = candidates.filter((c) => {
    const profile = profileOf(c.profileId);
    const value = attachmentSourcesValue(profile, c.context);
    for (const ref of refs) {
      const check = isAttachmentSourceAllowed(c.profileId, profile, value, ref);
      if (!check.allowed) { refusal ??= check.reason; return false; }
    }
    return true;
  });
  return { allowed, refusal: allowed.length ? undefined : refusal };
}
