/**
 * Attachment source policy — "which document sources/kinds a mandate may
 * attach" (suveren-invoicing-plan.md §6, item 4: "New email-profile limit:
 * which sources/kinds may be attached").
 *
 * No shipped profile declares this scope field yet (checked against
 * `hap-profiles/email/0.8.profile.json` 2026-10-17 — only `allowed_recipients`/
 * `allowed_domains`). Per instruction, this module enforces a SAFE DEFAULT
 * — no attachments allowed at all — rather than editing hap-profiles, and
 * is written generically (field name is the only profile-specific thing,
 * declared once below) so it activates automatically the moment a profile
 * adds the field. See this module's header comment in the commit / the
 * task report for the exact draft JSON to add to hap-profiles.
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
