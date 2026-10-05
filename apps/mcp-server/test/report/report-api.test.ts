/**
 * /internal/report* — real HTTP server tests (work-plan "evidence-backed
 * reports", R5 gateway frame half). Spawns the REAL `bin/http.ts`, unlike
 * `gateway.test.ts` sibling suite, WITH a non-empty `SUVEREN_INTERNAL_SECRET`
 * so the auth guard (`internalOnly` in http.ts) is actually exercised —
 * per engineering.md "test refusals harder than successes": a gate with no
 * test proving it blocks is decoration.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const MCP_PORT = 13031; // distinct from gateway.test.ts's port
const BASE_URL = `http://127.0.0.1:${MCP_PORT}`;
const SECRET = 'test-report-secret';
const TEST_PROFILES_DIR = resolve(__dirname, '../../.test-profiles-report-api');
const TEST_DATA_DIR = resolve(__dirname, '../../.test-data-report-api');

let serverProcess: ChildProcess;

async function waitForServer(url: string, timeoutMs = 50000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

function withSecret(headers: Record<string, string> = {}): Record<string, string> {
  return { 'X-Internal-Secret': SECRET, ...headers };
}

describe('/internal/report* auth + round trip', () => {
  beforeAll(async () => {
    mkdirSync(TEST_PROFILES_DIR, { recursive: true });
    writeFileSync(resolve(TEST_PROFILES_DIR, 'index.json'), JSON.stringify({ repository: 'test', profiles: {} }));
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });

    serverProcess = spawn('npx', ['tsx', 'bin/http.ts'], {
      cwd: resolve(__dirname, '../..'),
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        SUVEREN_MCP_PORT: String(MCP_PORT),
        SUVEREN_AS_URL: 'https://www.suveren.ai',
        SUVEREN_DATA_DIR: TEST_DATA_DIR,
        SUVEREN_PROFILES_DIR: TEST_PROFILES_DIR,
        SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1',
        SUVEREN_INTERNAL_SECRET: SECRET,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    serverProcess.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`  [report-api server] ${data.toString()}`);
    });
    await waitForServer(BASE_URL);
  }, 60000);

  afterAll(async () => {
    serverProcess?.kill();
    rmSync(TEST_PROFILES_DIR, { recursive: true, force: true });
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('REFUSAL: GET /internal/report with no secret is rejected (403)', async () => {
    const res = await fetch(`${BASE_URL}/internal/report`);
    expect(res.status).toBe(403);
  });

  it('REFUSAL: GET /internal/report with the WRONG secret is rejected (403)', async () => {
    const res = await fetch(`${BASE_URL}/internal/report`, { headers: withSecret({ 'X-Internal-Secret': 'wrong' }) });
    expect(res.status).toBe(403);
  });

  it('REFUSAL: POST /internal/report with no secret is rejected (403), never saves', async () => {
    const res = await fetch(`${BASE_URL}/internal/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<p>should not be saved</p>' }),
    });
    expect(res.status).toBe(403);

    const check = await fetch(`${BASE_URL}/internal/report`, { headers: withSecret() });
    const data = await check.json();
    expect(data.report).toBeNull();
  });

  it('GET /internal/report with the correct secret returns {report: null} before any save', async () => {
    const res = await fetch(`${BASE_URL}/internal/report`, { headers: withSecret() });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.report).toBeNull();
  });

  it('REFUSAL: POST /internal/report rejects a missing/empty html body (400)', async () => {
    const res = await fetch(`${BASE_URL}/internal/report`, {
      method: 'POST',
      headers: { ...withSecret(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('saves a report, verifies it, and GET reflects exactly what was saved', async () => {
    const html = '<h1>Three-week test</h1><sv-ticket ref="ghost-1"></sv-ticket>';
    const saveRes = await fetch(`${BASE_URL}/internal/report`, {
      method: 'POST',
      headers: { ...withSecret(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ html }),
    });
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()).report;
    expect(saved.savedAt).toBe(saved.checkedAt);
    expect(saved.renderedHtml).toContain('Three-week test');
    expect(saved.renderedHtml).not.toMatch(/<sv-ticket/);
    // No real archive/connector in this test harness — an unknown ticket ref
    // is correctly unverifiable, never invented.
    expect(saved.proof.unverifiableCount).toBe(1);
    expect(saved.elements[0].status).toBe('unverifiable');

    const getRes = await fetch(`${BASE_URL}/internal/report`, { headers: withSecret() });
    const fetched = (await getRes.json()).report;
    expect(fetched.savedAt).toBe(saved.savedAt);
    expect(fetched.renderedHtml).toBe(saved.renderedHtml);
  });

  it('recheck() re-verifies without requiring a new html body, and REFUSES without a secret', async () => {
    const noAuth = await fetch(`${BASE_URL}/internal/report/recheck`, { method: 'POST' });
    expect(noAuth.status).toBe(403);

    const res = await fetch(`${BASE_URL}/internal/report/recheck`, { method: 'POST', headers: withSecret() });
    expect(res.status).toBe(200);
    const data = (await res.json()).report;
    expect(data.checkedAt).toBeGreaterThanOrEqual(data.savedAt);
  });
});
