import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — a plain .mjs script outside the TypeScript project
import { findPersonalData } from '../../../../bundle/check-no-personal-data.mjs';

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pd-check-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

describe('the published package carries no personal data', () => {
  it('finds a personal address, a mail domain and a home path', () => {
    const root = tree({
      'dist/ui/mockups/a.html': '<p>andreas@example.org</p>',
      'dist/x.js': 'const to = "someone@sublin.app";',
      'lib/y.js': 'const p = "/Users/someone/.suveren";',
    });
    try {
      const hits = findPersonalData(root) as { file: string; why: string }[];
      expect(hits.map(h => h.why).sort()).toEqual(['a macOS home path', 'a personal mail domain', 'a personal name']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts a clean tree, the licence files and API paths like /api/users/', () => {
    const root = tree({
      'LICENSE': 'Copyright (c) 2026 Andreas Schadauer',
      'dist/z.js': 'fetch(`${url}/api/users/me/pubkey`); const to = "owner@example.com";',
      'node_modules/dep/readme.md': 'andreas',
    });
    try {
      expect(findPersonalData(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
