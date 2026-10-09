/**
 * What the approval screen shows for a proposal's arguments — for every tool, the
 * same way (simulation setup S8, generic by design):
 *
 * 1. Without any declaration: arguments labelled from their name, the tool's own
 *    description as a hint, values formatted by type (long text as a block, lists
 *    as lists). The ticket reference and anything secret-looking are not shown.
 * 2. Optionally, per tool (manifest or built-in `approvalView`): a label and a
 *    display kind from a fixed set — `markdown`, `list`, `money`, `profile`,
 *    `profile-limits`, `profile-scope`. The last two show an object of limits or
 *    scope against the profile named in another argument, with the profile's own
 *    names and units, the way the mandate screen does.
 *
 * Purely presentational. What is approved is the proposal itself.
 */
import type { AgentProfile } from '@hap/core';
import { formatUnit } from './bound-format';

export type ApprovalViewKind = 'text' | 'markdown' | 'list' | 'money' | 'profile' | 'profile-limits' | 'profile-scope';
export type ApprovalView = Record<string, { label?: string; kind?: ApprovalViewKind; currencyArg?: string; profileArg?: string }>;
export interface ToolDisplay { inputSchema?: Record<string, unknown>; approvalView?: ApprovalView }

export type RowKind = ApprovalViewKind | 'object';
export interface ArgRow {
  key: string;
  label: string;
  kind: RowKind;
  value: unknown;
  /** The tool's own description of the argument. */
  hint?: string;
  /** money: the currency taken from `currencyArg`. */
  currency?: string;
  /** profile*: the profile id or short name taken from `profileArg` (or the value itself for `profile`). */
  profileRef?: string;
}

/** Never shown: the gateway's ticket reference and secret-looking values. */
export const HIDDEN_ARG_KEYS = new Set([
  'ticket_id', 'apiKey', 'api_key', 'accessToken', 'access_token', 'password', 'secret', 'signature',
  '_imagePreview',
]);

export function humanizeKey(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function inferKind(value: unknown): RowKind {
  if (Array.isArray(value)) return 'list';
  if (value && typeof value === 'object') return 'object';
  if (typeof value === 'string' && (value.includes('\n') || value.length > 120)) return 'markdown';
  return 'text';
}

export function argRows(args: Record<string, unknown>, display?: ToolDisplay): ArgRow[] {
  const view = display?.approvalView ?? {};
  const props = ((display?.inputSchema as { properties?: Record<string, { description?: string }> } | undefined)?.properties) ?? {};
  // Declared order first, then the schema's order, then anything else the call carries.
  const order = [...new Set([...Object.keys(view), ...Object.keys(props), ...Object.keys(args)])];
  const rows: ArgRow[] = [];
  for (const key of order) {
    if (!(key in args) || HIDDEN_ARG_KEYS.has(key)) continue;
    const value = args[key];
    const v = view[key] ?? {};
    const kind: RowKind = v.kind ?? inferKind(value);
    const row: ArgRow = { key, label: v.label ?? humanizeKey(key), kind, value, hint: props[key]?.description };
    if (kind === 'money' && v.currencyArg && typeof args[v.currencyArg] === 'string') row.currency = args[v.currencyArg] as string;
    if (kind === 'profile' && typeof value === 'string') row.profileRef = value;
    if ((kind === 'profile-limits' || kind === 'profile-scope') && v.profileArg && typeof args[v.profileArg] === 'string') {
      row.profileRef = args[v.profileArg] as string;
    }
    rows.push(row);
  }
  return rows;
}

export interface FieldLine {
  key: string;
  label: string;
  value: string;
  /** The profile's description of the field. */
  hint?: string;
  /** The key is not defined by the profile — shown, flagged, never hidden. */
  unknown?: boolean;
}

/** An object of limits (bounds) or scope (context), read through the profile's own field definitions. */
export function profileFieldLines(
  value: unknown,
  profile: AgentProfile | null,
  which: 'limits' | 'scope',
): FieldLine[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const schema = which === 'limits' ? profile?.boundsSchema : profile?.scopeSchema;
  const fields = (schema?.fields ?? {}) as Record<string, { displayName?: string; description?: string; unit?: string }>;
  const order = [...new Set([...(schema?.keyOrder ?? []), ...Object.keys(value as object)])];
  const lines: FieldLine[] = [];
  for (const key of order) {
    if (key === 'profile' || !(key in (value as object))) continue;
    const raw = (value as Record<string, unknown>)[key];
    const f = fields[key];
    const unit = formatUnit(f?.unit);
    const shown = Array.isArray(raw) ? raw.join(', ') : String(raw);
    lines.push({
      key,
      label: f?.displayName ?? humanizeKey(key),
      value: unit ? `${shown} ${unit}` : shown,
      hint: f?.description,
      unknown: profile ? !f : undefined,
    });
  }
  return lines;
}
