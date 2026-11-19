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

  it('draws for both widths: a narrow phone is the default and a wider screen adds one rule', () => {
    expect(code).toMatch(/@media \(min-width: 40rem\)/);
    expect(code).toMatch(/max-width: 40rem/);
  });

  it('hides the content when the app goes to the background', () => {
    expect(code).toMatch(/body\.ap-blank #root \{ visibility: hidden; \}/);
  });
});
