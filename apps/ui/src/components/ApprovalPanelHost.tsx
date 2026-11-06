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
  const [settling, setSettling] = useState<{ entry: QueueEntry; before: string[] } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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
    document.body.classList.add('apr-anim');
    const done = window.setTimeout(() => document.body.classList.remove('apr-anim'), SLIDE_MS + 80);
    document.body.classList.toggle('apr-rail', chrome.panel);
    document.body.classList.toggle('apr-strip', chrome.strip);
    document.body.classList.toggle('apr-bar', chrome.bar);
    return () => { window.clearTimeout(done); };
  }, [chrome.panel, chrome.strip, chrome.bar]);
  useEffect(() => () => { document.body.classList.remove('apr-rail', 'apr-strip', 'apr-bar', 'apr-anim'); }, []);

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
  const goLater = useCallback(() => { setMenuOpen(false); setPanel((p) => ({ ...p, open: false })); }, []);
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

  const handleDecided = useCallback((id: string, _kind: DecisionKind, _result: DecisionResult) => {
    const before = idsRef.current;
    const entry = q.entries.find((e) => e.id === id);
    if (!entry) return;
    q.markDecided(id);
    setSettling({ entry, before });
    void q.refresh();
    announceApprovalDecided();
    later(() => {
      const { next } = afterDecision(before, id);
      if (next) {
        setCurrentId(next);
        setSettling(null);
      } else {
        // Nothing left: slide out completely, keep the result on screen until it is gone.
        setPanel((p) => ({ ...p, open: false }));
        later(() => setSettling(null), reducedMotion ? 0 : SLIDE_MS + 80);
      }
    }, RESULT_SHOW_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.entries, q.markDecided, q.refresh, later, reducedMotion]);

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
            <header className="apr-head">
              <h2 className="apr-title" tabIndex={-1} data-apr-focus>
                Waiting for you{many && pos ? <span className="apr-m"> · {pos.index} of {total}</span> : null}
              </h2>
              <span className="apr-sp" />
              {many && (
                <>
                  <button type="button" className="apr-btn" aria-label="Previous approval" disabled={!prevId} onClick={() => prevId && setCurrentId(prevId)} data-testid="approval-prev">
                    <Chevron dir="left" /><span className="apr-txt">Previous</span>
                  </button>
                  <button type="button" className="apr-btn" aria-label="Next approval" disabled={!nextId} onClick={() => nextId && setCurrentId(nextId)} data-testid="approval-next">
                    <span className="apr-txt">Next</span><Chevron dir="right" />
                  </button>
                </>
              )}
              <button type="button" className="apr-btn" onClick={goLater} data-testid="approval-later">Later</button>
              {q.autoOpen === true && (
                <button type="button" className="apr-btn" onClick={noAuto} data-testid="approval-no-auto">Don’t open automatically</button>
              )}
            </header>
            <div className="apr-body">
              {shown && (
                <div className="apr-stage" key={shown.id} data-proposal-id={shown.id}>
                  <QueueCard entry={shown} onDecided={handleDecided} onBusyChange={setBusy} />
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
