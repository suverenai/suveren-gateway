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
  setupHint?: string;
  setupGuide?: Array<{ title: string; description?: string }>;
  credentials?: { fields?: Array<{ key: string; optional?: boolean }> };
  oauth?: unknown;
  documents?: Record<string, GuideDocument>;
  toolGating?: { overrides?: Record<string, { profile?: string; attachmentsArg?: string } | null> };
}

export interface GuideAuth {
  profileId: string;
  complete: boolean;
  needsReapproval?: boolean;
  context?: Record<string, string | number>;
  deferredCommitmentDomains?: string[];
}

export interface ConnectorFacts {
  running: boolean;
  /** Not running solely because of the gateway's mode. */
  blocked?: 'simulation' | 'production';
  /** The person has saved settings for it. */
  hasCredentials: boolean;
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

/** Does the connector need the person to enter something before it can start? */
function needsSettings(m: GuideManifest): boolean {
  return !!m.oauth || (m.credentials?.fields ?? []).some(f => !f.optional);
}

// ─── 1. The first mandate ───────────────────────────────────────────────────

/**
 * What to tell a person when nothing is set up. The first mandate can only be
 * signed by a person on the page: an AI cannot propose it. `card` is the name
 * the page shows on the mandate that lets the AI prepare other mandates.
 */
export function firstMandateText(opts: { url: string; card: string }): string {
  return [
    'No mandate exists yet, so no tool works. An AI can never create the first one: a person signs it. If the person asks how to start, tell them, in this order:',
    `1. Open the Suveren Gateway at ${opts.url}. In the left menu choose **Mandates**, then **+ New mandate** (top right).`,
    `2. Pick the card **${opts.card}** and press **Give a mandate**. It lets you prepare further mandates; the person approves each one before it exists. (Instead, they can pick the card of the area they need and sign that mandate themselves.)`,
    '3. The form has three steps: **Scope & Limits**, **Intent**, **Sign**. In Scope & Limits they name the areas you may prepare mandates for, the modes you may propose (review = they approve every action; automatic = it runs within the limits) and how many proposals a day. In Intent they write, in their own words, why they give it. Then they press **Sign mandate (asks first)**.',
    'Afterwards call list-authorizations(): it says what is still missing and what to do next.',
  ].join('\n');
}

// ─── 2. What is needed ──────────────────────────────────────────────────────

export interface SetupMandateFacts {
  /** The tool that proposes a mandate, as the AI calls it (e.g. "setup__create_mandate"); undefined = not listed to it. */
  tool?: string;
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
  /** One connector asked for by name: print its whole setup guide, not just the titles. */
  detail?: boolean;
}

/** Which of `areas` a held mandate covers. */
function covering(auths: GuideAuth[], area: string): GuideAuth[] {
  return auths.filter(a => a.complete && !a.needsReapproval && matches(a.profileId, area));
}

/** How to get a missing mandate for `area`, as one or two short sentences for the AI to pass on. */
export function howToGetMandate(
  area: string,
  card: string,
  input: Pick<OverviewInput, 'areaName' | 'setup' | 'team'>,
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
      return `Not yours to propose: the person's ${setup.card} mandate does not list ${name}. Tell them either to sign it themselves (**Mandates → + New mandate →** card **${card}**) or to add ${name} to the ${setup.card} mandate (**Mandates**, open it, **Edit**); then you can propose it.`;
    }
    const modes = [...new Set(setup.held.flatMap(h => csv(setup.fields.mode ? h.context?.[setup.fields.mode] : undefined)))];
    const modeNote = modes.length > 0 ? ` (modes you may propose: ${modes.join(', ')})` : '';
    return `Propose it with ${setup.tool}(profile: "${shortOf(area)}", ...)${modeNote}. ${BEFORE_PROPOSING} The person approves it in the gateway.`;
  }
  return `A person signs it: **Mandates → + New mandate**, card **${card}**, **Give a mandate**. (With a ${setup.card} mandate you could prepare it for them.)`;
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

  let state: string;
  if (f.running) {
    state = 'running';
  } else if (f.blocked === 'simulation') {
    state = 'not available right now';
    rank = 4;
  } else if (f.blocked === 'production') {
    state = 'not running: it is set to test data, and this gateway runs for real. A person changes its setting under **Connectors**';
    rank = 0;
  } else if (needsSettings(m) && !f.hasCredentials) {
    state = 'not set up. A person opens **Connectors**, finds the card **' + m.name + '** and follows the steps on it' + (input.detail && m.setupHint ? ` (${m.setupHint})` : '');
    rank = 0;
  } else {
    state = 'set up, but not running. A person opens **Connectors**, finds the card **' + m.name + '** and presses its start button';
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
      lines.push(`    mandate for ${input.areaName(area)}: none. ${howToGetMandate(area, m.name, input)}`);
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
  const guide = m.setupGuide ?? [];
  if (guide.length > 0 && input.detail) {
    lines.push('    Its setup guide (what the person is shown on its card):');
    guide.forEach((g, i) => lines.push(`      ${i + 1}. ${g.title}${g.description ? ` — ${g.description}` : ''}`));
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
  'When the person wants something done and a tool is refused or not set up, call list-authorizations() with no argument: it lists every connector, what is missing and the exact steps the person takes. Say those steps in its words and wait; never work around a refusal.';

/** What the AI does before it proposes a mandate. */
export const BEFORE_PROPOSING =
  'Before you propose: ask the person whether it should run automatically or ask them each time (review). Use the lowest limits and the shortest duration that cover the work. Tell them in plain words what the mandate really allows (what, how much, to whom, for how long).';

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
