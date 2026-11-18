import { describe, it, expect, afterEach } from 'vitest';
import { isAutomatedBrowser } from './automation';

describe('isAutomatedBrowser', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  afterEach(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); });
  const withWebdriver = (v: unknown) => Object.defineProperty(globalThis, 'navigator', { value: { webdriver: v }, configurable: true });

  it('true only when the browser says it is automated', () => {
    withWebdriver(true); expect(isAutomatedBrowser()).toBe(true);
    withWebdriver(false); expect(isAutomatedBrowser()).toBe(false);
    withWebdriver(undefined); expect(isAutomatedBrowser()).toBe(false);
  });
});
