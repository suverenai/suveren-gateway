/**
 * ApprovalBody — the shared middle section of a PENDING proposal's approval
 * card (AU5, work-plan.md "Added 2026-10-09"; approved mockup
 * temp/mockups/gateway-ux-v7.html §6). Used by BOTH ApproverProposalCard
 * (above-cap) and ActionCard (review-mode) so the two cannot drift again —
 * every pending proposal gets the same headline/preview/limits/mandate
 * treatment regardless of which queue surfaces it. Each caller keeps its own
 * header, approver-progress/buttons and approve/reject logic.
 *
 * Renders, in order:
 *  - Headline ("erp · send_quote")
 *  - Preview box — the system's own read, before it runs (PreviewBox.tsx)
 *  - "Within your limits" — per-call bound checks (lib/receipt-summary.ts)
 *  - Mandate + intent (two lines, "Show full intent")
 *  - Inspection links (above the fold — judging the action needs something
 *    to look at, not just an identifier)
 *  - "Details (exactly what is bound)" — folded; tool args + the
 *    execution-context fields the Gatekeeper actually checked, together.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { resolveProposalLinks, type ProposalLink } from '../lib/proposal-links';
import {
  spClient,
  type IntegrationManifest,
  type Proposal,
  type PreviewResponse,
  type RequestContextResponse,
  type ShownSnapshotPayload,
} from '../lib/sp-client';
import { ProposalArgs } from './ProposalArgs';
import { PreviewBox } from './PreviewBox';
import { RequestContextBox } from './RequestContextBox';
import { boundValuesOpen } from '../lib/approval-preview-view';
import { contextFieldLabel, splitTool, systemDisplayName, toolHeadline, type ToolDisplay } from '../lib/approval-view';
import { useProfile } from '../lib/profile-cache';
import { useMandateBounds } from '../lib/mandate-bounds-cache';
import { useProposalIntent } from '../lib/use-proposal-intent';
import { useProposalContent, missingRecipients } from '../lib/use-proposal-content';
import { limitChecks } from '../lib/receipt-summary';
import { profileDisplayName } from '../lib/profile-display';
import { useAuth } from '../contexts/AuthContext';
import { newestProfileOf, carryBoundsForward, carryContextForward } from '../lib/profile-upgrade';
import { mandatePrefillGate, type CreateMandateProposalArgs } from '../lib/create-mandate-prefill';

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

interface Props {
  proposal: Proposal;
  currentUserId: string;
  /** Declared by the acting integration's manifest — see resolveProposalLinks. */
  proposalLinks?: ProposalLink[];
  /** Labels and display kinds for the arguments (lib/approval-view.ts). */
  toolDisplay?: ToolDisplay;
  /** For "From <System>, before it runs" (lib/approval-view.ts systemDisplayName). */
  manifests?: IntegrationManifest[];
  /**
   * PE1 (mockup §4) — told once this card's content has settled, so the
   * CALLER (ActionCard/ApproverProposalCard — they own the decision buttons)
   * can hide Approve/Change needed/Reject on a card this device cannot
   * decrypt. Same pattern as PreviewBox's `onTone`.
   */
  onContentState?: (state: { loading: boolean; readable: boolean }) => void;
  /**
   * AU10 §8.4 — told the exact combined payload this card's AU8/AU10 boxes
   * are CURRENTLY showing (preview + request/history + one read time),
   * every time either box's own data changes; `null` until both have
   * resolved at least once. The caller (ApproverProposalCard/ActionCard)
   * reads this the moment a decision button is clicked and sends it as-is —
   * "the UI sends the same payload it rendered, so no second read can
   * differ" (doc §8.4).
   */
  onShownSnapshot?: (snapshot: ShownSnapshotPayload | null) => void;
  /**
   * Real-gateway e2e (2026-10-15) — the "Cannot read this proposal yet"
   * note used to join raw userIds (`tom-fecb81a6-…@test.local`), which the
   * gateway already has a display name for (member-names.ts) wherever its
   * caller resolved one. Optional, default identity: a caller with no name
   * map (ActionCard today) keeps showing the raw id, unchanged.
   */
  nameOf?: (userId: string) => string;
}

/** DL6: tool-specific on purpose — this builtin is the gateway's own, so
 *  pre-filling the mandate screen from ITS particular argument shape (profile/
 *  limits/scope/intent/mode/duration_hours) is acceptable even though every
 *  other part of this module stays generic (brief decision 6). */
const CREATE_MANDATE_TOOL = 'setup__create_mandate';

export function ApprovalBody({ proposal, currentUserId, proposalLinks, toolDisplay, manifests, onContentState, onShownSnapshot, nameOf }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editingBeforeSigning, setEditingBeforeSigning] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { group, groupId, domain } = useAuth();

  const boundsEntries = Object.entries(proposal.executionContext);
  const profile = useProfile(proposal.profileId);
  const mandateBounds = useMandateBounds(proposal.authorizationId);
  const checks = limitChecks(proposal.executionContext, mandateBounds, profile);
  const headline = toolHeadline(proposal.tool);
  const { integrationId } = splitTool(proposal.tool);
  const systemName = systemDisplayName(integrationId, manifests);
  const { intent, loading: intentLoading, error: intentError } = useProposalIntent(proposal.authorizationId, currentUserId);

  // PE1 — decrypt this proposal's sealed toolArgs (or pass a legacy row's
  // plain ones through). `content.toolArgs` is null while loading AND when
  // this device has no key wrap for it — the two are told apart by `loading`.
  const content = useProposalContent(proposal);
  const readable = content.toolArgs !== null;
  useEffect(() => {
    onContentState?.({ loading: content.loading, readable });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.loading, readable]);
  const cannotRead = missingRecipients(proposal);
  const inspectLinks = content.toolArgs ? resolveProposalLinks(proposalLinks, content.toolArgs) : [];

  // DL6 — "Edit before signing": opens the mandate screen pre-filled from
  // THIS proposal's own arguments (lib/create-mandate-prefill.ts), exactly
  // the way Copy/Edit prefills it from an existing grant
  // (AuthorizationsPage.handleCopy) — newest profile version, limits/scope
  // carried onto its schema, current active workspace (never the proposal's
  // own `team`). Nothing is created here; AgentReviewPage withdraws THIS
  // proposal only after the person actually signs (sessionStorage
  // `agentReplacesProposal`, read in its handleCommit).
  const handleEditBeforeSigning = async () => {
    if (!groupId) {
      setEditError('No active workspace; cannot open the mandate screen.');
      return;
    }
    setEditingBeforeSigning(true);
    setEditError(null);
    try {
      if (!content.toolArgs) {
        setEditError('This content is not readable on this device yet.');
        return;
      }
      const args = content.toolArgs as CreateMandateProposalArgs;
      const requested = typeof args.profile === 'string' ? args.profile : '';
      const catalog = await spClient.listProfiles();
      const newest = newestProfileOf(requested, catalog);
      if (!newest) {
        setEditError(`Unknown profile "${requested}".`);
        return;
      }
      const newProfile = await spClient.getProfile(newest.id);
      const prefill = mandatePrefillGate(args);
      const bounds = carryBoundsForward(prefill.bounds, newProfile);
      const context = carryContextForward(prefill.context, newProfile);

      sessionStorage.setItem('agentAuth', JSON.stringify({
        profileId: newest.id,
        groupId,
        groupName: group?.name ?? null,
        domain,
        isPersonal: !!group?.isPersonal,
      }));
      sessionStorage.setItem('agentGate', JSON.stringify({ ...prefill, bounds, context }));
      sessionStorage.setItem('agentReplacesProposal', proposal.id);
      navigate('/mandates/new/intent');
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Could not open the mandate screen.');
    } finally {
      setEditingBeforeSigning(false);
    }
  };

  // The bound values — the content the person approves. Shown OPEN as "What
  // will be sent" when there is no working preview (lib/approval-preview-view.ts
  // boundValuesOpen); folded under Details only when a preview already shows the
  // record from the system.
  const [previewTone, setPreviewTone] = useState<string | null>(null);
  const boundOpen = boundValuesOpen(previewTone);

  // AU10 §8.4 — the raw AU8/AU10 data, as it is CURRENTLY rendered (set via
  // PreviewBox/RequestContextBox's own `onData`), combined into one snapshot
  // the moment both have resolved at least once. `readAt` mirrors the card's
  // single "Context read HH:MM" note (doc §3) — the preview's own `readAt`
  // when it has one, else the moment this box last combined the two (a
  // preview-less tool still has a request-context read worth timestamping).
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null);
  const [requestContextData, setRequestContextData] = useState<RequestContextResponse | null>(null);
  useEffect(() => {
    if (!previewData || !requestContextData) { onShownSnapshot?.(null); return; }
    const readAt = previewData.status === 'ok' ? previewData.readAt : Date.now();
    // `toolArgs`/`sealed` travel too — PreviewBoxBody needs the bound values
    // to reproduce the SAME "What will be created" box later (the ticket
    // view's "What you saw", TicketWhatYouSaw.tsx), not just the preview's
    // own read result.
    onShownSnapshot?.({
      readAt,
      preview: previewData,
      requestContext: requestContextData,
      ...(content.toolArgs ? { toolArgs: content.toolArgs } : {}),
      sealed: content.sealed,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewData, requestContextData, content.toolArgs, content.sealed, onShownSnapshot]);
  const boundContent = content.toolArgs ? (
    <>
          <ProposalArgs args={content.toolArgs} display={toolDisplay} heading="" />
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
        </>
  ) : null;

  return (
    <>
      {/* Headline — the tool's display name. No invented label: the tool-name
          pattern ("erp · send_quote"), as in the approved mockup. */}
      <div className="approval-headline">{headline}</div>

      {/* PE1 mockup §4 — a device added after the proposal was made has no
          key wrap for it: no "What will be sent" box (nothing TO show), and
          — see ActionCard/ApproverProposalCard — no decision buttons either,
          via onContentState above. Takes priority over the preview box and
          every other content-shaped section below. */}
      {content.sealed && content.undecryptable && (
        <div className="preview-box" data-testid="proposal-undecryptable" style={{ marginBottom: '0.5rem' }}>
          <strong>Encrypted for another device.</strong>
          <p style={{ margin: '0.35rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            This device was added after the proposal was made, and no device of yours has shared it yet.
            It is shared automatically once a device that can read it comes online — or open it there.
          </p>
        </div>
      )}
      {content.sealed && content.loading && (
        <div className="preview-box" data-testid="proposal-decrypting" style={{ marginBottom: '0.5rem' }}>
          Decrypting…
        </div>
      )}

      {/* Preview box — the system's own read, before it runs. Gateway-internal
          (decision 1); every fallback keeps the bound values below visible
          and Approve/Reject enabled (decisions 2-3). */}
      {boundOpen && readable && (
        <div className="preview-box preview-box-ok" data-testid="bound-values-open" style={{ marginBottom: '0.5rem' }}>
          <h4>
            What will be sent
            {content.sealed
              ? <><span className="src-tag src-tag-sealed">sealed</span> <span className="lock-tag">end-to-end encrypted</span></>
              : <span className="src-tag src-tag-sealed">sealed</span>}
          </h4>
          {boundContent}
          {content.sealed && (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
              Decrypted on this device. suveren.ai stores only an unreadable copy and its fingerprint.
            </p>
          )}
        </div>
      )}
      {/* G4 — some recipients could not be reached when this was submitted
          (no registered end-to-end key); the submission itself was never
          blocked on it. Computed from fields already on the wire — see
          missingRecipients's doc comment — never a lookup. */}
      {cannotRead.length > 0 && (
        <p data-testid="proposal-cannot-read" style={{ margin: '0 0 0.5rem', fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
          Cannot read this proposal yet: {cannotRead.map(id => nameOf?.(id) ?? id).join(', ')} — shared automatically once they sign in on a device.
        </p>
      )}
      {readable && (
        <PreviewBox
          proposalId={proposal.id}
          systemName={systemName}
          toolArgs={content.toolArgs}
          sealed={content.sealed}
          onTone={setPreviewTone}
          onData={setPreviewData}
        />
      )}
      {/* AU10 — Request + History, right after the AU8 "What will be
          created" box (doc/au10-request-context.md §3). */}
      {readable && <RequestContextBox proposalId={proposal.id} onData={setRequestContextData} />}
      {/* AU10 F1 — ONE legend for the whole card, after History (mockup:
          temp/au10-mockup/index.html) — not duplicated inside the AU8 box
          any more (RenderedCreationView used to render its own, incl. in
          cards where Request/History never show). */}
      {readable && (
        <p className="creation-legend" data-testid="au10-legend">
          <span><i className="creation-legend-dot creation-legend-dot-sealed" />sealed — approved and executed exactly so</span>
          <span><i className="creation-legend-dot creation-legend-dot-system" />from the system — read by the gateway, not by the AI</span>
          <span><i className="creation-legend-dot au10-dot-ai" />the AI's own claim or text — not checked</span>
        </p>
      )}

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
              <p className="msg-error" style={{ fontSize: '0.8rem', margin: 0 }}>{intentError}</p>
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
      {readable && inspectLinks.length > 0 && (
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
      {!boundOpen && readable && (
      <details className="proposal-args-fold" style={{ marginBottom: '0.75rem' }}>
        <summary style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', cursor: 'pointer' }}>
          Details (exactly what is bound)
        </summary>
        <div style={{ marginTop: '0.5rem' }}>{boundContent}</div>
      </details>
      )}

      {/* DL6 — "Edit before signing": this proposal's own tool is the
          gateway's builtin mandate-creation proposal (CREATE_MANDATE_TOOL) —
          the only case where editing the intent before approving makes
          sense, since the intent becomes the person's own signed words.
          Approve/Reject (owned by the caller) stay exactly as they are;
          this is an additional way out, never a replacement for either. */}
      {readable && proposal.tool === CREATE_MANDATE_TOOL && (
        <div style={{ marginBottom: '0.75rem' }}>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0 0 0.4rem' }}>
            The intent above is written by the AI, but it becomes <strong>your words</strong> once you approve.
            Edit it first — nothing is created until you sign on the mandate screen.
          </p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="edit-before-signing"
            onClick={handleEditBeforeSigning}
            disabled={editingBeforeSigning}
          >
            {editingBeforeSigning ? 'Opening…' : 'Edit before signing'}
          </button>
          {editError && (
            <p className="msg-error" style={{ fontSize: '0.8rem', margin: '0.4rem 0 0' }}>{editError}</p>
          )}
        </div>
      )}
    </>
  );
}
