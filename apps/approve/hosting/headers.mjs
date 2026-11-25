// The HTTP headers the production host sends for the phone approval app (apps/approve).
// One source for the hosting guide (docs/phone-app-hosting.md), the release check server
// (scripts/serve-release.mjs) and the tests. Provider-neutral: any static host that can set
// response headers and one fallback rule can serve the app.
//
// Rules (DEC-112):
//   - index.html and sw.js are never cached: an update must reach the next open (sw.js answers the
//     shell from the network first; a cached sw.js or index.html would pin an old build).
//   - /assets/* carry a content hash in their name and are cached for a year, immutable.
//   - everything else (manifest, icons, fonts, favicon) is revalidated on every use.
//   - a path without a file extension is the app (SPA fallback to index.html); a missing file WITH an
//     extension is a 404, never index.html (a missing script must fail, not run HTML as JavaScript).

/** Content Security Policy (device-keys plan section 8, plus font-src for the self-hosted fonts and
 *  connect-src 'self' for the service worker's own shell refresh). `asOrigin` is the Authority Server. */
export function contentSecurityPolicy(asOrigin) {
  const as = new URL(asOrigin).origin;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${as}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** What the app may ask the browser for: the camera (pairing QR), passkeys, writing the clipboard. Nothing else. */
export const PERMISSIONS_POLICY = [
  'camera=(self)',
  'publickey-credentials-create=(self)',
  'publickey-credentials-get=(self)',
  'clipboard-write=(self)',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'bluetooth=()',
  'serial=()',
  'hid=()',
].join(', ');

/** Sent on every response. */
export function securityHeaders(asOrigin) {
  return {
    'Content-Security-Policy': contentSecurityPolicy(asOrigin),
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

export const NO_STORE = 'no-store';
export const REVALIDATE = 'no-cache';
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Cache-Control for a served path (after the SPA fallback: the fallback serves index.html → no-store). */
export function cacheControlFor(servedPath) {
  if (servedPath === '/index.html' || servedPath === '/sw.js') return NO_STORE;
  if (servedPath.startsWith('/assets/')) return IMMUTABLE;
  return REVALIDATE;
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** The fallback rule: which file a request path is answered with, or null for a 404. */
export function resolveServedPath(requestPath, fileExists) {
  const path = requestPath === '/' ? '/index.html' : requestPath;
  if (fileExists(path)) return path;
  const last = path.split('/').pop() ?? '';
  return last.includes('.') ? null : '/index.html';
}
