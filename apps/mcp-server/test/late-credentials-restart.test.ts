/**
 * A connector started before its settings arrived must be restarted when
 * they do. At boot the gateway starts connectors whose settings are all
 * optional (ERP, CRM) before the vault is unlocked — so they come up on their
 * defaults (simulation). On unlock the saved settings (mode=live, adapter=local)
 * arrive; `credentialsChangedSinceStart` is what tells http.ts's
 * startIntegrationForService to restart instead of skipping the running one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { IntegrationManager } from '../src/lib/integration-manager';
import type { IntegrationConfig } from '../src/lib/integration-registry';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'env-mode-mcp-server.mjs');

const CONFIG: IntegrationConfig = {
  id: 'late',
  name: 'Late credentials fixture',
  command: process.execPath,
  args: [FIXTURE],
  env: {},
  envKeys: {},
  optionalEnvKeys: { FIXTURE_MODE: 'late.mode' },
  profile: 'late-profile',
  toolGating: { default: { executionMapping: {} }, overrides: {} } as IntegrationConfig['toolGating'],
  enabled: true,
};

async function childMode(im: IntegrationManager): Promise<string> {
  const res = await im.callTool('late', 'mode', {});
  return res.content[0].text;
}

describe('restart on credentials that arrive after start', () => {
  let im: IntegrationManager;
  afterEach(async () => { await im.shutdown(); });

  it('unchanged credentials → no restart needed', async () => {
    const creds = new Map<string, Record<string, string>>([['late', { mode: 'live' }]]);
    im = new IntegrationManager(creds);
    await im.startIntegration(CONFIG);
    expect(im.credentialsChangedSinceStart(CONFIG)).toBe(false);
    // Same values pushed again (every unlock re-pushes the vault) — still no restart.
    creds.set('late', { mode: 'live' });
    expect(im.credentialsChangedSinceStart(CONFIG)).toBe(false);
  }, 30_000);

  it('started on defaults, settings arrive → change detected; a restart hands the child the saved value', async () => {
    const creds = new Map<string, Record<string, string>>();
    im = new IntegrationManager(creds);
    await im.startIntegration(CONFIG);
    expect(await childMode(im)).toBe('unset');

    creds.set('late', { mode: 'live' });
    expect(im.credentialsChangedSinceStart(CONFIG)).toBe(true);

    await im.startIntegration(CONFIG); // what startIntegrationForService does on a change
    expect(await childMode(im)).toBe('live');
    expect(im.credentialsChangedSinceStart(CONFIG)).toBe(false);
  }, 30_000);

  it('not running → false (nothing to restart; the normal start path handles it)', () => {
    im = new IntegrationManager(new Map([['late', { mode: 'live' }]]));
    expect(im.credentialsChangedSinceStart(CONFIG)).toBe(false);
  });
});
