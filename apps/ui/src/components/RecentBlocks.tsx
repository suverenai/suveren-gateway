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
  read_gate:    { chip: 'Not granted',  sev: 'act', fixTo: '/authorizations' },
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
    case 'read_gate':    return <>Read access isn't granted on your {src} authorization</>;
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

export function RecentBlocks() {
  const [records, setRecords] = useState<DenialRecord[] | null>(null);
  const [count, setCount] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    spClient.getDenials({ limit: expanded ? 200 : PREVIEW })
      .then(({ count, records }) => { setCount(count); setRecords(records); setFailed(false); })
      .catch(() => setFailed(true));
  }, [expanded]);

  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, 120_000);

  // Secondary panel — stay quiet on load or if the endpoint is unreachable
  // (e.g. vault locked → 401). Don't clutter the dashboard with an error.
  if (failed || records === null) return null;

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
        {count > 0 && <span className="rb-count">{count}</span>}
      </div>

      {records.length === 0 ? (
        <div className="rb-empty">
          <span className="rb-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
          <h3>Nothing blocked</h3>
          <p>Your agent has stayed within every limit you set.</p>
        </div>
      ) : (
        <>
          <p className="rb-sub">Limits you set that stopped your agent. Seeing them here means the gateway is doing its job.</p>
          <div className="rb-rows">{records.map(row)}</div>
          {!expanded && count > records.length && (
            <div className="rb-foot">
              <button className="rb-viewall" type="button" onClick={() => setExpanded(true)}>
                View all {count} blocks
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
