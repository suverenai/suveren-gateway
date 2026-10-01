import { describe, it, expect, beforeAll } from 'vitest';

// MobileMenu.tsx transitively imports useTheme.ts, which touches
// `localStorage` at module-load time (one-off legacy-key migration) — a
// no-op in this project's plain-node vitest environment (no jsdom here; see
// other *.test.ts files, all pure-logic, no DOM). Stub it before a dynamic
// import so loading the module for its NAV_ITEMS data doesn't throw.
beforeAll(() => {
  // Node's experimental --localstorage-file global (if active, per the
  // harness warning) exposes a `localStorage` that isn't actually
  // functional here — check for a working getItem, not just presence.
  if (typeof (globalThis as any).localStorage?.getItem !== 'function') {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
  }
});

// Mirrors Sidebar.test.ts: the mobile nav must stay in sync with the desktop
// sidebar's rename of the /settings entry.
describe('MobileMenu NAV_ITEMS — settings entry', () => {
  it('labels the /settings entry "Settings"', async () => {
    const { NAV_ITEMS } = await import('./MobileMenu');
    const settings = NAV_ITEMS.find(i => i.to === '/settings');
    expect(settings).toBeDefined();
    expect(settings?.label).toBe('Settings');
  });
});
