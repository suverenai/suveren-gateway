/**
 * The approval panel that opens by itself.
 *
 * When an approval FOR THIS PERSON is waiting ("For me"), a panel slides in from
 * the right and covers the page except the icon rail. It holds the real approval
 * card — only what is bound plus the gateway's own local data, never text the AI
 * wrote for the approver. "Later" sends it to a narrow strip at the right edge;
 * "Don't open automatically" turns the sliding in off (a gateway setting).
 *
 * The rules (what opens, when, what is on screen) are pure and tested in
 * lib/approval-panel.ts; this component renders them. Everything shown is read
 * from the gateway: the queue and the setting come from ApprovalQueueContext.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useApprovalQueue } from '../contexts/ApprovalQueueContext';
import { useFormInProgress } from '../hooks/useFormInProgress';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { QueueCard } from './QueueCard';
import { announceApprovalDecided, type DecisionKind, type DecisionResult } from '../lib/approval-flow';
import type { QueueEntry } from '../lib/approval-queue';
import { resultDismissLabel, type ApprovalOutcome } from '../lib/approval-outcome';
import {
  INITIAL_PANEL, RESULT_SHOW_MS, SLIDE_MS, afterDecision, neighbour, panelChrome, positionOf,
  reconcilePanel, resolveCurrent, stripAutoLabel, type PanelState,
} from '../lib/approval-panel';

const Chevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg className="apr-i" viewBox="0 0 16 16" aria-hidden="true"><path d={dir === 'left' ? 'M10 3 5 8l5 5' : 'm6 3 5 5-5 5'} /></svg>
);

export function ApprovalPanelHost() {
  const q = useApprovalQueue();
  const { pathname } = useLocation();
  const onApprovalsPage = pathname === '/approvals';
  const typing = useFormInProgress(pathname);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const [panel, setPanel] = useState<PanelState>(INITIAL_PANEL);
  const [currentId, setCurrentId] = useState<string | null>(null);
  // A decision the gateway answered: its card stays (with its result) until the next one opens.
  // `stay`: a refused or unconfirmed approval. The card waits for the person, it never times away.
  const [settling, setSettling] = useState<{ entry: QueueEntry; before: string[]; stay: boolean } | null>(null);
  const settlingRef = useRef<{ id: string; before: string[] } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [headMenu, setHeadMenu] = useState(false);
  const compact = useMediaQuery('(max-width: 1099px)');
  // The slide-out takes SLIDE_MS; the content stays mounted until it is gone.
  const [mounted, setMounted] = useState(false);

  const idsRef = useRef<string[]>(q.ids);
  idsRef.current = q.ids;
  const timers = useRef<number[]>([]);
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);
  const later = useCallback((fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); }, []);

  // ── What opens, when (pure rules) ──
  const hold = settling !== null;
  const idsKey = q.ids.join('\u0001');
  useEffect(() => {
    setPanel((prev) => reconcilePanel(prev, {
      ids: idsRef.current,
      loaded: q.loaded && q.settingRead,
      autoOpen: q.autoOpen,
      typing,
      onApprovalsPage,
      hold,
    }));
  }, [idsKey, q.loaded, q.settingRead, q.autoOpen, typing, onApprovalsPage, hold]);

  // The person clicked an approval (a row on the Approvals page, or a dashboard row): the panel opens on it.
  const reqSeq = q.openRequest?.seq ?? 0;
  useEffect(() => {
    if (!q.openRequest) return;
    setCurrentId(q.openRequest.id);
    setPanel((p) => ({ ...p, open: true, owed: false }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqSeq]);

  // Going somewhere else through the icon rail sends the panel away (the approval stays in the strip).
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current !== pathname) {
      lastPath.current = pathname;
      setPanel((p) => (p.open ? { ...p, open: false } : p));
    }
  }, [pathname]);

  const chrome = panelChrome({ count: q.ids.length, open: panel.open, typing, onApprovalsPage, hold });
  const showId = resolveCurrent(q.ids, currentId);
  const shown: QueueEntry | null = settling?.entry ?? q.entries.find((e) => e.id === showId) ?? null;

  // Keep the content while sliding out.
  useEffect(() => {
    if (chrome.panel) { setMounted(true); return; }
    const t = window.setTimeout(() => setMounted(false), SLIDE_MS + 60);
    return () => window.clearTimeout(t);
  }, [chrome.panel]);

  // The rail while the panel is open; the strip's room at the edge.
  useEffect(() => {
    // Animate the sidebar's collapse/expand together with the slide (not for hover, which is quicker).
    document.body.classList.add('apr-has-anim');
    const done = window.setTimeout(() => document.body.classList.remove('apr-has-anim'), SLIDE_MS + 80);
    document.body.classList.toggle('apr-has-rail', chrome.panel);
    document.body.classList.toggle('apr-has-strip', chrome.strip);
    document.body.classList.toggle('apr-has-bar', chrome.bar);
    return () => { window.clearTimeout(done); };
  }, [chrome.panel, chrome.strip, chrome.bar]);
  useEffect(() => () => { document.body.classList.remove('apr-has-rail', 'apr-has-strip', 'apr-has-bar', 'apr-has-anim'); }, []);

  // ── Focus: into the panel when it opens (never when the person is typing — it does not open then), back when it goes ──
  const panelRef = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (chrome.panel && !wasOpen.current) {
      const active = document.activeElement as HTMLElement | null;
      returnFocus.current = active && active !== document.body && !active.closest('[data-apr-ui]') ? active : null;
      const t = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>('[data-apr-focus]')?.focus({ preventScroll: true }), 30);
      wasOpen.current = true;
      return () => window.clearTimeout(t);
    }
    if (!chrome.panel && wasOpen.current) {
      wasOpen.current = false;
      const back = returnFocus.current;
      returnFocus.current = null;
      if (back && back.isConnected && panelRef.current?.contains(document.activeElement)) back.focus({ preventScroll: true });
    }
    return undefined;
  }, [chrome.panel]);

  // ── Actions ──
  const goLater = useCallback(() => {
    setMenuOpen(false); setHeadMenu(false);
    setPanel((p) => ({ ...p, open: false }));
    // A result the person sent away is done with: it must not reappear when the next approval opens the panel.
    if (settlingRef.current) { settlingRef.current = null; setSettling(null); }
  }, []);
  const openPanel = useCallback(() => { setMenuOpen(false); setPanel((p) => ({ ...p, open: true, owed: false })); }, []);

  // Esc = Later.
  useEffect(() => {
    if (!chrome.panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      goLater();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chrome.panel, goLater]);

  // The card's result has been on screen long enough, or the person pressed Next / Close: move on.
  const finishSettling = useCallback((id: string) => {
    const s = settlingRef.current;
    if (!s || s.id !== id) return;
    settlingRef.current = null;
    const { next } = afterDecision(s.before, id);
    if (next) {
      setCurrentId(next);
      setSettling(null);
    } else {
      // Nothing left: slide out completely, keep the result on screen until it is gone.
      setPanel((p) => ({ ...p, open: false }));
      later(() => setSettling(null), reducedMotion ? 0 : SLIDE_MS + 80);
    }
  }, [later, reducedMotion]);

  const handleDecided = useCallback((id: string, _kind: DecisionKind, _result: DecisionResult) => {
    const before = idsRef.current;
    const entry = q.entries.find((e) => e.id === id);
    if (!entry) return;
    q.markDecided(id);
    settlingRef.current = { id, before };
    setSettling({ entry, before, stay: false });
    void q.refresh();
    announceApprovalDecided();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.entries, q.markDecided, q.refresh]);

  const handleOutcome = useCallback((id: string, outcome: ApprovalOutcome) => {
    if (settlingRef.current?.id !== id) return;
    if (outcome === 'done') {
      later(() => finishSettling(id), RESULT_SHOW_MS);
    } else if (outcome === 'refused' || outcome === 'unknown') {
      setSettling((s) => (s && s.entry.id === id ? { ...s, stay: true } : s));
    }
  }, [later, finishSettling]);

  const [busy, setBusy] = useState(false);
  const noAuto = useCallback(() => { goLater(); void q.setAutoOpen(false); }, [goLater, q]);

  const listForCount = settling ? settling.before : q.ids;
  const pos = positionOf(listForCount, settling ? settling.entry.id : showId);
  const total = listForCount.length;
  const many = total > 1;
  const prevId = settling || busy ? null : neighbour(q.ids, showId, -1);
  const nextId = settling || busy ? null : neighbour(q.ids, showId, 1);
  const count = q.ids.length;

  return (
    <>
      {/* "1 approval waiting — Open": while the person is in a form. Nothing slides over it. */}
      {chrome.bar && (
        <div className="apr-bar" role="status" data-apr-ui data-testid="approval-bar">
          <b>{count} {count === 1 ? 'approval' : 'approvals'} waiting</b>
          <span aria-hidden="true">&mdash;</span>
          <button type="button" onClick={openPanel} data-testid="approval-bar-open">Open</button>
        </div>
      )}

      {/* The panel: always in the page, moved by CSS only so the slide is never cut short. */}
      <aside
        ref={panelRef}
        className={`apr-panel${chrome.panel ? ' is-open' : ''}`}
        aria-label="Approval waiting for you"
        aria-hidden={!chrome.panel}
        data-apr-ui
        data-testid="approval-panel"
      >
        {(mounted || chrome.panel) && (
          <>
            {compact ? (
              /* Below 1100px: ONE compact row — title, ‹ k of N ›, then the menu and ✕ Later. */
              <header className="apr-head is-compact">
                <h2 className="apr-title" tabIndex={-1} data-apr-focus>Waiting for you</h2>
                {many ? (
                  <nav className="apr-nav" aria-label="Move between approvals">
                    <button type="button" className="av3-btn apr-ico" aria-label="Previous approval" disabled={!prevId} onClick={() => prevId && setCurrentId(prevId)} data-testid="approval-prev"><Chevron dir="left" /></button>
                    <span className="apr-pos" data-testid="approval-position" aria-live="polite">{pos ? `${pos.index} of ${total}` : ''}</span>
                    <button type="button" className="av3-btn av3-btn-primary apr-ico" aria-label="Next approval" disabled={!nextId} onClick={() => nextId && setCurrentId(nextId)} data-testid="approval-next"><Chevron dir="right" /></button>
                  </nav>
                ) : <span className="apr-nav-ph" />}
                <div className="apr-acts">
                  {q.autoOpen !== null && (
                    <span className="apr-menu-wrap">
                      <button type="button" className="apr-btn apr-ico-plain" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={headMenu} onClick={() => setHeadMenu((o) => !o)} data-testid="approval-head-menu">&#8942;</button>
                      {headMenu && (
                        <div className="apr-pop apr-head-pop" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            className={`av3-btn apr-auto${q.autoOpen ? '' : ' av3-btn-primary'}`}
                            onClick={() => { setHeadMenu(false); if (q.autoOpen) noAuto(); else void q.setAutoOpen(true); }}
                            data-testid="approval-auto-toggle"
                          >
                            {q.autoOpen ? 'Don’t open automatically' : 'Open automatically'}
                          </button>
                        </div>
                      )}
                    </span>
                  )}
                  <button type="button" className="apr-btn apr-ico-plain" aria-label="Later" title="Later" onClick={goLater} data-testid="approval-later">
                    <svg className="apr-i" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
                  </button>
                </div>
              </header>
            ) : (
              <header className="apr-head">
                <h2 className="apr-title" tabIndex={-1} data-apr-focus>Waiting for you</h2>
                {many ? (
                  <nav className="apr-nav" aria-label="Move between approvals">
                    <button type="button" className="av3-btn" disabled={!prevId} onClick={() => prevId && setCurrentId(prevId)} data-testid="approval-prev">
                      <Chevron dir="left" /> Previous
                    </button>
                    <span className="apr-pos" data-testid="approval-position" aria-live="polite">{pos ? `${pos.index} of ${total}` : ''}</span>
                    <button type="button" className="av3-btn av3-btn-primary" disabled={!nextId} onClick={() => nextId && setCurrentId(nextId)} data-testid="approval-next">
                      Next <Chevron dir="right" />
                    </button>
                  </nav>
                ) : <span className="apr-nav-ph" />}
                <div className="apr-acts">
                  <button type="button" className="apr-btn" onClick={goLater} data-testid="approval-later">Later</button>
                  {q.autoOpen !== null && (
                    <button
                      type="button"
                      className={`av3-btn apr-auto${q.autoOpen ? '' : ' av3-btn-primary'}`}
                      onClick={q.autoOpen ? noAuto : () => { void q.setAutoOpen(true); }}
                      data-testid="approval-auto-toggle"
                    >
                      {q.autoOpen ? 'Don’t open automatically' : 'Open automatically'}
                    </button>
                  )}
                </div>
              </header>
            )}
            <div className="apr-body">
              {shown && (
                <div className="apr-stage" key={shown.id} data-proposal-id={shown.id}>
                  <QueueCard
                    entry={shown}
                    onDecided={handleDecided}
                    onBusyChange={setBusy}
                    onOutcome={handleOutcome}
                    {...(settling?.stay && settling.entry.id === shown.id ? {
                      dismissLabel: resultDismissLabel(afterDecision(settling.before, shown.id).next !== null),
                      onDismissResult: () => finishSettling(shown.id),
                    } : {})}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </aside>

      {/* The strip: where the panel goes when sent away. It also shows when new approvals do not open by themselves. */}
      {chrome.strip && (
        <div className="apr-strip" data-apr-ui data-testid="approval-strip">
          <button type="button" className="apr-strip-open" aria-label={`Open approvals, ${count} waiting`} onClick={openPanel} data-testid="approval-strip-open">
            <span className="apr-n">{count}</span>
            <span className="apr-strip-l">Approvals</span>
          </button>
          <span className="apr-sp" />
          {stripAutoLabel(q.autoOpen) && <span className="apr-strip-auto" data-testid="approval-strip-auto">{stripAutoLabel(q.autoOpen)}</span>}
          <button type="button" className="apr-menu-b" aria-label="Approvals menu" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)} data-testid="approval-strip-menu">&#8942;</button>
          {menuOpen && (
            <div className="apr-pop" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); void q.setAutoOpen(q.autoOpen !== true); }}
                data-testid="approval-strip-toggle"
              >
                {q.autoOpen === true ? 'Don’t open automatically' : 'Open automatically again'}
              </button>
              {q.autoOpenError && <p className="apr-err" role="alert">{q.autoOpenError}</p>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
