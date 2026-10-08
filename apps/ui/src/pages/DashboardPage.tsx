import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { spClient, type PendingItem, type Proposal, type AgentContact } from '../lib/sp-client';
import { SetupGuide } from '../components/SetupGuide';
import { FirstRunCard } from '../components/FirstRunCard';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useMcpEndpoint } from '../hooks/useMcpEndpoint';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { useSimulationPolicy } from '../hooks/useSimulationPolicy';
import { useManaged } from '../hooks/useManaged';
import { isPendingProposal } from '../lib/pending';
import { useIntegrationStatus } from '../contexts/IntegrationStatusContext';
import { Skeleton, SkeletonAttentionRow } from '../components/Skeleton';
import { RecentBlocks } from '../components/RecentBlocks';
import { SkippedCommitmentsCard } from '../components/SkippedCommitmentsCard';
import { bucketAuths } from '../lib/auth-status';
import { buildIntegrationAttentionItems, buildPausedSummary } from '../lib/integration-attention';
import { deriveFirstRunCard } from '../lib/first-run-card';

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
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const [proposalsReady, setProposalsReady] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const [contact, setContact] = useState<AgentContact | null>(null);
  const [contactReady, setContactReady] = useState(false);
  const { entries: integrationEntries, activeSessions, loading: integrationsLoading } = useIntegrationStatus();
  const mcpEndpoint = useMcpEndpoint();
  const integrationsReady = !integrationsLoading;
  // null until /health answers — the dashboard waits for it (allReady), so a
  // simulation-mode user never sees the live-mode guide flash first.
  const { simulation } = useSimulationPolicy();
  const simulationOn = simulation === true;
  const managed = useManaged();

  const refresh = useCallback(() => {
    // Fire-and-forget in parallel. Each call flips only its own ready flag,
    // so a slow SP response doesn't delay the cards that finished fast.
    spClient.getMyAttestations()
      .then(v => { setAuths(v); setAuthsReady(true); })
      .catch(() => setAuthsReady(true));
    spClient.getArchivedMandates()
      .then(setArchivedIds)
      .catch(() => setArchivedIds([]));
    spClient.getMyProposals(domain)
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
    // Drives the first-run card's "Connect your AI" step — null means no AI
    // has ever completed an MCP handshake with this gateway (not "none is
    // connected right now", which would forget a closed Claude Desktop).
    spClient.getAgentContact()
      .then(v => { setContact(v.contact); setContactReady(true); })
      .catch(() => setContactReady(true));
  }, [domain]);

  // SSE-driven refresh: fire on attestation, proposal, or team-membership changes.
  useSSEEvent('attestation-changed', refresh);
  useSSEEvent('proposal-added', refresh);
  useSSEEvent('proposal-resolved', refresh);
  useSSEEvent('proposal-approved', refresh);
  useSSEEvent('proposal-rejected', refresh);
  // Fallback full-sync every 5min in case of missed events (reconnect race, etc.).
  useVisiblePolling(refresh, 300_000, domain);

  const allReady = authsReady && proposalsReady && aiReady && integrationsReady && contactReady && simulation !== null;

  // Bucket through the shared helper so this surface, the Sidebar badge,
  // and the Authorizations page never disagree on what counts as
  // active / expired / revoked. See lib/auth-status.ts.
  const buckets = bucketAuths(auths, { archivedSet: new Set(archivedIds) });
  const active = buckets.active;
  const expired = buckets.expired;
  // First-run card inputs — see lib/first-run-card.ts. "Delegation" here
  // means an ACTIVE mandate for that profile, not merely having once had one.
  const hasDelegationMandate = active.some(a => shortProfile(a.profile_id) === 'delegation');
  const otherMandateCount = active.filter(a => shortProfile(a.profile_id) !== 'delegation').length;
  // getMyProposals returns the whole history for the domain (pending AND
  // decided), which is exactly "has a proposal ever arrived" — see
  // lib/pending.ts's isPendingProposal for the narrower "still waiting" filter
  // used elsewhere on this page.
  const delegationProposalCount = proposals.filter(p => shortProfile(p.profileId) === 'delegation').length;
  const firstRun = deriveFirstRunCard({
    hasContact: contact !== null,
    hasDelegationMandate,
    otherMandateCount,
    delegationProposalCount,
    managed,
    simulationOn,
  });
  // The first-run card belongs to simulation mode, where the Delegation mandate
  // exists and the person's AI sets up the rest. Outside it, the live-mode
  // SetupGuide stays; inside it, that guide never shows — once the card is done
  // the person is set up through their AI, and the guide's four steps would
  // contradict it.
  const showFirstRun = simulationOn && firstRun.visible;
  const soonExpiring = active.filter(a => a.remaining_seconds !== null && a.remaining_seconds <= EXPIRY_WARN_SECONDS);
  const pendingProposals = proposals.filter(isPendingProposal);
  const runningIntegrations = integrationEntries.filter(e => e.state === 'running');
  const startingIntegrations = integrationEntries.filter(e => e.state === 'starting');
  // Paused (simulation-blocked) integrations are deliberately excluded here —
  // see buildIntegrationAttentionItems. They get one calm summary line
  // instead (pausedSummary, below), not an attention row each.
  const pausedSummary = buildPausedSummary(integrationEntries);
  const todayReceipts = 0; // Could fetch but keep it simple

  // Attention items
  const attentionItems: { label: string; detail: string; to: string; color: string }[] = [];

  // Phase 6: above-cap actions awaiting my review (any team I'm in).
  // One row per proposal so the admin / approver sees what's blocking.
  for (const p of approverProposals) {
    attentionItems.push({
      label: 'Approval needed',
      detail: `${p.tool} — above-cap action under ${shortProfile(p.profileId)}`,
      to: '/approvals',
      color: 'var(--warning)',
    });
  }

  for (const p of pendingProposals) {
    attentionItems.push({
      label: 'Approval pending',
      detail: `${p.tool} awaiting your approval`,
      to: '/approvals',
      color: 'var(--warning)',
    });
  }

  for (const a of soonExpiring) {
    const mins = Math.ceil((a.remaining_seconds ?? 0) / 60);
    attentionItems.push({
      label: 'Expiring soon',
      detail: `${a.title ?? shortProfile(a.profile_id)} — ${mins} min remaining`,
      to: '/mandates',
      color: 'var(--warning)',
    });
  }

  for (const a of expired) {
    attentionItems.push({
      label: 'Expired',
      detail: a.title ?? shortProfile(a.profile_id),
      to: '/mandates',
      color: 'var(--danger)',
    });
  }

  attentionItems.push(...buildIntegrationAttentionItems(integrationEntries, simulationOn));
  for (const e of startingIntegrations) {
    attentionItems.push({
      label: 'Integration starting',
      detail: `${e.manifest.name} is coming up…`,
      to: '/integrations',
      color: 'var(--warning)',
    });
  }
  // A running subprocess with a dead OAuth token (e.g. an expired LinkedIn
  // access token): the process is fine, but nothing it does will work until
  // the human reconnects. Not covered by attentionIntegrations (those are
  // process-down); surface it as its own row. Skip already-down ones to
  // avoid a duplicate row.
  for (const e of integrationEntries) {
    if (e.authStatus === 'failed' && e.state !== 'not-running' && e.state !== 'error' && e.state !== 'paused') {
      attentionItems.push({
        label: 'Reconnect needed',
        detail: `${e.manifest.name}: authorization expired — reconnect to restore access`,
        to: '/integrations',
        color: 'var(--danger)',
      });
    }
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

      {/* First-run card takes over from the generic setup guide while there is
          no mandate besides (maybe) Delegation — see lib/first-run-card.ts.
          Both wait for allReady: rendering before auths, ai config,
          integrations, and agent contact have resolved caused a flicker (the
          guide's default evaluation made it visible for a frame, then the
          real data flipped every step to "done" and it vanished). Waiting for
          allReady means it either appears once with the correct progress, or
          never appears at all for a fully-set-up user. */}
      {allReady && mcpEndpoint && (
        showFirstRun ? (
          <FirstRunCard
            contact={contact}
            hasDelegationMandate={hasDelegationMandate}
            otherMandateCount={otherMandateCount}
            delegationProposalCount={delegationProposalCount}
            managed={managed}
            simulationOn={simulationOn}
            mcpEndpoint={mcpEndpoint}
          />
        ) : !simulationOn && (
          <SetupGuide
            aiConfigured={aiConfigured}
            hasRunningIntegration={runningIntegrations.length > 0}
            hasActiveAuth={active.length > 0}
            hasAgentConnected={activeSessions > 0}
            mcpEndpoint={mcpEndpoint}
          />
        )
      )}

      {/* Stats + "Needs your attention" stay hidden while the first-run card
          shows — an all-zero grid and an empty "All clear" ahead of the
          card's one action would just be noise before anything exists yet. */}
      {!showFirstRun && <>
      {/* Status bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
        <Link to="/mandates" style={{ textDecoration: 'none' }}>
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
        <Link to="/approvals" style={{ textDecoration: 'none' }}>
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
        <Link to="/mandates" style={{ textDecoration: 'none' }}>
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

      {/* Needs your attention — same shape as Recent blocks: the heading names
          the category, the rows or the green "All clear" give the answer. */}
      <section className="card attention" aria-label="Needs your attention">
        <div className="card-header">
          <h2 className="card-title">Needs your attention</h2>
          {attentionItems.length > 0 && <span className="rb-count">{attentionItems.length}</span>}
        </div>
        {attentionItems.length > 0 ? (
          <div className="attention-rows">
            {attentionItems.map((item, i) => (
              <Link key={i} to={item.to} className="attention-row">
                <span className="attention-dot" style={{ background: item.color }} aria-hidden="true" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>{item.label}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.detail}</div>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{'\u203A'}</span>
              </Link>
            ))}
          </div>
        ) : allReady ? (
          <div className="all-clear">
            <span className="rb-mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </span>
            <h3>All clear</h3>
            <p>Nothing needs your attention.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <SkeletonAttentionRow />
            <SkeletonAttentionRow />
            <SkeletonAttentionRow />
          </div>
        )}
      </section>
      </>}

      {/* Real systems paused by simulation mode — one calm line, not an
          attention row per connector. Only rendered while something IS
          paused (see buildPausedSummary); otherwise simulation mode is either
          off, or nothing real is registered yet. */}
      {pausedSummary && (
        <div className="sim-paused-summary" role="status">
          <span className="sim-paused-summary-icon" aria-hidden="true">&#9208;</span>
          <span>
            <b>
              {pausedSummary.count} real system{pausedSummary.count === 1 ? '' : 's'}{' '}
              {pausedSummary.count === 1 ? 'is' : 'are'} paused
            </b>{' '}
            while simulation mode is on — {pausedSummary.namesText}.
          </span>
        </div>
      )}

      {/* Approved commitments this gateway won't execute (submitted elsewhere) */}
      <SkippedCommitmentsCard />

      {/* Recent read-blocks — the trust signal: a limit you set vs a malfunction */}
      <RecentBlocks />
    </>
  );
}
