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
  signInGroup?: { id: string; name: string };
}

export interface ManifestLike {
  id: string;
  oauth?: OAuthLike | null;
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

/** What ONE sign-in requests: every member's scopes, deduplicated, first-seen order. */
export function unionScopes(group: SignInGroup): string[] {
  const out: string[] = [];
  for (const m of group.members) for (const s of m.oauth?.scopes ?? []) if (!out.includes(s)) out.push(s);
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
