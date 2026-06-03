import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { spClient, type PendingItem, type GateContentEntry } from '../lib/sp-client';
import { computeBoundsHashBrowser, computeContextHashBrowser, hashGateContent } from '../lib/frame';
import { buildGateForwardArgs } from '../lib/gate-forward';
import { profileDisplayName } from '../lib/profile-display';
import type { AgentProfile } from '@hap/core';

function formatRemaining(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'}`;
  const h = Math.floor(seconds / 3600);
  if (h >= 1) return `${h} hour${h === 1 ? '' : 's'}`;
  const m = Math.ceil(seconds / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

const TTL_OPTIONS = [
  { label: '30m', seconds: 1800 },
  { label: '1h', seconds: 3600 },
  { label: '2h', seconds: 7200 },
  { label: '4h', seconds: 14400 },
  { label: '8h', seconds: 28800 },
  { label: '24h', seconds: 86400 },
  { label: '7d', seconds: 604800 },
  { label: '30d', seconds: 2592000 },
  { label: '1y', seconds: 31536000 },
];

interface Props {
  item: PendingItem;
  onClose: () => void;
  onSuccess: () => void;
}

export function ExtendAuthModal({ item, onClose, onSuccess }: Props) {
  const { user, activeDomain, groupId } = useAuth();

  // Filter out durations that would SHORTEN the authorization. Extending to
  // less than the remaining TTL is nonsense — the attestation's existing TTL
  // is already longer. Keep options strictly greater than remaining.
  const remaining = item.remaining_seconds ?? 0;
  const usableOptions = TTL_OPTIONS.filter(o => o.seconds > remaining);

  // Default selection: smallest usable option (nearest useful bump), or 30d if
  // the list is empty because the auth is already on a multi-year TTL.
  const defaultTTL = usableOptions[0]?.seconds ?? 2592000;
  const [selectedTTL, setSelectedTTL] = useState(defaultTTL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const boundsEntries = Object.entries(item.frame)
    .filter(([k]) => k !== 'profile' && k !== 'path');

  const handleExtend = async () => {
    if (!user) return;
    setSubmitting(true);
    setError('');

    try {
      // 1. Fetch gate content from MCP. The gate store keys under (in priority):
      //    frame_hash / profile_id / path — v0.4 attestations have no `path`
      //    so passing item.path alone returns null (which is what caused the
      //    "Gate content not found locally" error users hit on extend).
      const lookupKey = item.frame_hash || item.profile_id || item.path;
      const gateEntry: GateContentEntry | null = await spClient.getGateContent(lookupKey);
      if (!gateEntry) {
        throw new Error('Gate content not found locally. The MCP server may have restarted. Please re-authorize through the full wizard instead.');
      }

      // 2. Fetch profile schema
      const profile: AgentProfile = await spClient.getProfile(item.profile_id);

      // 3. Recompute hashes
      const bounds = item.frame;
      const context = gateEntry.context ?? {};
      const domain = item.attested_domains[0] || activeDomain || 'owner';

      const boundsHash = await computeBoundsHashBrowser(bounds, profile);
      const contextHash = await computeContextHashBrowser(context, profile);

      const [intentHash, ecHash] = await Promise.all([
        hashGateContent(gateEntry.gateContent.intent),
        hashGateContent(JSON.stringify({
          profile: item.profile_id,
          path: item.path,
          domain,
        })),
      ]);

      // 4. Re-attest with new TTL.
      // v0.4: every attestation requires group_id and commitment_mode in
      // the signed payload. Preserve the original commitment mode by
      // checking deferred_commitment_domains — the original was 'review'
      // iff that array is non-empty.
      if (!groupId) {
        throw new Error('No active group; cannot extend authorization.');
      }
      const originalMode: 'automatic' | 'review' =
        (item.deferred_commitment_domains?.length ?? 0) > 0 ? 'review' : 'automatic';

      const result = await spClient.attest({
        profile_id: item.profile_id,
        path: item.path,
        bounds,
        bounds_hash: boundsHash,
        context_hash: contextHash,
        domain,
        did: user.did,
        gate_content_hashes: { intent: intentHash },
        execution_context_hash: ecHash,
        group_id: groupId,
        commitment_mode: originalMode,
        ttl: selectedTTL,
      });

      // 5. Push gate content to MCP. buildGateForwardArgs guarantees frameHash
      // is included — the MCP server resolves the attestation at the AS by its
      // per-user storage key, and boundsHash alone 404s. Shared with the create
      // flow so the two can't diverge (this flow once omitted frameHash).
      await spClient.pushGateContent(
        buildGateForwardArgs(result, {
          boundsHash,
          contextHash,
          context,
          path: item.path,
          gateContent: gateEntry.gateContent,
        }),
      );

      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Extension failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3 className="modal-title">Extend Authorization</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
              {profileDisplayName(item.profile_id)} / {item.path}
            </div>
            {boundsEntries.length > 0 && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                {boundsEntries.map(([k, v]) => `${k}=${v}`).join(' \u00B7 ')}
              </div>
            )}
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.5rem' }}>
              New duration
            </div>
            {remaining > 0 && (
              <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
                Currently valid for {formatRemaining(remaining)}. Only longer durations are shown.
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {usableOptions.length === 0 ? (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                  This authorization is already on the longest available duration. Nothing to extend.
                </div>
              ) : (
                usableOptions.map(opt => (
                  <button
                    key={opt.seconds}
                    className={`btn ${selectedTTL === opt.seconds ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setSelectedTTL(opt.seconds)}
                    style={{ minWidth: '3.5rem' }}
                  >
                    {opt.label}
                  </button>
                ))
              )}
            </div>
          </div>

          <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
            Same bounds, context, and gate content will be re-attested with a new TTL (measured from now).
          </div>

          {error && <div className="error-message">{error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" onClick={handleExtend} disabled={submitting}>
            {submitting ? 'Extending...' : 'Extend'}
          </button>
        </div>
      </div>
    </div>
  );
}
