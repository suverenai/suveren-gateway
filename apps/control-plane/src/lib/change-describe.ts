/**
 * What the phone is shown of a change to a connector login (device-keys plan 7 phone path, 20.4: "the phone shows what changes:
 * the old value and the new one, where the old one is not a secret"). Built from the exact change the gateway hashes
 * (routes/vault.ts, routes/oauth-flow.ts) and the connector manifests; never from anything the AI wrote.
 *
 *   connector  the manifest's display name, else the login's id
 *   fields     for a replacement that names fields (`credentials` put-merge, `services` put-replace): each field it changes.
 *              A field the manifest declares `text` (lib/credential-meta.ts `textFieldsFor`) carries its old and new value;
 *              every other field is a secret and carries none. A removal and a sign-in change name no field.
 *
 * Generic: which fields are secret comes from the manifest, not from a field name.
 *
 * Never a silently shortened view (independent review L5): when the phone could not be shown everything the change hash covers
 * (more fields than fit, a value too long to show, a field name or value that is not text, an OAuth change that replaces other
 * logins than this one, a change of a shape this file does not know), the answer is null and the phone path is refused
 * (`change_not_describable`); the password stays.
 */
import type { ChangeDetail, ChangeKind } from './change-confirmation';
import { META_KEY, textFieldsFor } from './credential-meta';

const MAX_VALUE = 500;
const MAX_FIELDS = 40;

type ManifestLike = { id?: unknown; name?: unknown; credentials?: { fields?: Array<{ key?: unknown; label?: unknown }> } };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const shortStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\u0000');

/** The fields a change writes, when it names any. */
function changedFields(change: unknown): Record<string, unknown> | null | 'unknown' {
  if (!isObj(change)) return 'unknown';
  if (change.route === 'credentials' && change.op === 'put-merge' && isObj(change.fields)) return change.fields;
  if (change.route === 'services' && change.op === 'put-replace' && isObj(change.credentials)) return change.credentials;
  return 'unknown';
}

/** An OAuth sign-in again names no field; it is shown only when it replaces this login and no other. */
function oauthOnlyThis(change: unknown, name: string): boolean {
  if (!isObj(change) || change.route !== 'oauth') return false;
  const replaces = Array.isArray(change.replaces) ? change.replaces : null;
  return change.integration === name && change.group === null && !!replaces && replaces.every((r) => r === name);
}

export function describeChange(
  kind: ChangeKind, name: string, change: unknown, manifests: unknown, stored: (name: string) => Record<string, string> | null,
): ChangeDetail | null {
  const list = Array.isArray(manifests) ? (manifests as ManifestLike[]) : [];
  const manifest = list.find((m) => m?.id === name);
  const connector = shortStr(manifest?.name, 128) ? manifest!.name as string : name.slice(0, 128);
  if (kind === 'remove') return { connector, fields: [] };
  if (oauthOnlyThis(change, name)) return { connector, fields: [] };
  const written = changedFields(change);
  if (written === 'unknown' || written === null) return null;
  const keys = Object.keys(written).filter((k) => k !== META_KEY);
  if (keys.length > MAX_FIELDS || keys.some((k) => !shortStr(k, 128))) return null;
  const text = textFieldsFor(name, manifests);
  const labels = new Map<string, string>();
  for (const f of manifest?.credentials?.fields ?? []) if (typeof f?.key === 'string' && shortStr(f?.label, 128)) labels.set(f.key, f.label as string);
  let old: Record<string, string> | null = null;
  try { old = stored(name); } catch { old = null; }
  const fields: ChangeDetail['fields'] = [];
  for (const key of keys.sort()) {
    const label = labels.get(key);
    const base = { key, ...(label ? { label } : {}) };
    if (!text.has(key)) { fields.push({ ...base, secret: true }); continue; }
    const next = written[key];
    // A text field's new value is shown in full, or the change is not described at all.
    if (typeof next !== 'string' || next.length > MAX_VALUE || next.includes('\u0000')) return null;
    const before = old?.[key];
    const entry: ChangeDetail['fields'][number] = { ...base, secret: false, new: next };
    if (typeof before === 'string') {
      if (before.length > MAX_VALUE || before.includes('\u0000')) return null;
      entry.old = before;
    }
    // A text field sent with the value it already has is no change.
    if (entry.old === entry.new) continue;
    fields.push(entry);
  }
  return { connector, fields };
}
