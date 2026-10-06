const MAX_NAME_LENGTH = 40;

/**
 * Display-name overrides by short profile id — what a person reads, never the
 * id. `delegation@0.1` is the gateway's test-setup tool group (propose
 * mandates and the brief, read setup guides); "Test Setup" says that plainly.
 * Applied here so every surface (cards, filters, picker, wizard) agrees.
 */
const DISPLAY_NAME_OVERRIDE: Readonly<Record<string, string>> = {
  delegation: 'Test Setup',
};

/**
 * Get the display name for a profile.
 * Prefers the explicit `name` field; falls back to extracting from the ID.
 */
export function profileDisplayName(profileId: string, name?: string): string {
  const lastSlash = profileId.lastIndexOf('/');
  const segment = lastSlash >= 0 ? profileId.slice(lastSlash + 1) : profileId;
  const atIndex = segment.indexOf('@');
  const raw = atIndex >= 0 ? segment.slice(0, atIndex) : segment;
  const override = DISPLAY_NAME_OVERRIDE[raw.toLowerCase()];
  if (override) return override;
  if (name) return name.slice(0, MAX_NAME_LENGTH);
  // Fallback: extract from ID — "github.com/.../charge@0.4" → "Charge"
  return (raw.charAt(0).toUpperCase() + raw.slice(1)).slice(0, MAX_NAME_LENGTH);
}
