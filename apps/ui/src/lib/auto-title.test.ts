import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { autoTitleUnlessTyped } from './auto-title';

describe('the give page default title', () => {
  it('fills an empty title', () => {
    expect(autoTitleUnlessTyped('', 'Sales: EUR')).toBe('Sales: EUR');
    expect(autoTitleUnlessTyped('  ', 'Sales: EUR')).toBe('Sales: EUR');
  });
  it('keeps a title the person typed before the profile arrived', () => {
    expect(autoTitleUnlessTyped('Quotes', 'Sales: EUR')).toBe('Quotes');
  });
  it('the page sets it from the latest title, not the one its profile callback captured', () => {
    // The bug: setAuthTitle(title) inside the getProfile callback overwrote a title typed while the profile loaded.
    const src = readFileSync(new URL('../pages/AgentReviewPage.tsx', import.meta.url), 'utf8');
    expect(src).toContain('setAuthTitle(prev => autoTitleUnlessTyped(prev, title))');
    expect(src).not.toMatch(/setAuthTitle\(title\)/);
  });
});
