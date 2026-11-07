/**
 * Shared sign-in groups (control-plane side).
 *
 * A manifest declares `oauth.signInGroup: { id, name }` to say "I share ONE
 * sign-in with every other connector that declares the same id" (Gmail and
 * Google Calendar: one Google account). Nothing here guesses a group from an
 * authUrl or a clientId; no group is ever named in code.
 *
 * Storage: the group has its own vault entry, `sign-in:<id>`, holding the
 * OAuth client settings, the token (under the manifest's `tokenStorage` key)
 * and the `_oauth*` metadata. A member's credentials are its OWN vault entry
 * with that entry laid over it (`effectiveCredentials`) - the MCP server and
 * every env mapping keep reading `<memberId>.<key>` exactly as before.
 *
 * Migration: a member's own entry is never rewritten by a group sign-in. Where
 * the group has no token yet, the member's own client + token stay in force, so
 * an install with two separate Google tokens keeps working with no re-sign-in.
 */

export const GROUP_CREDENTIAL_PREFIX = 'sign-in:';

export interface OAuthLike {
  scopes: string[];
  credentialKeys: Record<string, string>;
  tokenStorage: string;
  /** Provider's token revocation endpoint (RFC 7009). Optional. */
  revokeUrl?: string;
  signInGroup?: { id: string; name: string };
  /** The sign-in applies only while this data-source option is chosen (see manifest-loader). */
  forOption?: { mode: string; adapter?: string };
}

export interface ManifestLike {
  id: string;
  oauth?: OAuthLike | null;
  /** The mode choice `oauth.forOption` refers to. */
  simulation?: { field: string; default: string } | null;
  adapterField?: string;
}

export interface SignInGroup {
  id: string;
  name: string;
  members: ManifestLike[];
}

export function groupCredentialName(groupId: string): string {
  return `${GROUP_CREDENTIAL_PREFIX}${groupId}`;
}

/** The group id if `name` is a group's vault entry name, else null. */
export function parseGroupCredentialName(name: string): string | null {
  return name.startsWith(GROUP_CREDENTIAL_PREFIX) ? name.slice(GROUP_CREDENTIAL_PREFIX.length) || null : null;
}

function asList(manifests: unknown): ManifestLike[] {
  return Array.isArray(manifests) ? (manifests as ManifestLike[]) : [];
}

export function getGroup(manifests: unknown, groupId: string): SignInGroup | null {
  const members = asList(manifests).filter(m => m?.oauth?.signInGroup?.id === groupId);
  if (members.length === 0) return null;
  return { id: groupId, name: members[0].oauth!.signInGroup!.name, members };
}

/** The group a connector belongs to, or null (also null for an unknown id). */
export function groupOfMember(manifests: unknown, integrationId: string): SignInGroup | null {
  const m = asList(manifests).find(x => x?.id === integrationId);
  const gid = m?.oauth?.signInGroup?.id;
  return gid ? getGroup(manifests, gid) : null;
}

const norm = (v: string | undefined) => (v ?? '').trim().toLowerCase();

/**
 * Does this connector's sign-in apply with these saved settings? Always, unless
 * the manifest scopes it to one data-source option (`oauth.forOption`): then
 * only while the saved mode (and adapter) are that option. Mode unset means the
 * manifest's default, exactly as the card reads it.
 */
export function oauthApplies(m: ManifestLike, own: Record<string, string> | null | undefined): boolean {
  const f = m.oauth?.forOption;
  if (!m.oauth) return false;
  if (!f) return true;
  if (!m.simulation) return false;
  const mode = norm(own?.[m.simulation.field]) || norm(m.simulation.default);
  if (mode !== norm(f.mode)) return false;
  if (f.adapter === undefined) return true;
  return !!m.adapterField && norm(own?.[m.adapterField]) === norm(f.adapter);
}

/**
 * What ONE sign-in requests: the scopes of every member whose sign-in applies,
 * deduplicated, first-seen order. A member scoped to an option that is not
 * chosen (`ownOf` gives its saved settings) asks for nothing - Calendar alone
 * never requests Gmail access just because Email could use it.
 */
export function unionScopes(
  group: SignInGroup,
  ownOf: (memberId: string) => Record<string, string> | null = () => null,
): string[] {
  const out: string[] = [];
  for (const m of group.members) {
    if (!oauthApplies(m, ownOf(m.id))) continue;
    for (const s of m.oauth?.scopes ?? []) if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Keys of a credential entry that belong to the sign-in (client, token, `_oauth*` metadata). */
function isSignInKey(key: string, oauth: OAuthLike): boolean {
  return key.startsWith('_oauth') || key === oauth.tokenStorage || Object.values(oauth.credentialKeys).includes(key);
}

function pickSignIn(cred: Record<string, string>, oauth: OAuthLike): Record<string, string> {
  return Object.fromEntries(Object.entries(cred).filter(([k]) => isSignInKey(k, oauth)));
}

/**
 * The credentials a member actually runs on: its own entry, with the group's
 * sign-in fields laid over it - but ONLY once the group holds a token. A group
 * entry with just client settings (saved before the first sign-in) must not
 * replace a member's working client, because that member's own token is bound
 * to its own client.
 */
export function effectiveCredentials(
  own: Record<string, string> | null,
  groupCred: Record<string, string> | null,
  oauth: OAuthLike | null | undefined,
): Record<string, string> | null {
  if (!oauth || !groupCred?.[oauth.tokenStorage]) return own;
  return { ...(own ?? {}), ...pickSignIn(groupCred, oauth) };
}

/** `cred` without its token and `_oauth*` metadata (client settings stay). */
export function withoutSignIn(cred: Record<string, string>, oauth: OAuthLike): Record<string, string> {
  return Object.fromEntries(
    Object.entries(cred).filter(([k]) => !(k.startsWith('_oauth') || k === oauth.tokenStorage)),
  );
}

export interface SignInClient { clientId: string; clientSecret: string }

/**
 * Which OAuth client a group sign-in starts with: the group's own settings,
 * else (migration) the requesting member's, else any other member's complete
 * pair. The pair is then copied into the group entry on success.
 */
export function resolveGroupClient(
  group: SignInGroup,
  requestedId: string,
  groupCred: Record<string, string> | null,
  ownOf: (memberId: string) => Record<string, string> | null,
): SignInClient | null {
  const pick = (cred: Record<string, string> | null, oauth: OAuthLike): SignInClient | null => {
    const idKey = oauth.credentialKeys.clientId ?? 'clientId';
    const secretKey = oauth.credentialKeys.clientSecret ?? 'clientSecret';
    return cred?.[idKey] && cred?.[secretKey] ? { clientId: cred[idKey], clientSecret: cred[secretKey] } : null;
  };
  const anyOauth = group.members[0].oauth!;
  const fromGroup = pick(groupCred, anyOauth);
  if (fromGroup) return fromGroup;
  const ordered = [
    ...group.members.filter(m => m.id === requestedId),
    ...group.members.filter(m => m.id !== requestedId),
  ];
  for (const m of ordered) {
    const found = pick(ownOf(m.id), m.oauth!);
    if (found) return found;
  }
  return null;
}

/**
 * What to push to the MCP server after vault entry `name` was written or
 * loaded: `[serviceId, credentials]` pairs, group overlay already applied.
 * - a connector id        -> that connector, effective
 * - a group entry         -> every member, effective (the group entry itself
 *                            is never pushed: no connector is named after it)
 * - anything else         -> unchanged
 */
export function credentialsToPush(
  name: string,
  manifests: unknown,
  getCredential: (name: string) => Record<string, string> | null,
): Array<[string, Record<string, string>]> {
  const groupId = parseGroupCredentialName(name);
  if (groupId) {
    const group = getGroup(manifests, groupId);
    if (!group) return [];
    const groupCred = getCredential(name);
    const out: Array<[string, Record<string, string>]> = [];
    for (const m of group.members) {
      const eff = effectiveCredentials(getCredential(m.id), groupCred, m.oauth);
      if (eff) out.push([m.id, eff]);
    }
    return out;
  }
  const own = getCredential(name);
  const member = groupOfMember(manifests, name);
  if (!member) return own ? [[name, own]] : [];
  const m = member.members.find(x => x.id === name)!;
  const eff = effectiveCredentials(own, getCredential(groupCredentialName(member.id)), m.oauth);
  return eff ? [[name, eff]] : [];
}

// ─── scope coverage ─────────────────────────────────────────────────────────

const USERINFO_PREFIX = 'https://www.googleapis.com/auth/userinfo.';

/**
 * Providers report a granted scope under more than one name. Google's
 * "email" / "profile" are the same permission as ".../auth/userinfo.email" /
 * ".../userinfo.profile", and the token response may use either form. Both
 * sides are compared by their short form.
 */
export function normalizeScope(scope: string): string {
  return scope.startsWith(USERINFO_PREFIX) ? scope.slice(USERINFO_PREFIX.length) : scope;
}

/**
 * Scopes a member's manifest needs that the sign-in did not grant. `granted` is
 * the provider's space-separated `scope` string as stored in `_oauthScopes`;
 * undefined/empty means "not recorded" (a legacy per-connector token) -> [],
 * never a false alarm.
 */
export function missingScopes(granted: string | undefined, required: string[]): string[] {
  if (!granted || !granted.trim()) return [];
  const have = new Set(granted.split(/\s+/).filter(Boolean).map(normalizeScope));
  return required.filter(r => !have.has(normalizeScope(r)));
}

// ─── group lifecycle helpers ────────────────────────────────────────────────

/**
 * After the group token is stored: the members' OWN tokens and sign-in
 * metadata are removed (their client settings stay). Called only after a
 * successful group sign-in, so a failed one leaves old tokens working.
 * Returns the member ids that had a token to retire.
 */
export function retireMemberSignIns(
  group: SignInGroup,
  get: (name: string) => Record<string, string> | null,
  set: (name: string, cred: Record<string, string>) => void,
): string[] {
  const retired: string[] = [];
  for (const m of group.members) {
    const own = get(m.id);
    if (!own || !m.oauth) continue;
    const stripped = withoutSignIn(own, m.oauth);
    if (Object.keys(stripped).length !== Object.keys(own).length) {
      set(m.id, stripped);
      retired.push(m.id);
    }
  }
  return retired;
}

/** Would saving `incoming` change the group's OAuth client (which invalidates its token)? */
export function changesGroupClient(
  group: SignInGroup,
  prior: Record<string, string> | null,
  incoming: Record<string, string>,
): boolean {
  const keys = Object.values(group.members[0].oauth!.credentialKeys);
  return !!prior?.[group.members[0].oauth!.tokenStorage] &&
    keys.some(k => prior[k] !== undefined && incoming[k] !== undefined && prior[k] !== incoming[k]);
}

export interface RevokeOutcome { target: string; ok: boolean; error?: string }

/**
 * Best-effort RFC 7009 revocation of distinct tokens. Never throws, never
 * returns or logs a token. `tokens` maps a label (group id / member id) to the token.
 */
export async function revokeTokens(
  revokeUrl: string | undefined,
  tokens: Array<{ target: string; token: string }>,
  doFetch: typeof fetch = fetch,
): Promise<RevokeOutcome[]> {
  const seen = new Set<string>();
  const out: RevokeOutcome[] = [];
  for (const { target, token } of tokens) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    if (!revokeUrl) { out.push({ target, ok: false, error: 'no revokeUrl declared in the manifest' }); continue; }
    try {
      const r = await doFetch(revokeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
      if (r.ok) out.push({ target, ok: true });
      else {
        const body = await r.json().catch(() => ({})) as { error?: string; error_description?: string };
        out.push({ target, ok: false, error: body.error_description || body.error || `HTTP ${r.status}` });
      }
    } catch (err) {
      out.push({ target, ok: false, error: err instanceof Error ? err.message : 'revocation request failed' });
    }
  }
  return out;
}
