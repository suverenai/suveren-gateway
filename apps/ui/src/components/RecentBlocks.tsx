import { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { spClient, type DenialRecord, type DenialReason } from '../lib/sp-client';
import { useVisiblePolling } from '../hooks/useVisiblePolling';

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
export function denialView(reason: DenialReason): { chip: string; sev: Severity; fixTo?: string } {
  return REASON[reason] ?? { chip: 'Blocked', sev: 'info' };
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
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    spClient.getDenials({ limit: 200 })
      .then(({ records }) => { setRecords(records); setFailed(false); })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, 120_000);

  // Secondary panel — stay quiet on load or if the endpoint is unreachable
  // (e.g. vault locked → 401). Don't clutter the dashboard with an error.
  if (failed || records === null) return null;

  const { recent, all } = splitRecent(records, Date.now());
  const shown = expanded ? all : recent.slice(0, PREVIEW);
  const older = all.length - recent.length;

  const row = (r: DenialRecord, i: number) => {
    const v = denialView(r.reason);
    return (
      <div className="rb-row" key={`${r.ts}-${i}`}>
        <span className={`rb-dot ${v.sev === 'act' ? 'act' : v.sev === 'info' ? 'info' : ''}`} aria-hidden="true" />
        <div className="rb-body">
          <div className="rb-line">{lineFor(r)}</div>
          <div className="rb-meta">
            <span className={`rb-chip ${v.sev === 'act' ? 'act' : v.sev === 'warn' ? 'warn' : ''}`}>{v.chip}</span>
            <span className="rb-via">{sourceName(r.integrationId)}</span>
          </div>
          {v.fixTo && <Link className="rb-fix" to={v.fixTo}>Set a read window &rarr;</Link>}
        </div>
        <div className="rb-when">{relativeTime(r.ts, Date.now())}</div>
      </div>
    );
  };

  return (
    <section className="card recent-blocks" aria-label="Recent blocks" style={{ marginTop: '1.5rem' }}>
      <div className="card-header">
        <h2 className="card-title">Recent blocks</h2>
        {(expanded ? all.length : recent.length) > 0 && (
          <span className="rb-count">{expanded ? all.length : recent.length}</span>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="rb-empty">
          <span className="rb-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
          <h3>Nothing blocked in the last {RECENT_DAYS} days</h3>
          <p>Your agent has stayed within every limit you set.</p>
          {older > 0 && (
            <button className="rb-viewall" type="button" onClick={() => setExpanded(true)}>
              Show the last 30 days ({older})
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="rb-sub">
            {expanded ? 'Last 30 days. ' : `Last ${RECENT_DAYS} days. `}
            Limits you set that stopped your agent. Seeing them here means the gateway is doing its job.
          </p>
          <div className="rb-rows">{shown.map(row)}</div>
          {!expanded && all.length > shown.length && (
            <div className="rb-foot">
              <button className="rb-viewall" type="button" onClick={() => setExpanded(true)}>
                View all {all.length} blocks from the last 30 days
              </button>
            </div>
          )}
          {expanded && all.length > Math.min(recent.length, PREVIEW) && (
            <div className="rb-foot">
              <button className="rb-viewall" type="button" onClick={() => setExpanded(false)}>
                Show only the last {RECENT_DAYS} days
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
