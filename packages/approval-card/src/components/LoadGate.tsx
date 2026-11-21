import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { decideParts, soloView, GRACE_MS, type PartState, type PartView } from '../lib/load-gate';

/**
 * DEC-98, one implementation for the gateway page and the phone app: the skeleton primitives (grey blocks with the
 * soft shimmer of `.skeleton` in design-system.css, still under reduced motion) and the page gate. A page names the
 * parts it needs up front (`<LoadGate parts={[...]}>`); each part reports its state with `useGatePart` and renders its
 * own skeleton — same size as its real content — while the gate says so. The gate keeps every part a skeleton until all
 * are in, then shows them in one go; after the grace time the parts that are in show and only a missing one stays grey.
 * A part that once showed its content never turns back into a skeleton when it reloads (a refresh is not a first load).
 */

interface GateCtx {
  report: (name: string, state: PartState) => void;
  view: (name: string, state: PartState) => PartView;
}

const Ctx = createContext<GateCtx | null>(null);

export function LoadGate({ parts, children, graceMs = GRACE_MS }: { parts: readonly string[]; children: ReactNode; graceMs?: number }) {
  const started = useRef(Date.now());
  const [states, setStates] = useState<Record<string, PartState>>(() => Object.fromEntries(parts.map(p => [p, 'loading' as PartState])));
  const shown = useRef<Set<string>>(new Set());
  const [, tick] = useState(0);

  useEffect(() => {
    const left = graceMs - (Date.now() - started.current);
    if (left <= 0) return;
    const t = setTimeout(() => tick(n => n + 1), left);
    return () => clearTimeout(t);
  }, [graceMs]);

  const report = useCallback((name: string, state: PartState) => {
    setStates(prev => (prev[name] === state ? prev : { ...prev, [name]: state }));
  }, []);

  // Recomputed on every render (a report, or the grace timer): a part's own state as of this render wins over what it
  // last reported, so a part never waits one extra render for its own news.
  const view = (name: string, state: PartState): PartView => {
    if (shown.current.has(name)) return state === 'error' ? 'error' : 'content';
    const v = decideParts({ ...states, [name]: state }, Date.now() - started.current, graceMs)[name] ?? soloView(state);
    if (v === 'content') shown.current.add(name);
    return v;
  };

  const value = { report, view };
  const busy = Object.values(states).some(s => s === 'loading');
  return <Ctx.Provider value={value}><div aria-busy={busy || undefined} className="load-gate">{children}</div></Ctx.Provider>;
}

/** A part of a gated page: its view now. Outside a gate, its own state at once. */
export function useGatePart(name: string, state: PartState): PartView {
  const g = useContext(Ctx);
  useEffect(() => { g?.report(name, state); }, [g, name, state]);
  return g ? g.view(name, state) : soloView(state);
}

/**
 * A gated part that keeps its real content MOUNTED while its skeleton shows: the content starts its own loads at once
 * and is simply not displayed until the gate says so — so it appears complete, not piece by piece. `ready` is the
 * page's own "my data is in"; `error` (optional) shows the content too (it carries its own error text).
 */
export function Gated({ part, ready, error, skeleton, children }: { part: string; ready: boolean; error?: boolean; skeleton: ReactNode; children: ReactNode }) {
  const view = useGatePart(part, error ? 'error' : ready ? 'ready' : 'loading');
  const show = view !== 'skeleton';
  return (
    <>
      {!show && skeleton}
      <div style={{ display: show ? 'contents' : 'none' }} data-gated={part}>{children}</div>
    </>
  );
}

/* ── "The page's own loads are done" without touching every card ───────────
   Some pages are built from self-loading cards (Settings, Connectors, Devices). Instead of wiring each card into the
   gate, the page mounts them hidden and waits until the browser has no request of this page in flight: every `fetch`
   the page makes is counted here (event streams are not fetch, so they never hold it). Quiet for QUIET_MS after the
   page mounted means its cards have their data; the grace time of the gate caps the wait. */

let inFlight = 0;
const listeners = new Set<() => void>();
let patched = false;

function patchFetch(): void {
  if (patched || typeof globalThis.fetch !== 'function') return;
  patched = true;
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    inFlight += 1; listeners.forEach(l => l());
    try { return await orig(...args); } finally { inFlight -= 1; listeners.forEach(l => l()); }
  }) as typeof fetch;
}

/** In-flight request count (tests). */
export function requestsInFlight(): number { return inFlight; }

const QUIET_MS = 120;

/**
 * True once no request has been in flight for QUIET_MS since the calling component mounted (its children's loads,
 * started in their own effects before this one runs, are included). Latches: later polling never resets it.
 */
export function useNetworkSettled(maxWaitMs: number = GRACE_MS): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    patchFetch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = () => { if (!done) { done = true; setSettled(true); } };
    const check = () => {
      if (done) return;
      if (timer) clearTimeout(timer);
      if (inFlight === 0) timer = setTimeout(() => { if (inFlight === 0) finish(); }, QUIET_MS);
    };
    // A request that never ends (a long poll, a hung server) must not keep the page grey: at the grace time the page
    // shows what it has, like any gate.
    const cap = setTimeout(finish, maxWaitMs);
    listeners.add(check);
    check();
    return () => { listeners.delete(check); if (timer) clearTimeout(timer); clearTimeout(cap); };
  }, [maxWaitMs]);
  return settled;
}

/** Patch at import time, so requests started during the first render's effects are counted too. */
patchFetch();

/* ── The primitives ─────────────────────────────────────────────────────── */

/** One grey bar the height of a line of text. `w` is its width (a CSS length or percentage). */
export function SkelLine({ w = '100%', h = '0.85rem', style }: { w?: string; h?: string; style?: CSSProperties }) {
  return <span className="skeleton skel-line" style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

/** A grey block of a given size (an icon, a code, a field). */
export function SkelBlock({ w = '100%', h, radius, style }: { w?: string; h: string; radius?: string; style?: CSSProperties }) {
  return <span className="skeleton skel-block" style={{ width: w, height: h, ...(radius ? { borderRadius: radius } : {}), ...style }} aria-hidden="true" />;
}

/** A grey button, as tall as a real `.btn` (or `.btn-lg` with `large`). */
export function SkelButton({ full, large, w = '7.5rem' }: { full?: boolean; large?: boolean; w?: string }) {
  return <span className={`skeleton skel-button${large ? ' skel-button-lg' : ''}`} style={{ width: full ? '100%' : w }} aria-hidden="true" />;
}

/** A grey title bar the height of an `h1`/`h2`. */
export function SkelTitle({ w = '45%', level = 1 }: { w?: string; level?: 1 | 2 | 3 }) {
  return <span className={`skeleton skel-title skel-title-${level}`} style={{ width: w }} aria-hidden="true" />;
}

/** A `.card` with skeleton content: a title, lines of text and a button, sized like the real card it stands for. */
export function SkelCard({ lines = 1, button = true, title = true, minHeight, className }: { lines?: number; button?: boolean; title?: boolean; minHeight?: string; className?: string }) {
  return (
    <div className={`card skel-card${className ? ` ${className}` : ''}`} style={minHeight ? { minHeight } : undefined} role="status" aria-busy="true" aria-label="Loading">
      {title && <SkelLine w="40%" h="1.05rem" style={{ marginBottom: '0.75rem' }} />}
      {Array.from({ length: lines }, (_, i) => <SkelLine key={i} w={i === lines - 1 ? '70%' : '95%'} style={{ marginBottom: '0.6rem' }} />)}
      {button && <SkelButton />}
    </div>
  );
}

/** A plain container that marks its skeleton content busy for assistive technology. */
export function SkelArea({ children, label = 'Loading' }: { children: ReactNode; label?: string }) {
  return <div role="status" aria-busy="true" aria-label={label} className="skel-area">{children}</div>;
}
