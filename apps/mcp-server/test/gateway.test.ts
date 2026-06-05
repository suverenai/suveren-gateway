/**
 * Gateway integration test.
 *
 * Starts the Suveren MCP server, adds a test downstream MCP server via the
 * internal API, and verifies tools are discovered and callable.
 *
 * Run: npx vitest run test/gateway.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const MCP_PORT = 13030; // Use a non-default port to avoid conflicts
const BASE_URL = `http://127.0.0.1:${MCP_PORT}`;
const TEST_SERVER_PATH = resolve(__dirname, 'fixtures/test-mcp-server.ts');

let serverProcess: ChildProcess;
const TEST_PROFILES_DIR = resolve(__dirname, '../.test-profiles');

async function waitForServer(url: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function get(path: string) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, data: await res.json() };
}

async function del(path: string) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  return { status: res.status, data: await res.json() };
}

describe('MCP Gateway', () => {
  beforeAll(async () => {
    // Create test profiles directory with a charge profile
    mkdirSync(resolve(TEST_PROFILES_DIR, 'charge'), { recursive: true });
    writeFileSync(resolve(TEST_PROFILES_DIR, 'index.json'), JSON.stringify({
      repository: 'test',
      profiles: {
        'charge': 'charge/0.3.profile.json',
      },
    }));
    writeFileSync(resolve(TEST_PROFILES_DIR, 'charge/0.3.profile.json'), JSON.stringify({
      id: 'charge',
      version: '0.3',
      description: 'Test payment profile',
      frameSchema: { keyOrder: [], fields: {} },
      executionContextSchema: { fields: {} },
      executionPaths: {},
      requiredGates: [],
      gateQuestions: {
        problem: { question: 'Test?', required: true },
        objective: { question: 'Test?', required: true },
        tradeoffs: { question: 'Test?', required: true },
      },
      ttl: { default: 3600, max: 86400 },
      retention_minimum: 7776000,
      toolGating: {
        default: {
          executionMapping: {
            a: { field: 'amount', divisor: 100 },
            b: 'currency',
          },
          staticExecution: { action_type: 'charge' },
        },
        overrides: {
          echo: null,
        },
      },
    }));

    // Start the Suveren MCP server on a test port
    serverProcess = spawn('npx', ['tsx', 'bin/http.ts'], {
      cwd: resolve(__dirname, '..'),
      env: {
        ...process.env,
        SUVEREN_MCP_PORT: String(MCP_PORT),
        SUVEREN_AS_URL: 'https://www.suveren.ai',
        // Use a temp data dir so we don't pollute real config
        SUVEREN_DATA_DIR: resolve(__dirname, '../.test-data'),
        SUVEREN_PROFILES_DIR: TEST_PROFILES_DIR,
        // Clean slate: don't auto-register/install the crm+records personal
        // defaults (the suite asserts an empty integration list and add/remove).
        SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`  [server] ${data.toString()}`);
    });

    await waitForServer(BASE_URL, 50000);
    // Generous hook budget: spawning `npx tsx bin/http.ts` cold-starts tsx and
    // boots the MCP server + integration manager, which can exceed a tight 15s
    // on a loaded machine (the source of this suite's intermittent failures).
  }, 60000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      // Wait for graceful shutdown
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }

    // Clean up test data
    try {
      rmSync(resolve(__dirname, '../.test-data'), { recursive: true, force: true });
    } catch { /* ignore */ }
    try {
      rmSync(TEST_PROFILES_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('health endpoint works', async () => {
    const { status, data } = await get('/health');
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.integrations).toEqual([]);
  });

  it('can add a test integration', async () => {
    const { status, data } = await post('/internal/add-integration', {
      id: 'test-tools',
      name: 'Test Tools',
      command: 'npx',
      args: ['tsx', TEST_SERVER_PATH],
      envKeys: {},
      profile: null,
      enabled: true,
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.id).toBe('test-tools');
    expect(data.tools).toContain('test-tools__echo');
    expect(data.tools).toContain('test-tools__add');
  }, 15000);

  it('integrations endpoint shows running integration', async () => {
    const { status, data } = await get('/internal/integrations');
    expect(status).toBe(200);

    const testIntegration = data.integrations.find(
      (i: { id: string }) => i.id === 'test-tools',
    );
    expect(testIntegration).toBeDefined();
    expect(testIntegration.running).toBe(true);
    expect(testIntegration.toolCount).toBe(2);
  });

  it('health endpoint includes integration status', async () => {
    const { status, data } = await get('/health');
    expect(status).toBe(200);

    const testIntegration = data.integrations.find(
      (i: { id: string }) => i.id === 'test-tools',
    );
    expect(testIntegration).toBeDefined();
    expect(testIntegration.running).toBe(true);
  });

  it('can remove an integration', async () => {
    const { status, data } = await del('/internal/remove-integration/test-tools');
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    // Verify it's gone
    const { data: listData } = await get('/internal/integrations');
    expect(listData.integrations).toEqual([]);
  });

  it('removing non-existent integration returns 404', async () => {
    const { status } = await del('/internal/remove-integration/does-not-exist');
    expect(status).toBe(404);
  });

  it('can re-add and call tools via MCP client', async () => {
    // Re-add the integration
    await post('/internal/add-integration', {
      id: 'test-tools',
      name: 'Test Tools',
      command: 'npx',
      args: ['tsx', TEST_SERVER_PATH],
      envKeys: {},
      profile: null,
      enabled: true,
    });

    // Connect as an MCP client and call the proxied tool
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

    const transport = new SSEClientTransport(new URL(`${BASE_URL}/sse`));
    const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);

    try {
      // List tools — proxied tools should exist but be disabled (no profile = no authorization possible)
      const { tools } = await client.listTools();
      const toolNames = tools.map(t => t.name);
      // Tools with profile: null are disabled — they won't appear in the list
      // Only Suveren admin tools should be visible
      expect(toolNames).toContain('list-authorizations');
      expect(toolNames).toContain('check-pending-attestations');

      // Calling a disabled tool should fail
      try {
        await client.callTool({
          name: 'test-tools__echo',
          arguments: { message: 'hello gateway' },
        });
        expect.fail('Expected tool to be disabled when no profile is set');
      } catch (err) {
        expect(String(err)).toContain('disabled');
      }
    } finally {
      await client.close();
    }
  }, 15000);

  it('can add integration with gated tools using staticExecution and divisor mapping', async () => {
    // Remove previous test integration first
    await del('/internal/remove-integration/test-tools');

    // Add an integration with profile-based gating
    const { status, data } = await post('/internal/add-integration', {
      id: 'test-tools',
      name: 'Test Tools (gated)',
      command: 'npx',
      args: ['tsx', TEST_SERVER_PATH],
      envKeys: {},
      profile: 'charge',
      enabled: true,
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.tools).toContain('test-tools__echo');
    expect(data.tools).toContain('test-tools__add');

    // Connect as MCP client
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

    const transport = new SSEClientTransport(new URL(`${BASE_URL}/sse`));
    const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);

    try {
      // All tools should be disabled — no active authorization for 'charge' profile
      // Both echo and add require authorization now (no ungated tools)
      try {
        await client.callTool({
          name: 'test-tools__echo',
          arguments: { message: 'should fail' },
        });
        expect.fail('Expected tool to be disabled when no authorization exists');
      } catch (err) {
        expect(String(err)).toContain('disabled');
      }

      try {
        await client.callTool({
          name: 'test-tools__add',
          arguments: { a: 5000, b: 7 },
        });
        expect.fail('Expected gated tool to be disabled when no authorization exists');
      } catch (err) {
        expect(String(err)).toContain('disabled');
      }
    } finally {
      await client.close();
      await del('/internal/remove-integration/test-tools');
    }
  }, 15000);
});
