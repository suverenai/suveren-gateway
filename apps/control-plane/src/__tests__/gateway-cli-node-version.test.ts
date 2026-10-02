/**
 * The CLI's Node version gate (bundle/lib/node-version.mjs). Imported across
 * the package boundary, same convention as gateway-cli-config.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_NODE_MAJOR, unsupportedNodeReason } from '../../../../bundle/lib/node-version.mjs';

describe('bundle/lib/node-version.mjs', () => {
  it('accepts the minimum major and newer', () => {
    expect(unsupportedNodeReason('22.0.0')).toBeNull();
    expect(unsupportedNodeReason('22.11.0')).toBeNull();
    expect(unsupportedNodeReason('25.8.1')).toBeNull();
  });

  it('refuses older majors, naming both versions', () => {
    const reason = unsupportedNodeReason('20.18.1');
    expect(reason).toContain('Node.js 22 or newer');
    expect(reason).toContain('20.18.1');
    expect(unsupportedNodeReason('21.7.3')).not.toBeNull();
  });

  it('refuses an unparseable version', () => {
    expect(unsupportedNodeReason('')).not.toBeNull();
    expect(unsupportedNodeReason('v-next')).not.toBeNull();
  });

  it('matches engines in the published package.json template', () => {
    const tpl = readFileSync(join(__dirname, '../../../../bundle/package.json.tpl'), 'utf8');
    expect(tpl).toContain(`"node": ">=${MIN_NODE_MAJOR}"`);
  });

  it('is checked by both entry points before they start anything', () => {
    for (const file of ['bundle/bin/suveren-gateway.js', 'bundle/server.js']) {
      const src = readFileSync(join(__dirname, '../../../..', file), 'utf8');
      expect(src, file).toContain('unsupportedNodeReason(process.versions.node)');
    }
  });
});
