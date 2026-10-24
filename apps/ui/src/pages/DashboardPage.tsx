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
import { Skeleton } from '../components/Skeleton';
import { RecentBlocks } from '../components/RecentBlocks';
import { CoreColumns } from '../components/CoreColumns';
import { ReportLine } from '../components/ReportLine';
import { SkippedCommitmentsCard } from '../components/SkippedCommitmentsCard';
import { bucketAuths } from '../lib/auth-status';
import { buildIntegrationAttentionItems, buildPausedSummary } from '../lib/integration-attention';
import { deriveFirstRunCard } from '../lib/first-run-card';
import { AI_ASSISTANT_VISIBLE } from '../lib/ai-assistant';

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
  useSSEEvent('execution-failed', refresh);
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
  // UI spec §12.4: approvals waiting for me — my domain's and those routed to
  // me as approver — once each.
  const waiting = [...pendingProposals, ...approverProposals.filter(a => !pendingProposals.some(p => p.id === a.id))];

  // Attention items
  const attentionItems: { label: string; detail: string; to: string; color: string }[] = [];

  for (const a of soonExpiring) {
    const mins = Math.ceil((a.remaining_seconds ?? 0) / 60);
    attentionItems.push({
      label: 'Expiring soon',
      detail: `${a.title ?? shortProfile(a.profile_id)} — ${mins} min remaining`,
      to: '/mandates',
      color: 'var(--text-primary)',
    });
  }

  for (const a of expired) {
    attentionItems.push({
      label: 'Expired',
      detail: a.title ?? shortProfile(a.profile_id),
      to: '/mandates',
      color: 'var(--text-primary)',
    });
  }

  attentionItems.push(...buildIntegrationAttentionItems(integrationEntries, simulationOn));
  for (const e of startingIntegrations) {
    attentionItems.push({
      label: 'Integration starting',
      detail: `${e.manifest.name} is coming up…`,
      to: '/integrations',
      color: 'var(--text-primary)',
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
        color: 'var(--text-primary)',
      });
    }
  }

  // TO BE INVESTIGATED: the AI assistant is hidden for now (lib/ai-assistant.ts).
  if (AI_ASSISTANT_VISIBLE && !aiConfigured) {
    attentionItems.push({
      label: 'AI Assistant',
      detail: 'Not configured — needed for gate advisory',
      to: '/settings',
      color: 'var(--text-tertiary)',
    });
  }

  return (
    <div className="dash-page">
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
      {/* UI spec §12.4 — the three core-object columns */}
      <CoreColumns auths={auths} activeCount={active.length} waiting={waiting} waitingReady={proposalsReady} />
      {/* A new report waits to be read — one line, gone once it is opened. */}
      <ReportLine />

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

      {/* New blocks — the closed BLOCKED rows of the Blocked page (§18.5) */}
      <RecentBlocks />

      {/* Setup problems — shown only when there are any; at the bottom, one
          plain card, no dots or lines (UI spec §18.5). */}
      {!showFirstRun && attentionItems.length > 0 && (
      <section className="dash-sec" aria-label="Setup — needs attention">
        <div className="core-col-h">
          <h2>Setup — needs attention</h2>
          <span className="pill-count">{attentionItems.length}</span>
        </div>
        <div className="ob-card dash-att">
          {attentionItems.map((item, i) => (
            <Link key={i} to={item.to} className="dash-att-row">
              <b>{item.label}</b>
              <span>{item.detail}</span>
              <i aria-hidden="true">{'\u203A'}</i>
            </Link>
          ))}
        </div>
      </section>
      )}
    </div>
  );
}
