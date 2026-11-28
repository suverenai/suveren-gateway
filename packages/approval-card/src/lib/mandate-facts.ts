/**
 * The facts of a mandate, read from the profile's own schema and nothing else: no field name, no profile name appears here.
 * One implementation for every surface (the gateway's approval card, the mandate lists, the phone), so they show the same thing.
 *
 *  - `mandateFacts`: every limit and scope value with the profile's label, money and lists formatted the one way (full card).
 *  - `shortSummary`: the few facts that tell mandates apart (list cards), by the rule below.
 *
 * The short summary rule (maintainer, 2026-11-26):
 *   1. scope fields first, then limits, each in the profile's own order (`keyOrder`)
 *   2. a limit equal to its schema `default` is left out (it says nothing the person did not already get)
 *   3. a scope field whose value is every value of its `enum` is left out (it does not narrow anything)
 *   4. a scope field that only repeats the unit of a shown limit (`currency` EUR next to "€2,000") is left out
 *   5. at most MAX_FACTS facts; the rest as "+N more", counting only facts that would have been shown
 *   6. a list value shows two entries, then "and N more"
 */
import { formatLimitValue, formatUnit } from './bound-format';
import { isAttachmentSourceField, formatAttachmentSources, type SourceManifestLike } from './attachment-sources';

export interface FactField {
  displayName?: string; unit?: string; default?: unknown; enum?: unknown[]; format?: string;
  boundType?: { kind?: string; values?: unknown[] };
}
export interface FactSchema { fields?: Record<string, FactField>; keyOrder?: string[] }

export interface MandateFact { kind: 'scope' | 'limit'; key: string; label: string; value: string; /** the entries of a list value, whole */ items?: string[] }

export const MAX_FACTS = 4;
const SKIP_KEYS = new Set(['profile', 'path']);

/** "customer,lead" / ["customer","lead"] -> ["customer","lead"]. A scalar is one entry. */
export function listItems(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [raw];
  return parts.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter((x) => x !== '');
}

/** A list the full way: "customer, lead, partner, vendor". */
export const listText = (items: readonly string[]): string => items.join(', ');

/** A list the short way: two entries, then "and N more". */
export function shortListText(items: readonly string[]): string {
  if (items.length <= 2) return items.join(', ');
  const rest = items.length - 2;
  return `${items.slice(0, 2).join(', ')} and ${rest} more`;
}

/** The profile's own order: its `keyOrder`, then any key it does not list (in the order given). */
export function orderedKeys(schema: FactSchema | undefined, values: Record<string, unknown>): string[] {
  return [...new Set([...(schema?.keyOrder ?? Object.keys(schema?.fields ?? {})), ...Object.keys(values)])].filter((k) => k in values && !SKIP_KEYS.has(k));
}

function isPlain(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'));
}

function valueOf(def: FactField | undefined, raw: unknown, kind: 'scope' | 'limit', manifests: SourceManifestLike[] | undefined): { value: string; items?: string[] } {
  if (kind === 'limit') return { value: formatLimitValue(Array.isArray(raw) ? listText(listItems(raw)) : raw, def?.unit) };
  if (isAttachmentSourceField(def as { format?: string } | undefined)) {
    const text = formatAttachmentSources(Array.isArray(raw) ? raw.join(',') : (raw as string | number), manifests);
    return { value: text || 'None: text only' };
  }
  const items = listItems(raw);
  return { value: listText(items), items };
}

export interface FactsInput {
  limits?: Record<string, unknown> | null;
  scope?: Record<string, unknown> | null;
  boundsSchema?: FactSchema;
  scopeSchema?: FactSchema;
  /** Limit keys not shown (the ones only test-data tools use, outside simulation). */
  hidden?: ReadonlySet<string>;
  manifests?: SourceManifestLike[];
}

function build(input: FactsInput): { scope: MandateFact[]; limits: MandateFact[] } {
  const limits = Object.fromEntries(Object.entries(input.limits ?? {}).filter(([k, v]) => !SKIP_KEYS.has(k) && !input.hidden?.has(k) && isPlain(v)));
  const scope = Object.fromEntries(Object.entries(input.scope ?? {}).filter(([k, v]) => !SKIP_KEYS.has(k) && isPlain(v)));
  const make = (kind: 'scope' | 'limit', schema: FactSchema | undefined, values: Record<string, unknown>): MandateFact[] =>
    orderedKeys(schema, values).map((key) => {
      const def = schema?.fields?.[key];
      return { kind, key, label: def?.displayName ?? key, ...valueOf(def, values[key], kind, input.manifests) };
    }).filter((f) => f.value !== '');
  return { scope: make('scope', input.scopeSchema, scope), limits: make('limit', input.boundsSchema, limits) };
}

/** Every fact, scope and limits, in the profile's own order (the full card). */
export function mandateFacts(input: FactsInput): { scope: MandateFact[]; limits: MandateFact[] } {
  return build(input);
}

const currencyOf = (unit: string | undefined): string | null => (unit?.startsWith('currency:') ? unit.slice('currency:'.length).toUpperCase() : null);

/** The facts the short summary would show, before the cut at MAX_FACTS. */
export function distinguishingFacts(input: FactsInput): MandateFact[] {
  const { scope, limits } = build(input);
  const bounds = input.boundsSchema?.fields ?? {};
  const scopeDefs = input.scopeSchema?.fields ?? {};
  const rawLimits = input.limits ?? {};
  const shownLimits = limits.filter((f) => {
    const def = bounds[f.key]?.default;
    return def === undefined || String(def) !== String(rawLimits[f.key]);
  });
  const units = new Set(shownLimits.map((f) => currencyOf(bounds[f.key]?.unit)).filter((c): c is string => c !== null));
  const shownScope = scope.filter((f) => {
    const items = f.items ?? listItems(f.value);
    const every = scopeDefs[f.key]?.enum;
    if (Array.isArray(every) && every.length > 0 && every.every((e) => items.includes(String(e)))) return false;
    if (items.length > 0 && items.every((i) => units.has(i.toUpperCase()))) return false;
    return true;
  });
  return [...shownScope, ...shownLimits];
}

export interface ShortSummary { facts: MandateFact[]; more: number }

export function shortSummary(input: FactsInput): ShortSummary {
  const all = distinguishingFacts(input);
  const facts = all.slice(0, MAX_FACTS).map((f) => (f.kind === 'scope' && f.items ? { ...f, value: shortListText(f.items) } : f));
  return { facts, more: all.length - facts.length };
}

/** "Allowed recipients a@x, b@x and 1 more · Daily send limit 20 · +2 more": the one line a list card shows. */
export function shortSummaryText(input: FactsInput): string {
  const s = shortSummary(input);
  return [...s.facts.map((f) => `${f.label} ${f.value}`), ...(s.more > 0 ? [`+${s.more} more`] : [])].join('\u00A0· '); // no-break space before the dot: a wrapped line never starts with it
}

