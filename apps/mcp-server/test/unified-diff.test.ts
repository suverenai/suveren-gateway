/**
 * unified-diff.ts — the line-level diff `describe_brief_proposal` uses to
 * build its `change` field (DL1 — temp/briefs/dl-delegation-brief.md).
 */
import { describe, it, expect } from 'vitest';
import { unifiedLineDiff } from '../src/lib/unified-diff';

describe('unifiedLineDiff', () => {
  it('no change: every line comes back plain, no prefix', () => {
    const text = 'line one\nline two\nline three';
    expect(unifiedLineDiff(text, text)).toBe(text);
  });

  it('a changed line: the old line removed, the new line added', () => {
    const before = 'keep this\nold line\nkeep that';
    const after = 'keep this\nnew line\nkeep that';
    expect(unifiedLineDiff(before, after)).toBe(
      'keep this\n-old line\n+new line\nkeep that',
    );
  });

  it('an inserted line with no corresponding removal', () => {
    const before = 'a\nb';
    const after = 'a\nnew\nb';
    expect(unifiedLineDiff(before, after)).toBe('a\n+new\nb');
  });

  it('a removed line with no corresponding insertion', () => {
    const before = 'a\ngone\nb';
    const after = 'a\nb';
    expect(unifiedLineDiff(before, after)).toBe('a\n-gone\nb');
  });

  it('empty before: every line of after is an insertion', () => {
    expect(unifiedLineDiff('', 'one\ntwo')).toBe('-\n+one\n+two');
  });

  it('empty after: every line of before is a removal', () => {
    expect(unifiedLineDiff('one\ntwo', '')).toBe('-one\n-two\n+');
  });

  it('never emits ---/+++/@@ hunk headers', () => {
    const diff = unifiedLineDiff('a\nb\nc', 'a\nX\nc');
    expect(diff).not.toContain('@@');
    expect(diff).not.toContain('---');
    expect(diff).not.toContain('+++');
  });
});
