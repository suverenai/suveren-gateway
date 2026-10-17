const MAX_NAME_LENGTH = 40;

/**
 * Get the display name for a profile.
 * Prefers the explicit `name` field; falls back to extracting from the ID.
 *
 * No per-profile override lives here (removed 2026-10-17, UI spec §13.1 —
 * "a profile's name is its area"): a profile's own `name` field IS what a
 * person reads, never a hardcoded second name for it. `delegation@0.5`'s own
 * name is "Setup"; callers that want the NEWEST version's name regardless of
 * which version a given mandate pins use `lib/area.ts`'s `resolveAreaName`
 * instead of passing a stale `name` here.
 */
export function profileDisplayName(profileId: string, name?: string): string {
  const lastSlash = profileId.lastIndexOf('/');
  const segment = lastSlash >= 0 ? profileId.slice(lastSlash + 1) : profileId;
  const atIndex = segment.indexOf('@');
  const raw = atIndex >= 0 ? segment.slice(0, atIndex) : segment;
  if (name) return name.slice(0, MAX_NAME_LENGTH);
  // Fallback: extract from ID — "github.com/.../charge@0.4" → "Charge"
  return (raw.charAt(0).toUpperCase() + raw.slice(1)).slice(0, MAX_NAME_LENGTH);
}
