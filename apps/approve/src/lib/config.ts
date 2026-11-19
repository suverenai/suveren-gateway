/**
 * What this build is told at build time. Nothing here is a secret (DEC-1): the address of the Authority Server the
 * app talks to, and the commit it was built from. The CSP's `connect-src` names the same origin.
 */

/** https only; http only for a local Authority Server on the dev and test lanes (same rule as hap-core's pairing QR). */
const AS_URL_SHAPE = /^(https:\/\/[^\s/?#]+|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/;

/** The configured Authority Server origin without a trailing slash, or throws: a build with a wrong address must not start. */
export function asUrlOf(raw: string | undefined): string {
  const url = (raw ?? 'https://suveren.ai').replace(/\/+$/, '');
  if (!AS_URL_SHAPE.test(url)) throw new Error('VITE_AS_URL must be an https:// address (http:// only for localhost)');
  return url;
}

export const AS_URL: string = asUrlOf(import.meta.env.VITE_AS_URL);
export const BUILD_COMMIT: string = import.meta.env.VITE_BUILD_COMMIT ?? 'dev';

/** Epoch seconds. Injected into the flows so tests can move the clock. */
export const NOW = (): number => Math.floor(Date.now() / 1000);
