#!/usr/bin/env node
/**
 * Dependency audit gate — fails on any high or critical advisory in the
 * production dependencies that is not on the written exception list.
 *
 * Until 0.19.x nothing ran an audit (installs even passed --no-audit), and
 * 1 critical + 23 high findings built up unnoticed. This runs on every push,
 * every pull request, and weekly (new advisories appear without code changes).
 *
 * Exceptions live in .github/audit-allowlist.json, one entry per advisory:
 *   { "ghsa": "GHSA-…", "package": "…", "reason": "why it is not reachable",
 *     "reviewBy": "YYYY-MM-DD" }
 * An entry past its reviewBy date fails the check — exceptions are re-looked
 * at, not forgotten. An entry that no longer matches anything is reported so
 * it can be removed.
 *
 * Fails closed: if the audit itself cannot run (registry down, bad output),
 * the check fails rather than passing silently.
 *
 * Run: node scripts/audit-check.mjs   (from the repo root)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKING = new Set(['high', 'critical']);

const allowlist = JSON.parse(readFileSync(join(root, '.github', 'audit-allowlist.json'), 'utf8'));
const today = new Date().toISOString().slice(0, 10);

let raw;
try {
  raw = execFileSync('pnpm', ['audit', '--prod', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
} catch (err) {
  // pnpm audit exits non-zero whenever it finds anything — the JSON is still on stdout.
  raw = err.stdout;
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error('audit-check: pnpm audit did not return JSON — failing closed.\n' + String(raw).slice(0, 2000));
  process.exit(1);
}
if (!report.advisories) {
  console.error('audit-check: no advisories field in pnpm audit output — failing closed.\n' + String(raw).slice(0, 2000));
  process.exit(1);
}

const advisories = Object.values(report.advisories);
const allowed = new Map(allowlist.map((e) => [e.ghsa, e]));
const problems = [];

for (const a of advisories) {
  if (!BLOCKING.has(a.severity)) continue;
  const entry = allowed.get(a.github_advisory_id);
  const label = `${a.severity} ${a.module_name} ${a.github_advisory_id} — ${a.title}\n    ${a.url}`;
  if (!entry) {
    problems.push(`not on the exception list: ${label}`);
  } else if (entry.reviewBy < today) {
    problems.push(`exception expired on ${entry.reviewBy} (review it): ${label}`);
  } else {
    console.log(`allowed until ${entry.reviewBy}: ${a.severity} ${a.module_name} ${a.github_advisory_id} — ${entry.reason}`);
  }
}

const seen = new Set(advisories.map((a) => a.github_advisory_id));
for (const e of allowlist) {
  if (!seen.has(e.ghsa)) console.log(`no longer needed — remove from the exception list: ${e.ghsa} (${e.package})`);
}

const counts = advisories.reduce((m, a) => ((m[a.severity] = (m[a.severity] ?? 0) + 1), m), {});
console.log(`advisories in production dependencies: ${JSON.stringify(counts)}`);

if (problems.length) {
  console.error(`\naudit-check FAILED — ${problems.length} high/critical finding(s):\n- ${problems.join('\n- ')}`);
  console.error('\nFix by updating the dependency. Only if it cannot be fixed and is shown not reachable, add it to .github/audit-allowlist.json with a reason and a reviewBy date.');
  process.exit(1);
}
console.log('audit-check passed.');
