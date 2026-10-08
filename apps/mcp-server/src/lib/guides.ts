/**
 * Setup guides — the written instructions the setup AI reads through
 * `setup__get_guide` (simulation setup S10). Nothing about the topics is in code:
 *
 * - Defaults ship with the gateway as markdown files (`content/guides/`, found via
 *   SUVEREN_BUILTIN_GUIDES_DIR, which the npm bundle and Docker set; the repo path
 *   otherwise).
 * - An optional override folder (SUVEREN_GUIDES_DIR) is read on top: a file whose
 *   topic matches a default replaces it; a new file adds a topic. A company adapts
 *   the texts without a gateway release.
 *
 * File format: `<n>-<topic>.md` (the number sets the order; optional in the
 * override folder — an override keeps the default's place, a new topic goes
 * last). The first line is `# <Title>`, the first paragraph after it is the
 * one-line summary shown in the topic list.
 *
 * Read on every call, so an edited override applies without a restart.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { uiUrl } from './locked-notice';
import { AGENT_RULES } from './agent-rules';

export interface Guide {
  topic: string;
  order: number;
  title: string;
  summary: string;
  body: string;
  /** 'default' or 'override' — where the text came from. */
  source: 'default' | 'override';
}

const FILE_RE = /^(?:(\d+)-)?([a-z0-9][a-z0-9-]*)\.md$/;

/**
 * The default guides: SUVEREN_BUILTIN_GUIDES_DIR (the npm bundle and Docker set it),
 * else the repo's `content/guides`, found by walking up from this module. A fixed
 * number of `..` would be right only for one layout — the source file sits four
 * levels below the repo root, the compiled `dist/http.mjs` three.
 */
export function builtinGuidesDir(): string {
  if (process.env.SUVEREN_BUILTIN_GUIDES_DIR) return process.env.SUVEREN_BUILTIN_GUIDES_DIR;
  let dir = import.meta.dirname ?? __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'content', 'guides');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(import.meta.dirname ?? __dirname, 'content', 'guides'); // nothing found — an empty list, not a crash
}

function parse(body: string): { title: string; summary: string } {
  const lines = body.split(/\r?\n/);
  const titleLine = lines.find(l => l.startsWith('# ')) ?? '';
  const title = titleLine.slice(2).trim();
  const after = lines.slice(lines.indexOf(titleLine) + 1);
  const summary = after.find(l => l.trim() !== '' && !l.startsWith('#'))?.trim() ?? '';
  return { title, summary };
}

function readDir(dir: string | undefined, source: Guide['source']): Guide[] {
  if (!dir || !existsSync(dir)) return [];
  const out: Guide[] = [];
  for (const file of readdirSync(dir)) {
    const m = FILE_RE.exec(file);
    if (!m) continue;
    let body: string;
    try { body = readFileSync(join(dir, file), 'utf8'); } catch { continue; }
    const { title, summary } = parse(body);
    out.push({ topic: m[2], order: m[1] ? Number(m[1]) : Number.POSITIVE_INFINITY, title: title || m[2], summary, body, source });
  }
  return out;
}

/** All guides, defaults overlaid by the override folder, in reading order. */
export function loadGuides(
  builtinDir: string = builtinGuidesDir(),
  overrideDir: string | undefined = process.env.SUVEREN_GUIDES_DIR,
): Guide[] {
  const byTopic = new Map<string, Guide>();
  for (const g of readDir(builtinDir, 'default')) byTopic.set(g.topic, g);
  for (const g of readDir(overrideDir, 'override')) {
    const replaced = byTopic.get(g.topic);
    byTopic.set(g.topic, { ...g, order: Number.isFinite(g.order) ? g.order : replaced?.order ?? Number.POSITIVE_INFINITY });
  }
  return [...byTopic.values()].sort((a, b) => a.order - b.order || a.topic.localeCompare(b.topic));
}

/** One installed system as the guides see it: what it is governed by and what it can do. */
export interface SystemLine {
  id: string;
  profile: string;
  actionTypes: string[];
  writeTools: string[];
  readTools: string[];
}

/** "Every guide starts with" — the language rule, the rules, the systems actually
 *  connected, and the simulated systems not activated yet (`inactive`: their names). */
export function guideHeader(systems: SystemLine[], inactive: string[] = []): string {
  const lines = [
    '> This guide is in English. Talk to the person in their language, and write the brief and mandate intents in the language the team uses.',
    '',
    '**Systems connected to this gateway:**',
    '',
  ];
  if (systems.length === 0) {
    lines.push('- none yet — ask the person to connect the systems the work needs before you continue.');
  } else {
    for (const s of systems) {
      const parts = [`profile \`${s.profile}\``];
      if (s.actionTypes.length) parts.push(`action types ${s.actionTypes.map(a => `\`${a}\``).join(', ')}`);
      if (s.writeTools.length) parts.push(`changes via ${s.writeTools.map(t => `\`${t}\``).join(', ')}`);
      if (s.readTools.length) parts.push(`reads via ${s.readTools.map(t => `\`${t}\``).join(', ')}`);
      lines.push(`- **${s.id}** — ${parts.join('; ')}`);
    }
  }
  if (inactive.length) {
    lines.push('');
    lines.push('**Available but not activated:** ' + inactive.map(n => `**${n}**`).join(', ') + '. Before anything else, ask the person to activate the ones the work needs: in the Suveren Gateway, Integrations → the system\'s card → Activate. Then read this guide again — a system you cannot see here does not exist for the test.');
  }
  lines.push('');
  lines.push(`**Approvals:** every mandate and brief you propose waits until the person approves it in the Suveren Gateway at ${uiUrl()}/approvals. Tell them each time you propose one.`);
  lines.push('');
  lines.push('**Rules:**');
  for (const r of AGENT_RULES) lines.push(`- ${r}`);
  return lines.join('\n');
}

// ── Generated sections ────────────────────────────────────────────────────────
// A guide may contain `<!-- generated: limits -->` or `<!-- generated: package -->`;
// the gateway replaces them with what it reads from the connected systems, so the
// setup AI can propose valid mandates and a valid package BEFORE it holds any
// mandate for them (their own tools stay hidden until then). Placeholders, not
// topic names: an override guide decides where (and whether) they appear.

interface FieldDef {
  type?: string; displayName?: string; description?: string; unit?: string; default?: unknown;
  boundType?: { kind?: string; values?: unknown[]; window?: string };
  enum?: unknown[]; maximum?: number;
}
interface FieldsSchema { keyOrder?: string[]; fields?: Record<string, FieldDef> }
export interface ProfileLike { id: string; boundsSchema?: FieldsSchema; scopeSchema?: FieldsSchema }

/** A profile's scope fields (protocol 0.7 vocabulary: "scope", `scopeSchema`
 *  — no alias; every profile this gateway loads is v0.4+, which always
 *  carries the field under one name or the other, but only the current one
 *  is still typed since hap-core 0.12 dropped `contextSchema` entirely). */
export function scopeFieldsOf(profile: ProfileLike): FieldsSchema | undefined {
  return profile.scopeSchema;
}

function fieldLine(name: string, f: FieldDef): string {
  const kind: string[] = [];
  const values = f.boundType?.values ?? f.enum;
  if (Array.isArray(values)) kind.push(`one of ${values.map(v => `\`${String(v)}\``).join(', ')}`);
  else if (f.type) kind.push(f.type);
  if (f.unit) kind.push(f.unit);
  if (f.boundType?.window) kind.push(`per ${f.boundType.window === 'daily' ? 'day' : f.boundType.window}`);
  if (typeof f.maximum === 'number') kind.push(`at most ${f.maximum}`);
  if (f.default !== undefined) kind.push(`default \`${String(f.default)}\``);
  const label = f.displayName ? ` (${f.displayName})` : '';
  return `- \`${name}\`${label} — ${kind.join(', ') || 'value'}${f.description ? `. ${f.description}` : ''}`;
}

function fieldLines(schema: FieldsSchema | undefined): string[] {
  const fields = schema?.fields ?? {};
  const order = (schema?.keyOrder ?? Object.keys(fields)).filter(k => k !== 'profile' && k !== 'path' && fields[k]);
  return order.map(k => fieldLine(k, fields[k]));
}

/** "Limits and scope per system", from each connected system's profile. */
export function limitsSection(systems: Array<{ id: string; profile: ProfileLike | undefined }>): string {
  const out = ['## Limits and scope per system', '', 'From the profiles — use exactly these names in `create_mandate` (`limits` and `scope`). Every limit must be set.', ''];
  for (const s of systems) {
    if (!s.profile) continue;
    out.push(`### ${s.id} — profile \`${s.profile.id}\``, '', '**Limits:**', ...fieldLines(s.profile.boundsSchema));
    const scope = fieldLines(scopeFieldsOf(s.profile));
    out.push('', '**Scope:**', ...(scope.length ? scope : ['- none']), '');
  }
  return out.join('\n');
}

/** "The package format", from a simulated system's `load_simulation` input schema. */
export function packageSection(tool: { inputSchema?: Record<string, unknown>; description?: string } | undefined): string {
  if (!tool?.inputSchema) return '## The package format\n\nNo simulated system with `load_simulation` is active — ask the person to activate one first.';
  const pkg = (tool.inputSchema.properties as Record<string, unknown> | undefined)?.package ?? tool.inputSchema;
  return [
    '## The package format', '',
    ...(tool.description ? ['What the simulated systems say about it:', '', `> ${tool.description}`, ''] : []),
    'The `package` argument of `load_simulation` — the same package for every simulated system:', '',
    '```json', JSON.stringify(pkg, null, 2), '```',
  ].join('\n');
}

/** Replace the `<!-- generated: … -->` placeholders in a guide body. */
export function fillGenerated(body: string, sections: Record<string, () => string>): string {
  return body.replace(/<!--\s*generated:\s*([a-z-]+)\s*-->/g, (m, key: string) => (sections[key] ? sections[key]() : m));
}
