/**
 * Guidance — the words that let an AI with only the gateway's tools lead a
 * person from "nothing is set up" to "this works".
 *
 * Everything here is built from data: the connector manifests (what exists,
 * what its documents are, who saves them), the profiles (area names), the
 * mandates the person holds and the Setup mandate's own scope. No connector,
 * profile or field name is written in this file. The wording of the UI labels
 * ("Mandates", "+ New mandate", "Give a mandate", "Connectors", "What the AI
 * may attach") is the one place the page's own words appear: they are what the
 * person will see, so the AI must name them exactly.
 *
 * Pure: no I/O. The callers (mandate-brief.ts, tools/authorizations.ts,
 * tool-proxy.ts) hand in facts; tests hand in several different manifests.
 */

import { ATTACHMENT_SOURCES_FIELD, attachmentSourcesFieldDeclared, isAttachmentSourceAllowed } from './attachment-policy';

// ─── Inputs (narrow views, so tests and callers need no full types) ─────────

export interface GuideDocument { title?: string; label?: string; description?: string; savedBy?: string }

export interface GuideManifest {
  id: string;
  name: string;
  description?: string;
  /** The connector's own area (profile short name or full id). */
  profile?: string;
  /** An entry marked `simulationOnly` is shown only while the gateway is in test mode. */
  setupGuide?: Array<{ title: string; description?: string; simulationOnly?: boolean }>;
  /** Ready-made settings the connector offers: limits, mode and duration. */
  templates?: Array<{ name?: string; ttl?: number; mode?: string; bounds?: Record<string, unknown> }>;
  credentials?: { fields?: Array<{ key: string; label?: string; placeholder?: string; optional?: boolean }> };
  oauth?: { signInGroup?: { name?: string }; forOption?: unknown; tokenStorage?: string } | null;
  /** The where-does-it-get-its-data choice (same shape as the connector card's). */
  simulation?: { field: string; default: string } | null;
  modeLabels?: Record<string, string | Record<string, string>> | null;
  modeOptions?: Record<string, { label?: string; fields?: string[] } | Record<string, { label?: string; fields?: string[] }>> | null;
  documents?: Record<string, GuideDocument>;
  toolGating?: { overrides?: Record<string, { profile?: string; attachmentsArg?: string } | null> };
}

export type MandateEnded = 'revoked' | 'expired';

export interface GuideAuth {
  profileId: string;
  complete: boolean;
  needsReapproval?: boolean;
  context?: Record<string, string | number>;
  deferredCommitmentDomains?: string[];
}

/** The slice of a profile the field list needs. */
export interface ProfileFieldsLike {
  boundsSchema?: { fields?: Record<string, FieldLike> };
  scopeSchema?: { fields?: Record<string, FieldLike> };
  ttl?: { default?: number; max?: number };
  commitment_modes?: unknown;
}
interface FieldLike {
  required?: boolean;
  displayName?: string;
  unit?: string;
  default?: unknown;
  maximum?: number;
  enum?: string[];
  format?: string;
  valuesFrom?: string;
  boundType?: { kind?: string; values?: string[] };
}

export interface ConnectorFacts {
  running: boolean;
  /** Not running solely because of the gateway's mode. */
  blocked?: 'simulation' | 'production';
  /** The person has saved settings for it. */
  hasCredentials: boolean;
  /** It is listed on this gateway (activated once), so its card shows Paused / Start, not the setup form. */
  registered?: boolean;
  /** The account sign-in is done. Absent = not known. */
  signedIn?: boolean;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

const shortOf = (id: string): string => id.replace(/@.*$/, '').split('/').pop() ?? id;

function matches(profileId: string, area: string): boolean {
  return profileId === area || shortOf(profileId).toLowerCase() === shortOf(area).toLowerCase();
}

/** Every area a connector's tools serve: its own profile first, then any a tool names. */
export function manifestAreas(m: GuideManifest): string[] {
  const out: string[] = m.profile ? [shortOf(m.profile)] : [];
  for (const o of Object.values(m.toolGating?.overrides ?? {})) {
    const p = o?.profile ? shortOf(o.profile) : undefined;
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function capitalise(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The name the mandate form shows for one document kind ("Saved files"), same rule as the form's. */
export function sourceTitle(kind: string, doc: GuideDocument | undefined): string {
  if (doc?.title?.trim()) return doc.title.trim();
  const fromLabel = (doc?.label ?? '').replace(/\{id\}/g, '').replace(/\s+/g, ' ').trim();
  return capitalise(fromLabel || kind);
}

function csv(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
}


// ─── 1. The first mandate ───────────────────────────────────────────────────

/**
 * What to tell a person when nothing is set up. The first mandate can only be
 * signed by a person on the page: an AI cannot propose it. `card` is the name
 * the page shows on the mandate that lets the AI prepare other mandates.
 */
export function firstMandateText(opts: { card: string }): string {
  return [
    'No active mandate exists, so no tool works. An AI can never create the first one: a person signs it. This is the next step, whatever the person opens with. Lead them through it, one step at a time:',
    '1. They open the Suveren Gateway page themselves, in their own browser, outside this chat. In the left menu they choose **Mandates**, then **+ New mandate** (top right).',
    `2. Pick the card **${opts.card}** and press **Give a mandate**. Tell them why: they sign it once, and from then on they manage their mandates from this chat. They say what you should be able to do, you prepare the mandate, and they only approve it. (Instead, they can pick the card of the area they need and sign that mandate themselves.)`,
    '3. The form has three steps: **Scope & Limits**, **Intent**, **Sign**. In Scope & Limits they name the areas you may prepare mandates for, the modes you may propose (review = they approve every action; automatic = it runs within the limits) and how many proposals a day. In Intent they write, in their own words, why. In Sign they give it a **Title** (required), choose how it runs and for how long, then press **Sign mandate**. Ask them first whether it should run automatically or ask each time.',
    'Afterwards call list-authorizations(): it says what is still missing and what to do next.',
  ].join('\n');
}

/** The Sign step, as the AI tells it whenever a person signs a mandate themselves. */
export const SIGN_STEP =
  'Ask them first whether it should run automatically or ask each time. On the **Sign** step they give it a **Title** (required) and choose **Review Each Action** or **Automatic**, then press **Sign mandate**.';

/** The name of the card the mandate picker shows: "Name — Area" when the connector serves several areas. */
export function pickerCard(m: GuideManifest, area: string, areaName: (a: string) => string): string {
  return manifestAreas(m).length > 1 ? `${m.name} — ${areaName(area)}` : m.name;
}

interface ChoiceOption { label: string; simulated: boolean; fieldKeys: string[]; isDefault: boolean }

/** The options of "Where does <name> get its data?", same derivation as the connector card. */
function choiceOptions(m: GuideManifest): ChoiceOption[] {
  if (!m.simulation || !m.modeLabels) return [];
  const out: ChoiceOption[] = [];
  const isDefault = (mode: string) => mode === m.simulation!.default;
  for (const [mode, entry] of Object.entries(m.modeLabels)) {
    const decl = (m.modeOptions ?? {})[mode] as Record<string, unknown> | undefined;
    if (typeof entry === 'string') {
      const d = decl as { label?: string; fields?: string[] } | undefined;
      out.push({ label: d?.label ?? entry, simulated: mode === 'simulation', fieldKeys: d?.fields ?? [], isDefault: isDefault(mode) });
    } else {
      for (const [adapter, label] of Object.entries(entry)) {
        const d = decl?.[adapter] as { label?: string; fields?: string[] } | undefined;
        out.push({ label: d?.label ?? label, simulated: mode === 'simulation', fieldKeys: d?.fields ?? [], isDefault: isDefault(mode) });
      }
    }
  }
  return out;
}

/** "**Client ID** (From Google Cloud Console)": a field as the card labels it. */
function fieldWords(m: GuideManifest, key: string): string {
  const f = (m.credentials?.fields ?? []).find(x => x.key === key);
  if (!f) return `**${key}**`;
  const hint = f.placeholder && !/^\w+ \(default\)/.test(f.placeholder) ? ` (${f.placeholder})` : '';
  return `**${(f.label ?? key).replace(/\s*\(optional\)\s*$/i, '')}**${hint}`;
}

function chooseWords(m: GuideManifest, options: ChoiceOption[]): string {
  return `chooses ${options.map(o => `**${o.label}**`).join(' or ')} under *Where does ${m.name} get its data?*`;
}

function connectWords(m: GuideManifest, button: string): string {
  const group = m.oauth?.signInGroup?.name;
  return `**${button}** and follows the steps on the card${group ? ` to connect ${group}` : ''}`;
}

/**
 * What the person does on the card of a connector that is not set up yet: the option to choose,
 * the fields to fill, the button to press. Same states as IntegrationCard.tsx. "" never: there is
 * always a button.
 */
export function cardSteps(m: GuideManifest, simulation: boolean): string {
  const fields = m.credentials?.fields ?? [];
  // A sign-in that belongs to one option (the real one) does not apply to the practice data.
  const oauth = m.oauth && !(m.oauth.forOption && simulation) ? m.oauth : null;
  const options = choiceOptions(m);
  const wanted = options.filter(o => o.simulated === simulation);
  const parts: string[] = [];
  let needed = fields.filter(f => !f.optional).map(f => f.key);
  // The card preselects the manifest's default option. It must be changed when the default is not one
  // this gateway can run, and picking it is what makes the card offer Save & Encrypt.
  const choose = options.length > 1 && wanted.length > 0 && (wanted.some(o => o.fieldKeys.length > 0) || !wanted.some(o => o.isDefault));
  if (choose) {
    parts.push(chooseWords(m, wanted));
    if (wanted.length === 1) needed = [...needed, ...wanted[0].fieldKeys.filter(k => !needed.includes(k))];
  }
  if (needed.length > 0) parts.push(`enters ${needed.map(k => fieldWords(m, k)).join(' and ')}`);
  if (needed.length > 0 || choose) {
    parts.push(oauth
      ? `presses **Save & Encrypt**, then ${connectWords(m, `Connect ${m.name} Account`)}`
      : 'presses **Save & Encrypt** (the connector then starts by itself)');
  } else if (oauth) {
    parts.push(`presses ${connectWords(m, `Connect ${m.name} Account`)}`);
  } else {
    parts.push(`presses **Activate ${m.name}**`);
  }
  return parts.join(', ');
}

/**
 * The steps for a connector this gateway holds back because it is set to practice data while the
 * gateway runs for real. The card differs by what the person already did: listed = Paused with
 * **Edit settings**; settings saved but never started = **Update Credentials**; untouched = the setup form.
 */
export function productionBlockedSteps(m: GuideManifest, facts: Pick<ConnectorFacts, 'registered' | 'hasCredentials'>): string {
  const options = choiceOptions(m);
  const real = options.filter(o => !o.simulated);
  if (real.length === 0) return 'presses **Disable**: it has no real option, so it cannot run on this gateway';
  if (facts.registered) {
    const parts = ['presses **Edit settings**', chooseWords(m, real)];
    if (real.length === 1 && real[0].fieldKeys.length > 0) parts.push(`enters ${real[0].fieldKeys.map(k => fieldWords(m, k)).join(' and ')}`);
    parts.push(`presses **Save**${m.oauth ? `, then ${connectWords(m, `Connect ${m.name}`)}` : ' (the connector then starts by itself)'}`);
    return parts.join(', ');
  }
  if (facts.hasCredentials) {
    // The saved setting is the practice data, so a sign-in scoped to the real option does not apply yet.
    return `presses **${m.oauth && !m.oauth.forOption ? 'Change Credentials' : 'Update Credentials'}**, ${cardSteps(m, false)}`;
  }
  return cardSteps(m, false);
}

/** The fields to give `create_mandate` for one profile, from its own schema: required, allowed values, units. */
export function proposalFields(
  tool: string,
  area: string,
  p: ProfileFieldsLike,
  modes: readonly string[],
): string {
  const one = (key: string, f: FieldLike): string => {
    const bits: string[] = [];
    const values = f.boundType?.kind === 'enum' ? f.boundType.values : f.enum;
    if (values && values.length) bits.push(values.join('|'));
    else if (f.format === 'connector:kind') bits.push('comma-separated connector:kind sources, for example files:file');
    else if (f.valuesFrom) bits.push(`comma-separated names from the ${f.valuesFrom} available`);
    else bits.push(f.boundType ? 'number' : 'text');
    const extra: string[] = [];
    if (f.unit && f.unit !== 'count') extra.push(f.unit);
    if (f.maximum !== undefined) extra.push(`at most ${f.maximum}`);
    if (f.default !== undefined) extra.push(`default ${String(f.default)}`);
    return `${key}${f.required ? '*' : ''}${f.displayName ? ` (${f.displayName})` : ''} = ${bits.join('')}${extra.length ? ` [${extra.join(', ')}]` : ''}`;
  };
  const list = (fields: Record<string, FieldLike> | undefined) =>
    Object.entries(fields ?? {}).filter(([k]) => k !== 'profile').map(([k, f]) => one(k, f)).join('; ') || 'none';
  const hours = p.ttl?.max ? `, at most ${Math.floor(p.ttl.max / 3600)}` : '';
  return [
    `Fields for ${tool}(profile: "${shortOf(area)}", ...), * = required; any other field name is refused:`,
    `      limits {name: value}: ${list(p.boundsSchema?.fields)}`,
    `      scope {name: value}: ${list(p.scopeSchema?.fields)}`,
    `      mode = ${modes.join('|') || 'none allowed'} (ask the person); intent = text, at most 2000 characters; title = short name; duration_hours = number${hours}${p.ttl?.default ? `, default ${Math.floor(p.ttl.default / 3600)}` : ''}`,
  ].join('\n');
}

// ─── 2. What is needed ──────────────────────────────────────────────────────

export interface SetupMandateFacts {
  /** The tool that proposes a mandate, as the AI calls it (e.g. "setup__create_mandate"); undefined = not listed to it. */
  tool?: string;
  /** The area that governs that tool (short name); undefined = not known here. */
  area?: string;
  /** The name of the card the person picks to give that mandate. */
  card: string;
  /** Held complete mandates of the authority that governs `tool`. */
  held: GuideAuth[];
  /** Scope fields the tool's arguments are checked against: argument -> field. */
  fields: { profile?: string; mode?: string };
}

export interface MissingMandateFacts {
  /** `profile_not_enabled` / `not_a_grantor` from the team check, when the person is in a team. */
  teamCode?: string;
  teamName?: string;
}

export interface OverviewInput {
  manifests: GuideManifest[];
  facts: (id: string) => ConnectorFacts;
  auths: GuideAuth[];
  /** The area's name as the person sees it ("Email"). */
  areaName: (area: string) => string;
  setup: SetupMandateFacts;
  /** The team check per area (keyed by short area name), for areas with no mandate. */
  team?: Map<string, MissingMandateFacts>;
  /** The AI-callable name of a connector's tool ("files__save_file"). */
  toolName: (connectorId: string, tool: string) => string;
  /** One connector asked for by name: print its whole setup guide, the field list for proposing, not just the overview. */
  detail?: boolean;
  /** The gateway is in test mode: shows the guide entries marked simulationOnly, and the test-data choice. */
  simulation?: boolean;
  /** Did a mandate for this area exist before (and has ended)? Only when the gateway can know. */
  hadMandate?: (area: string) => boolean;
  /** The Authority Server's own answer for this area: the last mandate was revoked or expired. Undefined = no such answer. */
  endedMandate?: (area: string) => MandateEnded | undefined;
  /** The newest known profile of an area, and the modes it may be signed with — for the field list. */
  profileOf?: (area: string) => { profile: ProfileFieldsLike; modes: readonly string[] } | undefined;
}

/** Which of `areas` a held mandate covers. */
function covering(auths: GuideAuth[], area: string): GuideAuth[] {
  return auths.filter(a => a.complete && !a.needsReapproval && matches(a.profileId, area));
}

/** How to get a missing mandate for `area`, as one or two short sentences for the AI to pass on. */
export function howToGetMandate(
  area: string,
  card: string,
  input: Pick<OverviewInput, 'areaName' | 'setup' | 'team' | 'detail' | 'profileOf'>,
): string {
  const name = input.areaName(area);
  const t = input.team?.get(shortOf(area));
  if (t?.teamCode === 'profile_not_enabled') {
    const team = t.teamName ? `"${t.teamName}"` : 'the team';
    return `Blocked: the team ${team} has not enabled ${name}, so no one in it can give this mandate. Tell the person to ask an admin of ${team} to open **Team → Manage this team in your Authority Server**, enable ${name} and name who may give its mandates. Nothing else helps until then.`;
  }
  if (t?.teamCode === 'not_a_grantor') {
    const team = t.teamName ? `"${t.teamName}"` : 'the team';
    return `Blocked: ${name} is enabled in ${team}, but the person is not one of those who may give it. Tell them to ask one of them, or a team admin, to add them.`;
  }
  const { setup } = input;
  const listed = (field: string | undefined, value: string): boolean | undefined => {
    if (!field || setup.held.length === 0) return undefined;
    return setup.held.some(h => csv(h.context?.[field]).some(v => v.toLowerCase() === value.toLowerCase()));
  };
  if (setup.tool && setup.held.length > 0) {
    if (listed(setup.fields.profile, shortOf(area)) === false) {
      return `Not yours to propose: the person's ${setup.card} mandate does not list ${name}. Tell them either to sign it themselves (**Mandates → + New mandate →** card **${card}**; ${SIGN_STEP}) or to add ${name} to the ${setup.card} mandate (**Mandates**, open it, **Edit**); then you can propose it.`;
    }
    const modes = [...new Set(setup.held.flatMap(h => csv(setup.fields.mode ? h.context?.[setup.fields.mode] : undefined)))];
    const modeNote = modes.length > 0 ? ` (modes you may propose: ${modes.join(', ')})` : '';
    const known = input.profileOf?.(area);
    const fields = input.detail && known
      ? `\n      ${proposalFields(setup.tool, area, known.profile, known.modes)}`
      : known ? ` Its fields: list-authorizations(domain: "${shortOf(area)}").` : '';
    return `Propose it with ${setup.tool}(profile: "${shortOf(area)}", ...)${modeNote}. ${BEFORE_PROPOSING} The person approves it in the gateway.${fields}`;
  }
  return `A person signs it: **Mandates → + New mandate**, card **${card}**, **Give a mandate**. ${SIGN_STEP} (With a ${setup.card} mandate you could prepare it for them.)`;
}

interface ConnectorLine {
  rank: number;
  text: string;
}

/** One connector: is it running, set up, covered by a mandate; and the next step for each gap. */
function connectorLine(m: GuideManifest, input: OverviewInput, sourcesByConsumer: Map<string, AttachSource[]>): ConnectorLine {
  const f = input.facts(m.id);
  const areas = manifestAreas(m);
  const lines: string[] = [];
  let rank = 3;

  const sim = input.simulation ?? false;
  const card = `the card **${m.name}**`;
  let state: string;
  if (f.running) {
    state = 'running';
  } else if (f.blocked === 'simulation') {
    state = 'not available right now';
    rank = 4;
  } else if (f.blocked === 'production') {
    state = `not running: it is set to test data, and this gateway runs for real. A person opens **Connectors**, ${card}, ${productionBlockedSteps(m, f)}`;
    rank = 0;
  } else if (!f.hasCredentials) {
    state = `not set up. A person opens **Connectors**, ${card}, ${cardSteps(m, sim)}`;
    rank = 0;
  } else if (m.oauth && !(m.oauth.forOption && sim) && f.signedIn === false) {
    state = `settings saved, but not signed in. A person opens **Connectors**, ${card}, presses ${connectWords(m, `Connect ${m.name} Account`)}`;
    rank = 0;
  } else {
    state = `set up, but not running. A person opens **Connectors**, ${card} and presses **${f.registered ? 'Start' : `Start ${m.name} Connector`}**`;
    rank = 0;
  }
  lines.push(`- ${m.name}${m.description ? ` (${m.description})` : ''} — ${state}.`);

  for (const area of areas) {
    const have = covering(input.auths, area);
    if (have.length === 0 && input.auths.some(a => a.complete && a.needsReapproval && matches(a.profileId, area))) {
      lines.push(`    mandate for ${input.areaName(area)}: must be signed again. A person opens **Mandates** and presses **Sign again** on it.`);
    } else if (have.length > 0) {
      lines.push(`    mandate for ${input.areaName(area)}: yes${have.some(a => (a.deferredCommitmentDomains ?? []).length > 0) ? ' (review: each action needs approval)' : ''}`);
    } else {
      if (rank > 1 && f.running) rank = 1;
      const ended = input.endedMandate?.(area);
      const before = ended === 'revoked' ? ' The last one was revoked.'
        : ended === 'expired' ? ' The last one has expired.'
        : input.hadMandate?.(area) ? ' An earlier one has ended (revoked or expired).' : '';
      lines.push(`    mandate for ${input.areaName(area)}: none.${before} ${howToGetMandate(area, pickerCard(m, area, input.areaName), input)}`);
    }
  }

  // What this connector's documents can be attached to, and what the mandate still lacks.
  const own = m.documents ? Object.keys(m.documents) : [];
  if (own.length > 0) {
    const titles = own.map(k => sourceTitle(k, m.documents![k]));
    lines.push(`    its documents (${titles.join(', ')}) can be attached to messages if the sending mandate ticks them under **What the AI may attach**`);
  }
  const wanted = sourcesByConsumer.get(m.id) ?? [];
  if (wanted.length > 0) {
    const consumerAreas = areas.filter(a => covering(input.auths, a).length > 0);
    const ticked = new Set(consumerAreas.flatMap(a => covering(input.auths, a).flatMap(h => csv(h.context?.[ATTACHMENT_SOURCES_FIELD]))));
    const parts = wanted.map(s => {
      const how = s.savedBy ? ` (save the file first with ${s.savedBy})` : '';
      const state = consumerAreas.length === 0 ? '' : ticked.has(s.key) ? ' — allowed' : ' — not ticked in the mandate';
      return `${s.title}${how}${state}`;
    });
    lines.push(`    may attach: ${parts.join('; ')}`);
    if (consumerAreas.length > 0 && wanted.some(s => !ticked.has(s.key))) {
      lines.push('    A source that is not ticked needs the person to edit that mandate: **Mandates**, open it, **Edit**, tick it under **What the AI may attach**, sign again.');
    }
  }
  if (input.detail && m.templates?.length) {
    const days = (ttl?: number) => (ttl ? `${Math.round(ttl / 86400)} days` : 'duration to ask');
    const said = m.templates.map(t => `"${t.name ?? 'Suggested'}" (${t.mode ?? 'mode to ask'}, ${days(t.ttl)}${t.bounds ? `; ${Object.entries(t.bounds).map(([k, v]) => `${k} ${String(v)}`).join(', ')}` : ''})`);
    lines.push(`    suggested settings you can offer: ${said.join('; ')}`);
  }
  const guide = m.setupGuide ?? [];
  const shown = guide.filter(g => !g.simulationOnly || sim);
  if (shown.length > 0 && input.detail) {
    lines.push('    Its setup guide (what the person is shown on its card):');
    shown.forEach((g, i) => lines.push(`      ${i + 1}. ${g.title}${g.description ? ` — ${withoutGatewayAddress(g.description)}` : ''}`));
  }
  return { rank, text: lines.join('\n') };
}

export interface AttachSource {
  /** `connector:kind`, as a reference and a mandate store it. */
  key: string;
  connectorId: string;
  kind: string;
  title: string;
  /** The tool that brings this kind in, as the AI calls it. */
  savedBy?: string;
}

/** All attachable document kinds across `manifests`, each with the tool that saves it (if declared). */
export function attachmentSources(
  manifests: GuideManifest[],
  toolName: (connectorId: string, tool: string) => string,
): AttachSource[] {
  const out: AttachSource[] = [];
  for (const m of manifests) {
    for (const [kind, doc] of Object.entries(m.documents ?? {})) {
      out.push({
        key: `${m.id}:${kind}`,
        connectorId: m.id,
        kind,
        title: sourceTitle(kind, doc),
        ...(doc.savedBy ? { savedBy: toolName(m.id, doc.savedBy) } : {}),
      });
    }
  }
  return out;
}

/**
 * The line added to a tool that takes attachments, built from the manifests:
 * "May attach: Issued invoices; Saved files (save the file first with files__save_file). …"
 * Undefined when no running connector offers a document.
 */
export function attachmentLine(sources: AttachSource[]): string | undefined {
  if (sources.length === 0) return undefined;
  const list = sources
    .map(s => `${s.title} (${s.key}${s.savedBy ? `; save the file first with ${s.savedBy}` : ''})`)
    .join('; ');
  return `May attach: ${list}. Never send without an attachment the person asked for: if it is missing or refused, stop and ask the person.`;
}

/** What a sender is told when no mandate it holds lets it attach what the call carries. */
export function attachmentNotAllowedText(opts: {
  tool: string;
  area: string;
  /** The mandates that could otherwise carry the call. */
  candidates: Array<{ profileId: string; context?: Record<string, unknown> }>;
  refs: Array<{ connector: string; kind: string }>;
  profileOf: (profileId: string) => { scopeSchema?: { fields?: Record<string, unknown> } } | undefined;
  titleOf: (connector: string, kind: string) => string;
}): string {
  const missing = opts.refs.filter(ref => !opts.candidates.some(c => {
    const v = typeof c.context?.[ATTACHMENT_SOURCES_FIELD] === 'string' ? (c.context[ATTACHMENT_SOURCES_FIELD] as string) : undefined;
    return isAttachmentSourceAllowed(c.profileId, opts.profileOf(c.profileId), v, ref).allowed;
  }));
  const named = (missing.length > 0 ? missing : opts.refs).map(r => `${opts.titleOf(r.connector, r.kind)} (${r.connector}:${r.kind})`);
  const titles = [...new Set(named)].join(', ');
  const declared = opts.candidates.some(c => attachmentSourcesFieldDeclared(opts.profileOf(c.profileId)));
  const step = declared
    ? `Tell the person: open **Mandates**, open the ${opts.area} mandate, press **Edit**, tick ${titles} under **What the AI may attach**, and sign it again.`
    : `Tell the person: the ${opts.area} mandate is from a version that cannot carry attachments. They give a new ${opts.area} mandate (**Mandates → + New mandate → ${opts.area}**) and tick ${titles} under **What the AI may attach**.`;
  return `Refused: no ${opts.area} mandate lets ${opts.tool} attach ${titles}. Nothing was sent and no ticket was requested. ${step} Do not send without the attachment they asked for: stop and ask.`;
}

/**
 * The overview a person's AI reads to find out what a goal needs: every connector,
 * whether it is running and set up, whether a mandate covers each of its areas, and
 * for each gap the next step. Ordered so that what must happen first comes first:
 * connectors the person still has to set up, then running connectors with no mandate,
 * then the rest.
 */
/**
 * Setup guides name an example sign-in return address on this gateway. The AI never gets a
 * gateway address (a chat app turns it into a preview of the page); the card shows the real one.
 */
export function withoutGatewayAddress(text: string): string {
  return text.replace(/https?:\/\/[^\s)]+\/auth\/oauth\/[a-z-]+\/callback/gi, 'the return address shown on the card');
}

export function connectorOverview(input: OverviewInput): string {
  const consumers = new Map<string, AttachSource[]>();
  const all = attachmentSources(input.manifests, input.toolName);
  for (const m of input.manifests) {
    const takes = Object.values(m.toolGating?.overrides ?? {}).some(o => !!o?.attachmentsArg);
    if (takes) consumers.set(m.id, all);
  }
  const lines = input.manifests.map(m => connectorLine(m, input, consumers));
  lines.sort((a, b) => a.rank - b.rank);
  const head = [
    'Connectors, in the order to act (a connector must run before its mandate does anything):',
  ];
  return [...head, ...lines.map(l => l.text)].join('\n');
}

/** Short pointer for the session instructions: where the AI finds the steps. */
export const LEAD_THE_PERSON_RULE =
  'When the person wants something done and a tool is refused or not set up, call list-authorizations(domain) with the area of the task: it gives what is missing and the exact steps the person takes. Name the buttons exactly as it does and wait; never work around a refusal. list-authorizations() with no argument gives only where things stand and the one next step.';

// ─── 3. Who the AI is for the person, and the facts it draws on ─────────────

/**
 * The AI's role, sent in every mode (Andreas, 2026-11-10): nobody should need to learn
 * Suveren to get their work done. Their AI leads them, with Suveren's help, in the fewest
 * steps and the plainest words. It gives the AI a role and leaves the words to it, so it
 * holds whatever the person opens with. No sentence here may differ by mode: the working
 * AI reads it too and must not be able to tell a test gateway from a real one.
 */
export const ROLE_TEXT =
  'Your person probably knows nothing about Suveren, and may expect to learn a tool and click through it. They do not have to. ' +
  'Meet them wherever they start: a greeting, a question, a task, a complaint. ' +
  'Lead them to the new way of working: they say what they want done, you do the work, they set the limits and decide. ' +
  'Do not teach the tool; find the result they want. If they ask where to click or describe steps, ask what they want to end up with and take it from there. ' +
  'If work repeats, offer to take it over. Get their task done in the fewest steps. Use short, plain words. ' +
  'Explain a Suveren word only when it is needed, in one sentence. If they do not know what they want, say what is possible here and suggest one thing. ' +
  'Give one next step at a time. Do everything you can yourself and leave them only what only they can do: sign, approve, decide. ' +
  'Recommend safe limits and say why. They decide; you never decide for them and never press them. ' +
  'They are the final authority, not Suveren and not you.';

/** How many area names one line may carry. Above this the line says how many more there are. */
const MAX_AREAS_IN_ONE_LINE = 20;

/** The areas of work these connectors serve, once each, by the name the person sees. */
export function possibleAreas(manifests: GuideManifest[], areaName: (area: string) => string): string[] {
  return [...new Set(manifests.flatMap(m => manifestAreas(m)).map(areaName))];
}

function joinAreas(names: string[]): string {
  const shown = names.slice(0, MAX_AREAS_IN_ONE_LINE).join(', ');
  return names.length > MAX_AREAS_IN_ONE_LINE ? `${shown} and ${names.length - MAX_AREAS_IN_ONE_LINE} more` : shown;
}

/** The facts the AI draws on, stated as facts: it finds the words. Identical in every mode. */
export function factsLines(opts: { card: string; areas: string[]; port?: string }): string[] {
  return [
    `The Suveren Gateway page is opened by the person, in their own browser, outside this chat. You never write its address.${opts.port ? ` Only if they cannot find it, say in words that it runs on this computer on port ${opts.port}.` : ''}`,
    'A mandate is a permission the person gives their AI, with limits they choose. For example: "Send up to 5 emails a day, and show me each one first." It says what the AI may do, how much, for how long, and whether each action needs their approval or runs by itself within the limits. The AI needs a mandate for each kind of work. They can change or revoke it at any time.',
    `The ${opts.card} mandate is how the person manages their mandates from this chat. They sign it once. After that they just say here what the AI should be able to do; the AI prepares the mandate with its limits and duration, and they only approve it. Without it they fill in a form themselves for every mandate.`,
    `The ${opts.card} mandate allows no work. None of the mandates the AI prepares exists until the person approves it. It is the easiest start. An AI can never create the first mandate: a person signs it.`,
    ...(opts.areas.length > 0 ? [`Possible on this gateway: ${joinAreas(opts.areas)}.`] : []),
  ];
}

// ─── 4. The short answer to list-authorizations() with no argument ──────────

export interface ShortAnswerInput extends Pick<OverviewInput, 'manifests' | 'facts' | 'auths' | 'areaName' | 'setup' | 'team'> {
}

/** One line: every area this gateway can work in, and which of them a mandate covers. */
function possibleLine(input: ShortAnswerInput): string | undefined {
  const areas = input.manifests.flatMap(m => manifestAreas(m));
  if (areas.length === 0) return undefined;
  const nameOf = (list: string[]) => [...new Set(list.map(input.areaName))];
  const covered = areas.filter(a => covering(input.auths, a).length > 0);
  const open = areas.filter(a => covering(input.auths, a).length === 0);
  if (covered.length === 0) return `Possible here: ${joinAreas(nameOf(open))}.`;
  return `Possible here. With a mandate: ${joinAreas(nameOf(covered))}.${open.length > 0 ? ` No mandate yet: ${joinAreas(nameOf(open))}.` : ''}`;
}

/** What the current state requires, as ONE step. The steps of one area come from list-authorizations(domain). */
function oneNextStep(input: ShortAnswerInput): string {
  const { auths, setup, manifests, areaName } = input;
  const complete = auths.filter(a => a.complete);
  const stale = complete.filter(a => a.needsReapproval);
  if (stale.length > 0) {
    return `A person signs these again: ${joinAreas([...new Set(stale.map(a => areaName(shortOf(a.profileId))))])}. They open **Mandates** and press **Sign again**. Until then they do not work.`;
  }
  if (complete.length === 0) {
    if (auths.length > 0) return 'Wait for the other owners above to sign. Ask the person to remind them.';
    if (setup.area && input.team?.get(setup.area)?.teamCode) return howToGetMandate(setup.area, setup.card, input);
    const fields = setup.area ? ` The form, step by step: list-authorizations(domain: "${setup.area}").` : '';
    return `A person signs the first mandate: an AI can never create it. On the Suveren Gateway page, which they open themselves in their own browser, outside this chat, they open **Mandates**, then **+ New mandate**, pick the card **${setup.card}** and press **Give a mandate**. Tell them why: they sign it once, and from then on they manage their mandates from this chat. They say what you should be able to do, you prepare the mandate, and they only approve it. It allows no work itself. They can sign the mandate of one area themselves instead, by filling in its form.${fields}`;
  }
  const askAndDo = 'Ask what the person wants done';
  if (setup.tool && complete.length === setup.held.length) {
    return `${askAndDo}, then propose the mandate for that area with ${setup.tool}. For its fields: list-authorizations(domain: "<area>").`;
  }
  const stopped = manifests.find(m => {
    const f = input.facts(m.id);
    return !f.running && f.blocked !== 'simulation' && manifestAreas(m).some(a => covering(auths, a).length > 0);
  });
  if (stopped) {
    const area = manifestAreas(stopped).find(a => covering(auths, a).length > 0)!;
    return `The ${stopped.name} connector is not running, so its mandate does nothing yet. The steps: list-authorizations(domain: "${area}").`;
  }
  return `${askAndDo} and do it within the active mandates. If no mandate covers it: list-authorizations(domain: "<area>").`;
}

/** What the AI can do without the person, in this state. */
function whatYouCanDo(input: ShortAnswerInput): string {
  const works = input.auths.some(a => a.complete && !a.needsReapproval && !input.setup.held.includes(a));
  const parts: string[] = [];
  if (works) parts.push('do the work the active mandates allow (under a review mandate you create a proposal and the person approves it)');
  if (input.setup.tool) parts.push(`propose new mandates with ${input.setup.tool}, for the person to approve`);
  if (parts.length === 0) parts.push('find out what the person wants done, say which area it belongs to and recommend safe limits. Only a person can sign');
  return `You can do yourself: ${parts.join('; and ')}.`;
}

/**
 * The short answer an AI gets when it asks without naming an area: what is possible, the ONE
 * next step, what it can do itself. Every connector's steps live in list-authorizations(domain):
 * an AI handed all of them summarises status and never gets to the step that matters (2026-11-10).
 */
export function shortAnswer(input: ShortAnswerInput): string {
  const lines: string[] = [];
  const possible = possibleLine(input);
  if (possible) lines.push(possible);
  lines.push(`The one next step: ${oneNextStep(input)}`);
  lines.push(whatYouCanDo(input));
  lines.push('For the exact steps of one area: list-authorizations(domain: "<area>"), with the area of the task.');
  return lines.join('\n');
}

/** What the AI does before it proposes a mandate. */
export const BEFORE_PROPOSING =
  'Before you propose a mandate, ask everything you need in one message, as a short bullet list: should it run by itself or ask them each time, how much may it do, how long should it last. After each answer, ask again only the points still open, as a shorter list, until none is left. If this connector offers suggested settings, offer those; otherwise suggest what fits the work and say why. They decide. Never set a one-day duration unless they asked for it. Tell them in plain words what the mandate really allows (what, how much, to whom, for how long).';

/**
 * The step for the person after the Authority Server (or the gate's own check) refused a call,
 * by its canonical code. Every refusal text ends with one, so nobody is left not knowing what to do.
 * `card` is the connector's card name when known.
 */
export function refusalNextStep(code: unknown, card?: string): string {
  const c = typeof code === 'string' ? code : '';
  const sign = card ? `**Mandates → + New mandate →** card **${card}**` : '**Mandates → + New mandate**';
  switch (c) {
    case 'MANDATE_REVOKED':
    case 'MANDATE_EXPIRED':
    case 'MANDATE_NOT_FOUND':
      return `Nothing ran. Tell the person this mandate is no longer valid. They give a new one (${sign}) or press **Sign again** on it under **Mandates**. Do not retry.`;
    case 'BOUND_EXCEEDED':
    case 'CUMULATIVE_LIMIT_EXCEEDED':
      return 'Nothing ran. Tell the person a limit stopped it. They can raise it (**Mandates**, open the mandate, **Edit**, sign again) or wait until the period ends. Do not retry the same call.';
    case 'PROFILE_NOT_ENABLED_FOR_GROUP':
    case 'OWNER_NOT_APPROVER':
      return 'Nothing ran. Tell the person: their team has not enabled this area for them. A team admin opens **Team → Manage this team in your Authority Server** and enables it. Do not retry.';
    case 'RATE_LIMITED':
      return 'Nothing ran. Wait a minute and try once more; if it is refused again, tell the person.';
    default:
      return 'Nothing ran. Tell the person what is written above and ask what they want to do. Do not retry.';
  }
}

/** Why a proposal was refused, when the reason is that its mandate is dead. */
export function endedFromRefusal(code: string | undefined): MandateEnded | undefined {
  return code === 'MANDATE_REVOKED' ? 'revoked' : code === 'MANDATE_EXPIRED' ? 'expired' : undefined;
}

/**
 * What the AI is told about a proposal whose mandate is dead: it can never be approved.
 * Spoken once about the proposal, not about what the person did, so the AI stops waiting
 * and does not send the person back to the Approve button.
 */
export function mandateEndedProposalText(proposalId: string, ended: MandateEnded): string {
  const fact = ended === 'revoked' ? 'the mandate was revoked after this proposal' : 'the mandate expired after this proposal';
  return `Proposal ${proposalId} can no longer be approved: ${fact}, so it will never run. Nothing ran. A new mandate is needed; tell the person so, and do not ask them to approve this proposal again.`;
}

/** The ending of a refusal about one attachment: what the person does, and that the AI stops. */
export function attachmentFailureStep(opts: {
  code?: string;
  connector: string;
  connectorName?: string;
  /** The tool that brings this kind in, as the AI calls it. */
  savedBy?: string;
}): string {
  const name = opts.connectorName ?? opts.connector;
  const stop = 'Do not send without the attachment the person asked for: stop and ask them.';
  switch (opts.code) {
    case 'UNKNOWN_CONNECTOR':
    case 'UNAVAILABLE':
      return `Tell the person: the ${name} connector is not running. They open **Connectors**, find the card **${name}** and start it. ${stop}`;
    case 'NOT_FOUND':
      return opts.savedBy
        ? `That document does not exist yet. Bring it in first with ${opts.savedBy}, then attach the id it returns. ${stop}`
        : `That document does not exist. Ask the person which one they mean. ${stop}`;
    case 'TOO_LARGE':
      return `Ask the person for a smaller file or fewer attachments. ${stop}`;
    default:
      return `Tell the person what is written above; nothing was sent. ${stop}`;
  }
}
