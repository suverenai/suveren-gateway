import { describe, it, expect } from 'vitest';
import { modeView, mandatePreviewParts, mandateTechnicalLine, mandateTitleText, mandateTitleParts, mandateTargetProfile, MANDATE_TILE_OMIT } from './mandate-proposal';

describe('mandate proposal card parts', () => {
  it('words the mode', () => {
    expect(modeView('review')).toEqual({ label: 'Commitment', title: 'Review Each Action', text: 'You review and approve each action before it executes.' });
    expect(modeView('automatic')).toEqual({ label: 'Commitment', title: 'Automatic', text: 'Agent acts freely within your limits.' });
    expect(modeView('')).toBeNull();
    expect(modeView(undefined)).toBeNull();
    expect(modeView('review_above_cap')?.title).toBe('review_above_cap');
  });
  it('pulls the parts out of the preview and builds the technical line', () => {
    const p = mandatePreviewParts({ intent: ' Quotes. ', mode: 'review', proposal: 'New mandate · Sales', profile_version: 'sales 0.4', workspace: 'Weninger Translations', checks: ['Sales is allowed by your Delegation mandate', 3] });
    expect(p.intent).toBe('Quotes.');
    expect(p.checks).toEqual(['Sales is allowed by your Delegation mandate']);
    expect(mandateTechnicalLine(p)).toBe('New mandate · Sales · sales 0.4');
    expect(p.workspace).toBe('Weninger Translations');
    expect(mandateTechnicalLine(mandatePreviewParts(undefined))).toBe('new mandate');
  });
  it('title from the area; the tile keeps limits, scope, valid; title after Applies to', () => {
    expect(mandateTitleText('Sales', { title: ' Quotes to customers ' })).toBe('Sales · Quotes to customers');
    expect(mandateTitleText('Sales', {})).toBe('Sales · new mandate');
    expect(mandateTitleParts('Sales', { title: 5 }).name).toBeNull();
    expect(mandateTargetProfile({ profile: 'sales@0.4' }, 'delegation@0.1')).toBe('sales@0.4');
    expect(mandateTargetProfile(null, 'delegation@0.1')).toBe('delegation@0.1');
    for (const keep of ['limits', 'scope', 'valid']) expect(MANDATE_TILE_OMIT as readonly string[]).not.toContain(keep);
    // Title is shown after "Applies to", from the preview parts.
    expect(MANDATE_TILE_OMIT as readonly string[]).toContain('title');
    expect(mandatePreviewParts({ title: ' Quotes ' }).title).toBe('Quotes');
  });
});
