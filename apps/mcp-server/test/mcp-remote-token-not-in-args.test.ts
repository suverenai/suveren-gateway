/**
 * End to end: the REAL pinned mcp-remote (the version mollie.json pins,
 * installed by the gateway's own `ensureInstalled` from npm into a temp
 * integrations folder), started through the REAL spawn path
 * (`IntegrationManager.startIntegration` with the REAL mollie.json manifest),
 * against a local stand-in for the remote MCP server. Only the remote URL is
 * pointed at localhost; everything else is Mollie's shipped configuration.
 *
 * Proves, on whatever OS runs it (CI: macOS, Linux, Windows):
 *   (a) the remote receives `Authorization: Bearer <token>` — from mcp-remote
 *       AND from the gateway's preflight, which still sends the real header;
 *   (b) while the connector runs, no process in the tree this test started
 *       shows the token in its command line as the OS reports it
 *       (`ps -ww -o args=` / Win32_Process.CommandLine) — mcp-remote may be
 *       started through a shim (cmd.exe on Windows), so the whole tree is
 *       checked, and a control proves the check sees arguments at all;
 *   (c) a missing token is refused before anything is spawned, as before;
 *   plus: mcp-remote's own stdout/stderr never carry the token (success and
 *   unreachable-remote paths), and the gateway's start error never does.
 *
 * Needs the npm registry once per run (the pinned install). The process-list
 * check reads only the processes this test started, by pid.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');
const MOLLIE = JSON.parse(readFileSync(join(MANIFESTS_DIR, 'mollie.json'), 'utf8')) as {
  npmPackage: string;
  npmVersion: string;
  mcp: { command: string; args: string[] };
  credentials: { envMapping: Record<string, string> };
};
const FAKE_TOKEN = 'access_org_E2E_fake_token_5b81d0c4';
const isWin = process.platform === 'win32';

// ─── Local stand-in for the remote MCP server ───────────────────────────────

interface Seen { authorization: string | undefined; clientName: string | undefined; method: string | undefined }

let remote: Server;
let remoteUrl: string;
const seen: Seen[] = [];

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : undefined); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const body = await readBody(req);
  const first = (Array.isArray(body) ? body[0] : body) as { method?: string; params?: { clientInfo?: { name?: string } } } | undefined;
  seen.push({
    authorization: req.headers.authorization,
    clientName: first?.params?.clientInfo?.name,
    method: first?.method,
  });
  if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
    // Never reached in these tests (a 401 would make mcp-remote open a
    // browser); kept so a wrong header is a loud failure, not a pass.
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('wrong authorization header');
    return;
  }
  // Stateless: one server + transport per request.
  const server = new McpServer({ name: 'fake-remote', version: '0.0.1' }, {});
  server.registerTool('ping', { description: 'Answers pong' }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ─── The process tree this test started ─────────────────────────────────────

function childPidsOf(pid: number, table: Array<[number, number]>): number[] {
  const out: number[] = [];
  const queue = [pid];
  while (queue.length) {
    const p = queue.shift()!;
    for (const [child, parent] of table) {
      if (parent === p && !out.includes(child)) { out.push(child); queue.push(child); }
    }
  }
  return out;
}

/** pid/parent pairs of every process — numbers only, no command lines. */
function processTable(): Array<[number, number]> {
  const raw = isWin
    ? execFileSync('powershell.exe', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8' })
    : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  return raw.split(/\r?\n/).map(l => l.trim().split(/\s+/).map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite)) as Array<[number, number]>;
}

/** Command line of ONE process, as the OS reports it to other programs. */
function commandLineOf(pid: number): string {
  try {
    return isWin
      ? execFileSync('powershell.exe', ['-NoProfile', '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' }).trim()
      : execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return ''; // exited in between
  }
}

/** Command lines of every descendant of THIS test process (never anyone else's). */
function descendantCommandLines(): string[] {
  const own = childPidsOf(process.pid, processTable());
  return own.map(commandLineOf).filter(Boolean);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let workDir: string;
const savedEnv: Record<string, string | undefined> = {};
let IntegrationManager: typeof import('../src/lib/integration-manager').IntegrationManager;
let getIntegrationsBinDir: typeof import('../src/lib/integration-manager').getIntegrationsBinDir;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'hap-mcp-remote-e2e-'));
  // A private home: mcp-remote keeps state in ~/.mcp-auth, npm in ~/.npm.
  for (const k of ['SUVEREN_DATA_DIR', 'SUVEREN_INTEGRATIONS_DIR', 'HOME', 'USERPROFILE']) savedEnv[k] = process.env[k];
  process.env.SUVEREN_DATA_DIR = join(workDir, 'data');
  process.env.SUVEREN_INTEGRATIONS_DIR = join(workDir, 'integrations');
  process.env.HOME = join(workDir, 'home');
  if (isWin) process.env.USERPROFILE = join(workDir, 'home');

  remote = createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
  });
  await new Promise<void>(r => remote.listen(0, '127.0.0.1', () => r()));
  remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`;

  ({ IntegrationManager, getIntegrationsBinDir } = await import('../src/lib/integration-manager'));
  const { loadManifests } = await import('../src/lib/manifest-loader');
  loadManifests(MANIFESTS_DIR);
}, 60_000);

afterAll(async () => {
  await new Promise<void>(r => remote.close(() => r()));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(workDir, { recursive: true, force: true });
});

/** Mollie's shipped config, exactly as activation builds it — only the remote URL is local. */
function mollieConfig() {
  const envKeys: Record<string, string> = {};
  for (const [envVar, credKey] of Object.entries(MOLLIE.credentials.envMapping)) envKeys[envVar] = `mollie.${credKey}`;
  const args = MOLLIE.mcp.args.map(a => (/^https?:\/\//.test(a) ? remoteUrl : a));
  return {
    id: 'mollie',
    name: 'Mollie',
    command: MOLLIE.mcp.command,
    args,
    envKeys,
    profile: null,
    npmPackage: MOLLIE.npmPackage,
    enabled: true,
  };
}

describe(`real mcp-remote ${MOLLIE.npmVersion} through the gateway's spawn path`, () => {
  let im: InstanceType<typeof IntegrationManager> | undefined;
  afterEach(async () => { await im?.shutdown(); im = undefined; seen.length = 0; });

  it('control: the process-list check sees a child\'s arguments', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'visible-marker-3e1f'], { stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 300));
      expect(descendantCommandLines().some(l => l.includes('visible-marker-3e1f'))).toBe(true);
    } finally {
      child.kill();
    }
  }, 30_000);

  it('(a)+(b): the remote gets the token in the header; no process in the tree shows it in its command line', async () => {
    im = new IntegrationManager(new Map([['mollie', { accessToken: FAKE_TOKEN }]]));
    const tools = await im.startIntegration(mollieConfig());
    expect(tools.map(t => t.originalName)).toContain('ping');

    // A real call bridged through mcp-remote to the remote.
    const res = await im.callTool('mollie', 'ping', {});
    expect(res.content[0].text).toBe('pong');

    // (a) The preflight sent the real header, and so did mcp-remote.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every(s => s.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    expect(seen.some(s => s.clientName === 'suveren-gateway-preflight')).toBe(true);
    expect(seen.some(s => s.method === 'tools/call')).toBe(true);

    // (b) While it runs: the whole tree this test started.
    const lines = descendantCommandLines();
    // Not vacuous: the connector's command line is visible, with the placeholder in it.
    expect(lines.some(l => l.includes(remoteUrl) && l.includes('${MOLLIE_ACCESS_TOKEN}'))).toBe(true);
    for (const l of lines) expect(l).not.toContain(FAKE_TOKEN);
  }, 300_000);

  it('(c) a missing token: refused before spawning, named, as before — no request, no process', async () => {
    im = new IntegrationManager(new Map());
    const before = descendantCommandLines().filter(l => l.includes(remoteUrl)).length;
    const err = await im.startIntegration(mollieConfig()).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/^mollie: no credential configured for 127\.0\.0\.1:\d+/);
    expect(seen).toEqual([]);
    expect(im.isRunning('mollie')).toBe(false);
    expect(descendantCommandLines().filter(l => l.includes(remoteUrl)).length).toBe(before);
  }, 120_000);

  it('mcp-remote\'s own stdout and stderr never carry the token (working remote, unreachable remote)', async () => {
    // Uses the package the test above installed. Spawned directly only to
    // capture its output (the gateway inherits connector stderr on this base).
    const proxy = join(getIntegrationsBinDir(), '..', 'mcp-remote', 'dist', 'proxy.js');
    const run = (url: string) => new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [proxy, url, '--header', 'Authorization: Bearer ${MOLLIE_ACCESS_TOKEN}'], {
        env: { ...process.env, MOLLIE_ACCESS_TOKEN: FAKE_TOKEN },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', d => { out += String(d); });
      child.stderr.on('data', d => { out += String(d); });
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
      }) + '\n');
      setTimeout(() => { child.kill(); }, 6000);
      child.on('exit', () => resolve(out));
    });

    const ok = await run(remoteUrl);
    expect(ok).toContain('Using custom headers: Authorization'); // it ran and logged
    expect(ok).not.toContain(FAKE_TOKEN);

    // A port nothing listens on: the connection-error path.
    const dead = createServer();
    await new Promise<void>(r => dead.listen(0, '127.0.0.1', () => r()));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>(r => dead.close(() => r()));
    const unreachable = await run(`http://127.0.0.1:${deadPort}/mcp`);
    expect(unreachable.length).toBeGreaterThan(0);
    expect(unreachable).not.toContain(FAKE_TOKEN);
  }, 60_000);
});
