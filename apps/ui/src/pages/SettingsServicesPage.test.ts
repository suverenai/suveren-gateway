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

// TO BE INVESTIGATED (2026-10-24): the AI assistant is hidden while it is rethought.
// Flipping lib/ai-assistant.ts back on is a product decision — this test makes it a visible one.
import { AI_ASSISTANT_VISIBLE } from '../lib/ai-assistant';
describe('AI assistant visibility', () => {
  it('is hidden for now', () => {
    expect(AI_ASSISTANT_VISIBLE).toBe(false);
  });
});
