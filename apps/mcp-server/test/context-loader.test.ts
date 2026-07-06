import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readContextFile, getContextForBrief } from '../src/lib/context-loader';

const TEST_DIR = join(import.meta.dirname, '.test-context');

describe('context-loader', () => {
  // Clean up before and after
  function cleanup() {
    try { rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
  }

  it('returns null when context.md does not exist', () => {
    expect(readContextFile('/nonexistent/path')).toBeNull();
  });

  it('reads context.md content', () => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'context.md'), '## Organization\nAcme Corp');

    const content = readContextFile(TEST_DIR);
    expect(content).toBe('## Organization\nAcme Corp');

    cleanup();
  });

  it('returns null for empty file', () => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'context.md'), '');

    expect(readContextFile(TEST_DIR)).toBeNull();

    cleanup();
  });

  it('truncates content beyond the 16 KB editor cap (hand-edited files only)', () => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    const longContent = 'A'.repeat(17 * 1024);
    writeFileSync(join(TEST_DIR, 'context.md'), longContent);

    const { brief, truncated } = getContextForBrief(TEST_DIR);
    expect(truncated).toBe(true);
    expect(brief!.length).toBeLessThan(17 * 1024);
    expect(brief).toContain('truncated');

    cleanup();
  });

  it('delivers a full-size UI-saved brief whole (16 KB, untruncated)', () => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    const maxUiBrief = 'B'.repeat(16 * 1024);
    writeFileSync(join(TEST_DIR, 'context.md'), maxUiBrief);

    const { brief, truncated } = getContextForBrief(TEST_DIR);
    expect(truncated).toBe(false);
    expect(brief).toBe(maxUiBrief);

    cleanup();
  });

  it('does not truncate short content', () => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'context.md'), 'Short context');

    const { brief, truncated } = getContextForBrief(TEST_DIR);
    expect(truncated).toBe(false);
    expect(brief).toBe('Short context');

    cleanup();
  });
});
