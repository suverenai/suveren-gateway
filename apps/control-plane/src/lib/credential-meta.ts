/**
 * What the browser may learn about a stored credential.
 *
 * The old GET /vault/credentials/:name returned every decrypted field on every
 * settings-page load — the masking was CSS. Now the browser gets, per field,
 * either the value (fields the manifest declares as `text`) or a recognition
 * hint (everything else): enough to tell WHICH secret is stored, never the
 * secret. "Is it the right one?" is answered by using it, not by reading it.
 *
 * Fail closed, twice:
 * - A field the manifest does not declare is secret. OAuth flows store tokens
 *   (e.g. gmail's refreshToken) that appear in no manifest field list.
 * - A credential with no manifest at all (manifests unreachable, unknown name)
 *   is all-secret.
 */

export interface SecretHint {
  /**
   * Recognition hint, e.g. "GOCSPX-…a3f9", or null when the value is too short
   * to give anything away safely. Format: public prefix (if any) + last 4.
   */
  preview: string | null;
}

export interface CredentialView {
  configured: true;
  fieldNames: string[];
  /** Declared-`text` fields only — the UI renders these as values. */
  fields: Record<string, string>;
  /** Everything else: recognition hints, never values. */
  secrets: Record<string, SecretHint>;
  /** When the credential was last written, if known. */
  updatedAt?: string;
}

/**
 * Reserved key holding write metadata inside the encrypted blob. Stripped from
 * every response and from the merge surface; harmless downstream because env
 * mapping only picks declared keys.
 */
export const META_KEY = '__updatedAt';

/**
 * Below this length a secret gets no characters at all — last-4 of an
 * 8-character password is a third of it. Length-based, not name-based, so the
 * rule is generic rather than a field list someone forgets to extend.
 */
const MIN_PREVIEW_LENGTH = 12;

/**
 * Public format markers worth keeping: "sk-", "GOCSPX-", "github_pat_", …
 * Multi-part prefixes are real (github_pat_), so the pattern accepts several
 * separator-joined words, capped at 12 characters total.
 */
const PREFIX_RE = /^([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*[-_])/;
const MAX_PREFIX_LENGTH = 12;

/** Characters that must remain hidden after everything shown. */
const HIDDEN_FLOOR = 12;

export function previewSecret(value: string): SecretHint {
  if (value.length < MIN_PREVIEW_LENGTH) return { preview: null };
  // What matters is what stays HIDDEN: total minus prefix minus the last 4.
  // "sk-" on a 16-char key would leave 9 hidden characters — the prefix is
  // dropped rather than the floor lowered.
  const match = PREFIX_RE.exec(value)?.[1] ?? '';
  const prefix =
    match &&
    match.length <= MAX_PREFIX_LENGTH &&
    value.length - match.length - 4 >= HIDDEN_FLOOR
      ? match
      : '';
  if (!prefix && value.length - 4 < 8) return { preview: null };
  return { preview: `${prefix}…${value.slice(-4)}` };
}

/**
 * ai-config is not an integration manifest, so its field types are declared
 * here — the single non-manifest credential the UI edits. Anything not listed
 * is secret, like everywhere else.
 */
const AI_CONFIG_TEXT_FIELDS = new Set(['provider', 'endpoint', 'model']);

type ManifestLike = {
  id?: unknown;
  credentials?: { fields?: Array<{ key?: unknown; type?: unknown }> };
};

/** Field names declared `text` for this credential name; everything else is secret. */
export function textFieldsFor(name: string, manifests: unknown): Set<string> {
  if (name === 'ai-config') return AI_CONFIG_TEXT_FIELDS;
  const list = Array.isArray(manifests) ? (manifests as ManifestLike[]) : [];
  const manifest = list.find(m => m?.id === name);
  const out = new Set<string>();
  for (const f of manifest?.credentials?.fields ?? []) {
    if (typeof f?.key === 'string' && f?.type === 'text') out.add(f.key);
  }
  return out;
}

/** Build the response shape from a decrypted credential. */
export function credentialView(
  cred: Record<string, string>,
  textFields: Set<string>,
): CredentialView {
  const fields: Record<string, string> = {};
  const secrets: Record<string, SecretHint> = {};
  let updatedAt: string | undefined;

  for (const [key, value] of Object.entries(cred)) {
    if (key === META_KEY) {
      updatedAt = value;
      continue;
    }
    if (textFields.has(key)) fields[key] = value;
    else secrets[key] = previewSecret(value);
  }

  return {
    configured: true,
    fieldNames: Object.keys(fields).concat(Object.keys(secrets)),
    fields,
    secrets,
    ...(updatedAt ? { updatedAt } : {}),
  };
}
