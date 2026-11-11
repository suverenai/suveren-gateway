/**
 * What an EMPTY value of a list scope field allows — the one place the gateway
 * says it. The enforcement (apps/mcp-server attachment-policy.ts, plus hap-core's
 * generic scope check) and the mandate change card (mandate-change.ts) both read
 * it here, so the card's More/Less can never disagree with what the gateway does.
 *
 * The rules, as enforced:
 *  - hap-core's generic `subset` check skips a mandate whose value is empty: no
 *    restriction, so an empty list allows ANYTHING. A field with
 *    `constraint.requiredFor` follows the same rule: it only refuses a call that
 *    hides the value while the mandate SETS one; an empty mandate value is still
 *    unrestricted.
 *  - a list of document sources is fail-closed: the gateway refuses every
 *    attachment whose source the mandate does not list, so an empty list allows
 *    NOTHING (no attachments).
 *
 * A document-source list is recognised by the format its profile declares
 * (`format: "connector:kind"`), never by its field name: email@0.9 calls it
 * `allowed_attachment_sources`, and any other profile may declare one under
 * another name.
 *
 * A test (apps/mcp-server/test/scope-empty-rule.test.ts) runs the real
 * enforcement for every list field of every shipped profile and compares it
 * with {@link emptyScopeMeans}. Pure, no node imports: the browser bundle uses it.
 */

/** The profile field `format` of a list of document sources: comma-separated `connector:kind` pairs. */
export const DOCUMENT_SOURCES_FORMAT = 'connector:kind';

export type EmptyMeans = 'anything' | 'nothing';

/** True for a scope field that lists document sources — by its declared format, never by its name. */
export function isDocumentSourcesField(def: unknown): boolean {
  return !!def && typeof def === 'object' && (def as { format?: unknown }).format === DOCUMENT_SOURCES_FORMAT;
}

/** The slice of a profile {@link documentSourcesField} reads — AgentProfile fits. */
export interface ScopeSchemaLike {
  scopeSchema?: { fields?: Record<string, unknown> };
}

/**
 * The name of the profile's document-source scope field: the first scope field
 * (in declaration order) whose format is {@link DOCUMENT_SOURCES_FORMAT}.
 * Undefined when the profile declares none — such a profile carries no
 * attachments at all.
 */
export function documentSourcesField(profile: ScopeSchemaLike | undefined): string | undefined {
  for (const [name, def] of Object.entries(profile?.scopeSchema?.fields ?? {})) {
    if (isDocumentSourcesField(def)) return name;
  }
  return undefined;
}

/** What an empty value of this list scope field allows, exactly as the gateway enforces it. */
export function emptyScopeMeans(def: unknown): EmptyMeans {
  return isDocumentSourcesField(def) ? 'nothing' : 'anything';
}

// ─── At least one of a group of scope fields (`scopeSchema.atLeastOne`) ─────
//
// A profile MAY declare that, for some action types, a mandate must set at least
// one field of a group to a non-empty value (email@0.10: `allowed_recipients` or
// `allowed_domains` for `send`), because an empty value there means "no limit".
// Scope never reaches the Authority Server, so the gateway enforces it, in two
// places that both read these helpers:
//  - building a mandate (mandate-ceremony.ts planMandate, the sign form): refused
//    when a bound for a listed action type still allows that action;
//  - every execution (tool-proxy.ts): refused for a listed action type.
// Only profiles that declare a group are affected: a mandate under an older
// version without the declaration keeps working until it ends.
// The refusal sentences are built from the profile (its name, the fields'
// displayNames, the group's optional `ask`) — never from a field or profile name.

/** One declared group, as the profile states it. `ask`: what the person is asked ("who the AI may write to"). */
export interface AtLeastOneGroup {
  fields: string[];
  requiredFor: string[];
  ask?: string;
}

/** The slice of a profile the atLeastOne helpers read — AgentProfile fits. */
export interface AtLeastOneProfileLike {
  id?: string;
  name?: string;
  boundsSchema?: { fields?: Record<string, unknown> };
  scopeSchema?: { fields?: Record<string, unknown>; atLeastOne?: unknown };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

/**
 * The profile's groups. A malformed entry (no fields, no action types) is dropped:
 * a group with nothing to require can never refuse anything.
 */
export function atLeastOneGroups(profile: AtLeastOneProfileLike | undefined): AtLeastOneGroup[] {
  const raw = profile?.scopeSchema?.atLeastOne;
  if (!Array.isArray(raw)) return [];
  const out: AtLeastOneGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    const fields = strings((g as { fields?: unknown }).fields);
    const requiredFor = strings((g as { requiredFor?: unknown }).requiredFor);
    if (fields.length === 0 || requiredFor.length === 0) continue;
    const ask = (g as { ask?: unknown }).ask;
    out.push({ fields, requiredFor, ...(typeof ask === 'string' && ask.trim() ? { ask: ask.trim() } : {}) });
  }
  return out;
}

/** A scope value that says something: a number, or text with at least one non-empty list item. */
export function scopeValueSet(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  return v.split(',').some(s => s.trim().length > 0);
}

/** True when the scope sets at least one of the group's fields. */
export function groupSatisfied(group: AtLeastOneGroup, scope: Record<string, unknown> | undefined): boolean {
  return group.fields.some(f => scopeValueSet(scope?.[f]));
}

/**
 * The action types a bound governs: its `appliesTo`, else — for a cumulative
 * count named `<action>_<window>_max` — that action, else every action type
 * (undefined). The same reading as hap-core's `boundActionTypes` (copied, so this
 * module stays free of the crypto library for the browser bundle; a test pins the
 * two together for every shipped profile).
 */
export function boundGovernsActions(fieldName: string, def: unknown): readonly string[] | undefined {
  const d = def as { appliesTo?: unknown; boundType?: { kind?: unknown } } | undefined;
  if (Array.isArray(d?.appliesTo)) return d!.appliesTo as string[];
  if (d?.boundType?.kind !== 'cumulative_count') return undefined;
  const prefix = fieldName.replace(/_(?:daily|monthly|weekly)_max$/, '');
  if (prefix === fieldName || prefix.startsWith('transaction')) return undefined;
  return [prefix];
}

/**
 * Whether the mandate's limits still allow `actionType`: no count limit that governs
 * it is set to 0. A count limit of 0 means the Authority Server refuses every ticket
 * for that action (the same rule as tool-proxy.ts `zeroCappedBound`).
 */
export function boundsAllowAction(
  profile: AtLeastOneProfileLike | undefined,
  bounds: Record<string, unknown> | undefined,
  actionType: string,
): boolean {
  for (const [name, def] of Object.entries(profile?.boundsSchema?.fields ?? {})) {
    if ((def as { boundType?: { kind?: unknown } })?.boundType?.kind !== 'cumulative_count') continue;
    const governs = boundGovernsActions(name, def);
    if (governs !== undefined && !governs.includes(actionType)) continue;
    const v = bounds?.[name];
    if (v !== undefined && v !== '' && Number(v) <= 0) return false;
  }
  return true;
}

/** A group a mandate leaves unmet, and the action type it would allow without it. */
export interface UnmetGroup {
  group: AtLeastOneGroup;
  actionType: string;
}

/**
 * For building a mandate: the groups whose fields are all empty while the limits
 * still allow one of the group's action types. A mandate that allows none of them
 * (read-only, a count limit of 0) needs none of the fields.
 */
export function unmetForMandate(
  profile: AtLeastOneProfileLike | undefined,
  scope: Record<string, unknown> | undefined,
  bounds: Record<string, unknown> | undefined,
): UnmetGroup[] {
  const out: UnmetGroup[] = [];
  for (const group of atLeastOneGroups(profile)) {
    if (groupSatisfied(group, scope)) continue;
    const actionType = group.requiredFor.find(a => boundsAllowAction(profile, bounds, a));
    if (actionType) out.push({ group, actionType });
  }
  return out;
}

/** For one execution: the first group that refuses `actionType` under this scope, or undefined. */
export function unmetForAction(
  profile: AtLeastOneProfileLike | undefined,
  scope: Record<string, unknown> | undefined,
  actionType: string | undefined,
): UnmetGroup | undefined {
  if (typeof actionType !== 'string') return undefined;
  const group = atLeastOneGroups(profile).find(g => g.requiredFor.includes(actionType) && !groupSatisfied(g, scope));
  return group ? { group, actionType } : undefined;
}

// ─── The words ──────────────────────────────────────────────────────────────

const fieldsOf = (profile: AtLeastOneProfileLike | undefined) => profile?.scopeSchema?.fields ?? {};

/** A field's name as the form shows it ("Allowed recipients"). */
export function groupFieldLabels(profile: AtLeastOneProfileLike | undefined, group: AtLeastOneGroup): string[] {
  return group.fields.map(f => {
    const n = (fieldsOf(profile)[f] as { displayName?: unknown } | undefined)?.displayName;
    return typeof n === 'string' && n.trim() ? n.trim() : f;
  });
}

const lowerFirst = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const singular = (word: string): string => (/[^s]s$/.test(word) ? word.slice(0, -1) : word);

/**
 * The group as one noun phrase, singular: "Allowed recipients" + "Allowed domains"
 * → "allowed recipient or domain". A first word all labels share is said once.
 */
export function groupNoun(profile: AtLeastOneProfileLike | undefined, group: AtLeastOneGroup): string {
  const words = groupFieldLabels(profile, group).map(l => l.split(/\s+/).map((w, i, all) => (i === all.length - 1 ? singular(w) : w)));
  const first = words[0]?.[0];
  const shared = words.length > 1 && words.every(w => w.length > 1 && w[0].toLowerCase() === first?.toLowerCase());
  const parts = words.map((w, i) => (shared && i > 0 ? w.slice(1) : w).join(' '));
  return lowerFirst(parts.join(' or '));
}

/** "send" → "sending", "charge" → "charging". */
function gerund(verb: string): string {
  return /[^e]e$/.test(verb) ? `${verb.slice(0, -1)}ing` : `${verb}ing`;
}

const areaOf = (profile: AtLeastOneProfileLike | undefined): string => {
  if (typeof profile?.name === 'string' && profile.name.trim()) return profile.name.trim();
  const id = profile?.id ?? '';
  return id.replace(/@.*$/, '').split('/').pop() ?? id;
};
const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'An' : 'A');

/**
 * Building a mandate that leaves a group unmet — for the AI's proposal:
 * "An Email mandate that allows sending must name at least one allowed recipient or domain. Ask the person who the AI may write to."
 */
export function atLeastOneBuildRefusal(profile: AtLeastOneProfileLike | undefined, unmet: UnmetGroup): string {
  const area = areaOf(profile);
  const noun = groupNoun(profile, unmet.group);
  const ask = unmet.group.ask ?? `which ${noun} the AI may use`;
  return `${article(area)} ${area} mandate that allows ${gerund(unmet.actionType)} must name at least one ${noun}. Ask the person ${ask}.`;
}

/**
 * An execution under a mandate that leaves a group unmet:
 * "This mandate names no allowed recipient or domain, so it cannot send. The person gives a new Email mandate that says who the AI may write to."
 */
export function atLeastOneExecutionRefusal(profile: AtLeastOneProfileLike | undefined, unmet: UnmetGroup): string {
  const area = areaOf(profile);
  const noun = groupNoun(profile, unmet.group);
  const ask = unmet.group.ask ?? `which ${noun} the AI may use`;
  return `This mandate names no ${noun}, so it cannot ${unmet.actionType}. The person gives a new ${area} mandate that says ${ask}.`;
}

/**
 * The sign form, next to the group's fields while the limits allow a listed action:
 * "At least one of these: Allowed recipients or Allowed domains. Needed while this mandate allows sending."
 */
export function atLeastOneFormHint(profile: AtLeastOneProfileLike | undefined, unmet: UnmetGroup): string {
  return `At least one of these: ${groupFieldLabels(profile, unmet.group).join(' or ')}. Needed while this mandate allows ${gerund(unmet.actionType)}.`;
}

/**
 * The review step, next to the disabled Sign button:
 * "Name at least one allowed recipient or domain in step 2: this mandate allows sending."
 */
export function atLeastOneSignHint(profile: AtLeastOneProfileLike | undefined, unmet: UnmetGroup): string {
  return `Name at least one ${groupNoun(profile, unmet.group)} in step 2: this mandate allows ${gerund(unmet.actionType)}.`;
}

/**
 * The groups a newer version of an area declares that a mandate under an older
 * version leaves unmet while its limits allow the action — that older mandate is
 * not refused (its version declares nothing), so the dashboard points it out.
 * Empty when the mandate is already on `newer`.
 */
export function unmetUnderNewerVersion(
  mandateProfile: AtLeastOneProfileLike | undefined,
  newer: AtLeastOneProfileLike | undefined,
  scope: Record<string, unknown> | undefined,
  bounds: Record<string, unknown> | undefined,
): UnmetGroup[] {
  if (!newer || !mandateProfile || newer.id === mandateProfile.id) return [];
  if (atLeastOneGroups(mandateProfile).length > 0) return [];
  return atLeastOneGroups(newer)
    .filter(g => !groupSatisfied(g, scope))
    .map(group => ({ group, actionType: group.requiredFor.find(a => boundsAllowAction(mandateProfile, bounds, a)) }))
    .filter((u): u is UnmetGroup => typeof u.actionType === 'string');
}

/**
 * The dashboard's one line for such a mandate:
 * "names no allowed recipient or domain. Email 0.10 requires one: open it under Mandates and press Edit to replace it."
 */
export function atLeastOneOlderVersionLine(newer: AtLeastOneProfileLike & { version?: string }, unmet: UnmetGroup): string {
  const version = newer.version ?? (newer.id?.split('@')[1] ?? '');
  return `names no ${groupNoun(newer, unmet.group)}. ${areaOf(newer)} ${version} requires one: open it under Mandates and press Edit to replace it.`;
}
