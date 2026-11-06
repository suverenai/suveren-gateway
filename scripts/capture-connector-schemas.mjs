#!/usr/bin/env node
/**
 * Captures the tool input schemas of the pinned connectors into
 * apps/mcp-server/test/fixtures/connector-schemas/<id>.json, for the
 * sealed-args audit test (apps/mcp-server/test/sealed-args-audit.test.ts).
 *
 * The audit has to know which arguments a connector's tools accept, and that
 * list lives in the connector, not in the manifest. Re-run this when a manifest
 * pin changes:
 *
 *   mkdir /tmp/cap && cd /tmp/cap && npm init -y && npm i <pkg>@<pinned> ...
 *   node scripts/capture-connector-schemas.mjs /tmp/cap
 *
 * Reads npmPackage/npmVersion + mcp.command from content/integrations/*.json,
 * spawns <installDir>/node_modules/.bin/<command> over stdio and records
 * tools/list. Manifests whose connector cannot start offline (remote proxy)
 * are skipped and named.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '../apps/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../apps/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const installDir = resolve(process.argv[2] ?? '');
if (!process.argv[2]) { console.error('usage: capture-connector-schemas.mjs <installDir>'); process.exit(1); }
const manifestsDir = join(here, '..', 'content', 'integrations');
const outDir = join(here, '..', 'apps', 'mcp-server', 'test', 'fixtures', 'connector-schemas');
mkdirSync(outDir, { recursive: true });

for (const file of readdirSync(manifestsDir).filter(f => f.endsWith('.json') && f !== 'index.json')) {
  const m = JSON.parse(readFileSync(join(manifestsDir, file), 'utf-8'));
  const bin = join(installDir, 'node_modules', '.bin', m.mcp?.command ?? '');
  if (!existsSync(bin)) { console.error(`skip ${m.id}: no ${bin}`); continue; }
  const home = mkdtempSync(join(tmpdir(), 'cap-home-'));
  const env = { ...process.env, HOME: home, ...(m.mcp.env ?? {}) };
  for (const f of m.credentials?.fields ?? []) if (f.env) env[f.env] = 'x';
  const client = new Client({ name: 'capture', version: '0' });
  try {
    await client.connect(new StdioClientTransport({ command: bin, args: m.mcp.args ?? [], env }));
    const { tools } = await client.listTools();
    const out = {
      integration: m.id, npmPackage: m.npmPackage, npmVersion: m.npmVersion,
      tools: Object.fromEntries(tools.map(t => [t.name, t.inputSchema ?? {}]).sort(([a], [b]) => a.localeCompare(b))),
    };
    writeFileSync(join(outDir, `${m.id}.json`), JSON.stringify(out, null, 2) + '\n');
    console.error(`ok ${m.id}: ${tools.length} tools`);
  } catch (e) {
    console.error(`FAILED ${m.id}: ${e.message}`);
  } finally {
    await client.close().catch(() => {});
  }
}
process.exit(0);
