import { describe, it, expect } from 'vitest';
import { formatTabTitle, normalizeCount, badgedFaviconHref, applyAppBadge } from './tab-badge';

/**
 * DOM-free by design: this package's tests run without a DOM environment, so
 * the rules worth pinning live in pure functions and `setTabBadge` stays a thin
 * wrapper over them.
 */
describe('tab title', () => {
  it('carries the count and nothing else', () => {
    expect(formatTabTitle(3)).toBe('(3) Suveren');
    // A proposal title here would be readable by any extension holding the
    // `tabs` permission, and visible in every screen share.
    expect(formatTabTitle(3)).not.toMatch(/€|\$|approve|refund/i);
  });

  it('is the bare brand at zero', () => {
    expect(formatTabTitle(0)).toBe('Suveren');
  });

  it('treats negative, fractional and non-finite counts as no badge', () => {
    expect(formatTabTitle(-1)).toBe('Suveren');
    expect(formatTabTitle(Number.NaN)).toBe('Suveren');
    expect(normalizeCount(2.7)).toBe(2);
    expect(normalizeCount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('badged favicon', () => {
  const href = badgedFaviconHref();

  it('is a self-contained SVG data URI', () => {
    // Not canvas: toDataURL() throws SecurityError on a tainted canvas, which
    // is an obscure failure to debug for no gain.
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);
  });

  it('marks with a dot rather than a number', () => {
    const svg = decodeURIComponent(href);
    expect(svg).toContain('<circle');
    expect(svg).not.toMatch(/<text/);
  });

  it('keeps the same mark geometry as the base favicon', () => {
    const svg = decodeURIComponent(href);
    // Small-size master — must match public/favicon.svg, or the tab icon
    // visibly changes shape the moment something is pending.
    expect(svg).toContain('M 104.94 61.85 A 41 41 0 1 1 45.39 27.47');
    expect(svg).toContain('stroke-width:14');
  });

  it('adapts to the OS colour scheme', () => {
    const svg = decodeURIComponent(href);
    expect(svg).toContain('prefers-color-scheme:dark');
  });

  it('contains no foreignObject', () => {
    // Would taint a canvas, and is the usual reason an SVG favicon renders
    // blank in some browsers.
    expect(decodeURIComponent(href)).not.toContain('foreignObject');
  });
});

describe('applyAppBadge (Dock / taskbar badge)', () => {
  const fakeNav = () => {
    const calls: string[] = [];
    return {
      calls,
      nav: {
        setAppBadge: (n?: number) => { calls.push(`set:${n}`); return Promise.resolve(); },
        clearAppBadge: () => { calls.push('clear'); return Promise.resolve(); },
      },
    };
  };

  it('shows the count as a number, and nothing else', () => {
    const { calls, nav } = fakeNav();
    applyAppBadge(3, nav);
    expect(calls).toEqual(['set:3']);
  });

  it('clears at zero and for counts that mean "no badge"', () => {
    const { calls, nav } = fakeNav();
    applyAppBadge(0, nav);
    applyAppBadge(-2, nav);
    applyAppBadge(Number.NaN, nav);
    expect(calls).toEqual(['clear', 'clear', 'clear']);
  });

  it('does nothing where the Badging API is missing', () => {
    expect(() => applyAppBadge(2, {})).not.toThrow();
    expect(() => applyAppBadge(2, undefined)).not.toThrow();
  });

  it('swallows a rejected call (Safari without notification permission)', async () => {
    const nav = { setAppBadge: () => Promise.reject(new Error('NotAllowedError')) };
    expect(() => applyAppBadge(1, nav)).not.toThrow();
    await Promise.resolve();
  });
});
