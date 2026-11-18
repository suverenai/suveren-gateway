/**
 * What the gateway sends the Authority Server to prove who it is.
 *
 * Today that is the session cookie the AS set at sign-in (a string like
 * `hap-session=...`). A gateway that set up device keys signs in by its device
 * key instead (lib/device-signin.ts) and holds a bearer token. Both live in the
 * one slot the vault already has (`vault.getSpCookie()`); this module is the one
 * place that says how each is put on a request, so no caller builds a `Cookie`
 * header from a string that is really a token.
 *
 * A real cookie header value is `name=value`; a bearer credential always starts
 * with `Bearer ` (a cookie name cannot contain a space), so the two never mix.
 */

const BEARER_PREFIX = 'Bearer ';
/** What the AS issues: `randomUUID()`. Anything else is refused, so a token can never carry a header break. */
const TOKEN_SHAPE = /^[A-Za-z0-9-]{1,128}$/;

/** The credential string for a device-session token. Throws on a token that is not safe to put in a header. */
export function bearerCredential(token: string): string {
  if (!TOKEN_SHAPE.test(token)) throw new Error('not a device session token');
  return `${BEARER_PREFIX}${token}`;
}

export function isBearerCredential(credential: string | null | undefined): credential is string {
  return typeof credential === 'string' && credential.startsWith(BEARER_PREFIX);
}

/** The header that carries `credential` to the Authority Server: `Authorization` for a token, `Cookie` for a session cookie (unchanged). */
export function asAuthHeaders(credential: string): Record<string, string> {
  return isBearerCredential(credential) ? { Authorization: credential } : { Cookie: credential };
}
