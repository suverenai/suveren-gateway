/**
 * Attachment source policy — "which document sources/kinds a mandate may
 * attach" (suveren-invoicing-plan.md §6, item 4: "New email-profile limit:
 * which sources/kinds may be attached").
 *
 * The `email` profile declares this scope field from version 0.9 onward
 * (`hap-profiles/email/0.9.profile.json`'s `allowed_attachment_sources` —
 * comma-separated `connector:kind`, empty/absent = no attachments). A
 * mandate on an OLDER email profile (<=0.8, no such field) refuses every
 * attachment by construction: {@link attachmentSourcesFieldDeclared} is
 * false for it, so {@link isAttachmentSourceAllowed} always returns
 * `allowed: false` below, regardless of what the caller passes as
 * `allowedSourcesValue` — generic (field name is the only profile-specific
 * thing, declared once below), so it also activates automatically for any
 * OTHER profile that later adds the same field.
 *
 * Deliberately NOT relying solely on hap-core's generic scope `subset`
 * check (gatekeeper.ts's `checkScopeConstraints`): that check SKIPS
 * enforcement when the mandate's own scope value is absent/empty
 * (`if (boundValue === undefined || boundValue === '') continue;`) — correct
 * for `allowed_recipients`/`allowed_domains` (optional, "no restriction"
 * when unset) but wrong here, where absence must mean "no attachments
 * allowed," never "unrestricted." This module is the explicit, fail-closed
 * backstop; tool-proxy.ts ALSO sets the `allowed_attachment_sources`
 * execution-context field so the generic subset check runs too, as
 * defence in depth, for every mandate that DOES set the scope value.
 */

export const ATTACHMENT_SOURCES_FIELD = 'allowed_attachment_sources';

/** The shape of a profile this module needs — narrower than hap-core's full `Profile`. */
export interface AttachmentPolicyProfileLike {
  scopeSchema?: { fields?: Record<string, unknown> };
}

/** True once a profile declares the {@link ATTACHMENT_SOURCES_FIELD} scope field. */
export function attachmentSourcesFieldDeclared(profile: AttachmentPolicyProfileLike | undefined): boolean {
  return !!profile?.scopeSchema?.fields?.[ATTACHMENT_SOURCES_FIELD];
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
  if (!attachmentSourcesFieldDeclared(profile)) {
    return {
      allowed: false,
      reason:
        `Profile "${profileId}" does not yet declare "${ATTACHMENT_SOURCES_FIELD}" — no mandate can ` +
        `authorize an attachment until it does. Refusing by default (suveren-invoicing-plan.md §6).`,
    };
  }
  const allowedSet = new Set(
    (allowedSourcesValue ?? '').split(',').map(s => s.trim()).filter(Boolean),
  );
  const key = `${ref.connector}:${ref.kind}`;
  if (!allowedSet.has(key)) {
    return {
      allowed: false,
      reason: `"${key}" is not in this mandate's "${ATTACHMENT_SOURCES_FIELD}" (${allowedSourcesValue || '(none)'}).`,
    };
  }
  return { allowed: true, reason: '' };
}
