/**
 * A connector's own problem, in its own words, on its card (generic).
 *
 * Two sources, both the connector's:
 *  - running: the manifest-declared status check (`status.tool`), asked after
 *    start and again when the UI reads status (`refreshStatusChecks`);
 *  - not running: the last line it wrote to its error output before it
 *    stopped while starting (instead of the SDK's "Connection closed").
 *
 * Real child processes (fixtures/connector-status/*), no mocks.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  IntegrationManager, connectorLastWords, plainConnectorText, CONNECTOR_TEXT_MAX,
} from '../src/lib/integration-manager';
import { loadManifests, invalidManifestStatusReason, getManifest } from '../src/lib/manifest-loader';
import type { IntegrationConfig } from '../src/lib/integration-registry';

const DIR = join(import.meta.dirname, 'fixtures', 'connector-status');

function config(script: string, env: Record<string, string> = {}, id = 'status-fixture'): IntegrationConfig {
  const manifest = getManifest('status-fixture');
  return {
    id,
    name: 'Status Fixture',
    command: process.execPath,
    args: [join(DIR, script)],
    env,
    envKeys: {},
    profile: 'status-fixture',
    toolGating: manifest?.toolGating as IntegrationConfig['toolGating'],
    enabled: true,
  };
}

const statusOf = (im: IntegrationManager, cfg: IntegrationConfig) => im.getStatus([cfg]).find(s => s.id === cfg.id)!;

beforeAll(() => {
  expect(loadManifests(join(DIR, 'manifests'))).toBeGreaterThanOrEqual(1);
  expect(getManifest('status-fixture')?.status?.tool).toBe('check_status');
});

describe('a running connector reports its problem through its status check', () => {
  let im: IntegrationManager;
  let work: string;
  afterEach(async () => {
    await im.shutdown();
    rmSync(work, { recursive: true, force: true });
  });

  it('the problem is on the status right after start, in the connector\'s words; fixed, it is gone on the next check', async () => {
    work = mkdtempSync(join(tmpdir(), 'connector-status-'));
    const file = join(work, 'problem.txt');
    const sentence = 'The Files connector cannot use /Users/anna/Documents/x: this computer does not allow it to read or write there (Operation not permitted).';
    writeFileSync(file, sentence);
    im = new IntegrationManager(new Map());
    const cfg = config('status-mcp-server.mjs', { STATUS_FILE: file });
    await im.startIntegration(cfg);

    const s = statusOf(im, cfg);
    expect(s.running).toBe(true);
    expect(s.problem).toBe(sentence);
    expect(s.error).toBeUndefined();

    // The person fixes it; the UI's next status read asks again.
    writeFileSync(file, '');
    await im.refreshStatusChecks(0);
    const after = statusOf(im, cfg);
    expect(after.running).toBe(true);
    expect(after.problem).toBeUndefined();
    expect(after.error).toBeUndefined();
  }, 30_000);

  it('the status check is never offered to the AI: it is internal', async () => {
    work = mkdtempSync(join(tmpdir(), 'connector-status-'));
    im = new IntegrationManager(new Map());
    await im.startIntegration(config('status-mcp-server.mjs'));
    const check = im.getAllTools().find(t => t.originalName === 'check_status');
    expect(check?.internal).toBe(true);
    expect(im.getAllTools().find(t => t.originalName === 'echo')?.internal).toBeFalsy();
  }, 30_000);

  it('refreshStatusChecks honours its age: a fresh answer is not asked again', async () => {
    work = mkdtempSync(join(tmpdir(), 'connector-status-'));
    const file = join(work, 'problem.txt');
    writeFileSync(file, 'first problem');
    im = new IntegrationManager(new Map());
    const cfg = config('status-mcp-server.mjs', { STATUS_FILE: file });
    await im.startIntegration(cfg);
    writeFileSync(file, 'second problem');
    await im.refreshStatusChecks(60_000);
    expect(statusOf(im, cfg).problem).toBe('first problem');
    await im.refreshStatusChecks(0);
    expect(statusOf(im, cfg).problem).toBe('second problem');
  }, 30_000);

  it('a status check that answers with an error: the gateway says so in its own sentence, no old answer is kept', async () => {
    work = mkdtempSync(join(tmpdir(), 'connector-status-'));
    im = new IntegrationManager(new Map());
    const cfg = config('status-mcp-server.mjs', { STATUS_MODE: 'error' });
    await im.startIntegration(cfg);
    const s = statusOf(im, cfg);
    expect(s.running).toBe(true);
    expect(s.problem).toBeUndefined();
    expect(s.error).toBe('Status Fixture did not answer when the gateway checked whether it works.');
  }, 30_000);

  it('a status check that never answers does not hold the start: the gateway says so after its timeout', async () => {
    work = mkdtempSync(join(tmpdir(), 'connector-status-'));
    im = new IntegrationManager(new Map());
    const cfg = config('status-mcp-server.mjs', { STATUS_MODE: 'hang' });
    const t0 = Date.now();
    await im.startIntegration(cfg);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(statusOf(im, cfg).error).toBe('Status Fixture did not answer when the gateway checked whether it works.');
  }, 30_000);
});

describe('a connector that stops while starting', () => {
  let im: IntegrationManager;
  afterEach(async () => { await im.shutdown(); });

  it('the card gets the gateway\'s sentence and the connector\'s own last words, not "Connection closed"', async () => {
    im = new IntegrationManager(new Map());
    const cfg = config('exits-at-start.mjs', {}, 'exits-fixture');
    await expect(im.startIntegration(cfg)).rejects.toThrow(
      'Status Fixture stopped while starting. It said: [exits-fixture] fatal: the store at /nowhere/files.db cannot be opened',
    );
    const s = statusOf(im, cfg);
    expect(s.running).toBe(false);
    expect(s.error).toBe('Status Fixture stopped while starting.');
    expect(s.problem).toBe('[exits-fixture] fatal: the store at /nowhere/files.db cannot be opened');
    expect(JSON.stringify(s)).not.toMatch(/Connection closed/);
  }, 30_000);

  it('an uncaught error: the error line, not the stack or the Node.js footer', async () => {
    im = new IntegrationManager(new Map());
    const cfg = config('throws-at-start.mjs', {}, 'throws-fixture');
    await expect(im.startIntegration(cfg)).rejects.toThrow(/stopped while starting/);
    expect(statusOf(im, cfg).problem).toBe('Error: Cannot read the settings file');
  }, 30_000);

  it('a later successful start clears it; a deliberate stop clears it', async () => {
    im = new IntegrationManager(new Map());
    const bad = config('exits-at-start.mjs', {}, 'flip-fixture');
    await expect(im.startIntegration(bad)).rejects.toThrow();
    expect(statusOf(im, bad).error).toBeDefined();
    const good = { ...config('status-mcp-server.mjs', {}, 'flip-fixture') };
    await im.startIntegration(good);
    expect(statusOf(im, good).error).toBeUndefined();
    expect(statusOf(im, good).problem).toBeUndefined();

    await im.stopIntegration('flip-fixture');
    await expect(im.startIntegration(bad)).rejects.toThrow();
    await im.stopIntegration('flip-fixture');
    expect(statusOf(im, bad).error).toBeUndefined();
  }, 30_000);
});

describe('connectorLastWords / plainConnectorText', () => {
  it('skips what Node prints around an uncaught error', () => {
    const out = [
      'file:///x/index.js:3',
      "throw new Error('boom');",
      '^',
      '',
      'Error: boom',
      '    at file:///x/index.js:3:7',
      '    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)',
      '',
      'Node.js v22.12.0',
      '',
    ].join('\n');
    expect(connectorLastWords(out)).toBe('Error: boom');
  });

  it('nothing usable → undefined', () => {
    expect(connectorLastWords('')).toBeUndefined();
    expect(connectorLastWords('\n   at x\nNode.js v22.1.0\n')).toBeUndefined();
  });

  it('control characters and colour codes removed, length capped', () => {
    expect(plainConnectorText('\u001b[31mred\u001b[0m‮text\n  more')).toBe('red text more');
    const long = plainConnectorText('a'.repeat(2000))!;
    expect(long.length).toBe(CONNECTOR_TEXT_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(plainConnectorText('   ')).toBeUndefined();
    expect(plainConnectorText(42)).toBeUndefined();
  });
});

describe('invalidManifestStatusReason', () => {
  const gating = (internal: boolean) => ({
    default: { executionMapping: {} },
    overrides: { check_status: { category: 'read', internal } },
  }) as never;

  it('accepts no declaration, and a tool declared internal', () => {
    expect(invalidManifestStatusReason({ toolGating: gating(true) })).toBeNull();
    expect(invalidManifestStatusReason({ status: { tool: 'check_status' }, toolGating: gating(true) })).toBeNull();
  });

  it('refuses a status tool the AI could see, an undeclared one, and a bad shape', () => {
    expect(invalidManifestStatusReason({ status: { tool: 'check_status' }, toolGating: gating(false) })).toMatch(/internal/);
    expect(invalidManifestStatusReason({ status: { tool: 'nope' }, toolGating: gating(true) })).toMatch(/nope/);
    expect(invalidManifestStatusReason({ status: { tool: '' }, toolGating: gating(true) })).toMatch(/non-empty/);
    expect(invalidManifestStatusReason({ status: 'check_status' as never, toolGating: gating(true) })).toMatch(/object/);
  });
});
