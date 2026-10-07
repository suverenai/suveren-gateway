/**
 * Who can connect to the agent port.
 *
 * Until 0.19.x the MCP server listened on 0.0.0.0 and `/sse`, `/messages`,
 * `/mcp` had no check: any machine on the network could open a session and
 * call tools under the signed-in person's mandates. Runs the real server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const workDir = mkdtempSync(join(tmpdir(), 'suveren-agent-port-'));

function startServer(port: number, extraEnv: Record<string, string>): ChildProcess {
  const child = spawn('npx', ['tsx', 'bin/http.ts'], {
    cwd: resolve(__dirname, '..'),
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      SUVEREN_MCP_PORT: String(port),
      SUVEREN_AS_URL: 'https://www.suveren.ai',
      SUVEREN_DATA_DIR: join(workDir, `data-${port}`),
      SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1',
      SUVEREN_INTERNAL_SECRET: '',
      SUVEREN_BIND_HOST: '',
      SUVEREN_MCP_TOKEN: '',
      SUVEREN_CONTAINER: '',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`  [server:${port}] ${d}`));
  return child;
}

async function waitForServer(port: number, timeoutMs = 50000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`server on ${port} did not start`);
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 1000));
  if (!child.killed) child.kill('SIGKILL');
}

/** Status of GET /sse — read only the head, then drop the stream. Uses
 *  node:http because fetch() refuses to send a custom Host header. */
function sseStatus(port: number, opts: { host?: string; headers?: Record<string, string>; query?: string } = {}): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: `/sse${opts.query ?? ''}`,
        headers: { ...(opts.host ? { Host: opts.host } : {}), ...opts.headers },
      },
      (res) => {
        resolveStatus(res.statusCode ?? 0);
        res.destroy();
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A non-loopback IPv4 address of this machine, if it has one. */
function lanAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return undefined;
}

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('default: this machine only, no token', () => {
  const PORT = 13051;
  let server: ChildProcess;
  beforeAll(async () => {
    server = startServer(PORT, {});
    await waitForServer(PORT);
  }, 60000);
  afterAll(() => stop(server));

  it('is not reachable on the machine\'s network address', async () => {
    const lan = lanAddress();
    if (!lan) return; // no network interface on this runner — nothing to prove
    await expect(fetch(`http://${lan}:${PORT}/health`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  });

  it('opens a session for a local Host', async () => {
    expect(await sseStatus(PORT, { host: `localhost:${PORT}` })).toBe(200);
    expect(await sseStatus(PORT, { host: `127.0.0.1:${PORT}` })).toBe(200);
  });

  it('refuses a foreign Host (DNS rebinding)', async () => {
    expect(await sseStatus(PORT, { host: `evil.example:${PORT}` })).toBe(403);
  });

  it('offers the agent no ungated debug tool', async () => {
    const client = new Client({ name: 'agent-port-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).not.toContain('debug_test_tool');
    await client.close();
  }, 20000);

  it('sends no CORS header', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('with SUVEREN_MCP_TOKEN', () => {
  const PORT = 13052;
  const TOKEN = 'agent-port-test-token-0123456789';
  let server: ChildProcess;
  beforeAll(async () => {
    server = startServer(PORT, { SUVEREN_MCP_TOKEN: TOKEN });
    await waitForServer(PORT);
  }, 60000);
  afterAll(() => stop(server));

  it('refuses to open a session without the token', async () => {
    expect(await sseStatus(PORT)).toBe(401);
    expect(await sseStatus(PORT, { headers: { Authorization: 'Bearer wrong' } })).toBe(401);
  });

  it('opens a session with the token as header or query', async () => {
    expect(await sseStatus(PORT, { headers: { Authorization: `Bearer ${TOKEN}` } })).toBe(200);
    expect(await sseStatus(PORT, { query: `?token=${TOKEN}` })).toBe(200);
  });
});

describe('network exposure without a token', () => {
  it('refuses to start', async () => {
    const child = startServer(13053, { SUVEREN_BIND_HOST: '0.0.0.0' });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const code = await new Promise<number | null>(r => child.on('exit', r));
    expect(code).toBe(1);
    expect(stderr).toContain('SUVEREN_MCP_TOKEN is not set');
  }, 60000);
});
