import { describe, expect, it } from 'vitest';
import { decideParts, gateBusy, soloView, GRACE_MS } from './load-gate';

describe('the page loading gate (DEC-98)', () => {
  it('all parts in: every part shows its content at once, whatever the time', () => {
    expect(decideParts({ a: 'ready', b: 'ready' }, 0)).toEqual({ a: 'content', b: 'content' });
  });

  it('before the grace time, a part that is already in still shows its skeleton while another loads (no pop-in)', () => {
    expect(decideParts({ a: 'ready', b: 'loading' }, GRACE_MS - 1)).toEqual({ a: 'skeleton', b: 'skeleton' });
  });

  it('after the grace time, the parts that are in show and only the missing one stays a skeleton', () => {
    expect(decideParts({ a: 'ready', b: 'loading' }, GRACE_MS)).toEqual({ a: 'content', b: 'skeleton' });
  });

  it('an error is shown as an error, never an endless skeleton (once the page is settled or the grace time is over)', () => {
    expect(decideParts({ a: 'ready', b: 'error' }, 0)).toEqual({ a: 'content', b: 'error' });
    expect(decideParts({ a: 'loading', b: 'error' }, GRACE_MS)).toEqual({ a: 'skeleton', b: 'error' });
  });

  it('a part outside any gate shows its own state at once', () => {
    expect(soloView('loading')).toBe('skeleton');
    expect(soloView('ready')).toBe('content');
    expect(soloView('error')).toBe('error');
  });

  it('busy while any part loads', () => {
    expect(gateBusy({ a: 'ready', b: 'loading' })).toBe(true);
    expect(gateBusy({ a: 'ready', b: 'error' })).toBe(false);
  });
});
