#!/usr/bin/env node
/**
 * Dev convenience: POST test/fixtures/sample-report.html to a running
 * gateway's `/internal/report`, so you can open the Reports page in the UI
 * (apps/ui — `/reports`) and see all six sv-* elements rendered without
 * writing a tool/AI integration first.
 *
 * On a fresh gateway (no matching receipt archive) every element correctly
 * renders "not verifiable" — that is the fail-closed behaviour working, not
 * a bug. `test/report/sample-report.test.ts` is where this fixture is
 * exercised against a matching archive/export, proving what it SHOULD
 * resolve to when the evidence exists.
 *
 * Usage (from apps/mcp-server, against the dev MCP server on :3431):
 *   pnpm report:post-sample
 *
 * Env overrides:
 *   SUVEREN_MCP_INTERNAL_URL  default http://127.0.0.1:3431
 *   SUVEREN_INTERNAL_SECRET   default dev-shared-internal-secret (matches `pnpm dev:mcp`)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '../test/fixtures/sample-report.html');

const base = process.env.SUVEREN_MCP_INTERNAL_URL ?? 'http://127.0.0.1:3431';
const secret = process.env.SUVEREN_INTERNAL_SECRET ?? 'dev-shared-internal-secret';

const html = readFileSync(FIXTURE_PATH, 'utf-8');

const res = await fetch(`${base}/internal/report`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
  body: JSON.stringify({ html }),
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`[post-sample-report] ${res.status}`, body);
  process.exit(1);
}
console.log(`[post-sample-report] saved — ${body.report?.elements?.length ?? 0} element(s), ${body.report?.proof?.unverifiableCount ?? '?'} not verifiable. Open the Reports page in the UI to view it.`);
