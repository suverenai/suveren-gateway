/**
 * ApproverProposalCard — Phase 6 per-action approval card.
 *
 * Shown in the "Awaiting me" tab. Displays:
 *  - Profile + authority bounds (with above-cap annotation)
 *  - Intent (HPKE-decrypted on demand)
 *  - Proposed tool + args
 *  - Approve / Reject buttons
 *
 * On approve:
 *  1. Calls POST /api/proposals/:id/approve (SP)
 *  2. Fetches intent from SP (GET /api/attestations/:hash/intent)
 *  3. Decrypts via POST /api/decrypt-intent (CP)
 *  4. Persists to ~/.suveren/approved-intents.enc.json via POST /api/approved-intents (CP)
 */

import { useState, Fragment } from 'react';
import { spClient, type Proposal } from '../lib/sp-client';
import { profileDisplayName } from '../lib/profile-display';

const HIDDEN_ARG_KEYS = new Set([
  'apiKey', 'api_key', 'accessToken', 'access_token',
  'password', 'secret', 'signature', '_imagePreview',
]);

function formatArgValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 197) + '...' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => formatArgValue(x)).join(', ');
  try {
    const j = JSON.stringify(v);
    return j.length > 200 ? j.slice(0, 197) + '...' : j;
  } catch {
    return String(v);
  }
}

function formatAge(unixSeconds: number): string {
  const ageMs = Date.now() - unixSeconds * 1000;
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface Props {
  proposal: Proposal;
  currentUserId: string;
  onAction: () => void;
  onMessage: (msg: string) => void;
}

export function ApproverProposalCard({ proposal, currentUserId, onAction, onMessage }: Props) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [intent, setIntent] = useState<string | null>(null);
  const [intentLoading, setIntentLoading] = useState(false);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const toolShort = proposal.tool.split('__').pop() ?? proposal.tool;
  const argEntries = Object.entries(proposal.toolArgs).filter(([k]) => !HIDDEN_ARG_KEYS.has(k));
  const boundsEntries = Object.entries(proposal.executionContext);

  const pendingApprovers = proposal.pendingApprovers ?? [];
  const approvedBy = proposal.approvedBy ?? {};
  const approvedCount = Object.keys(approvedBy).length;
  const remainingCount = pendingApprovers.filter(uid => !(uid in approvedBy)).length;

  const alreadyApproved = currentUserId in approvedBy;

  // Fetch + decrypt intent from SP
  const loadIntent = async () => {
    if (intent !== null) return; // already loaded
    setIntentLoading(true);
    setIntentError(null);
    try {
      const intentData = await spClient.getAttestationIntent(proposal.frameHash);
      if (!intentData) {
        setIntentError('Intent not available or you are not an authorized approver.');
        return;
      }
      const decrypted = await spClient.decryptIntent({
        intentCiphertext: intentData.intentCiphertext,
        encryptedKey: intentData.encryptedKey,
        approverId: currentUserId,
      });
      setIntent(decrypted);
    } catch (err) {
      setIntentError(err instanceof Error ? err.message : 'Failed to decrypt intent');
    } finally {
      setIntentLoading(false);
    }
  };

  const handleExpand = async () => {
    if (!expanded) {
      setExpanded(true);
      await loadIntent();
    } else {
      setExpanded(false);
    }
  };

  const handleApprove = async () => {
    setApproving(true);
    onMessage('');
    try {
      await spClient.approveProposal(proposal.id);

      // Fetch + store the intent as accountability record (best-effort).
      try {
        if (intent === null) {
          const intentData = await spClient.getAttestationIntent(proposal.frameHash);
          if (intentData) {
            const decrypted = await spClient.decryptIntent({
              intentCiphertext: intentData.intentCiphertext,
              encryptedKey: intentData.encryptedKey,
              approverId: currentUserId,
            });
            setIntent(decrypted);
            await spClient.storeApprovedIntent(proposal.frameHash, decrypted);
          }
        } else {
          await spClient.storeApprovedIntent(proposal.frameHash, intent);
        }
      } catch {
        // Non-fatal: approval already recorded on SP; local store is best-effort.
      }

      onMessage(`Approved. ${remainingCount - 1 > 0 ? `${remainingCount - 1} more approver(s) still needed.` : 'All approvers signed off — action is ready to execute.'}`);
      onAction();
    } catch (err) {
      onMessage(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setApproving(false);
    }
  };

  const handleReject = async () => {
    const reason = prompt('Rejection reason (optional):');
    if (reason === null) return; // user cancelled
    setRejecting(true);
    onMessage('');
    try {
      await spClient.rejectProposal(proposal.id, reason || undefined);
      onMessage('Action rejected.');
      onAction();
    } catch (err) {
      onMessage(err instanceof Error ? err.message : 'Rejection failed');
    } finally {
      setRejecting(false);
    }
  };

  const isBusy = approving || rejecting;

  return (
    <div className="card">
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
          {profileDisplayName(proposal.profileId)}
        </span>
        <span style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem', borderRadius: '0.25rem', background: 'var(--accent-subtle)', color: 'var(--accent)', fontWeight: 600 }}>
          Above cap
        </span>
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
          {formatAge(proposal.createdAt)}
        </span>
      </div>

      {/* Approver progress */}
      <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
        {approvedCount} of {pendingApprovers.length} approver{pendingApprovers.length === 1 ? '' : 's'} signed off
        {pendingApprovers.map(uid => {
          const done = uid in approvedBy;
          return (
            <span key={uid} style={{ marginLeft: '0.5rem', color: done ? 'var(--success, green)' : 'var(--text-tertiary)' }}>
              {done ? '✓' : '○'} {uid === currentUserId ? 'You' : uid}
            </span>
          );
        })}
      </div>

      {/* Proposed tool */}
      <div style={{ marginBottom: '0.5rem' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>
          Proposed action
        </div>
        <code style={{ fontSize: '0.85rem' }}>{toolShort}</code>
      </div>

      {/* Arguments */}
      {argEntries.length > 0 && (
        <div style={{ marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>
            Arguments
          </div>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.2rem 0.75rem', fontSize: '0.85rem', margin: 0 }}>
            {argEntries.map(([k, v]) => (
              <Fragment key={k}>
                <dt style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', alignSelf: 'start' }}>{k}</dt>
                <dd style={{ color: 'var(--text-primary)', margin: 0, wordBreak: 'break-word' }}>{formatArgValue(v)}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}

      {/* Execution context */}
      {boundsEntries.length > 0 && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
          {boundsEntries.map(([k, v]) => `${k}=${formatArgValue(v)}`).join(' · ')}
        </div>
      )}

      {/* Intent (lazy-loaded HPKE decrypt) */}
      <div style={{ marginBottom: '0.75rem' }}>
        <button
          className="btn btn-ghost btn-sm"
          style={{ padding: '0.2rem 0', fontSize: '0.75rem' }}
          onClick={handleExpand}
          disabled={intentLoading}
        >
          {expanded ? '▲ Hide intent' : '▼ Show intent'}
          {intentLoading && ' (decrypting...)'}
        </button>
        {expanded && (
          <div style={{ marginTop: '0.5rem', padding: '0.75rem', background: 'var(--bg-main)', borderRadius: '0.375rem', border: '1px solid var(--border)' }}>
            {intentError ? (
              <p style={{ color: 'var(--danger)', fontSize: '0.8rem', margin: 0 }}>{intentError}</p>
            ) : intent !== null ? (
              <p style={{ fontSize: '0.85rem', margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>{intent}</p>
            ) : (
              <p style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem', margin: 0 }}>No intent available for this authority.</p>
            )}
          </div>
        )}
      </div>

      {/* Action buttons */}
      {!alreadyApproved && (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
          <button
            className="btn btn-primary"
            onClick={handleApprove}
            disabled={isBusy}
          >
            {approving ? 'Approving...' : 'Approve'}
          </button>
          <button
            className="btn btn-ghost"
            style={{ color: 'var(--danger)' }}
            onClick={handleReject}
            disabled={isBusy}
          >
            {rejecting ? 'Rejecting...' : 'Reject'}
          </button>
        </div>
      )}

      {alreadyApproved && (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
          You approved this action. Waiting on other approvers.
        </p>
      )}

      <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
        Proposal: {proposal.id}
      </div>
    </div>
  );
}
