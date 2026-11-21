/**
 * The page-level loading gate (DEC-98): a page shows its own skeleton layout until every part it needs has its data,
 * then the real content in one go — never part by part. Only if a part is still missing after the grace time do the
 * parts that have their data appear, while the missing one stays a skeleton. A part that failed shows its error,
 * never an endless skeleton.
 *
 * Pure: the view of each part from the parts' states and the time since the page started waiting.
 */

export type PartState = 'loading' | 'ready' | 'error';
export type PartView = 'skeleton' | 'content' | 'error';

/** How long a page waits for all its parts before it shows those that are in (DEC-98: about 1.5 seconds). */
export const GRACE_MS = 1500;

export function decideParts(
  parts: Readonly<Record<string, PartState>>,
  elapsedMs: number,
  graceMs: number = GRACE_MS,
): Record<string, PartView> {
  const names = Object.keys(parts);
  const settled = names.every(n => parts[n] !== 'loading');
  const out: Record<string, PartView> = {};
  for (const n of names) {
    const s = parts[n];
    if (settled || elapsedMs >= graceMs) out[n] = s === 'loading' ? 'skeleton' : s === 'ready' ? 'content' : 'error';
    else out[n] = 'skeleton';
  }
  return out;
}

/** A part's view when no gate surrounds it: its own state, at once (the behaviour of a part outside a gated page). */
export function soloView(state: PartState): PartView {
  return state === 'loading' ? 'skeleton' : state === 'ready' ? 'content' : 'error';
}

/** Whether a gate still waits for anything (for a test or an `aria-busy` on the page). */
export function gateBusy(parts: Readonly<Record<string, PartState>>): boolean {
  return Object.values(parts).some(s => s === 'loading');
}
