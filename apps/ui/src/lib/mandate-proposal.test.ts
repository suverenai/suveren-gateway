import { describe, it, expect } from 'vitest';
import { modeView, mandatePreviewParts, mandateTechnicalLine, mandateTitle, MANDATE_TILE_OMIT } from './mandate-proposal';

describe('mandate proposal card parts', () => {
  it('words the mode', () => {
    expect(modeView('review')?.title).toBe('Asks you each time');
    expect(modeView('automatic')?.title).toBe('Runs automatically within these limits');
    expect(modeView('')).toBeNull();
    expect(modeView(undefined)).toBeNull();
    expect(modeView('review_above_cap')?.title).toBe('review_above_cap');
  });
  it('pulls the parts out of the preview and builds the technical line', () => {
    const p = mandatePreviewParts({ intent: ' Quotes. ', mode: 'review', profile_version: 'sales 0.4', workspace: 'Weninger Translations', checks: ['Sales is allowed by your Delegation mandate', 3] });
    expect(p.intent).toBe('Quotes.');
    expect(p.checks).toEqual(['Sales is allowed by your Delegation mandate']);
    expect(mandateTechnicalLine(p)).toBe('sales 0.4 · Weninger Translations · new mandate');
    expect(mandateTechnicalLine(mandatePreviewParts(undefined))).toBe('new mandate');
  });
  it('title from the area; the tile keeps limits, scope, valid, title', () => {
    expect(mandateTitle('Sales')).toBe('New mandate · Sales');
    for (const keep of ['limits', 'scope', 'valid', 'title']) expect(MANDATE_TILE_OMIT as readonly string[]).not.toContain(keep);
  });
});
