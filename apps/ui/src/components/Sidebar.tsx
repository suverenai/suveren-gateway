import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useState, useCallback, useEffect, useRef } from 'react';
import { spClient } from '../lib/sp-client';
import { bucketAuths } from '../lib/auth-status';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { useIntegrationStatus } from '../contexts/IntegrationStatusContext';
import { unseenCount } from '../lib/blocked-view';

export interface NavItem {
  to: string;
  icon: string;
  /** A drawn, monochrome icon (UI spec §12.1) — used instead of `icon` when set. */
  iconClass?: string;
  label: string;
  statusKey?: 'integrations' | 'assistant' | 'authorizations' | 'proposals' | 'brief' | 'blocked';
  teamOnly?: boolean;
  /** UI spec §12.1: 'core' = the unlabelled main group; 'setup' = the quieter group below. */
  group?: 'top' | 'core' | 'setup';
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: '□', label: 'Dashboard', group: 'top' },
  // The core objects first, larger, no label (UI spec §12.1). v0.7 vocabulary
  // at the level a buyer reads; routes keep their names.
  { to: '/approvals', icon: '▷', iconClass: 'nav-ic-approval', label: 'Approvals', statusKey: 'proposals', group: 'core' },
  { to: '/mandates', icon: '☰', iconClass: 'nav-ic-mandate', label: 'Mandates', statusKey: 'authorizations', group: 'core' },
  { to: '/tickets', icon: '▣', iconClass: 'nav-ic-ticket', label: 'Tickets', group: 'core' },
  { to: '/blocked', icon: '⊘', iconClass: 'nav-ic-blocked', label: 'Blocked', statusKey: 'blocked', group: 'core' },
  { to: '/team', icon: '◉', label: 'Team', teamOnly: true, group: 'core' },
  { to: '/agent-brief', icon: '▤', label: 'Agent Brief', statusKey: 'brief', group: 'setup' },
  { to: '/integrations', icon: '⧗', label: 'Integrations', statusKey: 'integrations', group: 'setup' },
  { to: '/reports', icon: '▥', label: 'Reports', group: 'setup' },
  { to: '/settings', icon: '⚙', label: 'Settings', statusKey: 'assistant', group: 'setup' },
];

/**
 * Non-integration badge counts (AI config, authorizations, proposals).
 * Integration counts come from the shared IntegrationStatusContext below
 * so Sidebar / Dashboard / IntegrationsPage can't disagree.
 */
function useOtherNavStatus() {
  const { activeDomain } = useAuth();
  const [counts, setCounts] = useState<Record<string, number>>({});

  const poll = useCallback(async () => {
    try {
      const [aiStatus, authData, proposalData, approverProposals, briefText, archivedIds, denials, lastSeenBlockedAt] = await Promise.all([
        spClient.getCredential('ai-config').catch(() => null),
        spClient.getMyAttestations().catch(() => null),
        spClient.getMyProposals(activeDomain).catch(() => null),
        spClient.getProposalsForApprover().catch(() => null),
        spClient.getAgentContext().catch(() => ''),
        spClient.getArchivedMandates().catch(() => [] as string[]),
        spClient.getDenials({ limit: 200 }).catch(() => null),
        spClient.getLastSeenBlockedAt().catch(() => 0),
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
      // Combine domain proposals (legacy) + above-cap approver proposals (Phase 6).
      const domainPending = (proposalData?.length ?? 0);
      const approverPending = (approverProposals?.length ?? 0);
      const totalPending = domainPending + approverPending;
      if (totalPending > 0) {
        next.proposals = totalPending;
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
    return () => window.removeEventListener('suveren:blocked-seen-changed', poll);
  }, [poll]);
  // Fallback full-sync every 5min in case of missed events.
  useVisiblePolling(poll, 300_000, activeDomain);
  return counts;
}

const BADGE_STYLE: React.CSSProperties = {
  marginLeft: 'auto',
  minWidth: '1.25rem',
  height: '1.25rem',
  padding: '0 0.375rem',
  borderRadius: '0.625rem',
  background: 'var(--neutral)',
  color: 'var(--bg-elevated)',
  fontSize: '0.7rem',
  fontWeight: 600,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

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
  const { mode, group, domain, activeTeam } = useAuth();
  const other = useOtherNavStatus();
  const { attentionCount } = useIntegrationStatus();
  const counts: Record<string, number> = { ...other };
  if (attentionCount > 0) counts.integrations = attentionCount;

  const visibleItems = NAV_ITEMS.filter(item => !item.teamOnly || mode === 'team');

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
                      <span className="icon">
                        {item.iconClass ? <span className={`nav-ic ${item.iconClass}`} aria-hidden="true" /> : item.icon}
                      </span>
                      {item.label}
                      {count ? <span style={BADGE_STYLE}>{count}</span> : null}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <div className="sidebar-context">
        <div className="ctx-label">Active context</div>
        <div className="ctx-value">
          {mode === 'personal' ? 'personal' : group ? `${group.name} / ${domain}` : domain}
        </div>
      </div>

      {toastMsg && (
        <div style={TOAST_STYLE} role="status" aria-live="polite">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
