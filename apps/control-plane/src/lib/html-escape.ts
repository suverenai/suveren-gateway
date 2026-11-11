/**
 * Escape text for an HTML text node or a double-quoted attribute.
 *
 * Every value the control plane puts into an HTML response it builds by hand
 * goes through this — above all anything from the request (query string) or
 * from another server (an OAuth provider's token answer). Without it the
 * OAuth callback page reflected `?error=<script>…` back as live script
 * (security review 2026-11, finding A1).
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The small page the OAuth popup shows when it is done. `heading` and
 * `detail` are plain text; they are escaped here, so callers cannot forget.
 * `closeAfterMs` closes the popup on its own (the person started the sign-in
 * from the Integrations card, which is still open behind it).
 */
export function oauthResultPage(heading: string, detail?: string, closeAfterMs?: number): string {
  const p = detail === undefined ? '' : `<p>${escapeHtml(detail)}</p>`;
  const close = closeAfterMs === undefined
    ? ''
    : `<script>setTimeout(()=>window.close(),${Math.trunc(closeAfterMs)})</script>`;
  return `<html><body><h2>${escapeHtml(heading)}</h2>${p}${close}</body></html>`;
}
