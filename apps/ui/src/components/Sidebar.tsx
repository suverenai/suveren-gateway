import { isNewTicket } from '@suveren/approval-card/lib/core-objects';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useState, useCallback, useEffect, useRef } from 'react';
import { spClient } from '../lib/sp-client';
import { bucketAuths } from '../lib/auth-status';
import { useVisiblePolling } from '@suveren/approval-card/hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { useIntegrationStatus } from '../contexts/IntegrationStatusContext';
import { unseenCount } from '../lib/blocked-view';
import { usePendingCount } from '../hooks/usePendingCount';
import { isNewReport } from '../lib/report-news';
import { createLatestGuard } from '../lib/latest-guard';
import { APPROVALS_CHANGED_EVENT } from '@suveren/approval-card/lib/approval-flow';
import { NavIcon, type NavIconName } from './NavIcon';

export interface NavItem {
  to: string;
  /** The drawn, monochrome icon (UI spec §19.1). */
  icon: NavIconName;
  label: string;
  statusKey?: 'integrations' | 'assistant' | 'authorizations' | 'proposals' | 'brief' | 'blocked' | 'report' | 'tickets';
  teamOnly?: boolean;
  /** Only with device keys on (SUVEREN_DEVICE_KEYS): the Devices page exists only there. */
  deviceKeysOnly?: boolean;
  /** UI spec §12.1: 'core' = the unlabelled main group; 'setup' = the quieter group below. */
  group?: 'top' | 'core' | 'setup';
  /** The count is information, not an action: the outlined "setup" pill
   *  (UI spec §19.2), never the solid "needs you" pill. Setup items always are. */
  quietCount?: boolean;
  /** One thing that is new or not (there is only one report): a "New" label, never a count. */
  newLabel?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: 'dashboard', label: 'Dashboard', group: 'top' },
  // The core objects first, larger, no label (UI spec §12.1). v0.7 vocabulary
  // at the level a buyer reads; routes keep their names.
  { to: '/approvals', icon: 'approvals', label: 'Approvals', statusKey: 'proposals', group: 'core' },
  { to: '/mandates', icon: 'mandates', label: 'Mandates', statusKey: 'authorizations', group: 'core', quietCount: true },
  { to: '/tickets', icon: 'tickets', label: 'Tickets', statusKey: 'tickets', group: 'core' },
  // A report is a result to read, not setup (reports mockup, 2026-10-16).
  { to: '/reports', icon: 'reports', label: 'Reports', statusKey: 'report', newLabel: true, group: 'core' },
  { to: '/blocked', icon: 'blocked', label: 'Blocked', statusKey: 'blocked', group: 'core' },
  { to: '/team', icon: 'team', label: 'Team', teamOnly: true, group: 'setup' },
  { to: '/devices', icon: 'devices', label: 'Devices', deviceKeysOnly: true, group: 'setup' },
  { to: '/agent-brief', icon: 'brief', label: 'Agent Brief', statusKey: 'brief', group: 'setup' },
  { to: '/integrations', icon: 'integrations', label: 'Connectors', statusKey: 'integrations', group: 'setup' },
  { to: '/settings', icon: 'settings', label: 'Settings', statusKey: 'assistant', group: 'setup' },
];

/**
 * Non-integration badge counts (AI config, authorizations, proposals).
 * Integration counts come from the shared IntegrationStatusContext below
 * so Sidebar / Dashboard / IntegrationsPage can't disagree.
 */
function useOtherNavStatus() {
  const { activeDomain } = useAuth();
  const [counts, setCounts] = useState<Record<string, number>>({});
  // Every live event starts a poll; two events a moment apart (two blocked
  // calls) overlap. An older poll may not write over a newer one; without that,
  // one that finishes last puts an older count back (see latest-guard.ts).
  const guardRef = useRef(createLatestGuard());

  const poll = useCallback(async () => {
    const mayWrite = guardRef.current.begin();
    try {
      const [aiStatus, authData, briefText, archivedIds, denials, lastSeenBlockedAt, reportData, lastSeenReportAt, ticketPage, lastSeenTicketsAt] = await Promise.all([
        spClient.getCredential('ai-config').catch(() => null),
        spClient.getMyAttestations().catch(() => null),
        spClient.getAgentContext().catch(() => ''),
        spClient.getArchivedMandates().catch(() => [] as string[]),
        spClient.getDenials({ limit: 200 }).catch(() => null),
        spClient.getLastSeenBlockedAt().catch(() => 0),
        spClient.getReport().catch(() => null),
        spClient.getLastSeenReportAt().catch(() => Number.POSITIVE_INFINITY),
        spClient.getMyReceiptsPage({ limit: 200 }).catch(() => null),
        spClient.getLastSeenTicketsAt().catch(() => Number.POSITIVE_INFINITY),
      ]);

      const next: Record<string, number> = {};
      if (aiStatus && !aiStatus.configured) next.assistant = 1;
      if (authData) {
        // Bucket through the shared helper so this badge, the Dashboard
        // counts, and the Authorizations page never disagree.
        // Archived mandates are out of the badge: they are finished and the
        // owner has seen them. A failed archive load counts them (safe side).
        const expired = bucketAuths(authData, { archivedSet: new Set(archivedIds) }).expired.length;
        if (expired > 0) next.authorizations = expired;
      }
      // Empty agent brief → badge nudges the owner to author one.
      if (!briefText || !briefText.trim()) next.brief = 1;
      // AU2 — blocked actions arrived since the owner last opened the
      // Blocked page (not "today's total" — that's the page's own header
      // line). No notification (decided); this static nav count is the
      // only surfacing.
      if (denials) {
        const unseen = unseenCount(denials.records, lastSeenBlockedAt);
        if (unseen > 0) next.blocked = unseen;
      }
      // The one report: new since the Reports page was last opened.
      if (isNewReport(reportData?.report, lastSeenReportAt)) next.report = 1;
      // Tickets issued since the Tickets page was last opened.
      const newTickets = ticketPage ? ticketPage.receipts.filter(r => isNewTicket(r, lastSeenTicketsAt)).length : 0;
      if (newTickets > 0) next.tickets = newTickets;
      if (!mayWrite()) return;
      setCounts(next);
    } catch {
      // ignore
    }
  }, [activeDomain]);

  // SSE-driven refresh: fire immediately on events that change badge counts.
  useSSEEvent('attestation-changed', poll);
  useSSEEvent('proposal-added', poll);
  useSSEEvent('proposal-resolved', poll);
  useSSEEvent('proposal-approved', poll);
  useSSEEvent('proposal-rejected', poll);
  useSSEEvent('team-membership-changed', poll);
  // AU2 — a new block just happened (MCP server -> control plane -> SSE,
  // see cp-notify.ts / denial-log.ts). Moves the Blocked badge without
  // waiting on the 5-minute fallback poll below.
  useSSEEvent('denial-recorded', poll);
  useSSEEvent('report-written', poll);
  useSSEEvent('ticket-recorded', poll);
  // Archive is a local flag (no SSE event): the Mandates page announces it.
  useEffect(() => {
    window.addEventListener('suveren:archived-changed', poll);
    return () => window.removeEventListener('suveren:archived-changed', poll);
  }, [poll]);
  // Same convention for the Blocked "last seen" flag — the Blocked page
  // announces it once it has marked itself seen, so the badge clears
  // immediately instead of waiting for the 5-minute fallback poll below.
  useEffect(() => {
    window.addEventListener('suveren:blocked-seen-changed', poll);
    window.addEventListener('suveren:report-seen-changed', poll);
    window.addEventListener('suveren:tickets-seen-changed', poll);
    // The approvals page announces a decision the gateway has confirmed.
    window.addEventListener(APPROVALS_CHANGED_EVENT, poll);
    return () => {
      window.removeEventListener(APPROVALS_CHANGED_EVENT, poll);
      window.removeEventListener('suveren:blocked-seen-changed', poll);
      window.removeEventListener('suveren:report-seen-changed', poll);
      window.removeEventListener('suveren:tickets-seen-changed', poll);
    };
  }, [poll]);
  // Fallback full-sync every 5min in case of missed events.
  useVisiblePolling(poll, 300_000, activeDomain);
  return counts;
}

const TOAST_STYLE: React.CSSProperties = {
  position: 'fixed',
  bottom: '1.5rem',
  left: '50%',
  transform: 'translateX(-50%)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  padding: '0.625rem 1rem',
  fontSize: '0.85rem',
  boxShadow: 'var(--elevation-2)',
  zIndex: 9999,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};

export function Sidebar() {
  const { mode, activeTeam, deviceKeysSwitch } = useAuth();
  const other = useOtherNavStatus();
  const { attentionCount } = useIntegrationStatus();
  // Approvals: the one queue the Approvals list and the panel show, never a count of its own (they disagreed for a long time
  // after a request was closed on the phone, dev lane 2026-11-23).
  const waiting = usePendingCount();
  const counts: Record<string, number> = { ...other };
  if (attentionCount > 0) counts.integrations = attentionCount;
  if (waiting > 0) counts.proposals = waiting;

  const visibleItems = NAV_ITEMS.filter(item => (!item.teamOnly || mode === 'team') && (!item.deviceKeysOnly || deviceKeysSwitch));

  // Mode-flip toast — fires when mode changes after the initial render.
  // Dismissed automatically on next navigation (location change).
  const prevMode = useRef<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const location = useLocation();

  useEffect(() => {
    // Skip the very first render — we don't want a toast on page load.
    if (prevMode.current === null) {
      prevMode.current = mode;
      return;
    }
    if (prevMode.current === mode) return;

    if (mode === 'team' && activeTeam) {
      setToastMsg(`You are now acting in team context — ${activeTeam.name}`);
    } else if (mode === 'personal') {
      setToastMsg('You have left the team — back to personal context');
    }
    prevMode.current = mode;
  }, [mode, activeTeam]);

  // Dismiss toast on navigation
  useEffect(() => {
    setToastMsg(null);
  }, [location.pathname]);

  return (
    <div className="sidebar">
      {(['top', 'core', 'setup'] as const).map(group => {
        const items = visibleItems.filter(item => (item.group ?? 'setup') === group);
        if (items.length === 0) return null;
        return (
          <div key={group} className={`sidebar-${group}`}>
            {group === 'setup' && <><div className="sidebar-divider" /><div className="sidebar-group-label">Setup</div></>}
            {/* §19.4 — the closed icon rail shows Setup as ONE icon (its number = what needs attention);
                opening the rail (hover / focus) shows the group in full, as the wide nav always does. */}
            {group === 'setup' && (
              <span className={`sidebar-setup-rail${items.some(i => location.pathname.startsWith(i.to)) ? ' is-active' : ''}`} aria-hidden="true">
                <NavIcon name="settings" />
                {(() => {
                  const total = items.reduce((n, i) => n + (i.statusKey && !i.newLabel ? (counts[i.statusKey] ?? 0) : 0), 0);
                  if (total > 0) return <span className="nav-count nav-count-setup" data-testid="nav-count-setup-rail">{total > 99 ? '99+' : total}</span>;
                  return items.some(i => i.statusKey && counts[i.statusKey]) ? <span className="nav-dot" /> : null;
                })()}
              </span>
            )}
            <ul className="sidebar-nav">
              {items.map(item => {
                const count = item.statusKey ? counts[item.statusKey] : 0;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/'}
                      className={({ isActive }) => `sidebar-item${isActive ? ' active' : ''}`}
                    >
                      <span className="icon"><NavIcon name={item.icon} /></span>
                      <span className="sidebar-label">{item.label}</span>
                      {count ? (item.newLabel
                        ? <span className="nav-new" data-testid={`nav-new-${item.statusKey}`}>New</span>
                        : <span
                            className={`nav-count${item.quietCount || group === 'setup' ? ' nav-count-setup' : ''}`}
                            data-testid={`nav-count-${item.statusKey}`}
                            title={item.statusKey === 'authorizations' ? 'Expired mandates' : undefined}
                          >{count > 99 ? '99+' : count}</span>) : null}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {/* No "Active context" block here: the workspace pill top right says
          where you are, and the second copy showed the team's raw id. */}

      {toastMsg && (
        <div style={TOAST_STYLE} role="status" aria-live="polite">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
