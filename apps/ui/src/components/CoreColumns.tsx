/**
 * The dashboard's three columns (UI spec §12.4, mockup core-objects.html C2):
 *
 *   1. Waiting for you        — the Approvals page's rows (§18.5)
 *   2. Done today             — automatic tickets grouped per mandate and
 *                               action ("new since your last visit"), then
 *                               today's approved tickets as single rows
 *   3. Mandates at work today — only mandates that acted today, with usage
 *
 * Every item is the closed row of its own page (UI spec §18.5).
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { useAreaCatalog } from '../lib/area-catalog';

import {
  areaName, systemName, isToday, isNewTicket, ticketTime,
  groupAutomatic, mandatesAtWork, nearLimit, matchesTicketFilter, shortTicketId,
} from '../lib/core-objects';
import { actionLabel } from '../lib/receipt-summary';
import { ObTypeLine } from './ObjectCard';
import { ApprovalRow } from './ApprovalRow';
import { showMandateLine } from '../lib/area';
import { Skeleton } from './Skeleton';

const MAX_ITEMS = 5;

/** "via <system>" — left out when it only repeats the area ("Email · via Email"), so the narrow columns stay one line. */
function viaPart(system: string | undefined, area: string): string | null {
  return system && system.trim().toLowerCase() !== area.trim().toLowerCase() ? `via ${system}` : null;
}

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
    spClient.getLabelManifests().then(setManifests).catch(() => {});
    spClient.getLocalAuthorizations().then(({ authorizations }) => setLocalAuths(authorizations)).catch(() => {});
  }, []);

  // Area names (UI spec §13.1) — the newest version of each profile's own
  // name, shared with every other surface via lib/area-catalog.ts.
  const catalog = useAreaCatalog();
  // Mandate titles for the quiet "Mandate:" line (§13.2).
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
    () => groupAutomatic(today, { catalog, manifests, titles, lastSeenMs: lastSeen ?? Number.POSITIVE_INFINITY }),
    [today, catalog, manifests, titles, lastSeen],
  );
  const approvedToday = today.filter(r => matchesTicketFilter(r, 'approved')).length;
  const atWork = useMemo(
    () => mandatesAtWork(today, {
      nowMs: Date.now(),
      catalog,
      manifests,
      titles,
      boundsOf: id => localAuths[id]?.bounds,
      profileOf: id => profiles[id],
    }),
    [today, catalog, manifests, titles, localAuths, profiles],
  );
  const newGroups = groups.filter(g => g.newCount > 0).length;
  const oldestFirst = [...waiting].sort((a, b) => a.createdAt - b.createdAt);
  // Approved tickets were decided by the person; they fill what the automatic groups leave of the 5 rows.
  const approvedRows = today
    .filter(r => matchesTicketFilter(r, 'approved'))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, Math.max(0, MAX_ITEMS - Math.min(groups.length, MAX_ITEMS)));
  const navigate = useNavigate();

  return (
    <div className="core-cols dash-cols" data-testid="core-cols">
      {/* 1 — Waiting for you: the Approvals page's own rows (§18.5) */}
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
          <div className="dash-rows">
            {oldestFirst.slice(0, MAX_ITEMS).map(p => (
              <div key={p.id} data-testid="dash-approval">
                <ApprovalRow
                  proposal={p}
                  manifests={manifests}
                  titles={titles}
                  onOpen={() => navigate(`/approvals?open=${encodeURIComponent(p.id)}`)}
                />
              </div>
            ))}
          </div>
        )}
        {oldestFirst.length > 0 && <Link to="/approvals" className="ob-btn dash-btn">All approvals</Link>}
      </section>

      {/* 2 — Done today: automatic tickets grouped per mandate and action, then approved ones */}
      <section aria-label="Done today" data-testid="col-automatic">
        <div className="core-col-h">
          <h2>Done today</h2>
          {newGroups > 0 && <span className="meta">{groups.reduce((n, g) => n + g.newCount, 0)} new</span>}
        </div>
        {receipts === null ? (
          <Skeleton variant="line" />
        ) : groups.length === 0 && approvedRows.length === 0 ? (
          <p className="core-col-empty">Nothing was done today.</p>
        ) : (
          <div className="dash-rows">
            {groups.slice(0, MAX_ITEMS).map(g => (
              <details key={g.key} className={`ob-card dash-row auto-grp${g.newCount > 0 ? '' : ' is-seen'}`} data-testid="auto-group">
                <summary>
                  <ObTypeLine
                    tag="Ticket"
                    className="obj-line"
                    profileId={g.profileId}
                    parts={[g.area, viaPart(g.system, g.area), ticketTime(g.latestSec, now), <span className="ob-st" key="st">Automatic</span>]}
                  />
                  <span className="ob-title">{g.area} · {g.count} × {g.label}</span>
                  <span className="ob-one">
                    {showMandateLine(g.mandateTitle, g.area) && <span data-testid="mandate-line">Mandate: {g.mandateTitle}</span>}
                    <span>{g.newCount > 0 ? <b className="ob-bold">{g.newCount} new</b> : 'seen'}</span>
                  </span>
                </summary>
                <div className="auto-grp-list">
                  {g.tickets.slice(0, MAX_ITEMS).map(t => (
                    <div key={t.id} className="auto-grp-row">
                      {actionLabel(t, manifests)}
                      <span className="t">{ticketTime(t.timestamp, now)} · {shortTicketId(t.id)}{isNewTicket(t, lastSeen ?? Number.POSITIVE_INFINITY) ? ' · new' : ''}</span>
                    </div>
                  ))}
                  {g.tickets.length > MAX_ITEMS && (
                    <div className="auto-grp-row meta">+ {g.tickets.length - MAX_ITEMS} more in Tickets</div>
                  )}
                </div>
              </details>
            ))}
            {approvedRows.map(t => {
              const area = areaName(t.profileId, catalog);
              const system = systemName(t.action, manifests);
              const title = t.authorizationId ? titles[t.authorizationId] : undefined;
              return (
                <Link key={t.id} to="/tickets?filter=approved" className="ob-card dash-row" data-testid="dash-approved-ticket">
                  <ObTypeLine
                    tag="Ticket"
                    className="obj-line"
                    profileId={t.profileId}
                    parts={[area, viaPart(system, area), ticketTime(t.timestamp, now), <span className="ob-st" key="st">Approved</span>]}
                  />
                  <span className="ob-title">{area} · {actionLabel(t, manifests)}</span>
                  {showMandateLine(title, area) && <span className="ob-one" data-testid="mandate-line">Mandate: {title}</span>}
                </Link>
              );
            })}
          </div>
        )}
        {(groups.length > 0 || approvedRows.length > 0) && (
          <Link to={groups.length > 0 ? '/tickets?filter=automatic' : '/tickets'} className="ob-btn dash-btn" data-testid="btn-automatic-tickets">All tickets</Link>
        )}
        {approvedToday > approvedRows.length && (
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
          <div className="dash-rows">
            {atWork.slice(0, MAX_ITEMS).map(m => (
              <Link key={m.authorizationId} to="/mandates" className="ob-card dash-row mandate-obj" data-testid="mandate-at-work">
                <ObTypeLine
                  tag="Mandate"
                  className="obj-line"
                  profileId={m.profileId}
                  parts={[m.area, viaPart(m.system, m.area)]}
                />
                <span className="ob-title">{m.mandateTitle?.trim() ? m.mandateTitle : m.area}</span>
                <span className="ob-one">
                  {m.limit !== undefined
                    ? (nearLimit(m) ? <b className="ob-bold">{m.used} of {m.limit} used today</b> : `${m.used} of ${m.limit} used today`)
                    : `${m.used} ${m.used === 1 ? 'action' : 'actions'} today`}
                </span>
              </Link>
            ))}
          </div>
        )}
        {receipts !== null && activeCount > atWork.length && (
          <p className="core-quiet-line">
            {activeCount - atWork.length} more mandate{activeCount - atWork.length === 1 ? '' : 's'} in force — no actions today.
          </p>
        )}
        {activeCount > 0 && <Link to="/mandates" className="ob-btn dash-btn">All mandates</Link>}
      </section>
    </div>
  );
}
