/**
 * Pinned connector versions (decision Andreas, 2026-10-02, "option A") — every
 * shipped manifest that installs an npm package MUST pin the EXACT tested
 * version, and none may ask npm to resolve a moving target.
 *
 * Before this, `ensureInstalled` installed `npmPackage` once and never checked
 * its version again — a connector installed on day one silently never
 * updated, no matter how many releases shipped later (observed: erp-mcp stuck
 * at 0.3.0 while 0.3.3 was out). `deploy-github` took the opposite, equally
 * wrong, extreme: it ran `npx -y @humanagencyp/deploy-mcp@latest` on EVERY
 * start — unvetted code nobody here tested, fetched fresh each time.
 *
 * The fix: a gateway release ships a tested SET of connector versions, like
 * the bundled profiles. `npmVersion` is that pin. This lint is the regression
 * guard for two ways a manifest could quietly lose it:
 *   - a new manifest ships `npmPackage` with no `npmVersion` at all (the
 *     original erp-mcp bug, now impossible to reintroduce unnoticed);
 *   - a manifest or the install command itself asks for "latest" or any
 *     other moving target (the original deploy-github bug).
 *
 * Uses `invalidNpmPinReason`/`isExactSemver` — the SAME predicates
 * `loadManifests` refuses a manifest with at runtime — so lint and runtime
 * can never disagree about what counts as a valid pin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { invalidNpmPinReason, isExactSemver } from '../src/lib/manifest-loader';

const MANIFESTS_DIR = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');

const manifestFiles = readdirSync(MANIFESTS_DIR)
  .filter(f => f.endsWith('.json') && f !== 'index.json');

interface ManifestShape {
  npmPackage?: string;
  npmVersion?: string;
  mcp: { command: string; args: string[] };
}

describe('manifest npm-pin lint (pinned connector versions)', () => {
  it('finds manifests to lint (guards against a broken path)', () => {
    expect(manifestFiles.length).toBeGreaterThan(0);
  });

  it('control check: isExactSemver actually rejects what it should', () => {
    // If this predicate stopped rejecting anything, every check below would
    // pass vacuously. Pin its behaviour directly.
    expect(isExactSemver('1.2.3')).toBe(true);
    expect(isExactSemver('0.3.3')).toBe(true);
    expect(isExactSemver('1.2.3-beta.1')).toBe(true);
    expect(isExactSemver('1.2.3+build.5')).toBe(true);
    expect(isExactSemver('latest')).toBe(false);
    expect(isExactSemver('^1.2.3')).toBe(false);
    expect(isExactSemver('~1.2.3')).toBe(false);
    expect(isExactSemver('>=1.2.3')).toBe(false);
    expect(isExactSemver('1.x')).toBe(false);
    expect(isExactSemver('*')).toBe(false);
    expect(isExactSemver('git+https://github.com/x/y.git')).toBe(false);
    expect(isExactSemver('https://example.com/pkg.tgz')).toBe(false);
    expect(isExactSemver('file:../local-pkg')).toBe(false);
    expect(isExactSemver(undefined)).toBe(false);
    expect(isExactSemver('')).toBe(false);
  });

  for (const file of manifestFiles) {
    const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, file), 'utf8')) as ManifestShape;

    describe(file, () => {
      if (!manifest.npmPackage) {
        it('declares no npmPackage — nothing to pin', () => {
          expect(manifest.npmPackage).toBeUndefined();
        });
        return;
      }

      it('pins an exact, valid npmVersion', () => {
        expect(
          invalidNpmPinReason(manifest),
          `${file}: npmPackage "${manifest.npmPackage}" must pin an exact npmVersion`,
        ).toBeNull();
      });

      it('npmVersion is not a dist-tag, range, git spec, URL, or file path', () => {
        expect(manifest.npmVersion, `${file} has no npmVersion to check`).toBeDefined();
        expect(isExactSemver(manifest.npmVersion)).toBe(true);
      });

      it('the install command never asks npm to resolve "latest" (or any tag) itself', () => {
        // The whole point of the pin is defeated if the command line still
        // fetches a moving target regardless of what's installed locally —
        // this was deploy-github's actual bug (`npx -y pkg@latest`).
        const commandLine = [manifest.mcp.command, ...manifest.mcp.args].join(' ');
        expect(commandLine, `${file}: mcp.command/args must not reference @latest or any dist-tag`).not.toMatch(
          /@(latest|next|canary|beta|alpha)\b/,
        );
        expect(commandLine, `${file}: must not shell out via npx — it bypasses the pinned local install`).not.toMatch(
          /\bnpx\b/,
        );
      });
    });
  }
});
