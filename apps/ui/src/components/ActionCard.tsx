import { Fragment } from 'react';
import type { ThreadItem } from '../lib/thread-aggregator';
import { ProfileBadge } from './ProfileBadge';
import { formatTimeLeft } from '../lib/time-left';

type CardStatus = 'pending' | 'committed' | 'executed' | 'rejected' | 'expired';

// Maps thread/proposal statuses to the existing design-system CSS classes.
// Keeps this component independent of StatusBadge's narrower status union.
const STATUS_LABEL: Record<CardStatus, string> = {
  pending: 'Pending',
  committed: 'Approved',
  executed: 'Executed',
  rejected: 'Rejected',
  expired: 'Expired',
};
const STATUS_CLASS: Record<CardStatus, string> = {
  pending: 'status-pending',
  committed: 'status-active',
  executed: 'status-active',
  rejected: 'status-revoked',
  expired: 'status-expired',
};

function formatTimestamp(unixSeconds: number): string {
  const ageMs = Date.now() - unixSeconds * 1000;
  const hours = ageMs / 3_600_000;
  if (hours < 48) {
    if (hours < 1) {
      const minutes = Math.max(1, Math.round(ageMs / 60_000));
      return `${minutes}m ago`;
    }
    return `${Math.round(hours)}h ago`;
  }
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shortToolName(namespaced: string): string {
  return namespaced.split('__').pop() ?? namespaced;
}

function isDestructive(tool: string): boolean {
  const lower = tool.toLowerCase();
  return (
    lower.includes('delete') ||
    lower.includes('refund') ||
    lower.includes('cancel') ||
    lower.includes('revoke')
  );
}

const HIDDEN_ARG_KEYS = new Set([
  'apiKey', 'api_key', 'accessToken', 'access_token',
  'password', 'secret', 'signature',
  '_imagePreview', // rendered separately, not in the args table
]);

const IMAGE_FIELD_RE = /^(image|img|photo|picture|thumbnail)(_?url)?$/i;

function isImageArg(key: string, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Data URLs are always images regardless of field name
  if (/^data:image\//i.test(value)) return true;
  if (IMAGE_FIELD_RE.test(key)) return /^https?:\/\//.test(value);
  return /^https?:\/\/.+\.(jpe?g|png|gif|webp|svg|avif)(\?|$)/i.test(value);
}

// NEVER truncate: this card is the review surface — the human approves
// exactly what they can read here, so the full content must be visible at
// once (an email body cut at 160 chars was approvable but not reviewable).
function formatArgValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => formatArgValue(x)).join(', ');
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

interface Props {
  item: ThreadItem;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  resolving?: boolean;
}

export function ActionCard({ item, onApprove, onReject, resolving }: Props) {
  const isProposal = item.kind === 'proposal';
  const status: CardStatus = isProposal ? item.proposal.status : 'executed';
  const toolFull = isProposal ? item.proposal.tool : item.receipt.action;
  const toolShort = shortToolName(toolFull);
  const destructive = isDestructive(toolFull);

  const args = isProposal ? item.proposal.toolArgs : null;
  const executionContext = isProposal ? item.proposal.executionContext : item.receipt.executionContext;
  const cumulative = !isProposal ? item.receipt.cumulativeState : null;

  const argEntries = args
    ? Object.entries(args).filter(([k]) => !HIDDEN_ARG_KEYS.has(k))
    : [];
  const ctxEntries = Object.entries(executionContext ?? {});

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <ProfileBadge profileId={item.profileId} />
        <code style={{ fontSize: '0.85rem' }}>{toolShort}</code>
        {item.commitmentMode === 'automatic' && (
          <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            autonomous
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {isProposal && status === 'pending' && (() => {
            const left = formatTimeLeft(item.proposal.expiresAt, Date.now());
            return (
              <span style={{
                fontSize: '0.72rem',
                color: left.urgent ? 'var(--warning)' : 'var(--text-tertiary)',
                fontWeight: left.urgent ? 600 : 400,
                whiteSpace: 'nowrap',
              }}>
                {left.label}
              </span>
            );
          })()}
          <span className={`status-badge ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
            {formatTimestamp(item.sortTimestamp)}
          </span>
        </span>
      </div>

      {destructive && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.4rem',
          fontSize: '0.8rem', color: 'var(--warning)',
          background: 'var(--bg-main)', border: '1px solid var(--border)',
          borderRadius: '0.375rem', padding: '0.4rem 0.6rem', marginBottom: '0.75rem',
        }}>
          <span>⚠</span>
          <span>Irreversible action</span>
        </div>
      )}

      {isProposal && typeof (args as Record<string, unknown>)?._imagePreview === 'string' && (
        <div style={{ marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.35rem' }}>
            Preview
          </div>
          <img
            src={(args as Record<string, string>)._imagePreview}
            alt={typeof (args as Record<string, unknown>)?.altText === 'string'
              ? (args as Record<string, string>).altText
              : 'local image preview'}
            style={{
              display: 'block',
              maxWidth: '100%',
              maxHeight: '240px',
              borderRadius: '0.375rem',
              border: '1px solid var(--border)',
            }}
          />
        </div>
      )}

      {isProposal && argEntries.length > 0 && (
        <div style={{ marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.35rem' }}>
            Arguments
          </div>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.2rem 0.75rem', fontSize: '0.85rem', margin: 0 }}>
            {argEntries.map(([k, v]) => (
              <Fragment key={k}>
                <dt style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', alignSelf: 'start' }}>{k}</dt>
                <dd style={{ color: 'var(--text-primary)', margin: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                  {isImageArg(k, v) ? (
                    <img
                      src={v}
                      alt={typeof (args as Record<string, unknown>)?.altText === 'string'
                        ? (args as Record<string, string>).altText
                        : k}
                      style={{
                        display: 'block',
                        maxWidth: '100%',
                        maxHeight: '240px',
                        borderRadius: '0.375rem',
                        border: '1px solid var(--border)',
                      }}
                      onError={(e) => {
                        const img = e.currentTarget;
                        const parent = img.parentElement;
                        if (!parent) return;
                        img.style.display = 'none';
                        const fallback = document.createElement('span');
                        fallback.textContent = v;
                        fallback.style.color = 'var(--text-tertiary)';
                        parent.appendChild(fallback);
                      }}
                    />
                  ) : (
                    formatArgValue(v)
                  )}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}

      {ctxEntries.length > 0 && (
        <div style={{ marginBottom: '0.75rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {ctxEntries.map(([k, v]) => `${k}=${formatArgValue(v)}`).join(' · ')}
        </div>
      )}

      {cumulative && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
          After this action · today: {cumulative.daily.count} action{cumulative.daily.count === 1 ? '' : 's'}
          {cumulative.daily.amount > 0 ? `, ${cumulative.daily.amount}` : ''}
          {' · '}this month: {cumulative.monthly.count}
          {cumulative.monthly.amount > 0 ? `, ${cumulative.monthly.amount}` : ''}
        </div>
      )}

      {isProposal && status === 'pending' && (
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            className="btn btn-primary"
            onClick={() => onApprove?.(item.id)}
            disabled={resolving}
          >
            {resolving ? 'Approving…' : 'Approve'}
          </button>
          <button
            className="btn btn-ghost"
            style={{ color: 'var(--danger)' }}
            onClick={() => onReject?.(item.id)}
            disabled={resolving}
          >
            Reject
          </button>
        </div>
      )}

      <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
        {isProposal ? 'Proposal' : 'Receipt'}: {item.id}
      </div>
    </div>
  );
}
