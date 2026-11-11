import { describe, it, expect } from 'vitest';
import { modeView, mandatePreviewParts, mandateTechnicalLine, mandateTitleText, mandateTitleParts, mandateTargetProfile, MANDATE_TILE_OMIT, omitLimitLabels } from './mandate-proposal';

describe('mandate proposal card parts', () => {
  it('words the mode', () => {
    expect(modeView('review')).toEqual({ label: 'Commitment', title: 'Review Each Action', text: 'You review and approve each action before it executes.' });
    expect(modeView('automatic')).toEqual({ label: 'Commitment', title: 'Automatic', text: 'Agent acts freely within your limits.' });
    expect(modeView('')).toBeNull();
    expect(modeView(undefined)).toBeNull();
    expect(modeView('review_above_cap')?.title).toBe('Review above the limit');
    expect(JSON.stringify(modeView('review_above_cap'))).not.toMatch(/above.cap/i);
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

describe('omitLimitLabels — a mandate proposal without the limits not shown outside simulation', () => {
  it('drops exactly the named limits from the preview; the rest of the preview is untouched', () => {
    const resp = { status: 'ok', tool: 'describe', body: { structured: { proposal: 'X', limits: { 'Daily write limit': '20', 'Test-data loads per day': '0' } } } };
    const out = omitLimitLabels(resp, new Set(['Test-data loads per day']));
    expect(out.body.structured.limits).toEqual({ 'Daily write limit': '20' });
    expect(out.body.structured.proposal).toBe('X');
    expect(resp.body.structured.limits).toHaveProperty('Test-data loads per day'); // a copy, never mutated
  });
  it('nothing to hide, or no limits: the same object', () => {
    const resp = { status: 'ok', body: { structured: { proposal: 'X' } } };
    expect(omitLimitLabels(resp, new Set(['A']))).toBe(resp);
    expect(omitLimitLabels(resp, new Set())).toBe(resp);
  });
});
