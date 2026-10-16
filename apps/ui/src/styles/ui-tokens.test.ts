/**
 * UI spec guard (suveren-as/docs/ui-spec, signed off 2026-10-15; work-plan UI1).
 *
 * 1. Every `var(--name)` used in the UI is defined — in tokens.css (the spec's
 *    token set), as a custom property declared in design-system.css, or set from
 *    script (`setProperty('--name', …)`). An undefined var silently renders as
 *    nothing; that is how unstyled "hard/soft" cap notes once shipped.
 * 2. No literal colour (hex, rgb(), hsl(), or a named colour in a CSS value)
 *    outside tokens.css. Colour carries meaning in this UI (UI spec §2.1) — a
 *    literal bypasses that and breaks dark mode.
 * 3. tokens.css defines every token for light AND dark.
 *
 * The only exceptions are listed in ALLOWED below, each with its reason.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..');
const TOKENS = join(__dirname, 'tokens.css');

/** file (relative to src) → literal snippets that may appear there, and why. */
const ALLOWED: Record<string, { literal: RegExp; why: string }[]> = {
  'styles/design-system.css': [
    { literal: /#ecfdf3|#15803d|#9a9a9a/, why: 'report legend swatches picture the exported report (render-report.ts)' },
    { literal: /#ffffff/, why: 'the exported report is a light document; its iframe frame stays white' },
  ],
  'pages/ReportsPage.tsx': [
    { literal: /background:#fff/, why: 'the report iframe document is the light, self-contained report (render-report.ts)' },
  ],
  'lib/tab-badge.ts': [
    { literal: /#111111|#ffffff|#[0-9a-fA-F]{3,8}/, why: 'favicon SVG — a standalone image, not page CSS; follows the OS theme itself' },
  ],
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** Drop comments so prose like "PR #120" or "#fff bug" can't trip the checks. */
function stripComments(text: string, isCss: boolean): string {
  // Keep the newlines so reported line numbers match the file.
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''));
  if (!isCss) out = out.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  return out;
}

function definedNames(): Set<string> {
  const names = new Set<string>();
  const collect = (text: string) => {
    for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(m[1]);
  };
  collect(readFileSync(TOKENS, 'utf8'));
  for (const f of walk(SRC)) {
    const text = readFileSync(f, 'utf8');
    if (f.endsWith('.css')) collect(stripComments(text, true));
    for (const m of text.matchAll(/setProperty\(\s*['"`](--[a-z0-9-]+)/g)) names.add(m[1]);
    // Inline style objects that declare a custom property: { '--x': … }
    for (const m of text.matchAll(/['"](--[a-z0-9-]+)['"]\s*:/g)) names.add(m[1]);
  }
  return names;
}

// (?<!&) skips HTML character references such as &#8599;
const LITERAL = /(?<!&)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\(/g;
const NAMED_IN_CSS = /(?:color|background|border(?:-[a-z]+)?|fill|stroke|outline)\s*:\s*[^;'"]*?\b(white|black|red|green|blue|orange|yellow|gray|grey)\b/gi;

describe('UI spec tokens (UI1)', () => {
  it('every var(--…) used is defined', () => {
    const defined = definedNames();
    const missing: string[] = [];
    for (const f of [...walk(SRC), TOKENS]) {
      const text = stripComments(readFileSync(f, 'utf8'), f.endsWith('.css'));
      for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        if (!defined.has(m[1])) missing.push(`${relative(SRC, f)}: ${m[1]}`);
      }
    }
    const unique = [...new Set(missing)];
    expect(unique, `undefined tokens:\n${unique.join('\n')}`).toEqual([]);
  });

  it('no literal colour outside tokens.css', () => {
    const found: string[] = [];
    for (const f of walk(SRC)) {
      if (f === TOKENS) continue;
      // Always '/' — the allow-list is written that way (Windows uses '\\').
      const rel = relative(SRC, f).split(sep).join('/');
      const allowed = ALLOWED[rel] ?? [];
      const lines = stripComments(readFileSync(f, 'utf8'), f.endsWith('.css')).split('\n');
      lines.forEach((line, i) => {
        const hits = [...line.matchAll(LITERAL)].map((m) => m[0]);
        if (f.endsWith('.css') || /style|color|background|border/i.test(line)) {
          hits.push(...[...line.matchAll(NAMED_IN_CSS)].map((m) => m[1]));
        }
        for (const hit of hits) {
          if (allowed.some((a) => a.literal.test(line))) continue;
          found.push(`${rel}:${i + 1}: ${hit} — ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(found, `literal colours:\n${found.join('\n')}`).toEqual([]);
  });

  it('tokens.css defines every colour token for light and dark', () => {
    const text = readFileSync(TOKENS, 'utf8');
    const blockOf = (selector: string) => {
      const start = text.indexOf(selector);
      expect(start, `${selector} block`).toBeGreaterThan(-1);
      return text.slice(start, text.indexOf('}', text.indexOf('{', start)));
    };
    const names = (block: string) => new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const light = names(blockOf(':root {'));
    const dark = names(blockOf('[data-theme="dark"] {'));
    const lightOverride = names(blockOf('[data-theme="light"] {'));
    // Every light token whose value is a colour must have a dark value too.
    const rootBlock = blockOf(':root {');
    const colourTokens = [...light].filter((n) =>
      new RegExp(`${n}\\s*:\\s*(#|rgba?\\()`).test(rootBlock),
    );
    expect(colourTokens.filter((n) => !dark.has(n))).toEqual([]);
    expect(colourTokens.filter((n) => !lightOverride.has(n))).toEqual([]);
  });
});
