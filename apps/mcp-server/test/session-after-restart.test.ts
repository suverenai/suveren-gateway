/**
 * After a gateway restart, an assistant's old MCP session must be answered
 * with 404 — not 400.
 *
 * The MCP Streamable HTTP spec (Session Management): a server that receives a
 * session id it does not recognize MUST answer 404, and a client that gets 404
 * MUST start a new session. The gateway answered 400 ("missing or invalid
 * session"), so after every update ChatGPT Desktop and Claude stopped working
 * until the person restarted them. Runs the real server and restarts it.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 13061;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'suveren-session-restart-'));
let server: ChildProcess | undefined;

function start(): ChildProcess {
  const child = spawn('npx', ['tsx', 'bin/http.ts'], {
    cwd: resolve(__dirname, '..'),
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      SUVEREN_MCP_PORT: String(PORT),
      SUVEREN_AS_URL: 'https://www.suveren.ai',
      SUVEREN_DATA_DIR: dataDir,
      SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1',
      SUVEREN_INTERNAL_SECRET: '',
      SUVEREN_BIND_HOST: '',
      SUVEREN_MCP_TOKEN: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group, so stop() can kill npx AND the server it started —
    // on Linux killing only npx left the server running (seen in CI).
    detached: process.platform !== 'win32',
  });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`  [server] ${d}`));
  return child;
}

async function waitUp(): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < 50000) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    return;
  }
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
}

/** Stop the server AND prove it is gone — a "restart" that leaves the old
 *  process answering would make this test pass or fail for the wrong reason. */
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child) return;
  killTree(child, 'SIGTERM');
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) }); }
    catch { return; } // port no longer answers — the server is gone
    if (Date.now() - t0 > 5000) killTree(child, 'SIGKILL');
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('the old gateway process is still answering — restart did not happen');
}

afterAll(async () => {
  await stop(server);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('MCP session after a gateway restart', () => {
  it('answers 404 Session not found to the old session, and a new session works', async () => {
    server = start();
    await waitUp();

    const before = new Client({ name: 'restart-test', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
    await before.connect(transport);
    const oldSession = transport.sessionId;
    expect(oldSession).toBeTruthy();
    await before.listTools();

    // The update: the gateway restarts and forgets every session.
    await stop(server);
    server = start();
    await waitUp();

    // Raw request with the old session id — what an assistant sends next.
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': oldSession!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });

    // The official SDK client surfaces exactly that status to its host app.
    await expect(before.listTools()).rejects.toMatchObject({ code: 404 });

    // What a spec-following client then does: open a new session — it works.
    const after = new Client({ name: 'restart-test', version: '0' });
    await after.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
    const { tools } = await after.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await after.close();
  }, 120000);

  it('answers 404 to a message for an unknown SSE session', async () => {
    if (!server || server.exitCode !== null) { server = start(); await waitUp(); }
    const res = await fetch(`${BASE}/messages?sessionId=does-not-exist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  }, 60000);

  it('still answers 400 to a request with no session that is not an initialize', async () => {
    if (!server || server.exitCode !== null) { server = start(); await waitUp(); }
    const res = await fetch(`${BASE}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(400);
  }, 60000);
});
