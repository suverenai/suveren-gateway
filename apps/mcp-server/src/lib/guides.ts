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

/** "Every guide starts with" — the language rule and the systems actually connected. */
export function guideHeader(systems: SystemLine[]): string {
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
  lines.push('');
  lines.push(`**Approvals:** every mandate and brief you propose waits until the person approves it in the Suveren Gateway at ${uiUrl()}/approvals. Tell them each time you propose one.`);
  return lines.join('\n');
}
