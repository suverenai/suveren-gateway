/**
 * The app came to the front: from the background, from the app switcher, or opened again from the home screen (a page restored
 * from the back-forward cache fires `pageshow` with `persisted`, not `visibilitychange`). The caller reads its list at once,
 * not at the next 30-second refresh (Andreas, 2026-11-24).
 */
export interface FrontTargets {
  doc: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { hidden: boolean };
  win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

/** Calls `cb` each time the app comes to the front. Returns the function that stops listening. */
export function onForeground(t: FrontTargets, cb: () => void): () => void {
  const onVis = () => { if (!t.doc.hidden) cb(); };
  const onShow = (e: Event) => { if ((e as Event & { persisted?: boolean }).persisted) cb(); };
  t.doc.addEventListener('visibilitychange', onVis);
  t.win.addEventListener('pageshow', onShow);
  return () => { t.doc.removeEventListener('visibilitychange', onVis); t.win.removeEventListener('pageshow', onShow); };
}
