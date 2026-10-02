/**
 * Maps a manifest's `icon` key to the emoji shown next to its name. Shared
 * between IntegrationCard (full card) and IntegrationsPage (compact paused
 * rows) so the two never show a different icon for the same connector.
 */
const ICON_MAP: Record<string, string> = {
  card: '\u{1F4B3}',
  mail: '✉️',
};

export function integrationIcon(iconKey: string): string {
  return ICON_MAP[iconKey] ?? '\u{1F527}';
}
