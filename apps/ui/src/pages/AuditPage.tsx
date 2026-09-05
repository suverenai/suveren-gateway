import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  spClient,
  type ExecutionReceipt,
  type IntegrationManifest,
  type LocalAuthorization,
  type SignatureStatus,
} from '../lib/sp-client';
import { actionLabel, scopeSummary, wasReviewed, profileVersionLabel } from '../lib/receipt-summary';
import { profileDisplayName } from '../lib/profile-display';
import { ProfileBadge } from '../components/ProfileBadge';
import { ReceiptCard } from '../components/ReceiptCard';
import { ReceiptCompleteDialog } from '../components/ReceiptCompleteDialog';
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

  // Evidence download (local archive + best-effort AS export).
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  // Local mandate data (context, intent, bounds), keyed by authorizationId.
  // The AS holds only hashes of these, so the card's mandate rows come from
  // here or not at all.
  const [localAuths, setLocalAuths] = useState<Record<string, LocalAuthorization>>({});
  // Could the local store be read at all? "Unreachable" and "this grant has no
  // local copy" are different facts and must not render as the same sentence.
  const [localUnavailable, setLocalUnavailable] = useState(false);
  // Local signature-verification result per receipt id.
  const [signatures, setSignatures] = useState<Record<string, SignatureStatus>>({});
  // Grant titles, from the AS attestation records, keyed by authorizationId.
  const [grantTitles, setGrantTitles] = useState<Record<string, string>>({});
  // Which receipt's complete record is open, if any.
  const [openReceipt, setOpenReceipt] = useState<ExecutionReceipt | null>(null);

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

  // The readable mandate behind each receipt. Context and intent live ONLY on
  // this machine (the AS stores their hashes), and the grant's human name lives
  // only at the AS — so the card joins both. Each is best-effort: a missing
  // source degrades a row to a stated absence, never to a blank that would read
  // as "there was no intent".
  useEffect(() => {
    spClient.getLocalAuthorizations()
      .then(({ authorizations, signatures: sigs }) => {
        setLocalAuths(authorizations);
        setSignatures(sigs);
        setLocalUnavailable(false);
      })
      .catch(() => { setLocalAuths({}); setSignatures({}); setLocalUnavailable(true); });
    spClient.getMyAttestations()
      .then(items => {
        const titles: Record<string, string> = {};
        for (const item of items) {
          if (item.authorization_id && item.title) titles[item.authorization_id] = item.title;
        }
        setGrantTitles(titles);
      })
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

  /**
   * Download the evidence bundle: the LOCAL receipt archive (works even if the
   * AS is gone) merged with a best-effort AS export. The control-plane states
   * which sources contributed; surface a partial-source note rather than
   * pretending the file is complete.
   */
  async function downloadEvidence() {
    setExporting(true);
    setExportNote(null);
    try {
      const { bundle, filename } = await spClient.fetchEvidenceBundle();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      const src = (bundle.sources ?? {}) as { local?: boolean; authorityServer?: boolean; localError?: string; asError?: string };
      if (!src.authorityServer) {
        setExportNote(`Downloaded local evidence only — ${src.asError ?? 'Authority Server export unavailable.'}`);
      } else if (!src.local) {
        setExportNote(`Downloaded Authority Server history only — ${src.localError ?? 'local archive unavailable.'}`);
      }
    } catch (err) {
      setExportNote(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div
        className="page-header"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}
      >
        <div>
          <h1 className="page-title">Tickets</h1>
          <p className="page-subtitle">Execution history for agent actions.</p>
        </div>
        <button className="btn btn-secondary" onClick={downloadEvidence} disabled={exporting}>
          {exporting ? 'Preparing…' : 'Download evidence'}
        </button>
      </div>
      {exportNote && (
        <div style={{ marginBottom: '1rem', color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>
          {exportNote}
        </div>
      )}

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
            {filtered.map(receipt => {
              const owner = receipt.userId ? userById[receipt.userId] : undefined;
              return (
                <div className="timeline-event" key={receipt.id}>
                  <ReceiptCard
                    receipt={receipt}
                    manifests={manifests}
                    localAuth={receipt.authorizationId ? localAuths[receipt.authorizationId] : undefined}
                    localUnavailable={localUnavailable}
                    signature={signatures[receipt.id]}
                    grantTitle={receipt.authorizationId ? grantTitles[receipt.authorizationId] : null}
                    ownerLabel={
                      viewTab === 'team' && receipt.userId
                        ? (owner ? `${owner.name} (${owner.email})` : receipt.userId)
                        : null
                    }
                    spUrl={spUrl}
                    formatDate={formatDate}
                    onOpenComplete={() => setOpenReceipt(receipt)}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}

      {openReceipt && (
        <ReceiptCompleteDialog receipt={openReceipt} onClose={() => setOpenReceipt(null)} />
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
