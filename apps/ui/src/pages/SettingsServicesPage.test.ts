import { describe, it, expect } from 'vitest';
import { SETTINGS_SECTIONS } from './SettingsServicesPage';

// The page's JSX renders each <h2> from this array by index (see
// SettingsServicesPage.tsx), so asserting the array's order is asserting
// what actually ships, not a parallel copy that can drift.
describe('SettingsServicesPage section order', () => {
  it('orders sections AI Assistant → Authority Server → This computer → Security → Version', () => {
    expect(SETTINGS_SECTIONS).toEqual(['AI Assistant', 'Authority Server', 'This computer', 'Security', 'Version']);
  });
});
