/**
 * Locating the CLI from the control-plane.
 *
 * The autostart toggle shells out to `suveren-gateway service …`, so if the
 * binary cannot be found the switch reports "unavailable" — silently, and for
 * every user, while working perfectly on a developer machine where the repo
 * happens to sit at the path being probed.
 *
 * That is precisely what the first version did: it checked a repo-relative
 * path before the shipped one. tsup flattens the control-plane into
 * <root>/dist/control-plane/*.mjs, so the shipped CLI is TWO levels up, not
 * three. These tests pin the layout so a change to the build cannot quietly
 * break the feature.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCli } from '../routes/autostart';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'autostart-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Build the layout the bundle actually ships. */
function bundledLayout(): string {
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'suveren-gateway.js'), '#!/usr/bin/env node\n');
  const cpDir = join(root, 'dist', 'control-plane');
  mkdirSync(cpDir, { recursive: true });
  return cpDir; // what __dirname is at runtime
}

describe('findCli', () => {
  it('finds the CLI in the SHIPPED bundle layout', () => {
    const cpDir = bundledLayout();
    expect(findCli(cpDir)).toBe(join(root, 'bin', 'suveren-gateway.js'));
  });

  it('returns null when there is no CLI anywhere', () => {
    const cpDir = join(root, 'dist', 'control-plane');
    mkdirSync(cpDir, { recursive: true });
    // No bin/ — running from source with no build. The feature must report
    // unavailable rather than shell out to something that is not there.
    expect(findCli(cpDir)).toBeNull();
  });

  it('prefers the SHIPPED CLI over a repo path higher up', () => {
    // The original bug: a developer machine has both, and the wrong one won —
    // which meant the shipped layout was never actually exercised.
    const cpDir = bundledLayout();
    const strayRepo = join(root, '..', 'bundle', 'bin');
    try {
      mkdirSync(strayRepo, { recursive: true });
      writeFileSync(join(strayRepo, 'suveren-gateway.js'), '// stray\n');
      expect(findCli(cpDir)).toBe(join(root, 'bin', 'suveren-gateway.js'));
    } finally {
      rmSync(join(root, '..', 'bundle'), { recursive: true, force: true });
    }
  });

  it('returns an absolute path — it is spawned, so relative would be fragile', () => {
    const cpDir = bundledLayout();
    const found = findCli(cpDir);
    expect(found).toBeTruthy();
    expect(found!.startsWith('/') || /^[A-Za-z]:/.test(found!)).toBe(true);
  });
});
