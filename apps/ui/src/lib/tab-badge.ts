/**
 * Tab title + favicon badge for pending reviews.
 *
 * Presence, never content: the title carries a count and nothing else. Tab
 * titles are readable by any extension with the `tabs` permission and are
 * visible in screen shares and window switchers — "Approve €4,000 to…" must
 * never appear there.
 *
 * The badged favicon is built as an SVG data URI rather than by drawing into a
 * canvas. Canvas would work, but `toDataURL()` throws a SecurityError the moment
 * the source image taints the canvas, which is an irritating failure to
 * diagnose for zero benefit — and the SVG route stays crisp at any DPI.
 *
 * The geometry is the small-size master (wider gaps, thinner stroke) that
 * public/favicon.svg uses, so the badged and unbadged icons are the same mark.
 */

const BASE_TITLE = 'Suveren';
const FAVICON_HREF = '/favicon.svg';

/** Small-size master, matching public/favicon.svg. */
const RING = 'M 104.94 61.85 A 41 41 0 1 1 45.39 27.47';
const KEY = { x1: 74.54, y1: 22.74, x2: 94.46, y2: 34.24 };
const STROKE = 14;

/** Amber, so the dot reads as "waiting on you" rather than as an error. */
const DOT_COLOR = '#f59e0b';

/**
 * The tab title for a given count.
 *
 * Pure, and exported, so the "count and nothing else" rule is testable without
 * a DOM — this repo's UI tests run without one.
 */
export function formatTabTitle(count: number): string {
  const n = normalizeCount(count);
  return n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
}

/** Negative, fractional and non-finite counts all mean "no badge". */
export function normalizeCount(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function badgedFaviconHref(): string {
  // `currentColor` is meaningless in a favicon, so the mark is drawn twice —
  // once per colour scheme — and the media query picks one. Same trick as
  // public/favicon.svg.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
<path class="m" d="${RING}"/>
<line class="m" x1="${KEY.x1}" y1="${KEY.y1}" x2="${KEY.x2}" y2="${KEY.y2}"/>
<circle cx="103" cy="103" r="25" fill="${DOT_COLOR}"/>
<style>.m{stroke:#111111;stroke-width:${STROKE};fill:none;stroke-linecap:round}@media (prefers-color-scheme:dark){.m{stroke:#ffffff;stroke-width:13.3}}</style>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function iconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

/**
 * Reflect the pending count in the tab.
 *
 * A dot on the favicon, not a number: two digits are illegible at 16px, and the
 * count is already in the title for anyone who wants it.
 */
export function setTabBadge(count: number): void {
  const n = normalizeCount(count);

  document.title = formatTabTitle(n);

  const link = iconLink();
  if (!link) return;
  const next = n > 0 ? badgedFaviconHref() : FAVICON_HREF;
  // Avoid rewriting an identical href — Safari re-fetches on every assignment.
  if (link.getAttribute('href') !== next) link.setAttribute('href', next);
}

/** Back to a clean tab — on logout, or when the count can no longer be trusted. */
export function clearTabBadge(): void {
  setTabBadge(0);
}
