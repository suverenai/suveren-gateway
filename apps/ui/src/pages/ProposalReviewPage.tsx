import { useState, useCallback, useMemo, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { spClient, type Proposal, type ExecutionReceipt, type IntegrationManifest, type ProposalOutcome, type NoteEncryptedWire } from '../lib/sp-client';
import { aggregateThread, type ThreadItem } from '../lib/thread-aggregator';
import { ActionCard } from '../components/ActionCard';
import { ApproverProposalCard } from '../components/ApproverProposalCard';
import { profileDisplayName } from '../lib/profile-display';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';
import type { ToolDisplay } from '../lib/approval-view';
import { resolveDomainFor } from '../lib/my-queue';
import { ProfileRail } from '../components/ProfileRail';
import { HumanOnlyNote } from '../components/HumanOnlyNote';
import { isAutomatedBrowser, AUTOMATION_REFUSAL } from '../lib/automation';
import { isTestSetupAction, profileIdentity } from '../lib/profile-identity';
import { rejectOutcomeArgs, changeNeededOutcomeArgs } from '../lib/reject-outcome';
import { contentHashForDecision, noteRecipients } from '../lib/use-proposal-content';
import { useApprovalTeamInfo } from '../lib/approval-team-info';
import { isProposer as isProposerOf, visibleApprovers } from '../lib/proposal-proposer';

type QueueTab = 'awaiting-me' | 'awaiting-others' | 'all';
type StatusFilter = 'pending' | 'all';

/**
 * ProposalReviewPage — /proposals
 *
 * Phase 6: Three-tab view:
 *  - Awaiting me: above-cap proposals where I'm in pendingApprovers and haven't approved.
 *  - Awaiting others: proposals I authored or approved that are still pending on others.
 *  - All: existing domain-based proposal + receipt thread (legacy flow).
 */
export function ProposalReviewPage() {
  const { domain, user } = useAuth();
  const userId = user?.id ?? '';

  const [queueTab, setQueueTab] = useState<QueueTab>('awaiting-me');

  // ─── Awaiting me (Phase 6 per-action approver proposals) ──────────────
  const [approverProposals, setApproverProposals] = useState<Proposal[]>([]);
  // Manifests supply the inspection links shown on an approval card. Fetched
  // once: without them the reviewer sees identifiers and nothing to open, which
  // turns approving into signing.
  const [manifests, setManifests] = useState<IntegrationManifest[]>([]);
  const [toolDisplay, setToolDisplay] = useState<Record<string, ToolDisplay>>({});
  const [approverLoading, setApproverLoading] = useState(true);
  const [approverMessage, setApproverMessage] = useState('');

  const fetchApproverProposals = useCallback(async () => {
    try {
      const proposals = await spClient.getProposalsForApprover();
      setApproverProposals(proposals);
    } catch {
      // keep previous state on background refresh
    } finally {
      setApproverLoading(false);
    }
  }, []);

  useSSEEvent('proposal-added', fetchApproverProposals);
  useSSEEvent('proposal-approved', fetchApproverProposals);
  useSSEEvent('proposal-rejected', fetchApproverProposals);
  useSSEEvent('proposal-resolved', fetchApproverProposals);
  useVisiblePolling(fetchApproverProposals, 30_000);

  // ─── Awaiting others (proposals I authored or already approved, still pending) ──
  // We derive these from the same approverProposals scan + domain proposals.
  const [myProposals, setMyProposals] = useState<Proposal[]>([]);

  const fetchMyProposals = useCallback(async () => {
    try {
      const ps = await spClient.getMyProposals(domain);
      // Also include above-cap proposals where I'm the creator but already approved.
      setMyProposals(ps);
    } catch {
      // keep previous state
    }
  }, [domain]);

  useSSEEvent('proposal-added', fetchMyProposals);
  useSSEEvent('proposal-approved', fetchMyProposals);
  useSSEEvent('proposal-rejected', fetchMyProposals);
  useSSEEvent('proposal-resolved', fetchMyProposals);
  // An approved proposal here can still fail downstream, after the ticket —
  // see commitments.ts / OutcomeBox. Refresh so the failure is visible
  // without waiting for the next poll.
  useSSEEvent('execution-failed', fetchMyProposals);
  useVisiblePolling(fetchMyProposals, 30_000, domain);

  // Review-mode (domain-scoped) proposals I'm responsible for approving: pending
  // proposals in MY domain queue with no Phase-6 above-cap approver list — i.e.
  // the "Send with Review" flow. These belong in "Awaiting me" (I'm the domain
  // owner/reviewer), NOT "Awaiting others". Above-cap proposals (pendingApprovers
  // set) are surfaced separately via approverProposals.
  const pendingDomainProposals = useMemo(
    () => myProposals.filter(
      p => p.status === 'pending' && (p.pendingApprovers?.length ?? 0) === 0,
    ),
    [myProposals],
  );
  const awaitingMeDomainItems = useMemo(
    () => aggregateThread(pendingDomainProposals, [], { status: 'pending' }),
    [pendingDomainProposals],
  );

  // Phase 6: Above-cap proposals where I already approved but others haven't yet.
  const [approvedByMeStillPending, setApprovedByMeStillPending] = useState<Proposal[]>([]);

  const fetchApprovedByMe = useCallback(async () => {
    if (!userId) return;
    try {
      // We have no dedicated endpoint for this yet. Derive from domain proposals
      // that have pendingApprovers (above-cap) and userId in approvedBy.
      // For v1 this queries domain proposals — above-cap proposals also exist
      // in the domain index (pendingDomains is [] but they're still by authorizationId).
      // The simplest v1 approach: re-use getProposals + filter client-side.
      // This works because above-cap proposals are still stored per frame, not per domain.
      // The domain query may miss them — but the SP returns all pending proposals
      // including those with empty pendingDomains. Good enough for v1.
      const ps = await spClient.getMyProposals(domain);
      const mine = ps.filter(p =>
        p.status === 'pending' &&
        p.pendingApprovers &&
        p.pendingApprovers.includes(userId) &&
        p.approvedBy &&
        userId in p.approvedBy,
      );
      setApprovedByMeStillPending(mine);
    } catch {
      // keep previous state
    }
  }, [userId, domain]);

  useSSEEvent('proposal-approved', fetchApprovedByMe);
  useSSEEvent('proposal-rejected', fetchApprovedByMe);
  useVisiblePolling(fetchApprovedByMe, 30_000, `${userId}:${domain}`);

  // Above-cap proposals I CREATED, still pending (2026-10-15, real-gateway
  // e2e). Primary source: the AS's own creator-scoped query (suveren-as#89,
  // GET /api/proposals?creator=me) — works across every device, not just
  // this one. `getProposalsCreatedByMe` returns `null` on a 400, the one
  // way to tell an OLDER AS that doesn't support the mode yet from
  // "genuinely nothing pending" — only THEN fall back to the gateway's own
  // local submission record (sp-client.ts's getMyPendingProposals doc
  // comment: only ever sees proposals submitted through THIS gateway
  // install). Never both at once — one list replaces the other outright,
  // so a proposal can never appear twice.
  const [myPendingProposals, setMyPendingProposals] = useState<Proposal[]>([]);

  const fetchMyPendingProposals = useCallback(async () => {
    try {
      const fromAS = await spClient.getProposalsCreatedByMe();
      if (fromAS !== null) {
        setMyPendingProposals(fromAS);
        return;
      }
      setMyPendingProposals(await spClient.getMyPendingProposals());
    } catch {
      // keep previous state
    }
  }, []);

  useSSEEvent('proposal-added', fetchMyPendingProposals);
  useSSEEvent('proposal-approved', fetchMyPendingProposals);
  useSSEEvent('proposal-rejected', fetchMyPendingProposals);
  useVisiblePolling(fetchMyPendingProposals, 30_000);

  // Initial load
  useEffect(() => {
    spClient.getIntegrationManifests()
      .then(d => setManifests(d.manifests ?? []))
      .catch(() => { /* links are an enhancement — never block review on them */ });
    spClient.getToolDisplay()
      .then(setToolDisplay)
      .catch(() => { /* labels are an enhancement — the card still shows every argument */ });
  }, []);

  // The tool is namespaced `<integrationId>__<tool>`, which is the only link
  // back from a proposal to the connector that produced it.
  const linksForTool = (tool: string) =>
    manifests.find(m => m.id === tool.split('__')[0])?.proposalLinks;

  useEffect(() => {
    void fetchApproverProposals();
    void fetchMyProposals();
    void fetchApprovedByMe();
    void fetchMyPendingProposals();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── "All" tab — existing legacy domain thread ──────────────────────────
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [receipts, setReceipts] = useState<ExecutionReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [profileFilter, setProfileFilter] = useState<string | null>(null);
  const [includeAutonomous, setIncludeAutonomous] = useState(false);

  const fetchThread = useCallback(async () => {
    try {
      const { proposals: ps, receipts: rs } = await spClient.getThread({
        domain,
        status: statusFilter,
        sinceDays: 7,
      });
      setProposals(ps);
      setReceipts(rs);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [domain, statusFilter]);

  useVisiblePolling(fetchThread, 30_000, `${domain}:${statusFilter}`);

  const handleResolve = async (
    id: string,
    action: 'commit' | 'reject',
    opts?: { outcome?: ProposalOutcome; note?: string },
    /** AU10 §8.4 — already computed by ActionCard (it owns the ApprovalBody
     *  snapshot and POSTs it to the control plane before calling this). */
    shownHash?: string,
  ) => {
    // Automation that announces itself may not approve (defense in depth — lib/automation.ts).
    if (action === 'commit' && isAutomatedBrowser()) { setMessage(AUTOMATION_REFUSAL); return; }
    setResolving(id);
    setMessage('');
    try {
      // Resolve under the proposal's own queue — a personal one stays 'owner' in team context.
      const proposal = proposals.find(p => p.id === id) ?? myProposals.find(p => p.id === id);
      const resolveDomain = resolveDomainFor(proposal, domain);
      // PE1 — the fingerprint of what THIS device decrypted and showed.
      const contentHash = proposal ? await contentHashForDecision(proposal) : undefined;
      // G5 — a change-needed note is sealed on THIS (the deciding) gateway
      // for exactly who can already read the proposal's own content
      // (content.keys' own userIds — the submitter, the owner, every
      // approver) plus this device's own signed-in user.
      let resolveOpts: { outcome?: ProposalOutcome; note?: string; noteEncrypted?: NoteEncryptedWire } = opts ?? {};
      if (opts?.outcome === 'change_needed' && opts.note) {
        const recipientUserIds = proposal ? noteRecipients(proposal, userId) : [userId];
        const { noteEncrypted } = await spClient.encryptProposalNote(opts.note, recipientUserIds);
        resolveOpts = { outcome: 'change_needed', noteEncrypted };
      }
      const result = await spClient.resolveProposal(id, action, resolveDomain, { ...resolveOpts, contentHash, shownHash });
      setMessage(
        action === 'commit'
          ? `Action approved. Status: ${result.status}`
          : opts?.outcome === 'change_needed' ? 'Sent back for a change.' : 'Action rejected.',
      );
      // Refresh the All thread AND the awaiting-me domain queue so a just-approved
      // review-mode proposal leaves the "Awaiting me" tab immediately.
      await Promise.all([fetchThread(), fetchMyProposals()]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed');
    } finally {
      setResolving(null);
    }
  };

  const handleApprove = (id: string, shownHash?: string) => handleResolve(id, 'commit', undefined, shownHash);
  const handleReject = (id: string, shownHash?: string) => handleResolve(id, 'reject', rejectOutcomeArgs(), shownHash);

  /** "Send back for change" (RJ2) — note already validated by ActionCard. */
  const handleChangeNeeded = (id: string, note: string, shownHash?: string) =>
    handleResolve(id, 'reject', changeNeededOutcomeArgs(note), shownHash);

  const profileIds = useMemo(() => {
    const set = new Set<string>();
    for (const p of proposals) set.add(p.profileId);
    for (const r of receipts) set.add(r.profileId);
    return Array.from(set).sort();
  }, [proposals, receipts]);

  const items: ThreadItem[] = useMemo(
    () => aggregateThread(proposals, receipts, {
      status: statusFilter,
      profile: profileFilter ?? undefined,
      includeAutonomous,
    }),
    [proposals, receipts, statusFilter, profileFilter, includeAutonomous],
  );

  // ─── Awaiting me callback (from ApproverProposalCard) ─────────────────
  const handleApproverAction = useCallback(() => {
    void fetchApproverProposals();
    void fetchApprovedByMe();
  }, [fetchApproverProposals, fetchApprovedByMe]);

  // ─── Combined awaiting-others list ────────────────────────────────────
  // Genuinely "awaiting others" = above-cap proposals I already approved
  // that are still pending on other approvers, PLUS above-cap proposals I
  // CREATED that are still pending (myPendingProposals — see its own doc
  // comment: a stand-in until the AS has a creator-scoped query). Review-mode
  // domain proposals are NOT here — they're mine to approve and live under
  // "Awaiting me".
  const awaitingOthersAll = useMemo(() => {
    const seen = new Set<string>();
    const result: Proposal[] = [];
    for (const p of [...approvedByMeStillPending, ...myPendingProposals]) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        result.push(p);
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }, [approvedByMeStillPending, myPendingProposals]);

  // Badge counts for tab headers
  const awaitingMeCount = approverProposals.length + awaitingMeDomainItems.length;
  const awaitingOthersCount = awaitingOthersAll.length;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Pending Approvals</h1>
        <p className="page-subtitle">
          Actions awaiting approval, plus recent activity from the last 7 days.
        </p>
        <HumanOnlyNote what="approve" />
      </div>

      {/* Queue tab strip */}
      <div className="nav-tabs" style={{ marginBottom: '1rem' }}>
        <button
          className={`nav-tab${queueTab === 'awaiting-me' ? ' active' : ''}`}
          onClick={() => setQueueTab('awaiting-me')}
        >
          Awaiting me {awaitingMeCount > 0 && <span style={{ marginLeft: '0.4rem', background: 'var(--warning)', color: 'var(--bg-elevated)', borderRadius: '0.625rem', padding: '0 0.375rem', fontSize: '0.7rem', fontWeight: 600 }}>{awaitingMeCount}</span>}
        </button>
        <button
          className={`nav-tab${queueTab === 'awaiting-others' ? ' active' : ''}`}
          onClick={() => setQueueTab('awaiting-others')}
        >
          Awaiting others {awaitingOthersCount > 0 && <span style={{ marginLeft: '0.4rem', background: 'var(--border)', color: 'var(--text-secondary)', borderRadius: '0.625rem', padding: '0 0.375rem', fontSize: '0.7rem', fontWeight: 600 }}>{awaitingOthersCount}</span>}
        </button>
        <button
          className={`nav-tab${queueTab === 'all' ? ' active' : ''}`}
          onClick={() => { setQueueTab('all'); void fetchThread(); }}
        >
          All
        </button>
      </div>

      {/* ─── Awaiting me ────────────────────────────────────────────── */}
      {queueTab === 'awaiting-me' && (
        <>
          {approverLoading && awaitingMeCount === 0 ? (
            <p style={{ color: 'var(--text-tertiary)' }}>Loading...</p>
          ) : awaitingMeCount === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
              <p style={{ color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
                No actions awaiting your approval.
              </p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                Review-mode actions and above-cap actions you must approve will appear here.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {(approverMessage || message) && (
                <div className="alert alert-success">{approverMessage || message}</div>
              )}
              {/* Review-mode ("Send with Review") proposals I must approve. */}
              {awaitingMeDomainItems.map(item => (
                <ActionCard
                  key={item.id}
                  proposalLinks={item.kind === 'proposal' ? linksForTool(item.proposal.tool) : undefined}
                  toolDisplay={item.kind === 'proposal' ? toolDisplay[item.proposal.tool] : undefined}
                  manifests={manifests}
                  currentUserId={userId}
                  item={item}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onChangeNeeded={handleChangeNeeded}
                  resolving={resolving === item.id}
                />
              ))}
              {/* Above-cap proposals where I'm a required approver. */}
              {approverProposals.map(proposal => (
                <ApproverProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  currentUserId={userId}
                  onAction={handleApproverAction}
                  onMessage={setApproverMessage}
                  proposalLinks={linksForTool(proposal.tool)}
                  toolDisplay={toolDisplay[proposal.tool]}
                  manifests={manifests}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ─── Awaiting others ─────────────────────────────────────────── */}
      {queueTab === 'awaiting-others' && (
        <>
          {awaitingOthersAll.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
              <p style={{ color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
                No actions waiting on others.
              </p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                Actions you proposed or approved that are pending other approvers will appear here.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {awaitingOthersAll.map(proposal => (
                <AwaitingOthersCard
                  key={proposal.id}
                  proposal={proposal}
                  currentUserId={userId}
                  onCancel={async () => {
                    try {
                      await spClient.rejectProposal(proposal.id, { reason: 'cancelled by creator' });
                      void fetchApprovedByMe();
                      void fetchMyProposals();
                    } catch (err) {
                      alert(err instanceof Error ? err.message : 'Cancel failed');
                    }
                  }}
                  onWithdraw={async () => {
                    // No `shown_hash`: this card does not render the AU10
                    // preview/request-context pipeline (ApprovalBody) that
                    // produces one — nothing here is a "what was shown"
                    // read to fingerprint, so it is omitted rather than
                    // invented. `content_hash` still applies (PE1): the
                    // proposal's own content fingerprint, independent of
                    // any rendering.
                    const contentHash = await contentHashForDecision(proposal);
                    await spClient.withdrawProposal(proposal.id, undefined, contentHash);
                    void fetchMyPendingProposals();
                    void fetchApprovedByMe();
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ─── All (legacy domain thread) ──────────────────────────────── */}
      {queueTab === 'all' && (
        <>
          {message && (
            <div className="alert alert-success" style={{ marginBottom: '1rem' }}>{message}</div>
          )}

          <div className="filter-chips" style={{ marginBottom: '1rem' }}>
            <button
              className={`filter-chip ${statusFilter === 'pending' ? 'selected' : ''}`}
              onClick={() => setStatusFilter('pending')}
            >
              Pending
            </button>
            <button
              className={`filter-chip ${statusFilter === 'all' ? 'selected' : ''}`}
              onClick={() => setStatusFilter('all')}
            >
              All
            </button>

            {profileIds.length > 0 && (
              <span style={{ width: 1, background: 'var(--border)', alignSelf: 'stretch', margin: '0 0.25rem' }} />
            )}

            {profileIds.map((pid) => (
              <button
                key={pid}
                className={`filter-chip ${profileFilter === pid ? 'selected' : ''}`}
                onClick={() => setProfileFilter(profileFilter === pid ? null : pid)}
              >
                {profileDisplayName(pid)}
              </button>
            ))}

            {statusFilter === 'all' && (
              <>
                <span style={{ width: 1, background: 'var(--border)', alignSelf: 'stretch', margin: '0 0.25rem' }} />
                <button
                  className={`filter-chip ${includeAutonomous ? 'selected' : ''}`}
                  onClick={() => setIncludeAutonomous(!includeAutonomous)}
                  title="Include actions executed without human review (automatic commitment mode)"
                >
                  {includeAutonomous ? '✓ ' : ''}Autonomous actions
                </button>
              </>
            )}
          </div>

          {loading && items.length === 0 ? (
            <p style={{ color: 'var(--text-tertiary)' }}>Loading...</p>
          ) : items.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
              <p style={{ color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
                {statusFilter === 'pending' ? 'No actions awaiting your approval.' : 'Nothing here yet.'}
              </p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                {statusFilter === 'pending'
                  ? 'Your agents are operating within their mandates. Switch to All to see recent activity.'
                  : 'When an agent calls a gated tool, activity will appear here.'}
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {items.map((item) => (
                <ActionCard
                  key={item.id}
                  proposalLinks={item.kind === 'proposal' ? linksForTool(item.proposal.tool) : undefined}
                  toolDisplay={item.kind === 'proposal' ? toolDisplay[item.proposal.tool] : undefined}
                  manifests={manifests}
                  currentUserId={userId}
                  item={item}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onChangeNeeded={handleChangeNeeded}
                  resolving={resolving === item.id}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

// ─── AwaitingOthersCard ─────────────────────────────────────────────────────

interface AwaitingOthersCardProps {
  proposal: Proposal;
  currentUserId: string;
  onCancel: () => void;
  /** suveren-as#89 — the proposer withdraws their own still-pending
   *  above-cap proposal (the Cancel/reject route is closed to them: TR5
   *  excludes the proposer from pendingApprovers). */
  onWithdraw: () => Promise<void>;
}

function formatAge(unixSeconds: number): string {
  const ageMs = Date.now() - unixSeconds * 1000;
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function AwaitingOthersCard({ proposal, currentUserId, onCancel, onWithdraw }: AwaitingOthersCardProps) {
  const [cancelling, setCancelling] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState('');

  // TR5 (real-gateway e2e, 2026-10-15) — the SAME approver roster/name
  // resolution as ApproverProposalCard, so the proposer's own "Awaiting
  // others" view of this proposal reads identically to how an approver
  // sees it: "Needs N approval(s) from: …", never a raw-id tally.
  const team = useApprovalTeamInfo(proposal);
  const isProposer = isProposerOf(proposal, currentUserId);
  const approvers = visibleApprovers(proposal);
  const approvedBy = proposal.approvedBy ?? {};
  const approvedCount = Object.keys(approvedBy).length;
  const isAboveCap = approvers.length > 0;

  const handleCancel = async () => {
    if (!confirm('Cancel this action? All approvers will be notified.')) return;
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  };

  // suveren-as#89 — the proposer's own way to end their still-pending
  // above-cap proposal (the reject route is closed to them, see the
  // `isProposer` branch below). A withdrawn proposal can never be
  // approved/executed afterward.
  const handleWithdraw = async () => {
    if (!confirm('Withdraw this action? It can never be approved afterward.')) return;
    setWithdrawing(true);
    setWithdrawError('');
    try {
      await onWithdraw();
    } catch (err) {
      setWithdrawError(err instanceof Error ? err.message : 'Withdraw failed');
    } finally {
      setWithdrawing(false);
    }
  };

  const testSetup = profileIdentity(proposal.profileId).testSetup || isTestSetupAction(proposal.tool);

  return (
    <div className="card id-card">
      <ProfileRail profileId={proposal.profileId} />
      <div className="id-body">
      {/* Decided (real-gateway e2e, 2026-10-15): plain words only — same as
          ApproverProposalCard — the "Above the team limit: …" line below
          already says it; no "Above cap" jargon pill. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <code style={{ fontSize: '0.85rem' }}>{proposal.tool.split('__').pop() ?? proposal.tool}</code>
        {testSetup && <span className="sim-mark">Test setup</span>}
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
          {formatAge(proposal.createdAt)}
        </span>
      </div>

      {/* TR5 — "Needs N approval(s) from: …", the SAME wording and name
          resolution as ApproverProposalCard (never the old raw per-user
          "X approved" / "Waiting on <uuid>" tally). */}
      {isAboveCap && (
        <div className="approver-progress" style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
          Needs {team.requiredApprovals} approval{team.requiredApprovals === 1 ? '' : 's'} from:{' '}
          {approvers.map((uid, i) => (
            <span key={uid} className={`who${uid in approvedBy ? ' done' : ''}`} style={{ marginLeft: i === 0 ? '0.25rem' : '0.5rem', color: uid in approvedBy ? 'var(--success)' : undefined }}>
              {uid in approvedBy ? '✓ ' : ''}{team.nameOf(uid)}{uid === currentUserId ? ' (you)' : ''}
              {i < approvers.length - 1 ? ',' : ''}
            </span>
          ))}
          {team.requiredApprovals > 1 && (
            <span style={{ marginLeft: '0.5rem' }}>({approvedCount} of {team.requiredApprovals})</span>
          )}
        </div>
      )}

      {/* TR5 — "Above the team limit: <field> <value> (limit <cap>). Requested
          by <proposer>." Same construction as ApproverProposalCard
          (team-caps.ts's findAboveCapViolation — built only from real data,
          never a guess). */}
      {team.aboveCapReason && (
        <div className="over-limit-box" data-testid="above-cap-reason" style={{
          display: 'flex', gap: '0.5rem', alignItems: 'flex-start',
          background: 'var(--bg-main)', border: '1px solid var(--border)',
          borderRadius: '0.5rem', padding: '0.6rem 0.8rem', marginBottom: '0.6rem', fontSize: '0.82rem',
        }}>
          <span style={{ color: 'var(--warning)', fontWeight: 700, whiteSpace: 'nowrap' }}>Above the team limit:</span>
          <span>
            {team.aboveCapReason.fieldLabel}
            {team.aboveCapReason.value !== undefined ? ` ${team.aboveCapReason.value}` : ''} (limit {String(team.aboveCapReason.cap)}).{' '}
            {proposal.createdBy ? `Requested by ${team.nameOf(proposal.createdBy)}.` : ''}
          </span>
        </div>
      )}

      {/* TR5 — the proposer can never approve their own action; said in
          plain words here too, same as ApproverProposalCard, even though
          this card never had an Approve button to replace. */}
      {isAboveCap && isProposer && (
        <p data-testid="cant-approve-own-action" style={{ fontSize: '0.82rem', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
          <strong style={{ color: 'var(--danger)' }}>You can&apos;t approve your own action.</strong>
        </p>
      )}

      {/* suveren-as#89 — the proposal's own creator withdraws it directly
          (the reject route is closed to them: TR5 excludes the proposer
          from pendingApprovers). Outline button — form, not colour, per
          the UI spec — same bordered-surface treatment as the "Change
          needed" button elsewhere, not a plain ghost+colour link. */}
      {isAboveCap && isProposer ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.35rem', marginTop: '0.5rem' }}>
          <button
            className="btn btn-secondary btn-sm"
            style={{ background: 'var(--bg-elevated)', color: 'var(--danger)', borderColor: 'var(--danger)' }}
            onClick={handleWithdraw}
            disabled={withdrawing}
          >
            {withdrawing ? 'Withdrawing...' : 'Withdraw'}
          </button>
          {withdrawError && (
            <p style={{ fontSize: '0.78rem', color: 'var(--danger)', margin: 0 }}>{withdrawError}</p>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button
            className="btn btn-ghost btn-sm"
            style={{ color: 'var(--danger)' }}
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelling...' : 'Cancel'}
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
