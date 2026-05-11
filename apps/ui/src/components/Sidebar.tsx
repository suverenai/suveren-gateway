import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useState, useCallback, useEffect, useRef } from 'react';
import { spClient } from '../lib/sp-client';
import { bucketAuths } from '../lib/auth-status';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { useIntegrationStatus } from '../contexts/IntegrationStatusContext';

interface NavItem {
  to: string;
  icon: string;
  label: string;
  statusKey?: 'integrations' | 'assistant' | 'authorizations' | 'proposals' | 'brief';
  teamOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: '□', label: 'Dashboard' },
  { to: '/proposals', icon: '▷', label: 'Pending Approvals', statusKey: 'proposals' },
  { to: '/authorizations', icon: '☰', label: 'Authorizations', statusKey: 'authorizations' },
  { to: '/agent-brief', icon: '▤', label: 'Agent Brief', statusKey: 'brief' },
  { to: '/audit', icon: '▣', label: 'Receipts' },
  { to: '/groups', icon: '◉', label: 'Team', teamOnly: true },
  { to: '/integrations', icon: '⧗', label: 'Integrations', statusKey: 'integrations' },
  { to: '/settings', icon: '⚙', label: 'AI Assistant', statusKey: 'assistant' },
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
      const [aiStatus, authData, proposalData, approverProposals, briefText] = await Promise.all([
        spClient.getCredential('ai-config').catch(() => null),
        spClient.getMyAttestations().catch(() => null),
        spClient.getProposals(activeDomain || 'owner').catch(() => null),
        spClient.getProposalsForApprover().catch(() => null),
        spClient.getAgentContext().catch(() => ''),
      ]);

      const next: Record<string, number> = {};
      if (aiStatus && !aiStatus.configured) next.assistant = 1;
      if (authData) {
        // Bucket through the shared helper so this badge, the Dashboard
        // counts, and the Authorizations page never disagree.
        const expired = bucketAuths(authData).expired.length;
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
  background: 'var(--warning)',
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
  background: 'var(--bg-elevated, #1e1e2e)',
  color: 'var(--text-primary, #e2e8f0)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  padding: '0.625rem 1rem',
  fontSize: '0.85rem',
  boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
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
      <ul className="sidebar-nav">
        {visibleItems.map(item => {
          const count = item.statusKey ? counts[item.statusKey] : 0;
          return (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => `sidebar-item${isActive ? ' active' : ''}`}
              >
                <span className="icon">{item.icon}</span>
                {item.label}
                {count ? <span style={BADGE_STYLE}>{count}</span> : null}
              </NavLink>
            </li>
          );
        })}
      </ul>
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
