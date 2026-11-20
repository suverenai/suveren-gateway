import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { manifestDir } from '../src/lib/manifest-loader';

/** A gateway checkout with content/integrations/index.json, and the folders the source and the build run from. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'gw-checkout-'));
  mkdirSync(join(root, 'content', 'integrations'), { recursive: true });
  writeFileSync(join(root, 'content', 'integrations', 'index.json'), '[]');
  mkdirSync(join(root, 'apps', 'mcp-server', 'src', 'lib'), { recursive: true });
  mkdirSync(join(root, 'apps', 'mcp-server', 'dist'), { recursive: true });
  return root;
}

describe('where the gateway finds its connector manifests', () => {
  const saved = process.env.SUVEREN_MANIFESTS_DIR;
  afterEach(() => { if (saved === undefined) delete process.env.SUVEREN_MANIFESTS_DIR; else process.env.SUVEREN_MANIFESTS_DIR = saved; });

  it('from the source (apps/mcp-server/src/lib)', () => {
    delete process.env.SUVEREN_MANIFESTS_DIR;
    const root = checkout();
    expect(manifestDir(undefined, join(root, 'apps', 'mcp-server', 'src', 'lib'))).toBe(resolve(root, 'content', 'integrations'));
  });

  it('from the build (apps/mcp-server/dist): found without SUVEREN_MANIFESTS_DIR', () => {
    delete process.env.SUVEREN_MANIFESTS_DIR;
    const root = checkout();
    expect(manifestDir(undefined, join(root, 'apps', 'mcp-server', 'dist'))).toBe(resolve(root, 'content', 'integrations'));
  });

  it('the variable and an explicit folder still win', () => {
    process.env.SUVEREN_MANIFESTS_DIR = '/x/y';
    expect(manifestDir(undefined, '/anywhere')).toBe(resolve('/x/y'));
    expect(manifestDir('/a/b', '/anywhere')).toBe(resolve('/a/b'));
  });
});
