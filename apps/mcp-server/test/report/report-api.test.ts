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

  it('REFUSAL: GET /internal/report/export before any save fails visibly (404), never an empty file', async () => {
    const res = await fetch(`${BASE_URL}/internal/report/export`, { headers: withSecret() });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/json/);
  });

  it('REFUSAL: POST /internal/report rejects a missing/empty html body (400)', async () => {
    const res = await fetch(`${BASE_URL}/internal/report`, {
      method: 'POST',
      headers: { ...withSecret(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('REFUSAL: POST /internal/report with no reporting mandate is refused (409) — no window, nothing verified or saved (RR2)', async () => {
    const saveRes = await fetch(`${BASE_URL}/internal/report`, {
      method: 'POST',
      headers: { ...withSecret(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<h1>Three-week test</h1><sv-ticket ref="ghost-1"></sv-ticket>' }),
    });
    expect(saveRes.status).toBe(409);
    expect((await saveRes.json()).error).toMatch(/reporting mandate/i);
    const check = await fetch(`${BASE_URL}/internal/report`, { headers: withSecret() });
    expect((await check.json()).report).toBeNull();
  });

  it('recheck with no report yet returns {report: null} — no window needed to say "nothing there"', async () => {
    const res = await fetch(`${BASE_URL}/internal/report/recheck`, { method: 'POST', headers: withSecret() });
    expect(res.status).toBe(200);
    expect((await res.json()).report).toBeNull();
  });
});

/**
 * A report the AI already wrote under a reporting mandate (seeded on disk, as
 * write_report stores it — with the reporting window it was checked against).
 * "Check again" and the export reuse THAT window: they need no active
 * mandate, and the window's start never moves (window.ts#scopeReportSourcesToStoredWindow).
 */
describe('/internal/report* on a stored report (its own reporting window)', () => {
  const PORT2 = 13032;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const DATA2 = resolve(__dirname, '../../.test-data-report-api-stored');
  const PROFILES2 = resolve(__dirname, '../../.test-profiles-report-api-stored');
  let proc2: ChildProcess;
  const now = Math.floor(Date.now() / 1000);
  const window = { start: now - 30 * 86_400, end: now, days: 30, label: 'since then (the last 30 days)' };

  beforeAll(async () => {
    mkdirSync(PROFILES2, { recursive: true });
    writeFileSync(resolve(PROFILES2, 'index.json'), JSON.stringify({ repository: 'test', profiles: {} }));
    rmSync(DATA2, { recursive: true, force: true });
    mkdirSync(DATA2, { recursive: true });
    const html = '<h1>Three-week test</h1><sv-ticket ref="ghost-1"></sv-ticket>';
    writeFileSync(resolve(DATA2, 'report.json'), JSON.stringify({
      version: 1,
      report: {
        html, savedAt: now - 60, checkedAt: now - 60,
        result: {
          html, elements: [],
          proof: { ticketsReferenced: [], signaturesValid: 0, recordsChecked: 0, unverifiableCount: 0, verifiedValues: [] },
          coverage: {
            loadedCases: [], coveredCases: [], missingCases: [], periodStart: window.start, window,
            ticketsInPeriod: [], ticketsReferenced: [], ticketsNotReferenced: [],
          },
        },
      },
    }));
    proc2 = spawn('npx', ['tsx', 'bin/http.ts'], {
      cwd: resolve(__dirname, '../..'),
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        SUVEREN_MCP_PORT: String(PORT2),
        SUVEREN_AS_URL: 'https://www.suveren.ai',
        SUVEREN_DATA_DIR: DATA2,
        SUVEREN_PROFILES_DIR: PROFILES2,
        SUVEREN_DISABLE_AUTO_INTEGRATIONS: '1',
        SUVEREN_INTERNAL_SECRET: SECRET,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc2.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`  [report-api stored server] ${data.toString()}`);
    });
    await waitForServer(BASE2);
  }, 60000);

  afterAll(async () => {
    proc2?.kill();
    rmSync(PROFILES2, { recursive: true, force: true });
    rmSync(DATA2, { recursive: true, force: true });
  });

  it('GET returns the stored report with its reporting window', async () => {
    const res = await fetch(`${BASE2}/internal/report`, { headers: withSecret() });
    const data = (await res.json()).report;
    expect(data.renderedHtml).toContain('Three-week test');
    expect(data.coverage.window.start).toBe(window.start);
  });

  it('recheck() re-verifies without requiring a new html body, and REFUSES without a secret', async () => {
    const noAuth = await fetch(`${BASE2}/internal/report/recheck`, { method: 'POST' });
    expect(noAuth.status).toBe(403);

    const res = await fetch(`${BASE2}/internal/report/recheck`, { method: 'POST', headers: withSecret() });
    expect(res.status).toBe(200);
    const data = (await res.json()).report;
    expect(data.checkedAt).toBeGreaterThanOrEqual(data.savedAt);
  });

  it('REFUSAL: GET /internal/report/export with no secret is rejected (403)', async () => {
    const res = await fetch(`${BASE2}/internal/report/export`);
    expect(res.status).toBe(403);
  });

  it('REFUSAL: GET /internal/report/export fails visibly (no AS pairing in this test harness, never an empty file)', async () => {
    // This suite's data dir has a stored report (seeded above)
    // but no as-pairing.json and no archived tickets — there is genuinely no
    // Authority Server key to anchor an export to, so the route must refuse
    // rather than ship an unanchored bundle.
    const res = await fetch(`${BASE2}/internal/report/export`, { headers: withSecret() });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/authority server/i);
    expect(res.headers.get('content-type')).toMatch(/json/);
  });

  /**
   * API-level counterpart to the 2026-10-06 regression (ReportsPage.test.ts's
   * "REGRESSION PIN" block): the live page briefly showed a "0 of 0" Cases
   * line while a just-exported file correctly said "unknown". That turned
   * out to be a CLIENT bug (the page never re-fetched after a successful
   * export, see `runExportAndRefresh`) — this test is the server-side half
   * of ruling that out: GET must always reflect the MOST RECENT check
   * (save OR recheck), with no staleness of its own, so a client that DOES
   * refresh (the fix) gets the true current answer. No email-mcp connector
   * is installed in this test harness, so `coverage.emailExportError` is
   * expected to be set from the FIRST save already — unlike the production
   * incident's synthetic reproduction, nothing here hand-crafts a
   * never-fails stub.
   */
  it('GET always reflects the MOST RECENT check (recheck, then recheck) — coverage.emailExportError never goes stale', async () => {
    const firstRes = await fetch(`${BASE2}/internal/report/recheck`, { method: 'POST', headers: withSecret() });
    const saved = (await firstRes.json()).report;
    expect(saved.coverage.emailExportError).toBeTruthy(); // no connector in this harness

    const getAfterSave = await fetch(`${BASE2}/internal/report`, { headers: withSecret() });
    const fetchedAfterSave = (await getAfterSave.json()).report;
    expect(fetchedAfterSave.coverage.emailExportError).toBe(saved.coverage.emailExportError);
    expect(fetchedAfterSave.checkedAt).toBe(saved.checkedAt);

    const recheckRes = await fetch(`${BASE2}/internal/report/recheck`, { method: 'POST', headers: withSecret() });
    const rechecked = (await recheckRes.json()).report;
    expect(rechecked.coverage.emailExportError).toBeTruthy();
    expect(rechecked.checkedAt).toBeGreaterThanOrEqual(saved.checkedAt);

    const getAfterRecheck = await fetch(`${BASE2}/internal/report`, { headers: withSecret() });
    const fetchedAfterRecheck = (await getAfterRecheck.json()).report;
    // The critical assertion: GET reflects the RECHECK's checkedAt/coverage,
    // not a stale copy of the earlier save's.
    expect(fetchedAfterRecheck.checkedAt).toBe(rechecked.checkedAt);
    expect(fetchedAfterRecheck.coverage.emailExportError).toBe(rechecked.coverage.emailExportError);
  });
});
