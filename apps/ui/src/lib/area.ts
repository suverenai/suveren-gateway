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
 *  - its ICON — chosen from the profile's short id (§13.1), never a
 *    declared profile field. `areaIcon` is the one helper for this; the
 *    actual paths live in `components/AreaIcon.tsx`.
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
  | 'unknown';

/** Short profile id → area icon (§13.1 — "chosen by the gateway from the
 *  profile id", never a profile-declared field). */
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

/** The area icon for a profile id. Unknown short id → `'unknown'`. */
export function areaIcon(profileId: string): AreaIconName {
  return AREA_ICON_BY_SHORT_ID[shortProfileId(profileId)] ?? 'unknown';
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
