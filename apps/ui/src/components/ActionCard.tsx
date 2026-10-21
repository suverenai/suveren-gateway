import { useRef, useState } from 'react';
import { resolveProposalLinks, type ProposalLink } from '../lib/proposal-links';
import type { ThreadItem } from '../lib/thread-aggregator';
import { formatTimeLeft } from '../lib/time-left';
import { ProposalArgs } from './ProposalArgs';
import { ProfileRail } from './ProfileRail';
import { OutcomeBox } from './OutcomeBox';
import { ApprovalBody } from './ApprovalBody';
import { TicketWhatWasDone } from './TicketWhatWasDone';
import { TicketWhatYouSaw } from './TicketWhatYouSaw';
import { ChangeNeededPanel } from './ChangeNeededPanel';
import { isTestSetupAction, profileIdentity } from '../lib/profile-identity';
import { splitTool, systemDisplayName, type ToolDisplay } from '../lib/approval-view';
import { spClient, type IntegrationManifest, type ShownSnapshotPayload } from '../lib/sp-client';
import { validateChangeNote, outcomeAfterView, refusedAfterView, type OutcomeKindLabel } from '../lib/reject-outcome';
import { useProposalContent, useDecryptedNote, decisionButtonsVisible } from '../lib/use-proposal-content';

type CardStatus = 'pending' | 'committed' | 'executed' | 'rejected' | 'expired' | 'refused';

// Maps thread/proposal statuses to the existing design-system CSS classes.
// Keeps this component independent of StatusBadge's narrower status union.
const STATUS_LABEL: Record<CardStatus, string> = {
  pending: 'Pending',
  committed: 'Approved',
  executed: 'Executed',
  rejected: 'Rejected',
  expired: 'Expired',
  // 2026-10-12 fix — overridden below by the REFUSED badge (via `refused`),
  // same pattern as 'rejected' is overridden by `outcome`; kept here only so
  // STATUS_LABEL/STATUS_CLASS stay total over CardStatus.
  refused: 'Refused',
};
const STATUS_CLASS: Record<CardStatus, string> = {
  pending: 'status-pending',
  committed: 'status-active',
  executed: 'status-active',
  rejected: 'status-revoked',
  expired: 'status-expired',
  refused: 'status-revoked',
};

// RJ2: once a proposal is resolved, the badge shows the actual outcome
// (REJECTED / CHANGE NEEDED / REPLACED) instead of the generic "Rejected" —
// see lib/reject-outcome.ts outcomeAfterView. REFUSED (2026-10-12 fix) is the
// Authority Server's own terminal refusal of an approved proposal's ticket —
// see refusedAfterView.
const OUTCOME_CLASS: Record<OutcomeKindLabel, string> = {
  REJECTED: 'status-revoked',
  'CHANGE NEEDED': 'status-change-needed',
  REPLACED: 'status-replaced',
  REFUSED: 'status-revoked',
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
  /** Declared by the acting integration's manifest — see resolveProposalLinks. */
  proposalLinks?: ProposalLink[];
  /** Labels and display kinds for the arguments (lib/approval-view.ts). */
  toolDisplay?: ToolDisplay;
  /** For the outcome box's "Refused by <System>" (lib/approval-view.ts systemDisplayName). */
  manifests?: IntegrationManifest[];
  /** Needed only for a PENDING proposal's ApprovalBody (intent decrypt), and
   *  to resolve a resolved proposal's "who" to "You" (lib/reject-outcome.ts). */
  currentUserId?: string;
  /** AU10 §8.4's `shownHash` — this card computes it (POSTing its own
   *  current ApprovalBody snapshot) right before calling this, and passes
   *  it on so the caller's actual approve/resolve call can carry it. */
  onApprove?: (id: string, shownHash?: string) => void;
  /** One click, no note — outcome `rejected` (decision 1). */
  onReject?: (id: string, shownHash?: string) => void;
  /** "Send back for change" — outcome `change_needed`, note required. */
  onChangeNeeded?: (id: string, note: string, shownHash?: string) => void;
  resolving?: boolean;
  /** Rendered inside an approval row (UI spec §12.2): the row already shows
   *  the profile, system, waiting time and deadline — so no rail, no header
   *  row, no raw id here. */
  inRow?: boolean;
}

export function ActionCard({ item, onApprove, onReject, onChangeNeeded, resolving, proposalLinks, toolDisplay, manifests, currentUserId, inRow = false }: Props) {
  const isProposal = item.kind === 'proposal';
  const status: CardStatus = isProposal ? item.proposal.status : 'executed';
  const toolFull = isProposal ? item.proposal.tool : item.receipt.action;
  const toolShort = shortToolName(toolFull);
  const destructive = isDestructive(toolFull);
  const { integrationId } = splitTool(toolFull);
  const systemName = systemDisplayName(integrationId, manifests);

  // RJ2 — "Change needed" panel, local UI-only state (never persisted; the
  // card's actual state always comes from the server, per project rule).
  const [changePanelOpen, setChangePanelOpen] = useState(false);
  const [changeNote, setChangeNote] = useState('');
  const [changeError, setChangeError] = useState('');

  // AU10 §8.4 — see ApproverProposalCard's identical ref/helper.
  const shownSnapshotRef = useRef<ShownSnapshotPayload | null>(null);
  const saveShownHash = async (): Promise<string | undefined> => {
    const snapshot = shownSnapshotRef.current;
    if (!snapshot || !isProposal) return undefined;
    try {
      const { shownHash } = await spClient.saveShownSnapshot(item.proposal.id, snapshot);
      return shownHash;
    } catch {
      return undefined;
    }
  };

  const handleSendChange = async () => {
    const result = validateChangeNote(changeNote);
    if (!result.valid) { setChangeError(result.error); return; }
    setChangeError('');
    const shownHash = await saveShownHash();
    onChangeNeeded?.(item.id, result.trimmed, shownHash);
  };

  // The after-state (mockup §3): what the server stored once this proposal
  // was resolved. Only ever set for a rejected/change-needed/replaced
  // proposal — null for anything else (pending/committed/executed/expired).
  const outcome = isProposal && status === 'rejected'
    ? outcomeAfterView(item.proposal, currentUserId ?? '')
    : null;
  // 2026-10-12 fix — the Authority Server's own terminal refusal of an
  // APPROVED proposal's ticket (a bound exceeded), distinct from `outcome`
  // above (a human decision). Backend truth: reads `proposal.refusal`
  // directly, no lookups — see refusedAfterView.
  const refused = isProposal && status === 'refused' ? refusedAfterView(item.proposal) : null;
  // PE1 G5 — a change-needed note is sealed; decrypt it for this after-
  // state display (a legacy row's plain note passes through unchanged).
  const decryptedNote = useDecryptedNote(
    isProposal ? (item.proposal.rejectedBy ?? item.proposal.approverRejectedBy ?? null) : null,
  );

  // PE1 — decrypt this proposal's sealed toolArgs (or pass a legacy row's
  // plain ones through) for the non-pending display branch below (pending
  // uses ApprovalBody's own, with the card-level decision-button gating
  // wired through onContentState). A receipt (ticket) item never has this —
  // its "What was done" always reads the local archive (TicketWhatWasDone).
  const content = useProposalContent(isProposal ? item.proposal : { toolArgs: undefined, content: undefined });
  const args = isProposal ? content.toolArgs : null;
  const executionContext = isProposal ? item.proposal.executionContext : item.receipt.executionContext;
  const cumulative = !isProposal ? item.receipt.cumulativeState : null;

  // Whether THIS device can decrypt a pending proposal's content — decision
  // buttons (further down) show only once this is settled and readable
  // (mockup §4: "no Approve button: nothing can be approved that this
  // device cannot show you"). Not loading pending at all is readable (true)
  // by definition — only set once ApprovalBody's own decrypt resolves.
  const [pendingReadable, setPendingReadable] = useState(true);
  const [pendingContentLoading, setPendingContentLoading] = useState(false);

  // Links the reviewer can open. This is the card review mode actually uses —
  // ApproverProposalCard is only for above-cap approvals — so a link wired only
  // there never reaches the person deciding.
  const inspectLinks = isProposal && content.toolArgs ? resolveProposalLinks(proposalLinks, content.toolArgs) : [];
  const ctxEntries = Object.entries(executionContext ?? {});
  // Test setup: the delegation profile, OR a setup__* tool.
  const testSetup = profileIdentity(item.profileId).testSetup || isTestSetupAction(toolFull);

  return (
    <div className={inRow ? 'card card-in-row' : 'card id-card'}>
      {!inRow && <ProfileRail profileId={item.profileId} />}
      <div className="id-body">
      {inRow ? (testSetup ? <div style={{ marginBottom: '0.5rem' }}><span className="sim-mark">Test setup</span></div> : null) : (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <code style={{ fontSize: '0.85rem' }}>{toolShort}</code>
        {testSetup && <span className="sim-mark">Test setup</span>}
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
                color: 'var(--text-tertiary)',
                fontWeight: left.urgent ? 600 : 400,
                whiteSpace: 'nowrap',
              }}>
                {left.label}
              </span>
            );
          })()}
          <span
            data-testid={outcome || refused ? 'outcome-kind' : undefined}
            className={`status-badge ${outcome ? OUTCOME_CLASS[outcome.kind] : refused ? OUTCOME_CLASS.REFUSED : STATUS_CLASS[status]}`}
          >
            {outcome ? outcome.kind : refused ? refused.kind : STATUS_LABEL[status]}
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
            {formatTimestamp(item.sortTimestamp)}
          </span>
        </span>
      </div>
      )}

      {/* AU4/AU5: the AS marks a proposal "executed" once the ticket is
          issued, even when the connector then refused the call or the
          record changed underneath it. Reads the local execution journal —
          renders nothing when there is nothing beyond the AS's own status. */}
      {isProposal && item.proposal.status === 'executed' && (
        <OutcomeBox proposalId={item.proposal.id} systemName={systemName} />
      )}

      {/* RJ2 — the after-state: what the person decided, by whom, and (for
          "Change needed") the note the AI will read. Read straight off the
          server's own rejectedBy/approverRejectedBy — no lookups. */}
      {outcome && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
          <div>By {outcome.who}, {formatTimestamp(outcome.at)}</div>
          {(decryptedNote ?? outcome.note) && (
            <div data-testid="outcome-note" style={{ marginTop: '0.2rem' }}>
              {outcome.kind === 'CHANGE NEEDED' ? 'Change: ' : 'Note: '}{decryptedNote ?? outcome.note}
            </div>
          )}
        </div>
      )}

      {/* 2026-10-12 fix — the Authority Server's own terminal refusal
          (a bound exceeded after approval). Backend truth, straight off
          `proposal.refusal` — never EXECUTED for this. */}
      {refused && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
          <div>By the Authority Server, {formatTimestamp(refused.at)}</div>
          <div data-testid="outcome-note" style={{ marginTop: '0.2rem' }}>Reason: {refused.message}</div>
        </div>
      )}

      {destructive && (
        <div className="note-attention" style={{
          display: 'flex', alignItems: 'center', gap: '0.4rem',
          fontSize: '0.8rem', padding: '0.4rem 0.6rem', marginBottom: '0.75rem',
        }}>
          <span className="msg-attention">Irreversible action</span>
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

      {/* A PENDING proposal (review mode — the main approval case, not just
          above-cap) gets the same headline/preview/limits/mandate+intent/
          folded-details body as ApproverProposalCard — see
          components/ApprovalBody.tsx. Anything else (committed/rejected/
          expired proposals, tickets/receipts) keeps the existing raw-args
          rendering below; this is a review surface, not a history view. */}
      {isProposal && status === 'pending' ? (
        <ApprovalBody
          proposal={item.proposal}
          currentUserId={currentUserId ?? ''}
          proposalLinks={proposalLinks}
          toolDisplay={toolDisplay}
          manifests={manifests}
          onContentState={({ loading, readable }) => {
            setPendingContentLoading(loading);
            setPendingReadable(readable);
          }}
          onShownSnapshot={(snapshot) => { shownSnapshotRef.current = snapshot; }}
        />
      ) : (
        <>
          {/* Above the arguments on purpose: what can be looked at should come
              before what can only be read. */}
          {inspectLinks.length > 0 && (
            <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {inspectLinks.map(l => (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary btn-sm"
                  style={{ textDecoration: 'none' }}
                  title={l.description ?? l.href}
                >
                  {l.label} &#8599;
                </a>
              ))}
            </div>
          )}

          {isProposal ? (
            <>
              {args && <ProposalArgs args={args} display={toolDisplay} />}
              {ctxEntries.length > 0 && (
                <div style={{ marginBottom: '0.75rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  {ctxEntries.map(([k, v]) => `${k}=${formatArgValue(v)}`).join(' · ')}
                </div>
              )}
            </>
          ) : (
            /* A ticket (receipt) — "What was done" first, same treatment as
               ReceiptCard.tsx (AU6). Self-contained: fetches its own local
               archive entry, so this card needs no extra wiring. AU10 §8.4's
               "What you saw" follows, only for a receipt that ran via a
               committed (review-mode) proposal. */
            <>
              <TicketWhatWasDone receipt={item.receipt} manifests={manifests} />
              {item.receipt.proposalId && (
                <TicketWhatYouSaw
                  proposalId={item.receipt.proposalId}
                  tool={item.receipt.action}
                  manifests={manifests}
                />
              )}
            </>
          )}
        </>
      )}

      {cumulative && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
          After this action · today: {cumulative.daily.count} action{cumulative.daily.count === 1 ? '' : 's'}
          {cumulative.daily.amount > 0 ? `, ${cumulative.daily.amount}` : ''}
          {' · '}this month: {cumulative.monthly.count}
          {cumulative.monthly.amount > 0 ? `, ${cumulative.monthly.amount}` : ''}
        </div>
      )}

      {/* PE1 mockup §4 — "no Approve button: nothing can be approved that
          this device cannot show you." A still-decrypting card shows
          neither the buttons nor a false negative; only a settled,
          undecryptable one hides them for good (until shared). */}
      {isProposal && status === 'pending' && decisionButtonsVisible({ loading: pendingContentLoading, readable: pendingReadable }) && (
        changePanelOpen ? (
          <ChangeNeededPanel
            note={changeNote}
            onNoteChange={setChangeNote}
            onSend={handleSendChange}
            onCancel={() => { setChangePanelOpen(false); setChangeNote(''); setChangeError(''); }}
            sending={!!resolving}
            error={changeError}
          />
        ) : (
          <>
          <p className="approval-resp">Approving sends exactly this. Your approval is recorded with your name.</p>
          {/* Wraps on a phone instead of pushing Reject off the screen. */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              onClick={async () => onApprove?.(item.id, await saveShownHash())}
              disabled={resolving}
            >
              {resolving ? 'Approving…' : 'Approve'}
            </button>
            <button
              data-testid="btn-change-needed"
              className="btn btn-outline-strong"
              onClick={() => setChangePanelOpen(true)}
              disabled={resolving}
            >
              <span aria-hidden="true">↩</span> Change needed
            </button>
            <button
              data-testid="btn-reject"
              className="btn btn-outline-strong"
              onClick={async () => onReject?.(item.id, await saveShownHash())}
              disabled={resolving}
            >
              <span aria-hidden="true">✕</span> Reject
            </button>
          </div>
          </>
        )
      )}

      {!inRow && (
      <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
        {isProposal ? 'Proposal' : 'Ticket'}: {item.id}
      </div>
      )}
      </div>
    </div>
  );
}
