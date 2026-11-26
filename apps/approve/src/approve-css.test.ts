import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('./approve.css', import.meta.url)), 'utf8');
const tokens = readFileSync(fileURLToPath(new URL('../../ui/src/styles/tokens.css', import.meta.url)), 'utf8');
const design = readFileSync(fileURLToPath(new URL('../../ui/src/styles/design-system.css', import.meta.url)), 'utf8');

describe('the phone app\'s own CSS uses tokens only (the gateway page\'s rule, ui-tokens.test.ts)', () => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('has no literal colour', () => {
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  it('every var(--x) it uses is defined in tokens.css or design-system.css', () => {
    for (const m of code.matchAll(/var\((--[a-z0-9-]+)/g)) {
      const name = m[1];
      expect(tokens.includes(`${name}:`) || design.includes(`${name}:`), name).toBe(true);
    }
  });

  it('keeps only what is phone-specific: full height with safe areas, the scan frame, the background blank, the panel without rail and nav', () => {
    expect([...code.matchAll(/^\.([a-z-]+)/gm)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i)).toEqual(['ap-shell', 'ap-top', 'ap-scan', 'ap-scan-frame', 'ap-scan-line', 'ap-panel']);
    expect(code).toMatch(/safe-area-inset-top/);
    expect(code).toMatch(/max-width: 40rem/);
  });

  it('the QR is the shared one (the gateway\'s design system) and stays dark on light in both themes: it fixes its own colour scheme', () => {
    expect(design).toMatch(/\.device-qr \{[^}]*color-scheme: light; background: Canvas/);
    expect(design).toMatch(/\.device-qr rect \{ fill: CanvasText; \}/);
  });

  it('hides the content when the app goes to the background', () => {
    expect(code).toMatch(/body\.ap-blank #root \{ visibility: hidden; \}/);
  });
});

describe('the result stamp (maintainer 2026-11-22)', () => {
  it('its small line uses the body font, not the mono font', () => {
    const rule = /\.av3-stamp-t\s*\{([^}]*)\}/.exec(design)?.[1] ?? '';
    expect(rule).not.toBe('');
    expect(rule).not.toMatch(/font-family/);
  });
});
