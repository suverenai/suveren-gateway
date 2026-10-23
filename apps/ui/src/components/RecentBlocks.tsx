import { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { spClient, type DenialRecord, type DenialReason } from '../lib/sp-client';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useAreaCatalog } from '../lib/area-catalog';
import { resolveAreaName } from '../lib/area';
import { blockedView, formatBlockedWhen, plainTitle, reasonLead } from '../lib/blocked-view';
import { ObTypeLine } from './ObjectCard';

/**
 * Recent blocks — read denials the Gatekeeper made, so the owner can tell a
 * limit they set from a malfunction (doc/read-denial-recording.md, Phase 3).
 * Records carry no message content; this maps each `reason` to a plain-language
 * line + a calm severity (amber = a limit fired; red = needs you; grey = info).
 */

const SOURCE: Record<string, string> = {
  gmail: 'Gmail', calendar: 'Google Calendar', crm: 'CRM',
  linkedin: 'LinkedIn', records: 'Records', mollie: 'Mollie',
};
/** Integration id → human name. Pure; exported for tests. */
export const sourceName = (id: string): string => SOURCE[id] ?? id;

export type Severity = 'warn' | 'act' | 'info';

/**
 * reason → chip label + calm severity + optional fix route. PURE and exported
 * for unit tests (the JSX sentence is presentation, verified in the browser
 * layer). amber = a limit you set fired; red (act) = needs you; grey (info).
 */
const REASON: Record<DenialReason, { chip: string; sev: Severity; fixTo?: string }> = {
  resource:     { chip: 'Restricted',   sev: 'warn' },
  spam:         { chip: 'Spam / Trash', sev: 'info' },
  age:          { chip: 'Too old',      sev: 'warn' },
  unset_age:    { chip: 'Needs setup',  sev: 'act', fixTo: '/integrations' },
  read_gate:    { chip: 'Not granted',  sev: 'act', fixTo: '/mandates' },
  ungoverned:   { chip: 'Unconfigured', sev: 'act' },
  query_unsafe: { chip: 'Unsafe search', sev: 'info' },
};
export function denialView(reason: DenialReason | undefined): { chip: string; sev: Severity; fixTo?: string } {
  // `reason` is only ever absent on a non-read record (AU2 kinds) — this
  // widget only ever renders read blocks in practice, but stays safe either way.
  return (reason && REASON[reason]) ?? { chip: 'Blocked', sev: 'info' };
}

/** The plain-language sentence (presentation). Coarse target only, never content. */
function lineFor(r: DenialRecord): React.ReactNode {
  const src = sourceName(r.integrationId);
  switch (r.reason) {
    case 'resource':
      return r.integrationId === 'calendar'
        ? <>Tried to read your <b>{r.target ?? 'restricted'}</b> calendar</>
        : <>Tried to read a restricted location in {src}</>;
    case 'spam':         return <>Tried to open a message in <b>spam or trash</b></>;
    case 'age':          return <>Tried to read {src} older than your read window</>;
    case 'unset_age':    return <>Your {src} has <b>no read window set</b>, so reads are blocked</>;
    case 'read_gate':    return <>Read access isn't granted on your {src} mandate</>;
    case 'ungoverned':   return <>A {src} tool isn't configured for safe reading</>;
    case 'query_unsafe': return <>A search couldn't be safely limited and was refused</>;
    default:             return <>{r.detail}</>;
  }
}

/** Relative "N ago" for a past timestamp. Pure; exported for tests. */
export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
}

const PREVIEW = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** "Recent" on the dashboard. The log itself keeps 30 days (reachable via "View all"). */
export const RECENT_DAYS = 7;

/** Split the retained log into the dashboard's recent window and the rest. Pure; exported for tests. */
export function splitRecent<T extends { ts: number }>(records: T[], now: number): { recent: T[]; all: T[] } {
  const cutoff = now - RECENT_DAYS * DAY_MS;
  return { recent: records.filter(r => r.ts >= cutoff), all: records };
}

export function RecentBlocks() {
  // The whole retained log (≤30 days, ≤200 records — small) in one call; the
  // 7-day "recent" window is cut client-side so both views agree.
  const [records, setRecords] = useState<DenialRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Only blocks NOT yet seen on the Blocked page show here — the same
  // condition as the Blocked nav count; once seen, the panel is gone.
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const catalog = useAreaCatalog();

  const load = useCallback(() => {
    spClient.getDenials({ limit: 200 })
      .then(({ records }) => { setRecords(records); setFailed(false); })
      .catch(() => setFailed(true));
    spClient.getLastSeenBlockedAt()
      .then(setLastSeen)
      .catch(() => setLastSeen(0));
  }, []);

  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, 120_000);
  useSSEEvent('denial-recorded', load);
  useEffect(() => {
    window.addEventListener('suveren:blocked-seen-changed', load);
    return () => window.removeEventListener('suveren:blocked-seen-changed', load);
  }, [load]);

  // Secondary panel — stay quiet on load or if the endpoint is unreachable
  // (e.g. vault locked → 401). Don't clutter the dashboard with an error.
  if (failed || records === null || lastSeen === null) return null;

  const { all } = splitRecent(records, Date.now());
  const unseen = all.filter(r => r.ts > lastSeen);
  // Nothing new → nothing shown (no "Nothing blocked" box).
  if (unseen.length === 0) return null;
  const shown = unseen.slice(0, PREVIEW);

  // UI spec §18.5 — each new block is the closed BLOCKED row of the Blocked page (§18.4).
  const row = (r: DenialRecord, i: number) => {
    const area = r.profile ? resolveAreaName(r.profile, catalog) : sourceName(r.integrationId);
    const v = denialView(r.reason);
    return (
      <Link className="ob-card dash-row" to="/blocked" key={`${r.ts}-${i}`} data-testid="dash-blocked">
        <ObTypeLine
          tag="Blocked"
          className="obj-line"
          profileId={r.profile ?? undefined}
          parts={[area, `via ${sourceName(r.integrationId)}`, formatBlockedWhen(r.ts, Date.now())]}
        />
        <span className="ob-title">{r.reason ? lineFor(r) : plainTitle(r)}</span>
        <span className="ob-one ob-check-x">
          <span aria-hidden="true">✕</span> <b>{reasonLead(r)}</b>{' '}
          <span className="ob-quiet-inline">{r.reason ? v.chip : blockedView(r).sentence}</span>
        </span>
      </Link>
    );
  };

  return (
    <section className="dash-sec" aria-label="Blocked — new since you looked" data-testid="dash-blocked-sec">
      <div className="core-col-h">
        <h2>Blocked — new since you looked</h2>
        <span className="pill-count">{unseen.length}</span>
      </div>
      <div className="dash-rows">{shown.map(row)}</div>
      {unseen.length > shown.length && <Link className="ob-btn dash-btn" to="/blocked">All blocked</Link>}
    </section>
  );
}
