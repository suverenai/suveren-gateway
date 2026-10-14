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
import { useApprovalTeamInfo } from '../lib/approval-team-info';

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
  // AS truth, never optimistic: exactly what the proposal's own record says
  // right now — the same count a fresh re-fetch after onAction() would show.
  const approvedCount = Object.keys(approvedBy).length;

  const alreadyApproved = currentUserId in approvedBy;

  // TR5 (work-plan "Added 2026-10-14 — Team: permissions, above-cap
  // approval, read limits"): how many DISTINCT approvals this proposal
  // needs (default 1, never "every pendingApprover"), who the configured
  // approvers are by name, and — when derivable from real data — why this
  // specific proposal is above cap.
  const team = useApprovalTeamInfo(proposal);
  const isProposer = !!proposal.createdBy && proposal.createdBy === currentUserId;

  /** TR5 — the AS's own clear refusal text already explains both cases;
   *  this only replaces the trailing "(CODE)" suffix asErrorMessage adds
   *  with something a non-technical reader doesn't have to parse. Defensive:
   *  APPROVER_IS_PROPOSER is already prevented client-side (the Approve
   *  button is replaced below), so this mainly covers a race (another
   *  device's state going stale) or a gateway that still shows the button. */
  const friendlyApprovalError = (err: unknown): string => {
    const msg = err instanceof Error ? err.message : 'Approval failed';
    if (msg.includes('APPROVER_IS_PROPOSER')) {
      return "You can't approve your own action. Ask another approver.";
    }
    if (msg.includes('APPROVAL_IMPOSSIBLE')) {
      return 'This action cannot be approved — there is no one else eligible to approve it. Ask a team admin to add another approver.';
    }
    return msg;
  };

  const handleApprove = async () => {
    // Automation that announces itself may not approve (defense in depth — lib/automation.ts).
    if (isAutomatedBrowser()) { onMessage(AUTOMATION_REFUSAL); return; }
    setApproving(true);
    onMessage('');
    try {
      const contentHash = await contentHashForDecision(proposal);
      const shownHash = await saveShownHash();
      const result = await spClient.approveProposal(proposal.id, contentHash, shownHash);

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

      // AS truth from THIS call's own response — never a client-side guess
      // (the old "every pendingApprover" tally). Older AS (pre-TR5) sends
      // neither field; fall back to a message that names no number at all
      // rather than compute one.
      const { requiredApprovals, approvedCount: newApprovedCount } = result;
      const stillNeeded = requiredApprovals !== undefined && newApprovedCount !== undefined
        ? requiredApprovals - newApprovedCount
        : undefined;
      onMessage(
        stillNeeded === undefined
          ? 'Approved.'
          : stillNeeded > 0
            ? `Approved. ${stillNeeded} more approval${stillNeeded === 1 ? '' : 's'} still needed.`
            : 'Approved — the required number of approvals is met; the action is ready to execute.',
      );
      onAction();
    } catch (err) {
      onMessage(friendlyApprovalError(err));
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

      {/* Approver progress — TR5: "needs N approval(s) from: ..." (N =
          requiredApprovals, default 1), never the old "all approvers"
          tally. A "X of N" count is only shown when N > 1 — with N === 1
          it is redundant (either nobody has approved, or the card would
          no longer be pending). */}
      <div className="approver-progress" style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
        Needs {team.requiredApprovals} approval{team.requiredApprovals === 1 ? '' : 's'} from:{' '}
        {pendingApprovers.map((uid, i) => (
          <span key={uid} className={`who${uid in approvedBy ? ' done' : ''}`} style={{ marginLeft: i === 0 ? '0.25rem' : '0.5rem', color: uid in approvedBy ? 'var(--success, green)' : undefined }}>
            {uid in approvedBy ? '✓ ' : ''}{team.nameOf(uid)}{uid === currentUserId ? ' (you)' : ''}
            {i < pendingApprovers.length - 1 ? ',' : ''}
          </span>
        ))}
        {team.requiredApprovals > 1 && (
          <span style={{ marginLeft: '0.5rem' }}>({approvedCount} of {team.requiredApprovals})</span>
        )}
      </div>

      {/* TR5 — "Above the team limit: <field> <value> (limit <cap>). Requested
          by <proposer>." Only shown when it can be built from real data
          (team-caps.ts's findAboveCapViolation) — never a guess. */}
      {team.aboveCapReason && (
        <div className="over-limit-box" data-testid="above-cap-reason" style={{
          display: 'flex', gap: '0.5rem', alignItems: 'flex-start',
          background: 'var(--warning-subtle, #fdf4e8)', border: '1px solid var(--warning)',
          borderRadius: '0.5rem', padding: '0.6rem 0.8rem', marginBottom: '0.6rem', fontSize: '0.82rem',
        }}>
          <span style={{ color: 'var(--warning)', fontWeight: 700, whiteSpace: 'nowrap' }}>Above the team limit:</span>
          <span>
            {team.aboveCapReason.fieldLabel}
            {team.aboveCapReason.value !== undefined ? ` ${team.aboveCapReason.value}` : ''} (limit {String(team.aboveCapReason.cap)}).{' '}
            {proposal.createdBy ? `Requested by ${team.nameOf(proposal.createdBy)}.` : ''}
          </span>
        </div>
      )}

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
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {/* TR5 (content/0.7/review.md "Group roles…", rule 4): the
                proposer of an above-cap action can never approve their own
                action — REPLACED, not merely disabled, so the reason is
                visible without the person having to wonder why a button is
                greyed out (signed-off mockup, screen 3 state B). */}
            {isProposer ? (
              <p className="blocked-note" data-testid="cant-approve-own-action" style={{ fontSize: '0.82rem', color: 'var(--text-tertiary)', margin: 0 }}>
                <strong style={{ color: 'var(--danger)' }}>You can&apos;t approve your own action.</strong>
              </p>
            ) : (
              <button
                className="btn btn-primary"
                onClick={handleApprove}
                disabled={isBusy}
              >
                {approving ? 'Approving...' : 'Approve'}
              </button>
            )}
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
          You approved this action.
          {team.requiredApprovals > 1 && approvedCount < team.requiredApprovals
            ? ` Waiting on ${team.requiredApprovals - approvedCount} more approval(s).`
            : ''}
        </p>
      )}

      <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
        Proposal: {proposal.id}
      </div>
      </div>
    </div>
  );
}
