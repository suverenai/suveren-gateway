/**
 * A credential field added to a manifest AFTER an integration was activated
 * must still reach the integration's process.
 *
 * 2026-09-05: deploy-github gained an optional "Artifact directory" field
 * (HAP_DEPLOY_ARTIFACT_PATH). The registry entry on every existing install was
 * a snapshot of the old manifest — envKeys held GITHUB_TOKEN only — so the
 * value the user saved in the vault was never mapped into the environment.
 * The UI reported "saved", the deploy tool reported `artifactPath: null`, and
 * the next release would have bound the wrong commit. resolveEnvKeys now also
 * consults the CURRENT manifest's mapping for variables the snapshot lacks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationManager } from '../src/lib/integration-manager';
import { loadManifests } from '../src/lib/manifest-loader';
import type { IntegrationConfig } from '../src/lib/integration-registry';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hap-manifests-'));
  mkdirSync(join(dir, 'dg'));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ integrations: { 'deploy-github': 'dg/manifest.json' } }));
  writeFileSync(
    join(dir, 'dg/manifest.json'),
    JSON.stringify({
      id: 'deploy-github',
      name: 'Deploy',
      version: '1',
      profile: 'deploy',
      mcp: { command: 'npx', args: ['-y', '@humanagencyp/deploy-mcp@latest'] },
      credentials: {
        fields: [
          { key: 'githubToken', label: 'GitHub token', type: 'password' },
          { key: 'artifactPath', label: 'Artifact directory (optional)', type: 'text', optional: true },
        ],
        // The CURRENT mapping — one more variable than the snapshot below knows.
        envMapping: { GITHUB_TOKEN: 'githubToken', HAP_DEPLOY_ARTIFACT_PATH: 'artifactPath' },
      },
    }),
  );
  loadManifests(dir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What an install activated under the OLD manifest still holds in integrations.json. */
const FROZEN: IntegrationConfig = {
  id: 'deploy-github',
  name: 'Deploy',
  command: 'npx',
  args: ['-y', '@humanagencyp/deploy-mcp@latest'],
  envKeys: { GITHUB_TOKEN: 'deploy-github.githubToken' },
  profile: 'deploy',
  enabled: true,
};

function resolve(im: IntegrationManager, config: IntegrationConfig): Record<string, string> {
  // Private by design; the test reaches in rather than spawning a child just
  // to read its environment back.
  return (im as unknown as { resolveEnvKeys(c: IntegrationConfig): Record<string, string> }).resolveEnvKeys(config);
}

describe('env mapping follows the current manifest, not only the activation snapshot', () => {
  it('a field the snapshot never knew still reaches the process when the vault has it', () => {
    const im = new IntegrationManager(
      new Map([['deploy-github', { githubToken: 'ghp_x', artifactPath: 'website/dist' }]]),
    );
    expect(resolve(im, FROZEN)).toEqual({ GITHUB_TOKEN: 'ghp_x', HAP_DEPLOY_ARTIFACT_PATH: 'website/dist' });
  });

  it('absent from the vault → absent from the env; nothing is invented', () => {
    const im = new IntegrationManager(new Map([['deploy-github', { githubToken: 'ghp_x' }]]));
    expect(resolve(im, FROZEN)).toEqual({ GITHUB_TOKEN: 'ghp_x' });
  });

  it('the snapshot wins where both name the same variable', () => {
    const im = new IntegrationManager(
      new Map([
        ['deploy-github', { githubToken: 'from-manifest-path', artifactPath: 'website/dist' }],
        ['other', { tok: 'from-snapshot-path' }],
      ]),
    );
    const cfg: IntegrationConfig = { ...FROZEN, envKeys: { GITHUB_TOKEN: 'other.tok' } };
    expect(resolve(im, cfg).GITHUB_TOKEN).toBe('from-snapshot-path');
  });

  it('required-ness is still judged from the snapshot — the new field cannot block a start', () => {
    const im = new IntegrationManager(new Map([['deploy-github', { githubToken: 'ghp_x' }]]));
    expect(im.canResolveEnvKeys(FROZEN)).toBe(true);
  });

  it('an integration with no manifest loaded behaves exactly as before', () => {
    const im = new IntegrationManager(new Map([['nomanifest', { a: '1' }]]));
    const cfg: IntegrationConfig = { ...FROZEN, id: 'nomanifest', envKeys: { A: 'nomanifest.a' } };
    expect(resolve(im, cfg)).toEqual({ A: '1' });
  });
});
