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
 */
import type { ChangeDetail, ChangeKind } from './change-confirmation';
import { META_KEY, textFieldsFor } from './credential-meta';

const MAX_VALUE = 500;
const MAX_FIELDS = 40;

type ManifestLike = { id?: unknown; name?: unknown; credentials?: { fields?: Array<{ key?: unknown; label?: unknown }> } };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const shortStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\u0000');

/** The fields a change writes, when it names any. */
function changedFields(change: unknown): Record<string, unknown> | null {
  if (!isObj(change)) return null;
  if (change.route === 'credentials' && change.op === 'put-merge' && isObj(change.fields)) return change.fields;
  if (change.route === 'services' && change.op === 'put-replace' && isObj(change.credentials)) return change.credentials;
  return null;
}

export function describeChange(
  kind: ChangeKind, name: string, change: unknown, manifests: unknown, stored: (name: string) => Record<string, string> | null,
): ChangeDetail {
  const list = Array.isArray(manifests) ? (manifests as ManifestLike[]) : [];
  const manifest = list.find((m) => m?.id === name);
  const connector = shortStr(manifest?.name, 128) ? manifest!.name as string : name.slice(0, 128);
  if (kind === 'remove') return { connector, fields: [] };
  const written = changedFields(change);
  if (!written) return { connector, fields: [] };
  const text = textFieldsFor(name, manifests);
  const labels = new Map<string, string>();
  for (const f of manifest?.credentials?.fields ?? []) if (typeof f?.key === 'string' && shortStr(f?.label, 128)) labels.set(f.key, f.label as string);
  let old: Record<string, string> | null = null;
  try { old = stored(name); } catch { old = null; }
  const fields: ChangeDetail['fields'] = [];
  for (const key of Object.keys(written).sort()) {
    if (key === META_KEY || !shortStr(key, 128) || fields.length >= MAX_FIELDS) continue;
    const label = labels.get(key);
    const base = { key, ...(label ? { label } : {}) };
    if (!text.has(key)) { fields.push({ ...base, secret: true }); continue; }
    const next = written[key];
    const before = old?.[key];
    const entry: ChangeDetail['fields'][number] = { ...base, secret: false };
    if (typeof next === 'string' && next.length <= MAX_VALUE) entry.new = next;
    if (typeof before === 'string' && before.length <= MAX_VALUE) entry.old = before;
    // A text field sent with the value it already has is no change.
    if (entry.new !== undefined && entry.old === entry.new) continue;
    fields.push(entry);
  }
  return { connector, fields };
}
