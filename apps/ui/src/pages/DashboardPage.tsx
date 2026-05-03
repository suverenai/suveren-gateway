import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { spClient, type PendingItem, type Proposal } from '../lib/sp-client';
import { SetupGuide } from '../components/SetupGuide';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { useIntegrationStatus } from '../contexts/IntegrationStatusContext';
import { Skeleton, SkeletonAttentionRow } from '../components/Skeleton';

const EXPIRY_WARN_SECONDS = 30 * 60; // 30 minutes

function shortProfile(id: string): string {
  return id.replace(/@.*$/, '').split('/').pop() ?? id;
}

export function DashboardPage() {
  const { domain } = useAuth();
  const [auths, setAuths] = useState<PendingItem[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  // Phase 6: above-cap proposals routed to me as approver. Separate from the
  // domain-scoped legacy proposals because the approver inbox is keyed by
  // userId, not domain.
  const [approverProposals, setApproverProposals] = useState<Proposal[]>([]);
  const [aiConfigured, setAiConfigured] = useState(true);
  // Per-section readiness. We used to gate the whole page on a single
  // "loadedOnce || integrationsLoading" flag, which meant a slow SP call
  // (cold Vercel lambda) held the spinner for seconds even though the
  // local integration data was ready in ~100ms. Each card now reveals
  // itself as soon as its own source resolves.
  const [authsReady, setAuthsReady] = useState(false);
  const [proposalsReady, setProposalsReady] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const { entries: integrationEntries, activeSessions, loading: integrationsLoading } = useIntegrationStatus();
  const integrationsReady = !integrationsLoading;

  const refresh = useCallback(() => {
    // Fire-and-forget in parallel. Each call flips only its own ready flag,
    // so a slow SP response doesn't delay the cards that finished fast.
    spClient.getMyAttestations()
      .then(v => { setAuths(v); setAuthsReady(true); })
      .catch(() => setAuthsReady(true));
    spClient.getProposals(domain || 'owner')
      .then(v => { setProposals(v); setProposalsReady(true); })
      .catch(() => setProposalsReady(true));
    // Phase 6: fetch approver inbox alongside the legacy domain proposals.
    // Failure is non-fatal — older SP deployments without the endpoint
    // simply leave this empty.
    spClient.getProposalsForApprover()
      .then(v => setApproverProposals(v))
      .catch(() => setApproverProposals([]));
    spClient.getCredential('ai-config')
      .then(s => { setAiConfigured(s.configured); setAiReady(true); })
      .catch(() => setAiReady(true));
  }, [domain]);

  // SSE-driven refresh: fire on attestation, proposal, or team-membership changes.
  useSSEEvent('attestation-changed', refresh);
  useSSEEvent('proposal-added', refresh);
  useSSEEvent('proposal-resolved', refresh);
  useSSEEvent('proposal-approved', refresh);
  useSSEEvent('proposal-rejected', refresh);
  // Fallback full-sync every 5min in case of missed events (reconnect race, etc.).
  useVisiblePolling(refresh, 300_000, domain);

  const allReady = authsReady && proposalsReady && aiReady && integrationsReady;

  // Compute counts. Revoked auths must drop out of every bucket — they don't
  // grant authority anymore, and the user already saw "Revoked" on the
  // dedicated tab. Mirrors the AuthorizationsPage `getStatus` logic.
  const live = auths.filter(a => a.sp_status !== 'revoked');
  const active = live.filter(a => a.remaining_seconds !== null && a.remaining_seconds > 0);
  const expired = live.filter(a => a.remaining_seconds === null || a.remaining_seconds <= 0);
  const soonExpiring = active.filter(a => a.remaining_seconds !== null && a.remaining_seconds <= EXPIRY_WARN_SECONDS);
  const pendingProposals = proposals.filter(p => p.status === 'pending');
  const runningIntegrations = integrationEntries.filter(e => e.state === 'running');
  const startingIntegrations = integrationEntries.filter(e => e.state === 'starting');
  const attentionIntegrations = integrationEntries.filter(
    e => e.state === 'not-running' || e.state === 'error',
  );
  const todayReceipts = 0; // Could fetch but keep it simple

  // Attention items
  const attentionItems: { label: string; detail: string; to: string; color: string }[] = [];

  // Phase 6: above-cap actions awaiting my review (any team I'm in).
  // One row per proposal so the admin / approver sees what's blocking.
  for (const p of approverProposals) {
    attentionItems.push({
      label: 'Approval needed',
      detail: `${p.tool} — above-cap action under ${shortProfile(p.profileId)}`,
      to: '/proposals',
      color: 'var(--warning)',
    });
  }

  for (const p of pendingProposals) {
    attentionItems.push({
      label: 'Approval pending',
      detail: `${p.tool} awaiting your approval`,
      to: '/proposals',
      color: 'var(--warning)',
    });
  }

  for (const a of soonExpiring) {
    const mins = Math.ceil((a.remaining_seconds ?? 0) / 60);
    attentionItems.push({
      label: 'Expiring soon',
      detail: `${a.title ?? shortProfile(a.profile_id)} — ${mins} min remaining`,
      to: '/authorizations',
      color: 'var(--warning)',
    });
  }

  for (const a of expired) {
    attentionItems.push({
      label: 'Expired',
      detail: a.title ?? shortProfile(a.profile_id),
      to: '/authorizations',
      color: 'var(--danger)',
    });
  }

  for (const e of attentionIntegrations) {
    attentionItems.push({
      label: e.state === 'error' ? 'Integration error' : 'Integration stopped',
      detail: e.state === 'error' && e.integration?.error
        ? `${e.manifest.name}: ${e.integration.error}`
        : `${e.manifest.name} is not running`,
      to: '/integrations',
      color: 'var(--danger)',
    });
  }
  for (const e of startingIntegrations) {
    attentionItems.push({
      label: 'Integration starting',
      detail: `${e.manifest.name} is coming up…`,
      to: '/integrations',
      color: 'var(--warning)',
    });
  }

  if (!aiConfigured) {
    attentionItems.push({
      label: 'AI Assistant',
      detail: 'Not configured — needed for gate advisory',
      to: '/settings',
      color: 'var(--text-tertiary)',
    });
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
      </div>

      {/* Setup guide — gated on the data it reads. Rendering before auths,
          ai config, and integrations have resolved caused a flicker: the
          guide's default evaluation ("nothing is set up yet") made it visible
          for a frame, then the real data flipped every step to "done" and it
          vanished. Waiting for allReady means it either appears once with the
          correct progress, or never appears at all for a fully-set-up user. */}
      {allReady && (
        <SetupGuide
          aiConfigured={aiConfigured}
          hasRunningIntegration={runningIntegrations.length > 0}
          hasActiveAuth={active.length > 0}
          hasAgentConnected={activeSessions > 0}
          mcpEndpoint={`http://localhost:${window.location.port === '3400' ? '3430' : '7430'}`}
        />
      )}

      {/* Status bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
        <Link to="/authorizations" style={{ textDecoration: 'none' }}>
          <div className="card" style={{ padding: '1rem', textAlign: 'center' }}>
            {authsReady ? (
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: active.length > 0 ? 'var(--success)' : 'var(--text-tertiary)' }}>
                {active.length}
              </div>
            ) : (
              <Skeleton variant="title" />
            )}
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Active</div>
          </div>
        </Link>
        <Link to="/proposals" style={{ textDecoration: 'none' }}>
          <div className="card" style={{ padding: '1rem', textAlign: 'center' }}>
            {proposalsReady ? (
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: pendingProposals.length > 0 ? 'var(--warning)' : 'var(--text-tertiary)' }}>
                {pendingProposals.length}
              </div>
            ) : (
              <Skeleton variant="title" />
            )}
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Pending Approvals</div>
          </div>
        </Link>
        <Link to="/authorizations" style={{ textDecoration: 'none' }}>
          <div className="card" style={{ padding: '1rem', textAlign: 'center' }}>
            {authsReady ? (
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: expired.length > 0 ? 'var(--danger)' : 'var(--text-tertiary)' }}>
                {expired.length}
              </div>
            ) : (
              <Skeleton variant="title" />
            )}
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Expired</div>
          </div>
        </Link>
        <Link to="/integrations" style={{ textDecoration: 'none' }}>
          <div className="card" style={{ padding: '1rem', textAlign: 'center' }}>
            {integrationsReady ? (
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: runningIntegrations.length > 0 ? 'var(--success)' : 'var(--text-tertiary)' }}>
                {runningIntegrations.length}
              </div>
            ) : (
              <Skeleton variant="title" />
            )}
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Integrations Running</div>
          </div>
        </Link>
      </div>

      {/* Attention required */}
      {attentionItems.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {attentionItems.map((item, i) => (
            <Link key={i} to={item.to} style={{ textDecoration: 'none' }}>
              <div className="card" style={{ padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{
                  width: '0.5rem',
                  height: '0.5rem',
                  borderRadius: '50%',
                  background: item.color,
                  flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>{item.label}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.detail}</div>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{'\u203A'}</span>
              </div>
            </Link>
          ))}
        </div>
      ) : allReady ? (
        <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>All clear. Nothing needs your attention.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <SkeletonAttentionRow />
          <SkeletonAttentionRow />
          <SkeletonAttentionRow />
        </div>
      )}
    </>
  );
}
