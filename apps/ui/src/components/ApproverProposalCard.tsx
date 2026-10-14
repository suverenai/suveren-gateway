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

import { useRef, useState } from 'react';
import type { ProposalLink } from '../lib/proposal-links';
import { spClient, type IntegrationManifest, type Proposal, type ShownSnapshotPayload } from '../lib/sp-client';
import { formatTimeLeft } from '../lib/time-left';
import { ProfileRail } from './ProfileRail';
import { ApprovalBody } from './ApprovalBody';
import { ChangeNeededPanel } from './ChangeNeededPanel';
import { isTestSetupAction, profileIdentity } from '../lib/profile-identity';
import { isAutomatedBrowser, AUTOMATION_REFUSAL } from '../lib/automation';
import type { ToolDisplay } from '../lib/approval-view';
import { validateChangeNote, rejectOutcomeArgs } from '../lib/reject-outcome';
import { contentHashForDecision, noteRecipients, decisionButtonsVisible } from '../lib/use-proposal-content';

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
  // RJ2 — "Change needed" panel, local UI-only state (never persisted; see
  // ActionCard's identical treatment of the same panel).
  const [changePanelOpen, setChangePanelOpen] = useState(false);
  const [changeNote, setChangeNote] = useState('');
  const [changeError, setChangeError] = useState('');
  const [sendingChange, setSendingChange] = useState(false);

  // Decision 10 (mockup §4) — whether THIS device can decrypt the
  // proposal's content, told by ApprovalBody's own decrypt via
  // onContentState (same mechanism ActionCard uses). Not-yet-pending at
  // all is readable (true) by default; only set once the decrypt settles.
  const [contentLoading, setContentLoading] = useState(false);
  const [contentReadable, setContentReadable] = useState(true);

  // AU10 §8.4 — the exact AU8/AU10 payload this card is CURRENTLY showing,
  // kept in a ref (not state) so handleApprove/handleReject/handleSendChange
  // read it synchronously at decision time without waiting on a render.
  const shownSnapshotRef = useRef<ShownSnapshotPayload | null>(null);

  /** Best-effort: stores the snapshot and returns its hash, or undefined on
   *  any failure (no snapshot yet, or the store call itself failed) — never
   *  blocks the decision (doc §8.4's whole engine never blocks, same as AU10
   *  §0's invariants). */
  const saveShownHash = async (): Promise<string | undefined> => {
    const snapshot = shownSnapshotRef.current;
    if (!snapshot) return undefined;
    try {
      const { shownHash } = await spClient.saveShownSnapshot(proposal.id, snapshot);
      return shownHash;
    } catch {
      return undefined;
    }
  };

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
      const contentHash = await contentHashForDecision(proposal);
      const shownHash = await saveShownHash();
      await spClient.approveProposal(proposal.id, contentHash, shownHash);

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

  // One click, no reason — outcome `rejected` (RJ2 decision 1). Rejecting
  // (unlike approving) only ever says no or asks for a change — never commits
  // anything — so there is no automation defense-in-depth check here, same
  // as before this change.
  const handleReject = async () => {
    setRejecting(true);
    onMessage('');
    try {
      const contentHash = await contentHashForDecision(proposal);
      const shownHash = await saveShownHash();
      await spClient.rejectProposal(proposal.id, rejectOutcomeArgs(), contentHash, shownHash);
      onMessage('Action rejected.');
      onAction();
    } catch (err) {
      onMessage(err instanceof Error ? err.message : 'Rejection failed');
    } finally {
      setRejecting(false);
    }
  };

  const handleSendChange = async () => {
    const result = validateChangeNote(changeNote);
    if (!result.valid) { setChangeError(result.error); return; }
    setChangeError('');
    setSendingChange(true);
    onMessage('');
    try {
      // G5 — sealed on THIS (the deciding) gateway for exactly who can
      // already read the proposal's own content (content.keys' own
      // userIds — the submitter, the owner, every approver) plus this
      // device's own signed-in user.
      const { noteEncrypted } = await spClient.encryptProposalNote(result.trimmed, noteRecipients(proposal, currentUserId));
      const contentHash = await contentHashForDecision(proposal);
      const shownHash = await saveShownHash();
      await spClient.rejectProposal(proposal.id, { outcome: 'change_needed', noteEncrypted }, contentHash, shownHash);
      onMessage('Sent back for a change.');
      onAction();
    } catch (err) {
      onMessage(err instanceof Error ? err.message : 'Failed to send back');
    } finally {
      setSendingChange(false);
    }
  };

  const isBusy = approving || rejecting || sendingChange;

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
        onContentState={({ loading, readable }) => {
          setContentLoading(loading);
          setContentReadable(readable);
        }}
        onShownSnapshot={(snapshot) => { shownSnapshotRef.current = snapshot; }}
      />

      {/* Action buttons — decision 10 (mockup §4): "no Approve button:
          nothing can be approved that this device cannot show you." */}
      {!alreadyApproved && decisionButtonsVisible({ loading: contentLoading, readable: contentReadable }) && (
        changePanelOpen ? (
          <ChangeNeededPanel
            note={changeNote}
            onNoteChange={setChangeNote}
            onSend={handleSendChange}
            onCancel={() => { setChangePanelOpen(false); setChangeNote(''); setChangeError(''); }}
            sending={sendingChange}
            error={changeError}
          />
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
            <button
              className="btn btn-primary"
              onClick={handleApprove}
              disabled={isBusy}
            >
              {approving ? 'Approving...' : 'Approve'}
            </button>
            <button
              data-testid="btn-change-needed"
              className="btn"
              style={{ background: '#fff', color: 'var(--warning)', border: '1px solid var(--warning)' }}
              onClick={() => setChangePanelOpen(true)}
              disabled={isBusy}
            >
              Change needed
            </button>
            <button
              data-testid="btn-reject"
              className="btn btn-ghost"
              style={{ color: 'var(--danger)' }}
              onClick={handleReject}
              disabled={isBusy}
            >
              {rejecting ? 'Rejecting...' : 'Reject'}
            </button>
          </div>
        )
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
