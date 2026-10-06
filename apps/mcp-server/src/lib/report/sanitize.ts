/**
 * Sanitize the AI's report HTML before it is ever verified or rendered —
 * work-plan "regular reporting", decision 5: the TWO-TAG RULE (RR6).
 *
 * A report is a flat sequence of top-level blocks, each one of exactly two
 * kinds:
 *   - a gateway element (`sv-ticket`, `sv-approval`, `sv-mandate`,
 *     `sv-record`, `sv-case`, `sv-metric`), optionally grouped in `<sv-row>`
 *     (which may hold only those elements) — references only, the gateway
 *     draws them;
 *   - `<sv-ai>…</sv-ai>` — the AI's own content, drawn in a grey "AI analysis
 *     — not verified" frame.
 * Plus at most one `<sv-glossary>` of `<sv-term key="…">word</sv-term>`.
 * Anything else at top level is DROPPED and counted, so `write_report` can
 * tell the AI what it lost ("dropped: N blocks outside sv-ai").
 *
 * Inside `sv-ai` the AI may write any HTML / inline SVG, minus:
 *   - every `sv-*` element (no verified element inside an AI block, and no
 *     way to nest a frame) — removed with its content;
 *   - `<style>` — see "Styles" below;
 *   - scripts, frames, plugins, `<base>`, `<meta>`, raw-text tags that would
 *     swallow the gateway's own markup that follows (`plaintext`, `xmp`, …),
 *     and the elements that render in the browser's TOP LAYER (`dialog`,
 *     `select` pickers, any `popover` attribute) — the top layer ignores the
 *     frame's clipping, so it is the one way content could escape it;
 *   - `html`/`head`/`body` tags are renamed to `div`: a `<body style=…>`
 *     nested in content would otherwise be merged onto the REAL body by the
 *     browser's HTML parser;
 *   - every `on*` handler, every URL that is not a `#fragment` or
 *     `data:image/*`, `id`s and classes starting `sv-` (the gateway's own).
 *
 * Styles — INLINE ONLY (the robust option of the two the plan allows). A
 * `style="…"` attribute has no selector: it can only ever style its own
 * element (and pass inherited properties to its own descendants), all of
 * which sit inside the clipped frame. Scoping a `<style>` block instead
 * would mean parsing adversarial CSS and rewriting every selector correctly
 * — `:has()`, nesting (`&`), `@scope`, `@layer`, `@import`, `:root`,
 * brace-injection, and whatever selector syntax browsers add next — where one
 * missed case reaches the gateway's own boxes. Inline styles have no such
 * case to miss. Cost, accepted: no media queries or `:hover` inside an AI
 * block (the brief tells the AI to use wrapping flex/grid and % widths).
 * Inline declarations that load a URL (`url(…)`, `image-set(…)`) other than
 * `data:image/*` are removed too (the render is also CSP-locked).
 *
 * Uses `sanitize-html` (a vetted library with its own test suite) for the
 * content inside `sv-ai`, and `htmlparser2` (its own parser) for the
 * top-level structure — an independent model of "what is this tag", not a
 * regex.
 */
import sanitizeHtmlLib from 'sanitize-html';
import { parseDocument } from 'htmlparser2';
import { REPORT_ELEMENTS, REPORT_BLOCKS } from '../report-brief';

/** The structural tags of the report format — never elements to verify. */
export const STRUCTURE_TAGS = new Set<string>(REPORT_BLOCKS);
const VERIFIED_KINDS = new Set<string>(REPORT_ELEMENTS);

/** A gloss is plain text, at most this many characters (decision 5: "length-limited"). */
export const MAX_GLOSS_CHARS = 60;
/** Characters a gloss may never carry — it must not borrow the gateway's seal. */
const CHECK_MARK_RE = /[✓✔✅☑☒✗✘❌❎\u{1f5f8}]/u;

const FORBIDDEN_IN_AI = new Set([
  'script', 'iframe', 'object', 'embed', 'link', 'base', 'meta', 'style',
  'frame', 'frameset', 'portal', 'fencedframe', 'applet',
  'plaintext', 'xmp', 'listing', 'noembed', 'noframes',
  'dialog', 'select',
]);

/** Attribute names (case-insensitive) that may carry a URL and so are
 *  subject to the fragment/data-image-only rule. */
function isUrlAttribute(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'href' || n === 'src' || n === 'srcset' || n === 'action' || n === 'formaction' ||
    n === 'poster' || n === 'background' || n === 'ping' || n === 'data' || n === 'xlink:href' ||
    n.endsWith(':href');
}

function isAllowedUrl(value: string): boolean {
  const v = value.trim();
  if (v.startsWith('#')) return true; // same-document fragment link
  if (/^data:image\//i.test(v)) return true; // inline image
  return false;
}

/** Drops inline-style declarations that would load a resource. */
function cleanInlineStyle(value: string): string {
  return value
    .split(';')
    .filter(decl => {
      if (/@import/i.test(decl)) return false;
      if (/image-set\s*\(/i.test(decl)) return false;
      const urls = [...decl.matchAll(/url\s*\(\s*(['"]?)([^'")]*)/gi)];
      return urls.every(m => /^data:image\//i.test(m[2].trim()));
    })
    .join(';')
    .trim();
}

/**
 * `sv-*` class names and `data-sv-*` attributes belong to the gateway (drawn
 * boxes, frames, the offline checker's markers). Stripped from the AI's
 * markup so it cannot borrow the gateway's own stylesheet (review SR5).
 */
export function stripGatewayClasses(value: string): string {
  return value.split(/\s+/).filter(c => c && !/^sv-/i.test(c)).join(' ');
}

export interface SanitizeNotes {
  /** Top-level content outside every allowed block (and non-elements inside
   *  an sv-row) — dropped. */
  droppedBlocks: number;
  /** sv-* elements written inside an sv-ai block — removed. */
  droppedSvInsideAi: number;
  /** <style> blocks — removed (inline style attributes only). */
  droppedStyles: number;
  /** Every sv-glossary after the first — ignored. */
  extraGlossaries: number;
  /** Glossary entries refused by the sanitizer itself. */
  rejectedTerms: Array<{ key: string; reason: string }>;
}

export interface SanitizeResult {
  html: string;
  notes: SanitizeNotes;
}

// Minimal structural view of domhandler nodes (htmlparser2 does not re-export
// the node types, and domhandler is not a direct dependency).
interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
  startIndex: number | null;
  endIndex: number | null;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textOf(node: DomNode): string {
  if (node.type === 'text') return node.data ?? '';
  return (node.children ?? []).map(textOf).join('');
}

function countTags(node: DomNode, pred: (name: string) => boolean): number {
  let n = 0;
  for (const c of node.children ?? []) {
    if (c.type === 'tag' || c.type === 'script' || c.type === 'style') {
      if (pred(c.name ?? '')) { n++; continue; } // removed with its content
      n += countTags(c, pred);
    }
  }
  return n;
}

function isElement(node: DomNode): boolean {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}

/** A verified element, re-serialized from its attributes only (it has no content). */
function serializeVerified(node: DomNode): string {
  const attrs = Object.entries(node.attribs ?? {})
    .filter(([k]) => /^[a-z][a-z0-9_-]*$/i.test(k) && !/^on/i.test(k))
    .map(([k, v]) => ` ${k.toLowerCase()}="${escapeAttr(v)}"`)
    .join('');
  return `<${node.name}${attrs}></${node.name}>`;
}

/** The content of one sv-ai block, through sanitize-html with the rules in
 *  the module comment. */
function sanitizeAiContent(inner: string): string {
  return sanitizeHtmlLib(inner, {
    // Deny-by-name, not allow-by-name: the AI writes free HTML structure and
    // inline SVG; `transformTags['*']` below is the ONLY attribute filter.
    // `allowVulnerableTags` silences sanitize-html's notice about style/script
    // — both are still removed by `exclusiveFilter`.
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    allowedSchemes: [...sanitizeHtmlLib.defaults.allowedSchemes, 'data'],
    // Keep camelCase SVG attributes (viewBox, …); every check below folds case.
    parser: { lowerCaseAttributeNames: false },
    exclusiveFilter: (frame) => {
      const tag = frame.tag.toLowerCase();
      if (FORBIDDEN_IN_AI.has(tag)) return true;
      if (tag.startsWith('sv-')) return true;
      return false;
    },
    transformTags: {
      '*': (tagName, attribs) => {
        const lowerTag = tagName.toLowerCase();
        // Renamed, attributes dropped: see module comment (body-attribute merge).
        if (lowerTag === 'html' || lowerTag === 'head' || lowerTag === 'body' || lowerTag === 'title') {
          return { tagName: 'div', attribs: {} };
        }
        const kept: Record<string, string> = {};
        for (const [name, value] of Object.entries(attribs)) {
          const lower = name.toLowerCase();
          if (lower.startsWith('on')) continue;
          if (isUrlAttribute(name) && !isAllowedUrl(value)) continue;
          if (lower.startsWith('data-sv')) continue;
          if (lower === 'popover' || lower === 'popovertarget' || lower === 'popovertargetaction') continue;
          if (lower === 'id' && /^sv-/i.test(value.trim())) continue;
          if (lower === 'class') {
            const classes = stripGatewayClasses(value);
            if (classes) kept[name] = classes;
            continue;
          }
          if (lower === 'style') {
            const style = cleanInlineStyle(value);
            if (style) kept[name] = style;
            continue;
          }
          kept[name] = value;
        }
        return { tagName, attribs: kept };
      },
    },
  });
}

/**
 * Applies the two-tag rule. Returns the normalized report html (only allowed
 * blocks, in order) and what was dropped. Idempotent: sanitizing the output
 * again yields the same html and no further drops.
 */
export function sanitizeReport(html: string): SanitizeResult {
  const notes: SanitizeNotes = {
    droppedBlocks: 0, droppedSvInsideAi: 0, droppedStyles: 0, extraGlossaries: 0, rejectedTerms: [],
  };
  const doc = parseDocument(html, {
    withStartIndices: true,
    withEndIndices: true,
    recognizeSelfClosing: true,
    decodeEntities: true,
  }) as unknown as DomNode;

  const out: string[] = [];
  let glossarySeen = false;

  const isBlank = (n: DomNode) => n.type === 'text' && !(n.data ?? '').trim();
  const isIgnorable = (n: DomNode) => isBlank(n) || n.type === 'comment' || n.type === 'directive' || n.type === 'cdata';

  /** A verified element (or an unknown sv-* — it renders "not verifiable").
   *  An unclosed element swallows what follows it; those children are
   *  processed as siblings at the same level, never lost silently. */
  function emitVerified(node: DomNode, sink: string[], inRow: boolean) {
    sink.push(serializeVerified(node));
    for (const c of node.children ?? []) processAt(c, sink, inRow);
  }

  function emitAi(node: DomNode) {
    notes.droppedSvInsideAi += countTags(node, n => n.startsWith('sv-'));
    notes.droppedStyles += countTags(node, n => n === 'style');
    const children = node.children ?? [];
    let inner = '';
    if (children.length > 0) {
      const start = children[0].startIndex;
      const end = children[children.length - 1].endIndex;
      if (start !== null && end !== null) inner = html.slice(start, end + 1);
    }
    out.push(`<sv-ai>${sanitizeAiContent(inner)}</sv-ai>`);
  }

  function emitGlossary(node: DomNode) {
    if (glossarySeen) { notes.extraGlossaries++; return; }
    glossarySeen = true;
    const lang = (node.attribs?.lang ?? '').trim().slice(0, 16);
    const seen = new Set<string>();
    const terms: string[] = [];
    const visit = (n: DomNode) => {
      for (const c of n.children ?? []) {
        if (!isElement(c)) continue;
        if (c.name !== 'sv-term') { visit(c); continue; }
        const key = (c.attribs?.key ?? '').trim();
        const text = textOf(c).replace(/\s+/g, ' ').trim();
        if (!key) continue;
        if (seen.has(key)) { notes.rejectedTerms.push({ key, reason: 'duplicate key — the first entry is used' }); continue; }
        if (!text) { notes.rejectedTerms.push({ key, reason: 'empty translation' }); continue; }
        if (text.length > MAX_GLOSS_CHARS) { notes.rejectedTerms.push({ key, reason: `longer than ${MAX_GLOSS_CHARS} characters` }); continue; }
        if (CHECK_MARK_RE.test(text)) { notes.rejectedTerms.push({ key, reason: 'contains a check mark' }); continue; }
        seen.add(key);
        terms.push(`<sv-term key="${escapeAttr(key)}">${escapeText(text)}</sv-term>`);
      }
    };
    visit(node);
    out.push(`<sv-glossary${lang ? ` lang="${escapeAttr(lang)}"` : ''}>${terms.join('')}</sv-glossary>`);
  }

  function emitRow(node: DomNode) {
    const items: string[] = [];
    for (const c of node.children ?? []) processAt(c, items, true);
    if (items.length > 0) out.push(`<sv-row>${items.join('')}</sv-row>`);
  }

  /** One node at top level (`inRow` false) or directly inside an sv-row. */
  function processAt(node: DomNode, sink: string[], inRow: boolean) {
    if (isIgnorable(node)) return;
    if (!isElement(node)) { notes.droppedBlocks++; return; }
    const name = node.name ?? '';
    if (!inRow) {
      if (name === 'html' || name === 'body') { for (const c of node.children ?? []) processAt(c, sink, false); return; }
      if (name === 'head') { notes.droppedStyles += countTags(node, n => n === 'style'); return; }
      if (name === 'sv-ai') { emitAi(node); return; }
      if (name === 'sv-row') { emitRow(node); return; }
      if (name === 'sv-glossary') { emitGlossary(node); return; }
    }
    if (name.startsWith('sv-') && !STRUCTURE_TAGS.has(name)) { emitVerified(node, sink, inRow); return; }
    if (name === 'style') notes.droppedStyles++;
    else notes.droppedBlocks++;
  }

  for (const c of doc.children ?? []) processAt(c, out, false);
  return { html: out.join('\n'), notes };
}

/** The normalized html only — see `sanitizeReport`. */
export function sanitizeReportHtml(html: string): string {
  return sanitizeReport(html).html;
}

export function isVerifiedKind(kind: string): boolean {
  return VERIFIED_KINDS.has(kind);
}
