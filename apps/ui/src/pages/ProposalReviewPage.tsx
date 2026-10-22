import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { spClient, type Proposal, type ExecutionReceipt, type IntegrationManifest } from '../lib/sp-client';
import { aggregateThread, type ThreadItem } from '../lib/thread-aggregator';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { nextAfter, nextLabel, navKeyFor, QUEUE_VIEWS, type QueueView, type DecisionKind, type DecisionResult } from '../lib/approval-flow';
import { ActionCard, ReviewApprovalCard } from '../components/ActionCard';
import { ApproverProposalCard } from '../components/ApproverProposalCard';
import { profileDisplayName } from '../lib/profile-display';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';
import type { ToolDisplay } from '../lib/approval-view';
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

  // ─── Awaiting me (Phase 6 per-action approver proposals) ──────────────
  const [approverProposals, setApproverProposals] = useState<Proposal[]>([]);
  // Manifests supply the inspection links shown on an approval card. Fetched
  // once: without them the reviewer sees identifiers and nothing to open, which
  // turns approving into signing.
  const [manifests, setManifests] = useState<IntegrationManifest[]>([]);
  const [toolDisplay, setToolDisplay] = useState<Record<string, ToolDisplay>>({});
  const [approverLoading, setApproverLoading] = useState(true);

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
    spClient.getLabelManifests()
      .then(setManifests)
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

  // Mandate titles for the rows' "area" (the proposal carries only the id).
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    spClient.getMyAttestations()
      .then(items => {
        const t: Record<string, string> = {};
        for (const i of items) if (i.authorization_id && i.title) t[i.authorization_id] = i.title;
        setTitles(t);
      })
      .catch(() => {});
  }, []);

  // ─── The queue "For me": one list, oldest first ───────────────────────
  // Review-mode proposals (decided through the workspace queue) and above-cap
  // proposals where I am a required approver (decided as an approver).
  type Entry = { id: string; proposal: Proposal; route: 'queue' | 'approver' };
  // Ids the gateway has answered a decision for: they leave the counts at once
  // (the lists re-read right after and would drop them anyway).
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const entries: Entry[] = useMemo(() => {
    const out: Entry[] = [];
    for (const item of awaitingMeDomainItems) {
      if (item.kind === 'proposal') out.push({ id: item.proposal.id, proposal: item.proposal, route: 'queue' });
    }
    for (const p of approverProposals) {
      if (!out.some(e => e.id === p.id)) out.push({ id: p.id, proposal: p, route: 'approver' });
    }
    return out.filter(e => !decided.has(e.id)).sort((a, b) => a.proposal.createdAt - b.proposal.createdAt);
  }, [awaitingMeDomainItems, approverProposals, decided]);
  const ids = useMemo(() => entries.map(e => e.id), [entries]);
  const idsRef = useRef<string[]>(ids);
  idsRef.current = ids;
  const awaitingMeCount = entries.length;

  // UI spec §17.1 — more than one waiting: the list opens first; exactly one:
  // its card opens directly. `?open=<id>` (from the dashboard) opens that one.
  const wide = useMediaQuery('(min-width: 1400px)');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [searchParams] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(() => searchParams.get('open'));
  const [leaving, setLeaving] = useState(false);
  // A decision on the open card is out or answered: no moving between cards meanwhile.
  const [cardBusy, setCardBusy] = useState(false);
  // A decision the gateway answered: its card stays on screen (stamp) until it slides out.
  const [settling, setSettling] = useState<{ entry: Entry; before: string[] } | null>(null);
  // The card that just slid in: "Next · 2 of 3" for about two seconds.
  const [arrived, setArrived] = useState<{ id: string; label: string | null } | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => { timers.current.forEach(t => window.clearTimeout(t)); }, []);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };

  const autoOpenedRef = useRef<string | null>(null);
  useEffect(() => {
    if (settling) return;
    // A lone item opens by itself — once; going back to the list is respected.
    if (ids.length === 1 && openId === null && autoOpenedRef.current !== ids[0]) {
      autoOpenedRef.current = ids[0];
      setOpenId(ids[0]);
      return;
    }
    // The open one is gone without us deciding it (decided elsewhere, expired):
    // the one that took its place, or the list. Only once the queue has loaded.
    if (openId && !approverLoading && !ids.includes(openId)) {
      setOpenId(null);
    }
  }, [ids, openId, settling, approverLoading]);

  const openEntry: Entry | null = settling?.entry ?? (openId ? entries.find(e => e.id === openId) ?? null : null);
  const position = openEntry && !settling ? ids.indexOf(openEntry.id) : -1;
  const goTo = useCallback((id: string | null) => { setArrived(null); setOpenId(id); }, []);

  /** The gateway answered (the card shows its stamp). Counts drop now; about a
   *  second later the card slides out and the next one slides in. */
  const handleDecided = useCallback((proposalId: string, _kind: DecisionKind, _result: DecisionResult) => {
    const before = idsRef.current;
    const entry = entries.find(e => e.id === proposalId);
    if (!entry) return;
    setDecided(prev => new Set(prev).add(proposalId));
    setSettling({ entry, before });
    // Re-read what the backend holds; the decision itself is already confirmed.
    void fetchApproverProposals();
    void fetchMyProposals();
    void fetchApprovedByMe();
    void fetchMyPendingProposals();
    void fetchThread();
    const advance = () => {
      const rest = before.filter(id => id !== proposalId);
      const next = nextAfter(before, proposalId);
      setSettling(null);
      setLeaving(false);
      setOpenId(next);
      setArrived(next ? { id: next, label: nextLabel(rest, next) } : null);
      if (next) later(() => setArrived(a => (a && a.id === next ? null : a)), 2200);
    };
    later(() => {
      if (reducedMotion) { advance(); return; }
      setLeaving(true);
      later(advance, 320);
    }, 1100);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, reducedMotion, fetchApproverProposals, fetchMyProposals, fetchApprovedByMe, fetchMyPendingProposals, fetchThread]);

  // A review-mode card in the "All" view was decided: re-read everything.
  const handleDecidedInThread = useCallback(() => {
    void fetchApproverProposals();
    void fetchMyProposals();
    void fetchApprovedByMe();
    void fetchThread();
  }, [fetchApproverProposals, fetchMyProposals, fetchApprovedByMe, fetchThread]);

  // Keys (§17.1): ← / → between cards, Esc to the list. Nothing decides on a key.
  useEffect(() => {
    if (view !== 'me' || !openId || settling || cardBusy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const nav = navKeyFor(e.key);
      if (!nav) return;
      const at = idsRef.current.indexOf(openId);
      if (nav === 'prev' && at > 0) { e.preventDefault(); goTo(idsRef.current[at - 1]); }
      else if (nav === 'next' && at >= 0 && at < idsRef.current.length - 1) { e.preventDefault(); goTo(idsRef.current[at + 1]); }
      else if (nav === 'list') { e.preventDefault(); goTo(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, openId, settling, cardBusy, goTo]);

  const linkFor = (e: Entry) => linksForTool(e.proposal.tool);
  const mandateTitleOf = (p: Proposal) => (p.authorizationId ? titles[p.authorizationId] : undefined);

  const card = (e: Entry) => {
    const label = arrived && arrived.id === e.id ? arrived.label : null;
    return e.route === 'queue' ? (
      <ReviewApprovalCard
        key={e.id}
        proposal={e.proposal}
        manifests={manifests}
        toolDisplay={toolDisplay[e.proposal.tool]}
        proposalLinks={linkFor(e)}
        currentUserId={userId}
        mandateTitle={mandateTitleOf(e.proposal)}
        onDecided={handleDecided}
        nextLabelText={label}
        onBusyChange={setCardBusy}
      />
    ) : (
      <ApproverProposalCard
        key={e.id}
        proposal={e.proposal}
        currentUserId={userId}
        manifests={manifests}
        toolDisplay={toolDisplay[e.proposal.tool]}
        proposalLinks={linkFor(e)}
        mandateTitle={mandateTitleOf(e.proposal)}
        onDecided={handleDecided}
        nextLabelText={label}
        onBusyChange={setCardBusy}
      />
    );
  };

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

  const listHeader = (
    <header className="av3-ph">
      <h1 className="av3-ph-title">Approvals</h1>
      <span className="av3-sp" />
      {showMenu}
    </header>
  );

  const cardHeader = (
    <header className="av3-ph">
      {!wide && (
        <button type="button" className="av3-back" data-testid="back-to-list" disabled={cardBusy} onClick={() => goTo(null)}>
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
          Approvals <span className="n">{awaitingMeCount}</span>
        </button>
      )}
      <span className="av3-sp" />
      {settling || cardBusy ? (
        <span className="av3-pos">{awaitingMeCount > 0 ? `${awaitingMeCount} left` : 'none left'}</span>
      ) : position >= 0 && ids.length > 1 ? (
        <>
          <span className="av3-pos" data-testid="card-position">{position + 1} of {ids.length}</span>
          <button type="button" className="av3-ib" aria-label="Previous approval" disabled={position <= 0} onClick={() => goTo(ids[position - 1])}>
            <svg className="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
          </button>
          <button type="button" className="av3-ib" aria-label="Next approval" disabled={position >= ids.length - 1} onClick={() => goTo(ids[position + 1])}>
            <svg className="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
          </button>
        </>
      ) : null}
    </header>
  );

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
          selected={openId === e.id}
          onOpen={() => goTo(e.id)}
          who={e.route === 'approver' ? 'Team approval — other people are involved' : undefined}
        />
      ))}
    </div>
  );

  const empty = <p className="av3-empty" data-testid="queue-empty">Nothing waiting for you.</p>;

  // The card in its stage: slides out to the left, the next one in from the right.
  const stage = openEntry && (
    <div
      key={openEntry.id}
      className={`av3-stage is-open${settling && leaving ? ' av3-out' : ''}${arrived && arrived.id === openEntry.id ? ' av3-in' : ''}`}
      // Narrow single-card layout keeps the old row hooks: the open approval is
      // the one `approval-row` on screen (hap-e2e's openApprovalById).
      data-testid={wide ? 'approval-open' : 'approval-row'}
      data-proposal-id={openEntry.id}
    >
      {card(openEntry)}
    </div>
  );

  return (
    <div className={`av3-page${wide ? ' av3-wide' : ''}`} data-view={view}>
      {view === 'me' && (
        approverLoading && awaitingMeCount === 0 && !settling ? (
          <>{listHeader}<p className="av3-empty">Loading…</p></>
        ) : wide ? (
          <div className="av3-split">
            <section className="av3-pane av3-pane-list" aria-label="Approvals">
              {listHeader}
              <div className="av3-pane-scroll">{awaitingMeCount === 0 ? empty : rows}</div>
            </section>
            <section className="av3-pane av3-pane-card">
              {openEntry ? <>{cardHeader}<div className="av3-cbox">{stage}</div></> : (
                awaitingMeCount > 0 && <p className="av3-empty">Pick an approval from the list.</p>
              )}
            </section>
          </div>
        ) : openEntry ? (
          <section className="av3-pane" aria-label="Approval">
            {cardHeader}
            <div className="av3-cbox">{stage}</div>
          </section>
        ) : (
          <section className="av3-pane" aria-label="Approvals">
            {listHeader}
            <div className="av3-pane-scroll">{awaitingMeCount === 0 ? empty : rows}</div>
          </section>
        )
      )}

      {/* ─── Others: waiting on other people ───────────────────────── */}
      {view === 'others' && (
        <section className="av3-pane" aria-label="Waiting on others">
          {listHeader}
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
      )}

      {/* ─── All: recent activity (the legacy domain thread) ───────── */}
      {view === 'all' && (
        <section className="av3-pane" aria-label="All approvals">
          {listHeader}
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
