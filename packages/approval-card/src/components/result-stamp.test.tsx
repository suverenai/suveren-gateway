import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ResultStamp } from './ResultStamp';
import { LoadGate } from './LoadGate';

describe('ResultStamp: the one result stamp', () => {
  it('covers the card (av3-given), the stamp is not in the flow, and Close is pinned below it', () => {
    const h = renderToStaticMarkup(createElement(ResultStamp, { word: 'Signed', line: 'Recorded', testId: 't', stampTestId: 's', close: { label: 'Close', onClose: () => {}, testId: 'c' } }));
    expect(h).toMatch(/^<div class="av3-given" data-testid="t"><div class="av3-stamp" role="status" data-testid="s">/);
    expect(h).not.toContain('position:static');
    expect(h).toContain('<footer class="av3-foot">');
    expect(h.match(/<button/g)?.length).toBe(1);
  });
  it('without close: no footer', () => {
    const h = renderToStaticMarkup(createElement(ResultStamp, { word: 'Signed', line: 'Recorded' }));
    expect(h).not.toContain('av3-foot');
  });
});

describe('LoadGate: data-gate, the stable signal for tests', () => {
  it('says "loading" while a part waits', () => {
    const h = renderToStaticMarkup(<LoadGate parts={['a']}>x</LoadGate>);
    expect(h).toContain('data-gate="loading"');
  });
  it('says "open" when there is no part to wait for', () => {
    const h = renderToStaticMarkup(<LoadGate parts={[]}>x</LoadGate>);
    expect(h).toContain('data-gate="open"');
  });
});
