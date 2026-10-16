/**
 * The dashboard's three columns (UI spec §12.4, mockup core-objects.html C2):
 *
 *   1. Waiting for you        — the action items, most prominent
 *   2. Done automatically     — tickets no person approved, grouped per mandate
 *                               and action, "new since your last visit"
 *   3. Mandates at work today — only mandates that acted today, with usage
 *
 * Approved tickets were seen at approval time, so they are one quiet line.
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { AgentProfile } from '@hap/core';
import {
  spClient,
  type PendingItem,
  type Proposal,
  type ExecutionReceipt,
  type IntegrationManifest,
  type LocalAuthorization,
} from '../lib/sp-client';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { loadProfile } from '../lib/profile-cache';

import {
  areaName, systemName, waitingLabel, deadlineLabel, isToday, isNewTicket, ticketTime,
  groupAutomatic, mandatesAtWork, nearLimit, matchesTicketFilter, shortTicketId,
} from '../lib/core-objects';
import { actionLabel } from '../lib/receipt-summary';
import { ObjectLine } from './ObjectLine';
import { ApprovalSummary } from './ApprovalSummary';
import { Skeleton } from './Skeleton';

const MAX_ITEMS = 5;

interface Props {
  auths: PendingItem[];
  activeCount: number;
  /** Pending, deduplicated: my domain's proposals + those routed to me as approver. */
  waiting: Proposal[];
  waitingReady: boolean;
}

export function CoreColumns({ auths, activeCount, waiting, waitingReady }: Props) {
  const [receipts, setReceipts] = useState<ExecutionReceipt[] | null>(null);
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const [manifests, setManifests] = useState<IntegrationManifest[]>([]);
  const [localAuths, setLocalAuths] = useState<Record<string, LocalAuthorization>>({});
  const [profiles, setProfiles] = useState<Record<string, AgentProfile | null>>({});

  const loadTickets = useCallback(() => {
    spClient.getMyReceiptsPage({ limit: 200 })
      .then(page => setReceipts(page.receipts))
      .catch(() => setReceipts(prev => prev ?? []));
    spClient.getLastSeenTicketsAt()
      .then(setLastSeen)
      .catch(() => setLastSeen(Number.POSITIVE_INFINITY));
  }, []);
  useVisiblePolling(loadTickets, 300_000);
  useSSEEvent('ticket-recorded', loadTickets);

  useEffect(() => {
    spClient.getIntegrationManifests().then(({ manifests }) => setManifests(manifests)).catch(() => {});
    spClient.getLocalAuthorizations().then(({ authorizations }) => setLocalAuths(authorizations)).catch(() => {});
  }, []);

  const titles = useMemo(() => {
    const t: Record<string, string> = {};
    for (const a of auths) if (a.authorization_id && a.title) t[a.authorization_id] = a.title;
    return t;
  }, [auths]);

  const now = Date.now();
  const today = useMemo(() => {
    const at = Date.now();
    return (receipts ?? []).filter(r => isToday(r.timestamp, at));
  }, [receipts]);

  // Profiles are needed to read which declared bound a ticket counts against.
  useEffect(() => {
    const missing = [...new Set(today.map(r => r.profileId))].filter(id => !(id in profiles));
    if (missing.length === 0) return;
    Promise.all(missing.map(id => loadProfile(id).then(p => [id, p] as const).catch(() => [id, null] as const)))
      .then(pairs => setProfiles(prev => ({ ...prev, ...Object.fromEntries(pairs) })));
  }, [today, profiles]);

  const groups = useMemo(
    () => groupAutomatic(today, { titles, manifests, lastSeenMs: lastSeen ?? Number.POSITIVE_INFINITY }),
    [today, titles, manifests, lastSeen],
  );
  const approvedToday = today.filter(r => matchesTicketFilter(r, 'approved')).length;
  const atWork = useMemo(
    () => mandatesAtWork(today, {
      nowMs: Date.now(),
      titles,
      manifests,
      boundsOf: id => localAuths[id]?.bounds,
      profileOf: id => profiles[id],
    }),
    [today, titles, manifests, localAuths, profiles],
  );
  const newGroups = groups.filter(g => g.newCount > 0).length;
  const oldestFirst = [...waiting].sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div className="core-cols" data-testid="core-cols">
      {/* 1 — Waiting for you */}
      <section aria-label="Waiting for you" data-testid="col-waiting">
        <div className="core-col-h is-main">
          <h2>Waiting for you</h2>
          {waiting.length > 0 && <span className="pill-count">{waiting.length}</span>}
        </div>
        {!waitingReady ? (
          <Skeleton variant="line" />
        ) : oldestFirst.length === 0 ? (
          <p className="core-col-empty">Nothing waits for your decision.</p>
        ) : (
          oldestFirst.slice(0, MAX_ITEMS).map(p => {
            const due = deadlineLabel(p.expiresAt, now);
            return (
              <Link key={p.id} to={`/approvals?open=${encodeURIComponent(p.id)}`} className="appr-item appr-item-link" data-testid="dash-approval">
                <div className="appr-item-main">
                  <ObjectLine
                    profileId={p.profileId}
                    area={areaName(p.authorizationId, p.profileId, titles)}
                    system={systemName(p.tool, manifests)}
                    time={waitingLabel(p.createdAt, now)}
                  />
                  <div className="appr-item-sum"><ApprovalSummary proposal={p} manifests={manifests} /></div>
                  {due && <div className="obj-due">{due}</div>}
                </div>
                <span className="appr-item-chev" aria-hidden="true">›</span>
              </Link>
            );
          })
        )}
        {oldestFirst.length > 0 && <Link to="/approvals" className="col-btn">All approvals ›</Link>}
      </section>

      {/* 2 — Done automatically */}
      <section aria-label="Done automatically" data-testid="col-automatic">
        <div className="core-col-h">
          <h2>Done automatically</h2>
          {newGroups > 0 && <span className="meta">{groups.reduce((n, g) => n + g.newCount, 0)} new</span>}
        </div>
        {receipts === null ? (
          <Skeleton variant="line" />
        ) : groups.length === 0 ? (
          <p className="core-col-empty">Nothing was done automatically today.</p>
        ) : (
          groups.slice(0, MAX_ITEMS).map(g => (
            <details key={g.key} className={`auto-grp${g.newCount > 0 ? '' : ' is-seen'}`} data-testid="auto-group">
              <summary>
                <span className={`seen-dot${g.newCount > 0 ? ' is-new' : ''}`} aria-label={g.newCount > 0 ? 'new since your last visit' : 'seen'} />
                <span className="auto-grp-txt">
                  <ObjectLine profileId={g.profileId} area={g.area} system={g.system} />
                  <b>{g.count} × {g.label}</b>
                  <span className="meta">
                    {g.newCount > 0 ? `${g.newCount} new` : 'seen'} · latest {ticketTime(g.latestSec, now)}
                  </span>
                </span>
              </summary>
              <div className="auto-grp-list">
                {g.tickets.slice(0, MAX_ITEMS).map(t => (
                  <div key={t.id} className="auto-grp-row">
                    <span className={`seen-dot${isNewTicket(t, lastSeen ?? Number.POSITIVE_INFINITY) ? ' is-new' : ''}`} />
                    {actionLabel(t, manifests)}
                    <span className="t">{ticketTime(t.timestamp, now)} · {shortTicketId(t.id)}</span>
                  </div>
                ))}
                {g.tickets.length > MAX_ITEMS && (
                  <div className="auto-grp-row meta">+ {g.tickets.length - MAX_ITEMS} more in Tickets</div>
                )}
              </div>
            </details>
          ))
        )}
        {groups.length > 0 && (
          <Link to="/tickets?filter=automatic" className="col-btn" data-testid="btn-automatic-tickets">Automatic tickets ›</Link>
        )}
        {approvedToday > 0 && (
          <div className="core-quiet-line">
            {approvedToday} approved today — <Link to="/tickets?filter=approved">see approved tickets</Link>
          </div>
        )}
      </section>

      {/* 3 — Mandates at work today */}
      <section aria-label="Mandates at work today" data-testid="col-mandates">
        <div className="core-col-h"><h2>Mandates at work today</h2></div>
        {receipts === null ? (
          <Skeleton variant="line" />
        ) : atWork.length === 0 ? (
          <p className="core-col-empty">No mandate has acted today.</p>
        ) : (
          atWork.slice(0, MAX_ITEMS).map(m => (
            <div key={m.authorizationId} className="mandate-obj" data-testid="mandate-at-work">
              <ObjectLine profileId={m.profileId} area={m.area} system={m.system} />
              <div className={`usage${nearLimit(m) ? ' is-near' : ''}`}>
                {m.limit !== undefined ? (
                  <>
                    <span className="usage-bar"><i style={{ width: `${Math.min(100, Math.round(m.ratio * 100))}%` }} /></span>
                    <span>{nearLimit(m) ? <b>{m.used} of {m.limit}</b> : `${m.used} of ${m.limit}`} today</span>
                  </>
                ) : (
                  <span>{m.used} {m.used === 1 ? 'action' : 'actions'} today</span>
                )}
              </div>
            </div>
          ))
        )}
        {receipts !== null && activeCount > atWork.length && (
          <div className="meta" style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-caption)' }}>
            {activeCount - atWork.length} more mandate{activeCount - atWork.length === 1 ? '' : 's'} in force — no actions today
          </div>
        )}
        {atWork.length > 0 && <Link to="/mandates" className="col-btn">All mandates ›</Link>}
      </section>
    </div>
  );
}
