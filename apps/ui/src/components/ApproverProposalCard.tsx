/**
 * ApproverProposalCard — Phase 6 per-action approval card.
 *
 * Shown in the "Awaiting me" tab (AU5, work-plan.md "Added 2026-10-09";
 * approved mockup temp/mockups/gateway-ux-v7.html §6):
 *  - Headline (the tool, "erp · send_quote")
 *  - Preview box — the system's own read of the record, before it runs
 *    (components/PreviewBox.tsx; gateway-internal, never shown to the AI)
 *  - "Within your limits" — per-call bound checks (lib/receipt-summary.ts)
 *  - Mandate + intent (two lines, "Show full intent")
 *  - Details (exactly what is bound) — folded
 *  - Approve / Reject buttons
 *
 * On approve:
 *  1. Calls POST /api/proposals/:id/approve (SP)
 *  2. Fetches intent from SP (GET /api/authorizations/:id/intent)
 *  3. Decrypts via POST /api/decrypt-intent (CP)
 *  4. Persists to ~/.suveren/approved-intents.enc.json via POST /api/approved-intents (CP)
 */

import { useEffect, useState } from 'react';
import { resolveProposalLinks, type ProposalLink } from '../lib/proposal-links';
import { spClient, type IntegrationManifest, type Proposal } from '../lib/sp-client';
import { formatTimeLeft } from '../lib/time-left';
import { ProposalArgs } from './ProposalArgs';
import { ProfileRail } from './ProfileRail';
import { PreviewBox } from './PreviewBox';
import { isTestSetupAction, profileIdentity } from '../lib/profile-identity';
import { isAutomatedBrowser, AUTOMATION_REFUSAL } from '../lib/automation';
import { contextFieldLabel, splitTool, systemDisplayName, toolHeadline, type ToolDisplay } from '../lib/approval-view';
import { useProfile } from '../lib/profile-cache';
import { useMandateBounds } from '../lib/mandate-bounds-cache';
import { limitChecks } from '../lib/receipt-summary';
import { profileDisplayName } from '../lib/profile-display';


// NEVER truncate: approvers commit to exactly what they can read here, so
// the full content must be visible at once (an email body cut at 200 chars
// was approvable but not reviewable).
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
  /** Declared by the acting integration's manifest — see resolveProposalLinks. */
  proposalLinks?: ProposalLink[];
  /** Labels and display kinds for the arguments (lib/approval-view.ts). */
  toolDisplay?: ToolDisplay;
  /** For the preview box's "From <System>, before it runs" (lib/approval-view.ts systemDisplayName). */
  manifests?: IntegrationManifest[];
  currentUserId: string;
  onAction: () => void;
  onMessage: (msg: string) => void;
}

export function ApproverProposalCard({ proposal, currentUserId, onAction, onMessage, proposalLinks, toolDisplay, manifests }: Props) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [intent, setIntent] = useState<string | null>(null);
  const [intentLoading, setIntentLoading] = useState(false);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const boundsEntries = Object.entries(proposal.executionContext);
  const profile = useProfile(proposal.profileId);
  const mandateBounds = useMandateBounds(proposal.authorizationId);
  const checks = limitChecks(proposal.executionContext, mandateBounds, profile);
  const inspectLinks = resolveProposalLinks(proposalLinks, proposal.toolArgs);
  const headline = toolHeadline(proposal.tool);
  const { integrationId } = splitTool(proposal.tool);
  const systemName = systemDisplayName(integrationId, manifests);
  // Test setup: the delegation profile, OR a setup__* tool.
  const testSetup = profileIdentity(proposal.profileId).testSetup || isTestSetupAction(proposal.tool);

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
      const intentData = await spClient.getAttestationIntent(proposal.authorizationId);
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

  // AU5: the mockup always shows the intent's first two lines — not lazy on
  // click, as Phase 6 had it — with "Show full intent" only toggling the
  // clamp. The approver already has standing to see it on this card.
  useEffect(() => {
    void loadIntent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal.authorizationId]);

  const handleApprove = async () => {
    // Automation that announces itself may not approve (defense in depth — lib/automation.ts).
    if (isAutomatedBrowser()) { onMessage(AUTOMATION_REFUSAL); return; }
    setApproving(true);
    onMessage('');
    try {
      await spClient.approveProposal(proposal.id);

      // Fetch + store the intent as accountability record (best-effort).
      try {
        if (intent === null) {
          const intentData = await spClient.getAttestationIntent(proposal.authorizationId);
          if (intentData) {
            const decrypted = await spClient.decryptIntent({
              intentCiphertext: intentData.intentCiphertext,
              encryptedKey: intentData.encryptedKey,
              approverId: currentUserId,
            });
            setIntent(decrypted);
            await spClient.storeApprovedIntent(proposal.authorizationId, decrypted);
          }
        } else {
          await spClient.storeApprovedIntent(proposal.authorizationId, intent);
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
    <div className="card id-card">
      <ProfileRail profileId={proposal.profileId} />
      <div className="id-body">
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem', borderRadius: '0.25rem', background: 'var(--accent-subtle)', color: 'var(--accent)', fontWeight: 600 }}>
          Above cap
        </span>
        {testSetup && <span className="sim-mark">Test setup</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {(() => {
            const left = formatTimeLeft(proposal.expiresAt, Date.now());
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
          <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
            {formatAge(proposal.createdAt)}
          </span>
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

      {/* Headline — the tool's display name. No invented label: the tool-name
          pattern ("erp · send_quote"), as in the approved mockup. */}
      <div className="approval-headline">{headline}</div>

      {/* Preview box — the system's own read, before it runs. Gateway-internal
          (decision 1); every fallback keeps the bound values below visible
          and Approve/Reject enabled (decisions 2-3). */}
      <PreviewBox proposalId={proposal.id} systemName={systemName} />

      {/* Within your limits — per-call bound checks only (lib/receipt-summary.ts
          limitChecks); cumulative bounds are deliberately not shown here (no
          usage figure exists for a pending proposal). */}
      {checks.length > 0 && (
        <div className="limit-checks">
          <h4>Within your limits</h4>
          <ul className="limit-check-list">
            {checks.map((c) => (
              <li key={c.key} className={c.ok ? 'ok' : 'bad'}>
                <span className="limit-check-icon">{c.ok ? '✓' : '✗'}</span>
                <span>{c.label} {c.valueText} — your limit {c.limitText}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Mandate + intent */}
      <div className="mandate-intent">
        <dl>
          <dt>Mandate</dt>
          <dd>
            <strong>{profile?.name ?? profileDisplayName(proposal.profileId)}</strong>
            <span className="src-tag src-tag-local">local</span>
          </dd>
        </dl>
        <dl>
          <dt>Intent</dt>
          <dd>
            {intentError ? (
              <p style={{ color: 'var(--danger)', fontSize: '0.8rem', margin: 0 }}>{intentError}</p>
            ) : intent !== null ? (
              <>
                <p className={`intent-text${expanded ? '' : ' intent-clamped'}`}>{intent}</p>
                <button
                  className="btn btn-ghost btn-sm intent-toggle"
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded ? 'Show less' : 'Show full intent'}
                </button>
              </>
            ) : intentLoading ? (
              <p style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem', margin: 0 }}>Loading intent…</p>
            ) : (
              <p style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem', margin: 0 }}>No intent available for this mandate.</p>
            )}
          </dd>
        </dl>
      </div>

      {/* Inspection links — ABOVE the folded Details on purpose. The point of
          review mode is judging the action, and an identifier cannot be judged.
          Whatever can actually be looked at has to come before the raw values. */}
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

      {/* Details (exactly what is bound) — folded; the preview box above
          already shows the system's own read, so the raw arguments are not
          the first thing to read, but every one of them is still here —
          the call's arguments AND the execution-context fields the
          Gatekeeper actually checked (never both hidden behind separate
          toggles: one fold, everything that is bound). */}
      <details className="proposal-args-fold" style={{ marginBottom: '0.75rem' }}>
        <summary style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', cursor: 'pointer' }}>
          Details (exactly what is bound)
        </summary>
        <div style={{ marginTop: '0.5rem' }}>
          <ProposalArgs args={proposal.toolArgs} display={toolDisplay} heading="" />
          {boundsEntries.length > 0 && (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              {boundsEntries.map(([k, v], i) => {
                const { label, hint } = contextFieldLabel(k, profile);
                return (
                  <span key={k}>
                    {i > 0 && ' · '}
                    <span title={hint}>{label}={formatArgValue(v)}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </details>

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
    </div>
  );
}
