/**
 * The phone imports hap-core's MAIN entry for the give hashes (give-hashes.ts). This bundles that import for the browser, the way the
 * phone build does, and fails if any Node built-in is reached. The one allowed: @hpke's guarded dynamic `import("crypto")` fallback
 * for a runtime without WebCrypto, already part of the phone's build through the content opening; it is never reached in a browser.
 */
import { describe, it, expect } from 'vitest';
import { builtinModules } from 'node:module';
import { build, type Rollup } from 'vite';
import { fileURLToPath } from 'node:url';

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

describe('give-hashes in the browser bundle', () => {
  it('reaches no Node built-in except @hpke\'s guarded WebCrypto fallback', async () => {
    const reached: Array<{ path: string; importer: string }> = [];
    const res = await build({
      logLevel: 'silent', configFile: false,
      plugins: [{
        name: 'builtins',
        enforce: 'pre',
        resolveId(source: string, importer: string | undefined) {
          if (!BUILTINS.has(source)) return null;
          reached.push({ path: source, importer: importer ?? '' });
          return { id: source, external: true };
        },
      }],
      build: {
        write: false, minify: false, target: 'es2022',
        lib: { entry: fileURLToPath(new URL('./give-hashes.ts', import.meta.url)), formats: ['es'], fileName: 'gh' },
      },
    });
    const code = (Array.isArray(res) ? res[0] : res as Rollup.RollupOutput).output.map((o) => ('code' in o ? o.code : '')).join('\n');
    // Only @hpke's guarded fallback (`crypto`, reached when the runtime has no WebCrypto) may name a Node module.
    const bad = reached.filter((r) => !(r.path === 'crypto' && /[\\/]@hpke[\\/+]/.test(r.importer)));
    expect(bad).toEqual([]);
    expect(reached.length, 'the check saw the bundle at all').toBeGreaterThan(0);
    expect(code).toContain('computeBoundsHash');
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toMatch(/\bprocess\.(env|versions|platform)/);
  }, 60_000);
});
