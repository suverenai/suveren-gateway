/**
 * Areas (UI spec §13, signed off 2026-10-17) — "areas first, tools second".
 * An area IS a profile: what a mandate grants, whichever tool carries it
 * out. Two things define an area, both resolved by the gateway, never
 * guessed from a tool name or the AI:
 *
 *  - its NAME — the profile's own `name`, from the NEWEST version of that
 *    profile family the gateway knows about, also for a mandate signed
 *    under an older one (§13.1). `resolveAreaName` is the one helper every
 *    surface uses for this.
 *  - its ICON — the icon its serving connector's manifest declares (`icon`
 *    in content/integrations/*.json, for the manifest's own `profile`),
 *    mapped to the UI's drawn set; an area no connector declares (the
 *    gateway's built-ins, an area served only by a per-tool override) falls
 *    back to the fixed map by short id below. Never a profile field.
 *    `areaIcon` is the one helper for this; the actual paths live in
 *    `components/AreaIcon.tsx`. (Andreas, 2026-11-11: icon from the
 *    connector, generic for new connectors.)
 *
 * Pure, dependency-free logic only — no fetching (see lib/area-catalog.ts
 * for the cached catalog fetch + hook that supplies `AreaCatalogEntry[]`).
 */
import { shortProfileId } from './profile-identity';
import { profileDisplayName } from './profile-display';

/** The fixed set of area icons the gateway draws (mockup
 *  `suveren-as/docs/ui-spec/areas.html`, symbols `a-customers` … `a-setup`).
 *  An id the gateway doesn't recognise gets `'unknown'` — a neutral icon,
 *  never guessed. */
export type AreaIconName =
  | 'customers'
  | 'email'
  | 'payments'
  | 'sales'
  | 'calendar'
  | 'records'
  | 'publishing'
  | 'deployments'
  | 'purchasing'
  | 'invoicing'
  | 'masterData'
  | 'reports'
  | 'setup'
  | 'files'
  | 'unknown';

/** Fallback: short profile id → area icon, for an area no connector
 *  manifest declares an icon for (§13.1, never a profile-declared field). */
const AREA_ICON_BY_SHORT_ID: Readonly<Record<string, AreaIconName>> = {
  customers: 'customers',
  email: 'email',
  charge: 'payments',
  sales: 'sales',
  calendar: 'calendar',
  records: 'records',
  publish: 'publishing',
  deploy: 'deployments',
  purchase: 'purchasing',
  reporting: 'reports',
  delegation: 'setup',
  invoicing: 'invoicing',
  'master-data': 'masterData',
};

/**
 * A connector manifest's `icon` name → the UI's drawn area icon. The names
 * are the manifests' own; each maps to the drawing that area already had
 * before icons came from the connector, so no existing area changes look.
 * A manifest icon not listed here has no UI drawing: its area falls back to
 * the fixed map, then to `'unknown'` — never guessed.
 */
export const AREA_ICON_BY_MANIFEST_ICON: Readonly<Record<string, AreaIconName>> = {
  users: 'customers',
  mail: 'email',
  card: 'payments',
  calendar: 'calendar',
  folder: 'records',
  share: 'publishing',
  wrench: 'deployments',
  briefcase: 'sales',
  'file-text': 'files',
};

/** Minimal manifest shape for `registerConnectorAreaIcons`. */
export interface ManifestIconEntry {
  id: string;
  profile?: string | null;
  icon?: string | null;
}

/** Area short id → the icon its connector declares. Filled from the gateway's manifests. */
let connectorAreaIcons: ReadonlyMap<string, AreaIconName> = new Map();

/**
 * Take each area's icon from the connector manifests: the icon a manifest
 * declares belongs to the manifest's own `profile` (not to areas a per-tool
 * override adds — those keep their own). Two manifests for one area with
 * different icons: the one with the alphabetically first id wins, so the
 * answer never depends on fetch order. Replaces what was registered before.
 */
export function registerConnectorAreaIcons(manifests: readonly ManifestIconEntry[]): void {
  const next = new Map<string, AreaIconName>();
  for (const m of [...manifests].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!m.profile || !m.icon) continue;
    const icon = AREA_ICON_BY_MANIFEST_ICON[m.icon];
    const area = shortProfileId(m.profile);
    if (icon && !next.has(area)) next.set(area, icon);
  }
  connectorAreaIcons = next;
}

/** The area icon for a profile id: its connector's declared icon, else the
 *  fixed fallback by short id, else `'unknown'`. */
export function areaIcon(profileId: string): AreaIconName {
  const shortId = shortProfileId(profileId);
  return connectorAreaIcons.get(shortId) ?? AREA_ICON_BY_SHORT_ID[shortId] ?? 'unknown';
}

/** Minimal shape of a catalog entry — whatever `spClient.listProfiles()`
 *  (or `getProfile()`) returns satisfies this; kept narrow so pure tests
 *  don't need the real wire type. */
export interface AreaCatalogEntry {
  id: string;
  name?: string;
}

/** `"customers@0.9"` → `"0.9"`; no `@` → `""` (sorts last). */
function profileVersion(id: string): string {
  const at = id.indexOf('@');
  return at >= 0 ? id.slice(at + 1) : '';
}

/**
 * The area's name: the profile's own `name`, from the NEWEST version of
 * that profile family the catalog knows — also for a mandate signed under
 * an older version (§13.1). Numeric version compare, so "0.10" sorts after
 * "0.9". Falls back to today's behaviour (capitalised short id) when the
 * catalog carries no version of this profile family at all, or no `name`.
 */
export function resolveAreaName(profileId: string, catalog: readonly AreaCatalogEntry[]): string {
  const shortId = shortProfileId(profileId);
  const newest = catalog
    .filter(p => shortProfileId(p.id) === shortId)
    .sort((a, b) => profileVersion(b.id).localeCompare(profileVersion(a.id), undefined, { numeric: true }))[0];
  return profileDisplayName(profileId, newest?.name);
}

/**
 * Whether the quiet "Mandate: <title>" line (§13.2) should show at all —
 * not when there is no title, and not when the title only repeats the area
 * name (case-insensitive): that line would say nothing the area line above
 * it didn't already say.
 */
export function showMandateLine(mandateTitle: string | undefined | null, area: string): boolean {
  const t = mandateTitle?.trim();
  if (!t) return false;
  return t.toLowerCase() !== area.trim().toLowerCase();
}

/** `?area=` → the profile short id to filter on, or `null` for "All". Any
 *  value is accepted as a short id (an unknown one simply matches nothing,
 *  same "never hide on an unrecognised param" rule as `parseTicketFilter`). */
export function parseAreaFilter(raw: string | null | undefined): string | null {
  return raw && raw.trim() ? raw.trim() : null;
}

/** Whether a profile id falls under the given area filter — `null` (All)
 *  matches everything. */
export function matchesAreaFilter(profileId: string, area: string | null): boolean {
  return area === null || shortProfileId(profileId) === area;
}
