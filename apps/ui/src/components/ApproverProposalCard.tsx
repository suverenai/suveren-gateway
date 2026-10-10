/**
 * ApproverProposalCard — Phase 6 per-action approval card.
 *
 * Shown in the "Awaiting me" tab (AU5, work-plan.md "Added 2026-10-09";
 * approved mockup temp/mockups/gateway-ux-v7.html §6). The headline/preview/
 * limits/mandate+intent/folded-details body is shared with ActionCard's
 * review-mode pending proposals via components/ApprovalBody.tsx — this card
 * owns only its own header (above-cap badge, approver progress) and the
 * approve/reject buttons.
 *
 * On approve:
 *  1. Calls POST /api/proposals/:id/approve (SP)
 *  2. Fetches intent from SP (GET /api/authorizations/:id/intent)
 *  3. Decrypts via POST /api/decrypt-intent (CP)
 *  4. Persists to ~/.suveren/approved-intents.enc.json via POST /api/approved-intents (CP)
 */

import { useState } from 'react';
import type { ProposalLink } from '../lib/proposal-links';
import { spClient, type IntegrationManifest, type Proposal } from '../lib/sp-client';
import { formatTimeLeft } from '../lib/time-left';
import { ProfileRail } from './ProfileRail';
import { ApprovalBody } from './ApprovalBody';
import { isTestSetupAction, profileIdentity } from '../lib/profile-identity';
import { isAutomatedBrowser, AUTOMATION_REFUSAL } from '../lib/automation';
import type { ToolDisplay } from '../lib/approval-view';

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

  // Test setup: the delegation profile, OR a setup__* tool.
  const testSetup = profileIdentity(proposal.profileId).testSetup || isTestSetupAction(proposal.tool);

  const pendingApprovers = proposal.pendingApprovers ?? [];
  const approvedBy = proposal.approvedBy ?? {};
  const approvedCount = Object.keys(approvedBy).length;
  const remainingCount = pendingApprovers.filter(uid => !(uid in approvedBy)).length;

  const alreadyApproved = currentUserId in approvedBy;

  const handleApprove = async () => {
    // Automation that announces itself may not approve (defense in depth — lib/automation.ts).
    if (isAutomatedBrowser()) { onMessage(AUTOMATION_REFUSAL); return; }
    setApproving(true);
    onMessage('');
    try {
      await spClient.approveProposal(proposal.id);

      // Fetch + decrypt + store the intent as an accountability record
      // (best-effort; ApprovalBody above already fetched one for display,
      // but keeps its own state — this is a separate, independent decrypt
      // rather than a shared one, deliberately: it never blocks on, or
      // depends on, how the body rendered).
      try {
        const intentData = await spClient.getAttestationIntent(proposal.authorizationId);
        if (intentData) {
          const decrypted = await spClient.decryptIntent({
            intentCiphertext: intentData.intentCiphertext,
            encryptedKey: intentData.encryptedKey,
            approverId: currentUserId,
          });
          await spClient.storeApprovedIntent(proposal.authorizationId, decrypted);
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

      {/* Shared with ActionCard's review-mode pending proposals — headline,
          preview box, "Within your limits", mandate + intent, inspect links,
          folded "Details (exactly what is bound)". See ApprovalBody.tsx. */}
      <ApprovalBody
        proposal={proposal}
        currentUserId={currentUserId}
        proposalLinks={proposalLinks}
        toolDisplay={toolDisplay}
        manifests={manifests}
      />

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
