/**
 * What a change to a mandate would change — shared by the gateway (which computes
 * and seals it when the AI proposes a change) and the web page (which recomputes
 * it against the signed mandate when the person edits the change themselves).
 *
 * Driven only by what a profile declares: no field or profile name is written
 * here; what an empty list allows comes from scope-rules.ts, the rule the
 * gateway enforces. Pure, no node imports: the browser bundle imports this file directly.
 */
import { emptyScopeMeans, type EmptyMeans } from './scope-rules';

export type { EmptyMeans } from './scope-rules';

export type ChangeTag = 'More' | 'Less' | 'Changed' | 'New' | 'Gone';

/** The slice of a profile this module reads — AgentProfile fits. */
export interface ChangeProfile {
  id: string;
  version?: string;
  name?: string;
  boundsSchema?: { keyOrder?: string[]; fields?: Record<string, FieldDef> };
  scopeSchema?: { keyOrder?: string[]; fields?: Record<string, FieldDef> };
}

interface FieldDef {
  displayName?: string;
  unit?: string;
  /** A profile value format, e.g. `connector:kind` for document sources. */
  format?: string;
  boundType?: { kind?: string };
  constraint?: { enforceable?: string[] };
}

export interface ChangeRow {
  section: 'limit' | 'scope';
  field: string;
  label: string;
  /** A profile unit: `count`, `currency:EUR`, ... Absent for a list or enum. */
  unit?: string;
  before: string | number | null;
  after: string | number | null;
  tag: ChangeTag;
  /** For a list: only what is added and what is removed. */
  added?: string[];
  removed?: string[];
  /** For a list: what an empty value allows, as the gateway enforces it. */
  emptyMeans?: EmptyMeans;
  /** The profile's value format, when it declares one (the card names `connector:kind` values). */
  format?: string;
}

export type WordPart = { kind: 'same' | 'add' | 'del'; text: string };

export interface MandateDiff {
  rows: ChangeRow[];
  mode?: { before: string; after: string; tag: ChangeTag };
  lastsUntil?: { before: number; after: number; tag: ChangeTag };
  /** The intent, word by word. Absent when it does not change. */
  intent?: WordPart[];
  /** The rest, one line each, for "Stays the same". `format`: as on a row. */
  stays: Array<{ label: string; value: string; format?: string }>;
  /** Set when the change moves to a newer version of the area's profile. */
  versionMove?: { from: string; to: string };
}

/** The signed mandate and the mandate it would become, on one profile each. */
export interface DiffInput {
  before: { profile: ChangeProfile; bounds: Values; scope: Values; intent: string; mode: string; expiresAt: number };
  after: { profile: ChangeProfile; bounds: Values; scope: Values; intent: string; mode: string; expiresAt: number };
}
export type Values = Record<string, string | number | undefined>;

const SKIP = new Set(['profile', 'path']);

function listOf(v: string | number | undefined): string[] {
  return typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
}

function fieldLabel(def: FieldDef | undefined, key: string): string {
  return def?.displayName ?? key;
}

function isSubset(def: FieldDef | undefined): boolean {
  return !!def?.constraint?.enforceable?.includes('subset');
}

/** Higher number = more room: true for every numeric limit a profile declares today. */
function asNumber(v: string | number | undefined): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function numberTag(before: number, after: number): ChangeTag {
  return after > before ? 'More' : after < before ? 'Less' : 'Changed';
}

function isEmpty(v: string | number | undefined): boolean {
  return v === undefined || v === '';
}

function scalarRow(section: ChangeRow['section'], key: string, def: FieldDef | undefined, before: Values[string], after: Values[string]): ChangeRow {
  const unit = def?.unit;
  const base = { section, field: key, label: fieldLabel(def, key), ...(unit ? { unit } : {}) };
  if (before === undefined) return { ...base, before: null, after: after ?? null, tag: 'New' };
  if (after === undefined) return { ...base, before, after: null, tag: 'Gone' };
  // A limit with a numeric bound compares as numbers even when the form sent a string.
  const [x, y] = [asNumber(before), asNumber(after)];
  const numeric = !!def?.boundType && def.boundType.kind !== 'enum';
  const tag = numeric && x !== undefined && y !== undefined ? numberTag(x, y) : 'Changed';
  return { ...base, before, after, tag };
}

/**
 * A list field. What an empty list allows is the gateway's rule for that field
 * (scope-rules.ts):
 *  - "anything" (no restriction): setting a list narrows it (Less), emptying it
 *    widens it (More);
 *  - "nothing" (fail-closed): the list is exactly what is allowed, so an
 *    addition is More and a removal Less, from or to empty too.
 * With both an addition and a removal the row counts as More: it reaches
 * somewhere it could not before.
 */
function listRow(key: string, def: FieldDef | undefined, before: Values[string], after: Values[string]): ChangeRow | null {
  const a = listOf(before);
  const b = listOf(after);
  const added = b.filter(x => !a.includes(x));
  const removed = a.filter(x => !b.includes(x));
  if (added.length === 0 && removed.length === 0) return null;
  const emptyMeans = emptyScopeMeans(key);
  let tag: ChangeTag;
  if (emptyMeans === 'anything' && a.length === 0) tag = 'Less';
  else if (emptyMeans === 'anything' && b.length === 0) tag = 'More';
  else tag = added.length > 0 ? 'More' : 'Less';
  return {
    section: 'scope', field: key, label: fieldLabel(def, key),
    before: isEmpty(before) ? null : (before as string), after: isEmpty(after) ? null : (after as string),
    tag, added, removed, emptyMeans,
    ...(def?.format ? { format: def.format } : {}),
  };
}

function valueText(key: string, def: FieldDef | undefined, v: string | number | undefined): string {
  return v === undefined || v === '' ? '—' : String(v);
}

function stay(def: FieldDef | undefined, key: string, v: string | number | undefined): MandateDiff['stays'][number] {
  return { label: fieldLabel(def, key), value: valueText(key, def, v), ...(def?.format ? { format: def.format } : {}) };
}

/** Word-level difference: longest common subsequence over words and the spaces between them. */
export function wordDiff(before: string, after: string): WordPart[] {
  // A word carries its trailing space, so a changed phrase reads as one run.
  const tokens = (t: string) => t.split(/(?<=\s)(?=\S)/).filter(Boolean);
  const a = tokens(before);
  const b = tokens(after);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const parts: WordPart[] = [];
  const push = (kind: WordPart['kind'], text: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text; else parts.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) { push('add', b[j]); j++; }
    else { push('del', a[i]); i++; }
  }
  return parts;
}

function modeTag(before: string, after: string): ChangeTag {
  // The only ordering a mode has: running on its own reaches further than asking first.
  const rank = (m: string) => (m === 'automatic' ? 1 : m === 'review' ? 0 : -1);
  const [x, y] = [rank(before), rank(after)];
  return x >= 0 && y >= 0 && x !== y ? (y > x ? 'More' : 'Less') : 'Changed';
}

export function computeMandateDiff(input: DiffInput): MandateDiff {
  const { before, after } = input;
  const rows: ChangeRow[] = [];
  const stays: MandateDiff['stays'] = [];
  const declared = (p: ChangeProfile, s: 'boundsSchema' | 'scopeSchema') => p[s]?.fields ?? {};

  const compare = (section: ChangeRow['section'], schema: 'boundsSchema' | 'scopeSchema', b: Values, a: Values) => {
    const newFields = declared(after.profile, schema);
    const oldFields = declared(before.profile, schema);
    const order = [...new Set([...(after.profile[schema]?.keyOrder ?? []), ...Object.keys(newFields), ...(before.profile[schema]?.keyOrder ?? []), ...Object.keys(oldFields)])];
    for (const key of order) {
      if (SKIP.has(key)) continue;
      const def = newFields[key] ?? oldFields[key];
      if (!(key in newFields) && key in oldFields) {
        if (b[key] !== undefined) rows.push(scalarRow(section, key, def, b[key], undefined));
        continue;
      }
      if (String(b[key] ?? '') === String(a[key] ?? '')) {
        if (!isEmpty(a[key])) stays.push(stay(def, key, a[key]));
        continue;
      }
      if (section === 'scope' && isSubset(def)) {
        const row = listRow(key, def, b[key], a[key]);
        if (row) rows.push(row);
        else if (!isEmpty(a[key])) stays.push(stay(def, key, a[key]));
      } else {
        rows.push(scalarRow(section, key, def, b[key], a[key]));
      }
    }
  };
  compare('limit', 'boundsSchema', before.bounds, after.bounds);
  compare('scope', 'scopeSchema', before.scope, after.scope);

  const diff: MandateDiff = { rows, stays };
  if (before.mode !== after.mode) diff.mode = { before: before.mode, after: after.mode, tag: modeTag(before.mode, after.mode) };
  else stays.push({ label: 'mode', value: after.mode });
  if (before.expiresAt !== after.expiresAt) diff.lastsUntil = { before: before.expiresAt, after: after.expiresAt, tag: numberTag(before.expiresAt, after.expiresAt) };
  else stays.push({ label: 'lasts-until', value: String(after.expiresAt) });
  if (before.intent !== after.intent) diff.intent = wordDiff(before.intent, after.intent);
  else stays.push({ label: 'intent', value: '' });
  if (before.profile.id !== after.profile.id) diff.versionMove = { from: before.profile.id, to: after.profile.id };
  return diff;
}

/** True when nothing the person signed would change. A version move alone is not a change. */
export function diffIsEmpty(d: MandateDiff): boolean {
  return d.rows.length === 0 && !d.mode && !d.lastsUntil && !d.intent;
}

/**
 * Carry values onto a (possibly newer) profile: a field the new version still has
 * keeps its value, a field it dropped is left out. Unlike the web form, a field
 * new in this version is NOT seeded from a default: the AI must ask the person,
 * so it arrives in the diff as a value they saw.
 */
export function carryValues(values: Values, schema: ChangeProfile['boundsSchema']): Values {
  const out: Values = {};
  for (const key of schema?.keyOrder ?? []) {
    if (SKIP.has(key)) continue;
    if (values[key] !== undefined) out[key] = values[key];
  }
  return out;
}
