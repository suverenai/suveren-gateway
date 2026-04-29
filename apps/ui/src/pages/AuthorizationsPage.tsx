import { useState, useEffect, useCallback } from 'react';
import { spClient, type PendingItem, type GateContentEntry, type ProfileConfig } from '../lib/sp-client';
import { profileDisplayName } from '../lib/profile-display';
import { AuthorizePicker } from '../components/AuthorizePicker';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { DomainBadge } from '../components/DomainBadge';
import { TTLBadge } from '../components/TTLBadge';
import { EmptyState } from '../components/EmptyState';
import { ExtendAuthModal } from '../components/ExtendAuthModal';
import { useVisiblePolling } from '../hooks/useVisiblePolling';
import { useSSEEvent } from '../contexts/EventSourceContext';

type StatusFilter = 'active' | 'pending' | 'expired' | 'revoked';
type Status = 'active' | 'pending' | 'expired' | 'revoked';
type ViewTab = 'mine' | 'team';

type TeamItem = PendingItem & { owner: { userId: string; name?: string; email?: string } };

function getStatus(item: PendingItem, revokedSet: Set<string>): Status {
  if (revokedSet.has(item.frame_hash)) return 'revoked';
  if (item.sp_status === 'revoked') return 'revoked';
  if (item.remaining_seconds === null || item.remaining_seconds <= 0) return 'expired';
  if (item.missing_domains.length > 0) return 'pending';
  return 'active';
}

function sortItems(items: PendingItem[], revokedSet: Set<string>): PendingItem[] {
  return [...items].sort((a, b) => {
    const sa = getStatus(a, revokedSet);
    const sb = getStatus(b, revokedSet);
    const order: Record<Status, number> = { active: 0, pending: 1, expired: 2, revoked: 3 };
    if (order[sa] !== order[sb]) return order[sa] - order[sb];
    // Active: ascending by remaining TTL
    if (sa === 'active' && sb === 'active') {
      return (a.remaining_seconds ?? 0) - (b.remaining_seconds ?? 0);
    }
    // Expired: most recent first
    if (sa === 'expired' && sb === 'expired') {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    }
    return 0;
  });
}

// Shared card rendering for a single authorization item.
// Used by both Mine and Team views.
interface AuthCardProps {
  item: PendingItem;
  revokedSet: Set<string>;
  expandedHash: string | null;
  gateCache: Record<string, GateContentEntry | null>;
  gateLoading: string | null;
  copiedHash: string | null;
  revokingHash: string | null;
  copyingHash: string | null;
  profileConfigCache: Map<string, ProfileConfig | null>;
  mode: string;
  activeDomain: string;
  group: { name: string } | null;
  groupId: string | null;
  // Team-view extras
  ownerLabel?: string;
  isAdmin?: boolean;
  onExpand: (item: PendingItem) => void;
  onCopyHash: (hash: string) => void;
  onCopy: (item: PendingItem) => void;
  onRevoke: (frameHash: string, ownerLabel?: string, profileShortName?: string) => void;
  onExtend: (item: PendingItem) => void;
}

function AuthCard({
  item,
  revokedSet,
  expandedHash,
  gateCache,
  gateLoading,
  copiedHash,
  revokingHash,
  copyingHash,
  profileConfigCache,
  mode,
  ownerLabel,
  isAdmin,
  onExpand,
  onCopyHash,
  onCopy,
  onRevoke,
  onExtend,
}: AuthCardProps) {
  const status = getStatus(item, revokedSet);
  const isExpanded = expandedHash === item.frame_hash;
  const gateEntry = gateCache[item.frame_hash || item.profile_id || item.path];
  const showExtend = status === 'active' || status === 'pending' || status === 'expired';
  const boundsEntries = Object.entries(item.frame)
    .filter(([k]) => k !== 'profile' && k !== 'path');

  const itemConfig = profileConfigCache.get(item.profile_id) ?? null;
  const hasApprovers = (itemConfig?.approvers?.length ?? 0) > 0;
  const aboveCapByKey = new Map<string, { authorized: number; cap: number }>();
  if (itemConfig?.caps && mode === 'team') {
    for (const [k, v] of boundsEntries) {
      const cap = itemConfig.caps[k];
      if (cap !== undefined && Number(v) > cap) {
        aboveCapByKey.set(k, { authorized: Number(v), cap });
      }
    }
  }
  const isAboveCap = aboveCapByKey.size > 0;

  const frozenApprovers = item.approvers_frozen ?? [];
  const currentApprovers = itemConfig?.approvers ?? [];
  const approversDrifted =
    mode === 'team' &&
    frozenApprovers.length > 0 &&
    currentApprovers.length > 0 &&
    (frozenApprovers.length !== currentApprovers.length ||
      frozenApprovers.some(uid => !currentApprovers.includes(uid)) ||
      currentApprovers.some(uid => !frozenApprovers.includes(uid)));

  const escalationSummary = Array.from(aboveCapByKey.entries())
    .map(([k, r]) => `${k}: ${r.authorized} (cap ${r.cap})`)
    .join(', ');
  const reducedSummary = Array.from(aboveCapByKey.entries())
    .map(([k, r]) => `${k}: ${r.authorized} → ${r.cap}`)
    .join(', ');
  const capPillText = !isAboveCap
    ? ''
    : hasApprovers
      ? aboveCapByKey.size === 1
        ? `Above team cap: ${escalationSummary} — actions require approval`
        : `Above team cap (${aboveCapByKey.size}): ${escalationSummary} — actions require approval`
      : aboveCapByKey.size === 1
        ? `Reduced by hard cap: ${reducedSummary}`
        : `Reduced by hard cap (${aboveCapByKey.size}): ${reducedSummary}`;
  const capPillTooltip = !isAboveCap
    ? undefined
    : hasApprovers
      ? `Above-cap actions under this authority require per-action approval from the profile's approvers. Bounds remain authorized at their original values.`
      : `No approvers are configured for this profile, so the team cap is a hard ceiling. Bounds above the cap are effectively reduced to the cap. Ask the admin to raise the cap or add approvers, or copy this authorization to reissue within the cap.`;

  const profileShortName = profileDisplayName(item.profile_id);

  return (
    <div className="card" key={item.frame_hash} style={{ marginBottom: 0 }}>
      {/* Team owner line */}
      {ownerLabel && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '0.375rem' }}>
          Owner: <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{ownerLabel}</span>
        </div>
      )}

      {/* Collapsed view */}
      <div className="auth-card-header">
        <span
          style={{
            fontWeight: 700,
            fontSize: '1rem',
            color: 'var(--text-primary)',
            letterSpacing: '0.01em',
          }}
        >
          {profileShortName}
        </span>
        {item.title && (
          <span style={{ fontWeight: 500, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {item.title}
          </span>
        )}
        <StatusBadge status={status} />
        {status === 'active' && item.earliest_expiry && (
          <TTLBadge expiresAt={new Date(item.earliest_expiry).getTime() / 1000} />
        )}
        {status === 'expired' && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
            {new Date(item.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem', alignItems: 'center' }}>
        {item.required_domains.map(d => (
          <DomainBadge key={d} domain={d} attested={item.attested_domains.includes(d)} />
        ))}
        {item.deferred_commitment_domains.length > 0 && (
          <span style={{
            fontSize: '0.65rem',
            padding: '0.15rem 0.4rem',
            borderRadius: '0.25rem',
            background: 'var(--accent-subtle)',
            color: 'var(--accent)',
            fontWeight: 600,
          }}>
            Review Mode
          </span>
        )}
        {isAboveCap && (
          <span
            title={capPillTooltip}
            style={{
              fontSize: '0.65rem',
              padding: '0.15rem 0.4rem',
              borderRadius: '0.25rem',
              background: hasApprovers ? 'var(--accent-subtle)' : 'var(--danger-subtle)',
              color: hasApprovers ? 'var(--accent)' : 'var(--danger)',
              fontWeight: 600,
              cursor: 'help',
            }}
          >
            {capPillText}
          </span>
        )}
        {approversDrifted && (
          <button
            className="btn btn-ghost btn-sm"
            style={{
              fontSize: '0.65rem',
              padding: '0.15rem 0.5rem',
              borderRadius: '0.25rem',
              background: 'var(--warning-subtle, rgba(234,179,8,0.12))',
              color: 'var(--warning, #ca8a04)',
              fontWeight: 600,
              border: '1px solid var(--warning-border, rgba(234,179,8,0.3))',
              cursor: 'pointer',
              lineHeight: 1.4,
            }}
            onClick={() => onCopy(item)}
            disabled={copyingHash === item.frame_hash}
            title="The approver list for this profile has changed since this authority was created. Copy to reissue with the current approvers."
          >
            {copyingHash === item.frame_hash ? 'Copying...' : 'Approver list updated · Copy with new approvers'}
          </button>
        )}
      </div>

      {boundsEntries.length > 0 && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
          {boundsEntries.map(([k, v], i) => {
            const r = aboveCapByKey.get(k);
            return (
              <span key={k}>
                {i > 0 && ' · '}
                {r ? (
                  hasApprovers ? (
                    <span title={`Team cap on ${k} is ${r.cap}. Actions exceeding the cap require per-action approval. Bound remains authorized at ${r.authorized}.`}>
                      <span style={{ color: 'var(--text-tertiary)' }}>{k}={String(v)}</span>
                      <span style={{ color: 'var(--accent)', marginLeft: '0.25rem', fontWeight: 600 }}>
                        ↑ approval at {r.cap}
                      </span>
                    </span>
                  ) : (
                    <span title={`Team cap on ${k} is ${r.cap} with no approvers configured (hard cap). Authorized for ${r.authorized}; effective ${r.cap}.`}>
                      <span style={{ textDecoration: 'line-through', color: 'var(--text-tertiary)' }}>{k}={String(v)}</span>
                      <span style={{ color: 'var(--danger)', marginLeft: '0.25rem', fontWeight: 600 }}>
                        {'→'} {r.cap}
                      </span>
                    </span>
                  )
                ) : (
                  <span>{k}={String(v)}</span>
                )}
              </span>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => onExpand(item)}
        >
          {isExpanded ? '▲ Hide Details' : '▼ Details'}
        </button>
      </div>

      {/* Expanded view */}
      {isExpanded && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: '0.75rem', paddingTop: '0.75rem' }}>
          {boundsEntries.length > 0 && (
            <>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>
                Bounds
              </div>
              <dl className="review-grid">
                {boundsEntries.map(([k, v]) => (
                  <span key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt>
                    <dd>{String(v)}</dd>
                  </span>
                ))}
              </dl>
            </>
          )}

          {gateEntry?.context && Object.keys(gateEntry.context).length > 0 && (
            <>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: '1rem', marginBottom: '0.25rem' }}>
                Context
              </div>
              <dl className="review-grid">
                {Object.entries(gateEntry.context).map(([k, v]) => (
                  <span key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt>
                    <dd>{String(v)}</dd>
                  </span>
                ))}
              </dl>
            </>
          )}

          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: '1rem', marginBottom: '0.25rem' }}>
            Intent
          </div>
          {gateLoading === item.frame_hash ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Loading gate content...</p>
          ) : gateEntry ? (
            <div className="gate-content-block">
              <div className="gate-content-item">
                <div className="gate-content-text">{gateEntry.gateContent.intent}</div>
              </div>
            </div>
          ) : (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Gate content not available.</p>
          )}

          <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '1rem' }}>
            Created: {new Date(item.created_at).toLocaleString()}
            {item.earliest_expiry && ` · Expires: ${new Date(item.earliest_expiry).toLocaleString()}`}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', fontFamily: "'SF Mono', Monaco, monospace", wordBreak: 'break-all' }}>
              {item.frame_hash}
            </span>
            <button
              className="btn btn-ghost btn-sm"
              style={{ fontSize: '0.7rem', padding: '0.125rem 0.375rem' }}
              onClick={() => onCopyHash(item.frame_hash)}
            >
              {copiedHash === item.frame_hash ? 'copied' : 'copy'}
            </button>
          </div>

          {/* Expanded action row */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.75rem' }}>
            {/* Copy action only shown in Mine tab (team items belong to other users) */}
            {!ownerLabel && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => onCopy(item)}
                disabled={copyingHash === item.frame_hash}
                title="Start a new authorization pre-filled with these bounds, context, and intent"
              >
                {copyingHash === item.frame_hash ? 'Copying…' : '⧉ Copy'}
              </button>
            )}
            {/* Extend only in Mine tab */}
            {!ownerLabel && showExtend && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => onExtend(item)}
              >
                {'↻ Extend'}
              </button>
            )}
            {/* Revoke: in Mine tab for active/pending; in Team tab for admin on any non-revoked item */}
            {ownerLabel && isAdmin && status !== 'revoked' ? (
              <button
                className="btn btn-danger btn-sm"
                onClick={() => onRevoke(item.frame_hash, ownerLabel, profileShortName)}
                disabled={revokingHash === item.frame_hash}
              >
                {revokingHash === item.frame_hash ? 'Revoking…' : 'Revoke'}
              </button>
            ) : !ownerLabel && (status === 'active' || status === 'pending') ? (
              <button
                className="btn btn-danger btn-sm"
                onClick={() => onRevoke(item.frame_hash)}
                disabled={revokingHash === item.frame_hash}
              >
                {revokingHash === item.frame_hash ? 'Revoking…' : 'Revoke'}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

export function AuthorizationsPage() {
  // Mine tab state
  const [items, setItems] = useState<PendingItem[]>([]);
  const [mineLoading, setMineLoading] = useState(true);

  // Team tab state
  const [teamItems, setTeamItems] = useState<TeamItem[]>([]);
  const [teamLoading, setTeamLoading] = useState(false);

  // Shared UI state
  const [viewTab, setViewTab] = useState<ViewTab>('mine');
  const [activeFilter, setActiveFilter] = useState<StatusFilter>('active');
  const [profileFilter, setProfileFilter] = useState<string | null>(null);
  const [modeFilter, setModeFilter] = useState<'auto' | 'review' | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [showPicker, setShowPicker] = useState(() => searchParams.get('new') === '1');
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [gateCache, setGateCache] = useState<Record<string, GateContentEntry | null>>({});
  const [gateLoading, setGateLoading] = useState<string | null>(null);
  const [extendItem, setExtendItem] = useState<PendingItem | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [revokedSet, setRevokedSet] = useState<Set<string>>(new Set());
  const [revokingHash, setRevokingHash] = useState<string | null>(null);
  const [copyingHash, setCopyingHash] = useState<string | null>(null);

  const navigate = useNavigate();
  const { group, groupId, domain: activeDomain, mode, activeTeam } = useAuth();
  const isAdmin = activeTeam?.isAdmin === true;

  const [profileConfigCache, setProfileConfigCache] = useState<Map<string, ProfileConfig | null>>(
    () => new Map(),
  );

  const fetchMineItems = useCallback(() => {
    setMineLoading(true);
    spClient.getMyAttestations()
      .then(setItems)
      .catch(() => {})
      .finally(() => setMineLoading(false));
  }, []);

  const fetchTeamItems = useCallback(() => {
    if (!groupId) return;
    setTeamLoading(true);
    spClient.listTeamAuthorizations(groupId)
      .then(setTeamItems)
      .catch(() => {})
      .finally(() => setTeamLoading(false));
  }, [groupId]);

  // SSE-driven refresh
  useSSEEvent('attestation-changed', () => {
    fetchMineItems();
    if (isAdmin && groupId) fetchTeamItems();
  });
  // Fallback full-sync every 5min
  useVisiblePolling(fetchMineItems, 300_000);

  // Fetch team items when switching to team tab for the first time
  useEffect(() => {
    if (viewTab === 'team' && isAdmin && groupId && teamItems.length === 0 && !teamLoading) {
      fetchTeamItems();
    }
  }, [viewTab, isAdmin, groupId, teamItems.length, teamLoading, fetchTeamItems]);

  // Profile config cache — fetch for items we haven't resolved yet (team mode only)
  useEffect(() => {
    if (mode !== 'team' || !groupId) return;
    const allItems = viewTab === 'mine' ? items : teamItems;
    if (allItems.length === 0) return;
    const unseen = [...new Set(allItems.map(i => i.profile_id))].filter(
      id => !profileConfigCache.has(id),
    );
    if (unseen.length === 0) return;
    setProfileConfigCache(prev => {
      const next = new Map(prev);
      for (const id of unseen) next.set(id, null);
      return next;
    });
    for (const profileId of unseen) {
      spClient.getTeamProfileConfig(groupId, profileId)
        .then(config => {
          setProfileConfigCache(prev => new Map(prev).set(profileId, config));
        })
        .catch(() => {});
    }
  }, [items, teamItems, viewTab, groupId, mode, profileConfigCache]);

  const handleExpand = async (item: PendingItem) => {
    if (expandedHash === item.frame_hash) {
      setExpandedHash(null);
      return;
    }
    setExpandedHash(item.frame_hash);

    const lookupKey = item.frame_hash || item.profile_id || item.path;
    if (!(lookupKey in gateCache)) {
      setGateLoading(item.frame_hash);
      try {
        const entry = await spClient.getGateContent(lookupKey);
        setGateCache(prev => ({ ...prev, [lookupKey]: entry }));
      } catch {
        setGateCache(prev => ({ ...prev, [lookupKey]: null }));
      } finally {
        setGateLoading(null);
      }
    }
  };

  const handleCopyHash = (hash: string) => {
    navigator.clipboard.writeText(hash).then(() => {
      setCopiedHash(hash);
      setTimeout(() => setCopiedHash(null), 2000);
    });
  };

  const handleCopy = async (item: PendingItem) => {
    if (!groupId) {
      alert('No active group; cannot copy authorization.');
      return;
    }
    setCopyingHash(item.frame_hash);
    try {
      const lookupKey = item.frame_hash || item.profile_id || item.path;
      let entry: GateContentEntry | null = gateCache[lookupKey] ?? null;
      if (!(lookupKey in gateCache)) {
        entry = await spClient.getGateContent(lookupKey);
        setGateCache(prev => ({ ...prev, [lookupKey]: entry }));
      }

      const bounds = Object.fromEntries(
        Object.entries(item.frame).filter(([k]) => k !== 'profile' && k !== 'path')
      );
      const context = entry?.context ?? {};
      const intent = entry?.gateContent?.intent ?? '';
      const templateMode: 'automatic' | 'review' =
        item.deferred_commitment_domains.length > 0 ? 'review' : 'automatic';
      const domainForAuth = item.attested_domains[0] || activeDomain || 'owner';

      sessionStorage.setItem('agentAuth', JSON.stringify({
        profileId: item.profile_id,
        groupId,
        groupName: group?.name ?? null,
        domain: domainForAuth,
      }));
      sessionStorage.setItem('agentGate', JSON.stringify({
        bounds,
        context,
        gateContent: { intent },
        templateMode,
      }));
      navigate('/agent/gate');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to copy authorization');
    } finally {
      setCopyingHash(null);
    }
  };

  const handleRevoke = async (frameHash: string, ownerLabel?: string, profileShortName?: string) => {
    const confirmMsg = ownerLabel && profileShortName
      ? `Revoke ${ownerLabel}'s ${profileShortName} authorization? This cannot be undone.`
      : 'Revoke this authorization? The agent will no longer be able to execute actions under this attestation.';
    if (!confirm(confirmMsg)) return;
    setRevokingHash(frameHash);
    try {
      await spClient.revokeAttestation(frameHash);
      setRevokedSet(prev => new Set(prev).add(frameHash));
      // Refresh team list after admin revoke
      if (ownerLabel && groupId) {
        fetchTeamItems();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to revoke authorization');
    } finally {
      setRevokingHash(null);
    }
  };

  // Compute counts and filtered list for the active view
  const activeItems = viewTab === 'mine' ? items : teamItems;
  const loading = viewTab === 'mine' ? mineLoading : teamLoading;

  const counts = {
    active: activeItems.filter(i => getStatus(i, revokedSet) === 'active').length,
    pending: activeItems.filter(i => getStatus(i, revokedSet) === 'pending').length,
    expired: activeItems.filter(i => getStatus(i, revokedSet) === 'expired').length,
    revoked: activeItems.filter(i => getStatus(i, revokedSet) === 'revoked').length,
  };

  const profileSummary = (() => {
    const map = new Map<string, { count: number; review: boolean }>();
    for (const item of activeItems) {
      if (getStatus(item, revokedSet) !== activeFilter) continue;
      const entry = map.get(item.profile_id) ?? { count: 0, review: false };
      entry.count += 1;
      if (item.deferred_commitment_domains.length > 0) entry.review = true;
      map.set(item.profile_id, entry);
    }
    return Array.from(map.entries())
      .map(([profileId, meta]) => ({ profileId, ...meta }))
      .sort((a, b) => profileDisplayName(a.profileId).localeCompare(profileDisplayName(b.profileId)));
  })();

  const filtered = sortItems(
    activeItems.filter(i => {
      if (getStatus(i, revokedSet) !== activeFilter) return false;
      if (profileFilter !== null && i.profile_id !== profileFilter) return false;
      if (modeFilter !== null) {
        const isReview = i.deferred_commitment_domains.length > 0;
        if (modeFilter === 'review' && !isReview) return false;
        if (modeFilter === 'auto' && isReview) return false;
      }
      return true;
    }),
    revokedSet,
  );

  const sharedCardProps = {
    revokedSet,
    expandedHash,
    gateCache,
    gateLoading,
    copiedHash,
    revokingHash,
    copyingHash,
    profileConfigCache,
    mode,
    activeDomain,
    group,
    groupId,
    onExpand: handleExpand,
    onCopyHash: handleCopyHash,
    onCopy: handleCopy,
    onRevoke: handleRevoke,
    onExtend: setExtendItem,
  };

  return (
    <>
      <div
        className="page-header"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}
      >
        <div>
          <h1 className="page-title">Authorizations</h1>
          <p className="page-subtitle">Active, pending, and expired agent authorizations.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowPicker(true)}>
          + New authorization
        </button>
      </div>

      {showPicker && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setShowPicker(false);
            if (searchParams.get('new')) {
              searchParams.delete('new');
              setSearchParams(searchParams, { replace: true });
            }
          }}
        >
          <div
            className="modal"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '960px', width: '90vw' }}
          >
            <div className="modal-header">
              <h2 className="modal-title">New authorization</h2>
              <button
                className="modal-close"
                onClick={() => {
                  setShowPicker(false);
                  if (searchParams.get('new')) {
                    searchParams.delete('new');
                    setSearchParams(searchParams, { replace: true });
                  }
                }}
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem', marginTop: 0, marginBottom: '1rem' }}>
                What should your agent be able to do? Pick a profile, set limits, then authorize.
              </p>
              <AuthorizePicker onDismiss={() => setShowPicker(false)} />
            </div>
          </div>
        </div>
      )}

      {/* Mine | Team view tab strip */}
      {isAdmin && (
        <div className="nav-tabs" style={{ marginBottom: '0.5rem' }}>
          <button
            className={`nav-tab${viewTab === 'mine' ? ' active' : ''}`}
            onClick={() => {
              setViewTab('mine');
              setActiveFilter('active');
              setProfileFilter(null);
              setModeFilter(null);
              setExpandedHash(null);
            }}
          >
            Mine
          </button>
          <button
            className={`nav-tab${viewTab === 'team' ? ' active' : ''}`}
            onClick={() => {
              setViewTab('team');
              setActiveFilter('active');
              setProfileFilter(null);
              setModeFilter(null);
              setExpandedHash(null);
            }}
          >
            Team
          </button>
        </div>
      )}

      {/* Status filter tabs */}
      <div className="nav-tabs">
        {(['active', 'pending', 'expired', 'revoked'] as const).map(tab => (
          <button
            key={tab}
            className={`nav-tab${activeFilter === tab ? ' active' : ''}`}
            onClick={() => { setActiveFilter(tab); setProfileFilter(null); setModeFilter(null); }}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)} ({counts[tab]})
          </button>
        ))}
      </div>

      {/* Secondary filter row */}
      {profileSummary.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap',
            alignItems: 'center',
            marginTop: '-0.25rem',
            marginBottom: '1rem',
          }}
        >
          {profileSummary.map(p => {
            const selected = profileFilter === p.profileId;
            return (
              <button
                key={p.profileId}
                className={`btn btn-sm ${selected ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setProfileFilter(selected ? null : p.profileId)}
              >
                {profileDisplayName(p.profileId)}
              </button>
            );
          })}

          <span
            aria-hidden="true"
            style={{
              color: 'var(--border)',
              fontSize: '1.1rem',
              padding: '0 0.25rem',
              userSelect: 'none',
            }}
          >
            |
          </span>

          {(['auto', 'review'] as const).map(m => {
            const selected = modeFilter === m;
            return (
              <button
                key={m}
                className={`btn btn-sm ${selected ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setModeFilter(selected ? null : m)}
              >
                {m === 'auto' ? 'Auto' : 'Review'}
              </button>
            );
          })}
        </div>
      )}

      {loading && activeItems.length === 0 ? (
        <p style={{ color: 'var(--text-tertiary)' }}>Loading...</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={'☰'}
          title="No authorizations"
          text={activeFilter === 'all'
            ? 'Authorization events will appear here after you authorize an agent.'
            : `No ${activeFilter} authorizations found.`}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {filtered.map(item => {
            const teamItem = viewTab === 'team' ? (item as TeamItem) : null;
            const ownerLabel = teamItem?.owner
              ? (teamItem.owner.name ?? teamItem.owner.email ?? teamItem.owner.userId)
              : undefined;
            return (
              <AuthCard
                key={item.frame_hash}
                item={item}
                ownerLabel={ownerLabel}
                isAdmin={isAdmin}
                {...sharedCardProps}
              />
            );
          })}
        </div>
      )}

      {/* Extend Modal */}
      {extendItem && (
        <ExtendAuthModal
          item={extendItem}
          onClose={() => setExtendItem(null)}
          onSuccess={() => {
            setExtendItem(null);
            fetchMineItems();
          }}
        />
      )}
    </>
  );
}
