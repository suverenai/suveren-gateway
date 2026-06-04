import { useState, useCallback, useMemo, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { spClient, type Proposal, type ExecutionReceipt } from '../lib/sp-client';
import { aggregateThread, type ThreadItem } from '../lib/thread-aggregator';
import { ActionCard } from '../components/ActionCard';
import { ApproverProposalCard } from '../components/ApproverProposalCard';
import { profileDisplayName } from '../lib/profile-display';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';

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
      const ps = await spClient.getProposals(domain || 'owner');
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
      // in the domain index (pendingDomains is [] but they're still by frameHash).
      // The simplest v1 approach: re-use getProposals + filter client-side.
      // This works because above-cap proposals are still stored per frame, not per domain.
      // The domain query may miss them — but the SP returns all pending proposals
      // including those with empty pendingDomains. Good enough for v1.
      const ps = await spClient.getProposals(domain || 'owner');
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

  // Initial load
  useEffect(() => {
    void fetchApproverProposals();
    void fetchMyProposals();
    void fetchApprovedByMe();
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

  const handleResolve = async (id: string, action: 'commit' | 'reject') => {
    setResolving(id);
    setMessage('');
    try {
      const resolveDomain = domain || 'owner';
      const result = await spClient.resolveProposal(id, action, resolveDomain);
      setMessage(action === 'commit' ? `Action approved. Status: ${result.status}` : 'Action rejected.');
      // Refresh the All thread AND the awaiting-me domain queue so a just-approved
      // review-mode proposal leaves the "Awaiting me" tab immediately.
      await Promise.all([fetchThread(), fetchMyProposals()]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed');
    } finally {
      setResolving(null);
    }
  };

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
  // Genuinely "awaiting others" = above-cap proposals I already approved that
  // are still pending on other approvers. Review-mode domain proposals are NOT
  // here — they're mine to approve and live under "Awaiting me".
  const awaitingOthersAll = useMemo(() => {
    const seen = new Set<string>();
    const result: Proposal[] = [];
    for (const p of approvedByMeStillPending) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        result.push(p);
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }, [approvedByMeStillPending]);

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
                  item={item}
                  onApprove={(id) => handleResolve(id, 'commit')}
                  onReject={(id) => handleResolve(id, 'reject')}
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
                      await spClient.rejectProposal(proposal.id, 'cancelled by creator');
                      void fetchApprovedByMe();
                      void fetchMyProposals();
                    } catch (err) {
                      alert(err instanceof Error ? err.message : 'Cancel failed');
                    }
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
                  ? 'Your agents are operating within their authorizations. Switch to All to see recent activity.'
                  : 'When an agent calls a gated tool, activity will appear here.'}
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {items.map((item) => (
                <ActionCard
                  key={item.id}
                  item={item}
                  onApprove={(id) => handleResolve(id, 'commit')}
                  onReject={(id) => handleResolve(id, 'reject')}
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
}

function formatAge(unixSeconds: number): string {
  const ageMs = Date.now() - unixSeconds * 1000;
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function AwaitingOthersCard({ proposal, currentUserId, onCancel }: AwaitingOthersCardProps) {
  const [cancelling, setCancelling] = useState(false);

  const approvedUserIds = Object.keys(proposal.approvedBy ?? {});
  const pendingUserIds = (proposal.pendingApprovers ?? []).filter(uid => !(uid in (proposal.approvedBy ?? {})));
  const isAboveCap = (proposal.pendingApprovers?.length ?? 0) > 0;

  const handleCancel = async () => {
    if (!confirm('Cancel this action? All approvers will be notified.')) return;
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{profileDisplayName(proposal.profileId)}</span>
        {isAboveCap && (
          <span style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem', borderRadius: '0.25rem', background: 'var(--accent-subtle)', color: 'var(--accent)', fontWeight: 600 }}>
            Above cap
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
          {formatAge(proposal.createdAt)}
        </span>
      </div>

      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
        <code>{proposal.tool.split('__').pop() ?? proposal.tool}</code>
      </div>

      {isAboveCap && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
          {approvedUserIds.map(uid => (
            <span key={uid} style={{ marginRight: '0.75rem', color: 'var(--success, green)' }}>
              {uid === currentUserId ? 'You approved' : `${uid} approved`}
            </span>
          ))}
          {pendingUserIds.map(uid => (
            <span key={uid} style={{ marginRight: '0.75rem', color: 'var(--text-tertiary)' }}>
              Waiting on {uid === currentUserId ? 'you' : uid}
            </span>
          ))}
        </div>
      )}

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
    </div>
  );
}
