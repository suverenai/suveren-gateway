/**
 * A connector does not inherit the gateway's secrets.
 *
 * Connectors used to start with `...process.env`, so every connector received
 * SUVEREN_INTERNAL_SECRET (which opens /internal/*), SUVEREN_AS_API_KEY, and
 * whatever the user's shell exported. Runs the real server and a real child
 * process: the fixture connector writes the environment it actually got.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inheritedConnectorEnv } from '../src/lib/connector-env';

const MCP_PORT = 13041;
const BASE_URL = `http://127.0.0.1:${MCP_PORT}`;
const FIXTURE = resolve(__dirname, 'fixtures/env-dump-mcp-server.ts');
const INTERNAL_SECRET = 'connector-env-test-internal-secret';

let serverProcess: ChildProcess;
let workDir: string;

async function waitForServer(timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${BASE_URL}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

describe('connector environment', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'suveren-connector-env-'));
    serverProcess = spawn('npx', ['tsx', 'bin/http.ts'], {
      cwd: resolve(__dirname, '..'),
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        SUVEREN_MCP_PORT: String(MCP_PORT),
        SUVEREN_AS_URL: 'https://www.suveren.ai',
        SUVEREN_DATA_DIR: join(workDir, 'data'),
        SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1',
        SUVEREN_INTERNAL_SECRET: INTERNAL_SECRET,
        SUVEREN_AS_API_KEY: 'connector-env-test-as-key',
        SOME_SHELL_SECRET: 'from-the-users-shell',
        HTTPS_PROXY: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    serverProcess.stderr?.on('data', (d: Buffer) => process.stderr.write(`  [server] ${d}`));
    await waitForServer(50000);
  }, 60000);

  afterAll(async () => {
    serverProcess?.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1000));
    if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGKILL');
    rmSync(workDir, { recursive: true, force: true });
  });

  it('a spawned connector gets runtime vars but none of the gateway secrets', async () => {
    const dump = join(workDir, 'env.json');
    const res = await fetch(`${BASE_URL}/internal/add-integration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
      body: JSON.stringify({
        id: 'env-dump',
        name: 'Env dump',
        command: 'npx',
        args: ['tsx', FIXTURE, dump],
        envKeys: {},
        profile: null,
        enabled: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(dump)).toBe(true);

    const env = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
    const values = Object.values(env);
    expect(values).not.toContain(INTERNAL_SECRET);
    expect(values).not.toContain('connector-env-test-as-key');
    expect(values).not.toContain('from-the-users-shell');
    expect(Object.keys(env).filter(k => k.startsWith('SUVEREN_'))).toEqual([]);
    // What a connector does need still arrives.
    expect(env.HAP_DATA_DIR).toBe(join(workDir, 'data'));
    expect(Object.keys(env).some(k => k.toUpperCase() === 'PATH')).toBe(true);
  }, 30000);
});

describe('inheritedConnectorEnv', () => {
  it('keeps proxy/CA settings and manifest-named vars, in their original spelling', () => {
    const out = inheritedConnectorEnv(
      {
        https_proxy: 'http://proxy:8080',
        NODE_EXTRA_CA_CERTS: '/ca.pem',
        Path: 'C:\\Windows',
        SystemRoot: 'C:\\Windows',
        ERP_COMPANY_FILE: '/seed.json',
        SUVEREN_INTERNAL_SECRET: 's',
        AWS_SECRET_ACCESS_KEY: 'k',
      },
      ['ERP_COMPANY_FILE'],
    );
    expect(out).toEqual({
      https_proxy: 'http://proxy:8080',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      SystemRoot: 'C:\\Windows',
      ERP_COMPANY_FILE: '/seed.json',
    });
  });
});
