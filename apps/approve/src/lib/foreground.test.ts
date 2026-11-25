import { describe, it, expect } from 'vitest';
import { onForeground } from './foreground';

function targets() {
  const doc = Object.assign(new EventTarget(), { hidden: true });
  const win = new EventTarget();
  const show = (persisted: boolean) => win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
  const vis = (hidden: boolean) => { doc.hidden = hidden; doc.dispatchEvent(new Event('visibilitychange')); };
  return { doc, win, show, vis };
}

describe('the app comes to the front: the list is read at once (not at the 30 s refresh)', () => {
  it('fires when the app becomes visible, not when it goes to the background', () => {
    const t = targets();
    let n = 0;
    onForeground(t, () => { n++; });
    t.vis(true);
    expect(n).toBe(0);
    t.vis(false);
    expect(n).toBe(1);
  });

  it('fires when a page is restored from the back-forward cache, not on a first load', () => {
    const t = targets();
    let n = 0;
    onForeground(t, () => { n++; });
    t.show(false);
    expect(n).toBe(0);
    t.show(true);
    expect(n).toBe(1);
  });

  it('stops listening when asked', () => {
    const t = targets();
    let n = 0;
    const stop = onForeground(t, () => { n++; });
    stop();
    t.vis(false);
    t.show(true);
    expect(n).toBe(0);
  });
});
