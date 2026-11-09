import { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { spClient, type Proposal, type ExecutionReceipt } from '../lib/sp-client';
import { aggregateThread, type ThreadItem } from '../lib/thread-aggregator';
import { announceApprovalDecided, QUEUE_VIEWS, type QueueView } from '../lib/approval-flow';
import { ActionCard } from '../components/ActionCard';
import { useApprovalQueue } from '../contexts/ApprovalQueueContext';
import { profileDisplayName } from '../lib/profile-display';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';
import { ApprovalRow } from '../components/ApprovalRow';
import { isTestSetupAction, profileIdentity } from '../lib/profile-identity';
import { contentHashForDecision } from '../lib/use-proposal-content';
import { useApprovalTeamInfo } from '../lib/approval-team-info';
import { isProposer as isProposerOf, visibleApprovers } from '../lib/proposal-proposer';

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

  // UI spec §17.1 — one menu ("Show: For me / Others / All") in place of the three tabs.
  const [view, setView] = useState<QueueView>('me');

  // ─── The queue "For me" is read once for the whole app (ApprovalQueueContext) ───
  // The page and the approval panel share it, so they can never disagree.
  const { entries, ids, loaded, manifests, toolDisplay, titles, refresh, requestOpen } = useApprovalQueue();
  const fetchApproverProposals = refresh;
  const fetchMyProposals = refresh;

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

  // The tool is namespaced `<integrationId>__<tool>`, which is the only link
  // back from a proposal to the connector that produced it.
  const linksForTool = (tool: string) =>
    manifests.find(m => m.id === tool.split('__')[0])?.proposalLinks;

  useEffect(() => {
    void fetchApprovedByMe();
    void fetchMyPendingProposals();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── "All" tab — existing legacy domain thread ──────────────────────────
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [receipts, setReceipts] = useState<ExecutionReceipt[]>([]);
  const [loading, setLoading] = useState(true);
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
  // A refusal after approval arrives later, from the Authority Server: read the list again when the gateway says so.
  useSSEEvent('denial-recorded', fetchThread);
  useSSEEvent('execution-failed', fetchThread);

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


  // ─── Combined awaiting-others list ────────────────────────────────────
  // Genuinely "awaiting others" = above-cap proposals I already approved
  // that are still pending on other approvers, PLUS above-cap proposals I
  // CREATED that are still pending (myPendingProposals — see its own doc
  // comment: a stand-in until the AS has a creator-scoped query). Review-mode
  // domain proposals are NOT here — they're mine to approve and live under
  // "For me".
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

  const awaitingMeCount = entries.length;

  // ONE way to see an approval: the slide-in panel. A row opens the panel on that approval
  // (its "k of N" is its place in this same "For me" list). `?open=<id>` (from the dashboard) does the same, once.
  const [searchParams, setSearchParams] = useSearchParams();
  const queueLoading = !loaded;
  useEffect(() => {
    const id = searchParams.get('open');
    if (!id || queueLoading) return;
    if (ids.includes(id)) requestOpen(id);
    const next = new URLSearchParams(searchParams);
    next.delete('open');
    setSearchParams(next, { replace: true });
  }, [searchParams, queueLoading, ids, requestOpen, setSearchParams]);

  // A review-mode card in the "All" view was decided: re-read everything.
  const handleDecidedInThread = useCallback(() => {
    void fetchApproverProposals();
    void fetchMyProposals();
    void fetchApprovedByMe();
    void fetchThread();
    announceApprovalDecided();
  }, [fetchApproverProposals, fetchMyProposals, fetchApprovedByMe, fetchThread]);

  const mandateTitleOf = (p: Proposal) => (p.authorizationId ? titles[p.authorizationId] : undefined);

  // ─── Pieces of the page ────────────────────────────────────────────────
  const showMenu = (
    <label className="av3-show">
      <span>Show</span>
      <span className="av3-select">
        <select
          data-testid="queue-view"
          value={view}
          onChange={(ev) => {
            const v = ev.target.value as QueueView;
            setView(v);
            if (v === 'all') void fetchThread();
          }}
          aria-label="Show"
        >
          {QUEUE_VIEWS.map(v => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
        <svg className="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </span>
    </label>
  );

  // The standard page header row (title left, the menu at the far right edge of the frame).
  const pageHead = (actions: React.ReactNode) => (
    <header className="page-header">
      <h1 className="page-title">Approvals</h1>
      <div className="page-header-actions">{actions}</div>
    </header>
  );
  const listHeader = pageHead(showMenu);

  const rows = (
    <div className="av3-rows">
      {entries.length > 0 && (
        <div className="av3-lh"><span>{entries.length} waiting for you</span><span>oldest first</span></div>
      )}
      {entries.map(e => (
        <ApprovalRow
          key={e.id}
          proposal={e.proposal}
          manifests={manifests}
          titles={titles}
          onOpen={() => requestOpen(e.id)}
          who={e.route === 'approver' ? 'Team approval — other people are involved' : undefined}
        />
      ))}
    </div>
  );

  const empty = <p className="av3-empty" data-testid="queue-empty">Nothing waiting for you.</p>;

  return (
    <div className="av3-page" data-view={view}>
      {view === 'me' && (
        <>
          {listHeader}
          {queueLoading ? (
            <p className="av3-empty">Loading…</p>
          ) : (
            <section className="av3-pane" aria-label="Approvals">
              <div className="av3-pane-scroll">{awaitingMeCount === 0 ? empty : rows}</div>
            </section>
          )}
        </>
      )}

      {/* ─── Others: waiting on other people ───────────────────────── */}
      {view === 'others' && (
        <>
        {listHeader}
        <section className="av3-pane" aria-label="Waiting on others">
          <div className="av3-pane-scroll">
            {awaitingOthersAll.length === 0 ? (
              <p className="av3-empty">Nothing is waiting on others.</p>
            ) : (
              <div className="av3-stack">
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
          </div>
        </section>
        </>
      )}

      {/* ─── All: recent activity (the legacy domain thread) ───────── */}
      {view === 'all' && (
        <>
        {listHeader}
        <section className="av3-pane" aria-label="All approvals">
          <div className="av3-pane-scroll">
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
                    title="Include actions that ran without a human review (automatic mode)"
                  >
                    {includeAutonomous ? '✓ ' : ''}Automatic actions
                  </button>
                </>
              )}
            </div>

            {loading && items.length === 0 ? (
              <p className="av3-empty">Loading…</p>
            ) : items.length === 0 ? (
              <p className="av3-empty">
                {statusFilter === 'pending' ? 'Nothing waiting for you.' : 'Nothing here yet.'}
              </p>
            ) : (
              <div className="av3-stack av3-inline">
                {items.map((item) => (
                  <ActionCard
                    key={item.id}
                    proposalLinks={item.kind === 'proposal' ? linksForTool(item.proposal.tool) : undefined}
                    toolDisplay={item.kind === 'proposal' ? toolDisplay[item.proposal.tool] : undefined}
                    manifests={manifests}
                    currentUserId={userId}
                    item={item}
                    mandateTitle={item.kind === 'proposal' ? mandateTitleOf(item.proposal) : undefined}
                    onDecided={handleDecidedInThread}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
        </>
      )}
    </div>
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

  // Real-gateway e2e (2026-10-15, "Tom withdraws his own over-the-limit
  // action"): `window.confirm()` is a BLOCKING native dialog — Playwright
  // auto-dismisses every dialog it doesn't explicitly handle (returns
  // `false`, as if Cancel was clicked, which is its documented default),
  // so `if (!confirm(...)) return;` silently aborted before any network
  // call: no error (the catch was never reached), the card never changed.
  // Reproduced live and confirmed: the AS never saw a request at all.
  // Root fix: no native confirm for either terminal action here, matching
  // the "one click, no reason" decision this card family already applies
  // to Approve/Reject/Change-needed (ApproverProposalCard; RJ2 decision
  // 1) — Cancel/Withdraw were the only two outliers.
  const handleCancel = async () => {
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
    <div className="card av3-other">
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
            <span key={uid} className={`who${uid in approvedBy ? ' done' : ''}`} style={{ marginLeft: i === 0 ? '0.25rem' : '0.5rem', fontWeight: uid in approvedBy ? 600 : undefined }}>
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
        <div className="over-limit-box" data-testid="above-cap-reason" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginBottom: '0.6rem', fontSize: '0.82rem' }}>
          <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Above the team limit:</span>
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
          <strong>You can&apos;t approve your own action.</strong>
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
            className="btn btn-outline-strong btn-sm"
            onClick={handleWithdraw}
            disabled={withdrawing}
          >
            {withdrawing ? 'Withdrawing...' : 'Withdraw'}
          </button>
          {withdrawError && (
            <p className="msg-error" style={{ fontSize: '0.78rem', margin: 0 }}>{withdrawError}</p>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button
            className="btn btn-outline-strong btn-sm"
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
