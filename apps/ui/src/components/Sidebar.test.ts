import { describe, it, expect } from 'vitest';
import { NAV_ITEMS } from './Sidebar';

// The gateway's configuration entry covers more than the AI assistant now
// (Authority Server, security, version) — it must read "Settings", not
// "AI Assistant", while keeping the same route and the same badge behaviour
// (dot when the assistant isn't configured — see useOtherNavStatus).
describe('Sidebar NAV_ITEMS — settings entry', () => {
  it('labels the /settings entry "Settings"', () => {
    const settings = NAV_ITEMS.find(i => i.to === '/settings');
    expect(settings).toBeDefined();
    expect(settings?.label).toBe('Settings');
  });

  it('keeps the gear icon and the assistant status badge on that entry', () => {
    const settings = NAV_ITEMS.find(i => i.to === '/settings');
    expect(settings?.icon).toBe('⚙');
    expect(settings?.statusKey).toBe('assistant');
  });
});
