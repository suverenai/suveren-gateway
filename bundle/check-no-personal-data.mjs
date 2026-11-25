#!/usr/bin/env node
/**
 * Fails when the published npm package carries personal data: the maintainer's name or
 * mail domain, or a developer machine's home path. Run on the UNPACKED tarball (what a
 * user installs), before `npm install` adds dependencies:
 *
 *   node bundle/check-no-personal-data.mjs <dir>
 *
 * The licence files name the copyright holder on purpose and are not checked.
 * 0.46.0 shipped two design mockups with personal addresses; this keeps it from recurring.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Each rule: a pattern and why it must not ship. */
export const RULES = [
  { re: /andreas/i, why: 'a personal name' },
  { re: /sublin\.app/i, why: 'a personal mail domain' },
  // A home path of a real machine. Example names shown to people ("/Users/anna/suveren-files") are allowed.
  { re: /\/Users\/(?!(?:anna|you|name|example|owner|me|shared|Shared)\b)[A-Za-z]/, why: 'a macOS home path' },
  { re: /[A-Z]:\\Users\\(?!(?:anna|you|name|example|owner|me|Public)\b)[A-Za-z]/, why: 'a Windows home path' },
];

const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_FILES = /^(LICENSE|LICENCE)(\..*)?$|^License\.rtf$/i;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) yield* files(p); }
    else if (st.isFile() && !SKIP_FILES.test(basename(p))) yield p;
  }
}

/** Every hit as { file, line, why, text } — empty when the tree is clean. */
export function findPersonalData(root) {
  const hits = [];
  for (const file of files(root)) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue; // binary
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.re.test(line)) hits.push({ file: relative(root, file), line: i + 1, why: rule.why, text: line.trim().slice(0, 160) });
      }
    });
  }
  return hits;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2];
  if (!root) { console.error('usage: check-no-personal-data.mjs <unpacked package dir>'); process.exit(2); }
  const hits = findPersonalData(root);
  for (const h of hits) console.error(`${h.file}:${h.line}: ${h.why}: ${h.text}`);
  if (hits.length) { console.error(`\n${hits.length} line(s) with personal data in the package.`); process.exit(1); }
  console.log('No personal data in the package.');
}
