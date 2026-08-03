import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { spClient, type ExecutionReceipt, type IntegrationManifest } from '../lib/sp-client';
import { actionLabel, scopeSummary, wasReviewed, profileVersionLabel } from '../lib/receipt-summary';
import { profileDisplayName } from '../lib/profile-display';
import { ProfileBadge } from '../components/ProfileBadge';
import { EmptyState } from '../components/EmptyState';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useAuth } from '../contexts/AuthContext';

type TimeRange = '1d' | '7d' | '30d' | 'all';

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function isWithinTimeRange(receipt: ExecutionReceipt, range: TimeRange): boolean {
  if (range === 'all') return true;
  const days = range === '1d' ? 1 : range === '7d' ? 7 : 30;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  return receipt.timestamp >= cutoff;
}

function matchesSearch(receipt: ExecutionReceipt, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    receipt.profileId.toLowerCase().includes(q) ||
    profileDisplayName(receipt.profileId).toLowerCase().includes(q) ||
    receipt.path.toLowerCase().includes(q) ||
    receipt.action.toLowerCase().includes(q) ||
    receipt.attestationHash.toLowerCase().includes(q) ||
    receipt.id.toLowerCase().includes(q) ||
    JSON.stringify(receipt.executionContext).toLowerCase().includes(q)
  );
}

/** Merge receipts by id, newest first — so polling adds new receipts without
 *  dropping older windows the user loaded via "Load older". */
function mergeReceipts(prev: ExecutionReceipt[], incoming: ExecutionReceipt[]): ExecutionReceipt[] {
  const byId = new Map(prev.map(r => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
}

export function AuditPage() {
  const { activeTeam, groupId } = useAuth();
  const isAdmin = activeTeam?.isAdmin === true;

  const [viewTab, setViewTab] = useState<'mine' | 'team'>('mine');
  const [receipts, setReceipts] = useState<ExecutionReceipt[]>([]);
  // Connector manifests name their own actions ("Email sent"); /health carries
  // the Authority Server's base URL so each row can link to its receipt.
  const [manifests, setManifests] = useState<IntegrationManifest[]>([]);
  const [spUrl, setSpUrl] = useState('');
  const [loading, setLoading] = useState(true);
  // Lazy-loaded user directory keyed by userId for resolving owner names in
  // the Team tab. Populated once on first switch to Team.
  const [userById, setUserById] = useState<Record<string, { name: string; email: string }>>({});
  const [ownerFilters, setOwnerFilters] = useState<Set<string>>(new Set());

  // Search & filter state
  const [search, setSearch] = useState('');
  const [profileFilters, setProfileFilters] = useState<Set<string>>(new Set());
  const [actionFilters, setActionFilters] = useState<Set<string>>(new Set());
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Pagination cursor for "Load older" (null = no older receipts within range).
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Tracks the current tab/group so a context switch replaces (not merges) data.
  const ctxRef = useRef<string>('');

  const fetchPage = useCallback((before?: string) => {
    return viewTab === 'team' && isAdmin && groupId
      ? spClient.listTeamReceiptsPage(groupId, { before, limit: 200 })
      : spClient.getMyReceiptsPage({ before, limit: 200 });
  }, [viewTab, isAdmin, groupId]);

  const fetchReceipts = useCallback(() => {
    const ctx = viewTab === 'team' ? `team:${groupId}` : 'mine';
    const fresh = ctxRef.current !== ctx; // tab/group switch → replace, not merge
    ctxRef.current = ctx;
    setLoading(true);
    setLoadError(false);
    fetchPage()
      .then(page => {
        setReceipts(prev => (fresh ? page.receipts : mergeReceipts(prev, page.receipts)));
        setCursor(prev => (fresh ? page.nextBefore : prev ?? page.nextBefore));
      })
      .catch(() => {
        if (fresh) setReceipts([]);
        // Surface the failure instead of rendering an empty list as if there
        // were simply no receipts (the prior silent .catch hid auth/AS errors).
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, [fetchPage, viewTab, groupId]);

  const loadOlder = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadError(false);
    fetchPage(cursor)
      .then(page => {
        setReceipts(prev => mergeReceipts(prev, page.receipts));
        setCursor(page.nextBefore);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, fetchPage]);

  useVisiblePolling(fetchReceipts, 120_000);

  // Manifests (for action labels) and the AS base URL (for receipt links).
  // Both are cosmetic: if either fails the rows still render, just duller —
  // an unlabelled action falls back to "<Profile> · <action_type>", and the
  // "View receipt" link is omitted rather than pointing somewhere wrong.
  useEffect(() => {
    spClient.getIntegrationManifests()
      .then(({ manifests }) => setManifests(manifests))
      .catch(() => {});
    fetch('/health')
      .then(r => r.json())
      .then(d => { if (typeof d.spUrl === 'string') setSpUrl(d.spUrl.replace(/\/$/, '')); })
      .catch(() => {});
  }, []);

  // Pull user directory the first time the admin opens the Team tab so we can
  // resolve owner names for the filter chips and per-row labels.
  useEffect(() => {
    if (viewTab !== 'team' || Object.keys(userById).length > 0) return;
    spClient.listUsers()
      .then(users => {
        const map: Record<string, { name: string; email: string }> = {};
        for (const u of users) map[u.id] = { name: u.name, email: u.email };
        setUserById(map);
      })
      .catch(() => {});
  }, [viewTab, userById]);

  // Derive available profiles and actions from data
  const availableProfiles = useMemo(() => {
    const set = new Set<string>();
    for (const r of receipts) set.add(profileDisplayName(r.profileId));
    return [...set].sort();
  }, [receipts]);

  const availableActions = useMemo(() => {
    const set = new Set<string>();
    for (const r of receipts) set.add(r.action);
    return [...set].sort();
  }, [receipts]);

  // Owner list for the Team-tab filter — distinct userIds present on the
  // currently-loaded receipts.
  const availableOwners = useMemo(() => {
    if (viewTab !== 'team') return [] as Array<{ id: string; label: string }>;
    const ids = new Set<string>();
    for (const r of receipts) if (r.userId) ids.add(r.userId);
    return [...ids].map(id => ({
      id,
      label: userById[id]?.name ? `${userById[id].name} (${userById[id].email})` : id,
    })).sort((a, b) => a.label.localeCompare(b.label));
  }, [viewTab, receipts, userById]);

  // Apply all filters
  const filtered = useMemo(() => {
    return receipts.filter(r => {
      if (!matchesSearch(r, search)) return false;
      if (profileFilters.size > 0 && !profileFilters.has(profileDisplayName(r.profileId))) return false;
      if (actionFilters.size > 0 && !actionFilters.has(r.action)) return false;
      if (ownerFilters.size > 0 && r.userId && !ownerFilters.has(r.userId)) return false;
      if (!isWithinTimeRange(r, timeRange)) return false;
      return true;
    });
  }, [receipts, search, profileFilters, actionFilters, ownerFilters, timeRange]);

  const hasActiveFilters = profileFilters.size > 0 || actionFilters.size > 0 || ownerFilters.size > 0 || timeRange !== 'all';

  function toggleProfile(p: string) {
    setProfileFilters(prev => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });
  }

  function toggleAction(a: string) {
    setActionFilters(prev => {
      const next = new Set(prev);
      next.has(a) ? next.delete(a) : next.add(a);
      return next;
    });
  }

  function toggleOwner(id: string) {
    setOwnerFilters(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function clearAllFilters() {
    setProfileFilters(new Set());
    setActionFilters(new Set());
    setOwnerFilters(new Set());
    setTimeRange('all');
    setSearch('');
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Receipts</h1>
        <p className="page-subtitle">Execution history for agent actions.</p>
      </div>

      {/* Mine | Team tab strip — Team is admin-only */}
      {isAdmin && (
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid var(--border)' }}>
          {(['mine', 'team'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setViewTab(tab)}
              className="btn btn-ghost"
              style={{
                borderRadius: 0,
                padding: '0.5rem 0.875rem',
                borderBottom: viewTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                color: viewTab === tab ? 'var(--text-primary)' : 'var(--text-tertiary)',
                fontWeight: viewTab === tab ? 600 : 500,
              }}
            >
              {tab === 'mine' ? 'Mine' : 'Team'}
            </button>
          ))}
        </div>
      )}

      {/* Search + Filter toggle row */}
      <div className="search-filter-bar">
        <div className="search-input-wrap">
          <span className="search-icon">&#x2315;</span>
          <input
            type="text"
            className="form-input search-input"
            placeholder="Search by profile, action, path, or hash\u2026"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch('')}>
              &times;
            </button>
          )}
        </div>
        <button
          className={`btn btn-sm btn-secondary${filtersOpen ? ' active' : ''}`}
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          Filters{hasActiveFilters ? ` (${profileFilters.size + actionFilters.size + (timeRange !== 'all' ? 1 : 0)})` : ''}
        </button>
      </div>

      {/* Expandable filter panel */}
      {filtersOpen && (
        <div className="filter-panel">
          {/* Profile */}
          {availableProfiles.length > 1 && (
            <div className="filter-section">
              <div className="filter-label">Profile</div>
              <div className="filter-chips">
                {availableProfiles.map(p => (
                  <button
                    key={p}
                    className={`filter-chip${profileFilters.has(p) ? ' selected' : ''}`}
                    onClick={() => toggleProfile(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Action */}
          {availableActions.length > 1 && (
            <div className="filter-section">
              <div className="filter-label">Action</div>
              <div className="filter-chips">
                {availableActions.map(a => (
                  <button
                    key={a}
                    className={`filter-chip${actionFilters.has(a) ? ' selected' : ''}`}
                    onClick={() => toggleAction(a)}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Owner — Team tab only */}
          {viewTab === 'team' && availableOwners.length > 1 && (
            <div className="filter-section">
              <div className="filter-label">Owner</div>
              <div className="filter-chips">
                {availableOwners.map(o => (
                  <button
                    key={o.id}
                    className={`filter-chip${ownerFilters.has(o.id) ? ' selected' : ''}`}
                    onClick={() => toggleOwner(o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Time range */}
          <div className="filter-section">
            <div className="filter-label">Time range</div>
            <div className="filter-chips">
              {([['1d', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time']] as const).map(([value, label]) => (
                <button
                  key={value}
                  className={`filter-chip${timeRange === value ? ' selected' : ''}`}
                  onClick={() => setTimeRange(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Active filter chips */}
      {hasActiveFilters && (
        <div className="active-filters">
          {[...profileFilters].map(p => (
            <span key={p} className="active-chip" onClick={() => toggleProfile(p)}>
              {p} <span className="chip-remove">&times;</span>
            </span>
          ))}
          {[...actionFilters].map(a => (
            <span key={a} className="active-chip" onClick={() => toggleAction(a)}>
              {a} <span className="chip-remove">&times;</span>
            </span>
          ))}
          {[...ownerFilters].map(o => {
            const u = userById[o];
            const label = u ? u.name : o;
            return (
              <span key={o} className="active-chip" onClick={() => toggleOwner(o)}>
                {label} <span className="chip-remove">&times;</span>
              </span>
            );
          })}
          {timeRange !== 'all' && (
            <span className="active-chip" onClick={() => setTimeRange('all')}>
              {timeRange === '1d' ? 'Today' : timeRange === '7d' ? '7 days' : '30 days'} <span className="chip-remove">&times;</span>
            </span>
          )}
          <button className="clear-filters" onClick={clearAllFilters}>
            Clear all
          </button>
        </div>
      )}

      {loadError && (
        <div className="card" style={{ borderColor: 'var(--danger, #c0392b)', marginBottom: '0.75rem' }}>
          <span style={{ color: 'var(--danger, #c0392b)', fontSize: '0.85rem' }}>
            Couldn&rsquo;t load receipts &mdash; your session may have expired. Try signing out and back in.
          </span>
        </div>
      )}

      {loading && receipts.length === 0 ? (
        <p style={{ color: 'var(--text-tertiary)' }}>Loading...</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={'\u2315'}
          title={receipts.length === 0 ? 'No receipts in the last 30 days' : 'No matching receipts'}
          text={receipts.length === 0
            ? 'Execution receipts appear here after an agent uses an authorized tool. Older receipts can be loaded below.'
            : 'Try adjusting your search or filters.'}
        />
      ) : (
        <>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '0.75rem' }}>
            {filtered.length === receipts.length
              ? `${receipts.length} receipt${receipts.length !== 1 ? 's' : ''}`
              : `${filtered.length} of ${receipts.length} receipts`}
          </div>
          <div className="timeline">
            {filtered.map(receipt => (
              <div className="timeline-event" key={receipt.id}>
                <div className="card" style={{ marginBottom: 0 }}>
                  {/* Headline: what happened, in words. Everything that is an
                      identifier moved into "Technical" below — it was three of
                      the four most prominent things on this card, and none of
                      it answers the question people open this page with. */}
                  <div className="receipt-head">
                    <span className="receipt-what">{actionLabel(receipt, manifests)}</span>
                    <span className="receipt-tag">{wasReviewed(receipt) ? 'review' : 'automatic'}</span>
                    {receipt.contentHash && (
                      <span
                        className="receipt-tag receipt-tag-bound"
                        title={receipt.contentBinding?.fields
                          ? `The receipt binds: ${receipt.contentBinding.fields.join(', ')}`
                          : 'This exact content was authorized'}
                      >
                        content bound
                      </span>
                    )}
                    <span className="auth-card-time">{formatDate(receipt.timestamp)}</span>
                  </div>

                  {/* Scope the Gatekeeper checked — recipients, environment.
                      A receipt never carries content, so this is as specific as
                      it can honestly get. */}
                  {scopeSummary(receipt) && (
                    <div className="receipt-scope">{scopeSummary(receipt)}</div>
                  )}

                  {/* Owner label — only on Team tab so admins can see at a glance */}
                  {viewTab === 'team' && receipt.userId && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '0.375rem' }}>
                      Owner:{' '}
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {userById[receipt.userId]?.name
                          ? `${userById[receipt.userId].name} (${userById[receipt.userId].email})`
                          : receipt.userId}
                      </span>
                    </div>
                  )}

                  {/* The receipt itself — the point of the page, and until now
                      unreachable from it. `spUrl` is published on /health. */}
                  <div className="receipt-foot">
                    {spUrl && (
                      <a
                        className="receipt-link"
                        href={`${spUrl}/r/${receipt.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View receipt &#8599;
                      </a>
                    )}
                    <span className="receipt-id">{receipt.id.slice(0, 8)}</span>
                    <span className="receipt-tag">{profileVersionLabel(receipt.profileId)}</span>
                  </div>

                  <details className="receipt-more">
                    <summary>Technical</summary>
                    <div className="receipt-kv">
                      <div>action &middot; {receipt.action}</div>
                      <div>profile &middot; {receipt.profileId}</div>
                      {Object.keys(receipt.executionContext).length > 0 && (
                        <div>
                          context &middot;{' '}
                          {Object.entries(receipt.executionContext)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(' \u00B7 ')}
                        </div>
                      )}
                      <div>
                        usage &middot; daily {receipt.cumulativeState.daily.count} calls,
                        ${receipt.cumulativeState.daily.amount} &middot; monthly{' '}
                        {receipt.cumulativeState.monthly.count} calls, ${receipt.cumulativeState.monthly.amount}
                      </div>
                      {receipt.contentHash && <div>content &middot; {receipt.contentHash}</div>}
                      <div>authorization &middot; {receipt.attestationHash}</div>
                    </div>
                  </details>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {cursor && (
        <div style={{ textAlign: 'center', marginTop: '1rem' }}>
          <button className="btn btn-secondary btn-sm" onClick={loadOlder} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older'}
          </button>
        </div>
      )}
    </>
  );
}
