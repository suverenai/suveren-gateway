/**
 * ApprovalBody — the scrolling middle of a PENDING proposal's approval card
 * (UI spec §17, "Approval card v3"; earlier: AU5). Used by every pending
 * proposal — review-mode and above-cap — so the two cannot drift.
 *
 * It lays out through CSS `order` (the card body is a flex column), in the
 * order of §17.3:
 *   1. type line ("Action · Invoicing · 12 min"), title (manifest sentence)
 *   2. failed check, over-limit block (only when present)
 *   3. notice / "not checked" lines
 *   4. the sealed tile — "Runs exactly as shown" / "You sign these limits"
 *   5. folded rows: Covered by · ✓ N checks passed · Request · History ·
 *      Technical details (mandate: Intent stays open above the rows,
 *      "Proposed through" is a row)
 * The decision buttons belong to the caller (ApprovalCard).
 */
import { approvalSummary } from '../lib/approval-summary';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CREATE_MANDATE_TOOL, MANDATE_TILE_OMIT, mandatePreviewParts, mandateTechnicalLine, mandateTitleParts, mandateTargetProfile, modeView } from '../lib/mandate-proposal';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
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
import { useAreaCatalog } from '../lib/area-catalog';
import { areaName, ageLabel } from '../lib/core-objects';
import { useMandateUsage } from '../lib/mandate-usage';
import { previewBoxView } from '../lib/approval-preview-view';
import { SystemBoxes } from './RenderedCreationView';
import { isTestSetupAction, profileIdentity, shortProfileId } from '../lib/profile-identity';
import { AttachmentsSealedBox } from './AttachmentsSealedBox';
import { AiTextBox } from './AiTextBox';
import { extractAttachmentsSealed, attachmentCheckEntries, type LimitCheckLike } from '../lib/attachment-sealed';
import { boundValuesOpen } from '../lib/approval-preview-view';
import { aiTextValue, contextFieldLabel, splitTool, systemDisplayName, toolHeadline, type ToolDisplay } from '../lib/approval-view';
import { useProfile } from '../lib/profile-cache';
import { useMandateBounds } from '../lib/mandate-bounds-cache';
import { useProposalIntent } from '../lib/use-proposal-intent';
import { useProposalContent, missingRecipients } from '../lib/use-proposal-content';
import { limitChecks } from '../lib/receipt-summary';
import { checkLines } from '../lib/checks-view';
import { ChecksLines } from './ChecksLines';
import { refNameFrom, setProposalPreview } from '../lib/preview-store';
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
  /** The covering mandate's own title, when it has one (shown under "Covered by"). */
  mandateTitle?: string;
  /** Over-limit block and approver progress (UI spec §4.2.4) — placed right under a failed check. */
  topExtras?: ReactNode;
}

/** DL6: tool-specific on purpose — this builtin is the gateway's own, so
 *  pre-filling the mandate screen from ITS particular argument shape (profile/
 *  limits/scope/intent/mode/duration_hours) is acceptable even though every
 *  other part of this module stays generic (brief decision 6). */

export function ApprovalBody({ proposal, currentUserId, proposalLinks, toolDisplay, manifests, onContentState, onShownSnapshot, nameOf, mandateTitle, topExtras }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editingBeforeSigning, setEditingBeforeSigning] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { group, groupId, domain } = useAuth();

  const boundsEntries = Object.entries(proposal.executionContext);
  const profile = useProfile(proposal.profileId);
  const mandateBounds = useMandateBounds(proposal.authorizationId);
  const headline = toolHeadline(proposal.tool);
  const { integrationId } = splitTool(proposal.tool);
  const systemName = systemDisplayName(integrationId, manifests);
  const { intent, loading: intentLoading, error: intentError } = useProposalIntent(proposal.authorizationId, currentUserId);

  // PE1 — decrypt this proposal's sealed toolArgs (or pass a legacy row's
  // plain ones through). `content.toolArgs` is null while loading AND when
  // this device has no key wrap for it — the two are told apart by `loading`.
  const content = useProposalContent(proposal);
  const readable = content.toolArgs !== null;
  // UI spec §15.2 — "attachment from an allowed source" (computed, always
  // true once a card exists at all — see attachmentCheckEntries' doc
  // comment) plus "same file as <label>" (dynamic — comes back only
  // once AttachmentsSealedBox's own live preview fetch resolves, via
  // onChecks below), alongside the ordinary per-call bound checks.
  const [attachmentChecks, setAttachmentChecks] = useState<LimitCheckLike[]>([]);
  const checks = [
    ...limitChecks(proposal.executionContext, mandateBounds, profile),
    ...attachmentCheckEntries(content.toolArgs),
    ...attachmentChecks,
  ];
  // Memoized on `content.toolArgs`'s own identity (stable across re-renders
  // until it actually changes) — AttachmentsSealedBox's `onChecks` effect
  // below depends on `attachments`' identity; an unmemoized array here
  // would be a NEW reference every render, including the very re-render
  // `onChecks` itself triggers via `setAttachmentChecks`, which would loop.
  const attachmentsSealed = useMemo(() => extractAttachmentsSealed(content.toolArgs), [content.toolArgs]);
  // UI spec §15.2 — fetches ONE attachment's live preview by its sealed
  // sha256, for THIS proposal (never stored on the proposal itself).
  const fetchAttachmentPreview = useCallback(
    (sha256: string) => spClient.getProposalAttachmentPreview(proposal.id, sha256),
    [proposal.id],
  );
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
  // UI spec §4.2.2 — one line per check: limits + attachments, then the
  // manifest checks the gateway evaluated with this card's own reads.
  const lines = checkLines(checks, previewData?.checks);
  // Share this card's read with the row's summary sentence (`{x|ref}`).
  useEffect(() => { setProposalPreview(proposal.id, previewData); }, [proposal.id, previewData]);
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
  // The manifest's declared request link (sourceFromArg) — rendered as
  // "Replying to", not as a raw id (see ProposalArgs).
  const { toolName } = splitTool(proposal.tool);
  const requestRefArg = (manifests?.find(m => m.id === integrationId)?.toolGating?.overrides?.[toolName] as
    { sourceFromArg?: { arg?: string } } | null | undefined)?.sourceFromArg?.arg;
  // What will be sent — the sealed arguments only (UI spec §4.2.3).
  const sentContent = content.toolArgs ? (
    <ProposalArgs args={content.toolArgs} display={toolDisplay} heading="" requestRefArg={requestRefArg} />
  ) : null;
  // Details — the same, plus the values the gateway checks the limits against.
  const boundContent = content.toolArgs ? (
    <>
          <ProposalArgs args={content.toolArgs} display={toolDisplay} heading="" requestRefArg={requestRefArg} />
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

  const catalog = useAreaCatalog();
  const isMandate = proposal.tool === CREATE_MANDATE_TOOL;
  const mandateArgs = isMandate ? (content.toolArgs as CreateMandateProposalArgs | null) : null;
  // A mandate proposal is about the area it names, not the Delegation it rides on.
  const typeArea = areaName(isMandate ? mandateTargetProfile(mandateArgs, proposal.profileId) : proposal.profileId, catalog);
  const testSetup = !isMandate && (profileIdentity(proposal.profileId).testSetup || isTestSetupAction(proposal.tool));
  const parts = mandatePreviewParts(previewData && previewData.status === 'ok' && 'body' in previewData ? previewData.body.structured : undefined);
  const aiIntent = typeof mandateArgs?.intent === 'string' && mandateArgs.intent.trim() ? mandateArgs.intent : (isMandate ? parts.intent ?? null : null);
  const mode = isMandate ? modeView(mandateArgs?.mode ?? parts.mode) : null;
  // The mandate card shows the AI's intent open above the rows, so it leaves the tile.
  const sentArgs = isMandate && content.toolArgs
    ? Object.fromEntries(Object.entries(content.toolArgs).filter(([k]) => k !== 'intent' && k !== 'mode'))
    : content.toolArgs;
  const sentFor = sentArgs ? (
    <ProposalArgs args={sentArgs} display={toolDisplay} heading="" requestRefArg={requestRefArg} />
  ) : null;
  const coveredName = mandateTitle || profile?.name || profileDisplayName(proposal.profileId);
  const usage = useMandateUsage(proposal.authorizationId, mandateBounds, profile);
  const usageOne = usage.state === 'ok' ? usage.lines.map((l) => `${l.text} ${l.label}`).join(' · ') : usage.state === 'none' ? 'none yet today' : '';
  // The display-only reads (VIES and the like) sit outside the sealed tile.
  const systemView = previewData ? previewBoxView(previewData, systemName, content.toolArgs ?? undefined).creation : undefined;
  const sourceNote = previewData ? previewBoxView(previewData, systemName, content.toolArgs ?? undefined).note : undefined;
  // Restored from the pre-v3 card: an irreversible tool is said so, and a local image preview is shown.
  const lowerTool = proposal.tool.toLowerCase();
  const destructive = ['delete', 'refund', 'cancel', 'revoke'].some((w) => lowerTool.includes(w));
  const imagePreview = typeof content.toolArgs?._imagePreview === 'string' ? (content.toolArgs._imagePreview as string) : null;
  const sealedHeading = isMandate ? 'You sign these limits' : 'Runs exactly as shown';
  const technicalOne = isMandate ? mandateTechnicalLine(parts) : `${headline} · ${shortProfileId(proposal.profileId)}${proposal.profileId.includes('@') ? `@${proposal.profileId.split('@')[1]}` : ''}`;

  return (
    <>
      {/* UI spec §17.2 — the type line: a small, quiet line above the title. */}
      <div className="av3-type" style={{ order: 0 }} data-testid="approval-type">
        {isMandate ? <span className="av3-mtag">Mandate</span> : <b>Action</b>}
        <span>{typeArea}</span>
        <span>{ageLabel(proposal.createdAt * 1000, Date.now())}</span>
        {testSetup && <span className="sim-mark">Test setup</span>}
      </div>
      {/* §4.2.1 — one sentence from the manifest's summary template and the
          sealed values (never AI text). */}
      <h2 className="av3-title" style={{ order: 1 }} data-testid="approval-summary">{isMandate ? <>{typeArea} · {mandateTitleParts(typeArea, mandateArgs).name ? <span className="av3-ai">{mandateTitleParts(typeArea, mandateArgs).name}</span> : 'new mandate'}</> : approvalSummary(proposal.tool, content.toolArgs, manifests, undefined, refNameFrom(previewData ?? undefined, content.toolArgs))}</h2>
      {/* §4.2.2 — a failed check is the one red line, right under the title. */}
      <ChecksLines lines={lines} placement="top" />
      {topExtras && <div className="av3-extras" style={{ order: 3 }}>{topExtras}</div>}
      {/* Notice / not-checked lines stay open; passed checks are one folded row. */}
      <ChecksLines lines={lines} placement="body" />

      {destructive && (
        <div className="av3-attention" style={{ order: 4 }} data-testid="irreversible-note">
          <div className="check-line check-notice">
            <svg className="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><path d="M8 7.5v3.5M8 5h0" /></svg>
            <span><strong>Irreversible action</strong></span>
          </div>
        </div>
      )}

      {/* PE1 mockup §4 — a device added after the proposal was made has no
          key wrap for it: no sealed values (nothing TO show), and no decision
          buttons either, via onContentState above. */}
      {content.sealed && content.undecryptable && (
        <div className="av3-note" style={{ order: 5 }} data-testid="proposal-undecryptable">
          <strong>Encrypted for another device.</strong>
          <p>
            This device was added after the proposal was made, and no device of yours has shared it yet.
            It is shared automatically once a device that can read it comes online — or open it there.
          </p>
        </div>
      )}
      {content.sealed && content.loading && (
        <div className="av3-note" style={{ order: 5 }} data-testid="proposal-decrypting">Decrypting…</div>
      )}

      {/* The sealed tile (§17.2): what the person approves, complete, never
          truncated (Tier A2). The preview's heading and "sealed" tag stay in
          the markup for readers and tests; the tile's own heading says it. */}
      <section className="av3-sealed" style={{ order: 6 }} data-testid="sealed-values" aria-labelledby={`sealed-h-${proposal.id}`}>
        <h3 id={`sealed-h-${proposal.id}`} className="av3-sealed-h">
          <svg className="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
          {sealedHeading}
        </h3>
        {imagePreview && (
          <img
            src={imagePreview}
            alt={typeof content.toolArgs?.altText === 'string' ? (content.toolArgs.altText as string) : 'local image preview'}
            className="av3-image"
          />
        )}
        {boundOpen && readable && (
          <div className="preview-box preview-box-ok" data-testid="bound-values-open">
            <h4>What will be sent <span className="src-tag src-tag-sealed">sealed</span></h4>
            {sentFor}
          </div>
        )}
        {/* UI spec §2.1/§15.2/§15.3 — the AI-authored-text argument (manifest
            `display.aiText`) in amber, apart from the sealed recipients/subject.
            Still sealed (content binding hashes it like every bound field). */}
        {readable && content.toolArgs && aiTextValue(content.toolArgs, toolDisplay) !== undefined && (
          <AiTextBox text={aiTextValue(content.toolArgs, toolDisplay)!} />
        )}
        {/* UI spec §15.2 — a sealed block per attachment/inserted value. */}
        {readable && (
          <AttachmentsSealedBox
            attachments={attachmentsSealed.attachments}
            inserts={attachmentsSealed.inserts}
            manifests={manifests}
            fetchPreview={fetchAttachmentPreview}
            onChecks={setAttachmentChecks}
          />
        )}
        {readable && (
          <PreviewBox
            proposalId={proposal.id}
            systemName={systemName}
            toolArgs={content.toolArgs}
            sealed={content.sealed}
            systemBoxes={false}
            omitKeys={isMandate ? MANDATE_TILE_OMIT : undefined}
            hideNote
            onTone={setPreviewTone}
            onData={setPreviewData}
          />
        )}
      </section>
      {systemView && systemView.systemBoxes.length > 0 && (
        <div style={{ order: 7 }}><SystemBoxes view={systemView} /></div>
      )}
      {/* G4 — some recipients could not be reached when this was submitted. */}
      {cannotRead.length > 0 && (
        <p className="av3-quiet" style={{ order: 7 }} data-testid="proposal-cannot-read">
          Cannot read this proposal yet: {cannotRead.map(id => nameOf?.(id) ?? id).join(', ')} — shared automatically once they sign in on a device.
        </p>
      )}

      {/* Mandate proposal: the AI's intent, once, very prominent right under the
          title (amber — the AI's own text, which becomes the person's words on
          signing), then the mode as its own block. Both sit above the tile. */}
      {isMandate && aiIntent && (
        <section className="av3-intent" style={{ order: 2 }} data-testid="mandate-intent-ai">
          <div className="av3-intent-l">Intent — written by the AI, becomes your words when you sign</div>
          <p>{aiIntent}</p>
        </section>
      )}
      {mode && (
        <section className="av3-mode" style={{ order: 2 }} data-testid="mandate-mode">
          <span className="av3-mode-g" aria-hidden="true">{mode.mark}</span>
          <div><div className="av3-mode-t">{mode.title}</div><div className="av3-mode-d">{mode.text}</div></div>
        </section>
      )}
      {readable && isMandate && (
        <div className="av3-edit" style={{ order: 8 }}>
          <button
            type="button"
            className="av3-link"
            data-testid="edit-before-signing"
            onClick={handleEditBeforeSigning}
            disabled={editingBeforeSigning}
          >
            {editingBeforeSigning ? 'Opening…' : 'Edit before signing'}
          </button>
          {editError && <p className="msg-error">{editError}</p>}
        </div>
      )}

      {/* ── Folded rows (§17.3): one line each, chevron, no lines between ── */}
      {isMandate ? (
        <details className="av3-fold" style={{ order: 10 }} data-testid="proposed-through">
          <summary>
            <span className="h">Proposed through</span>
            <span className="one">Delegation{parts.checks[0] ? ` · ${parts.checks[0]}` : ''}</span>
            <Chev />
          </summary>
          <div className="av3-fold-body">
            <p>Proposed by the AI through your <strong>Delegation</strong> mandate.</p>
            {parts.checks.length > 0 && (
              <ul className="av3-plain" data-testid="mandate-checks">{parts.checks.map((c) => <li key={c}>{c}</li>)}</ul>
            )}
            <MandateIntent intent={intent} loading={intentLoading} error={intentError} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
          </div>
        </details>
      ) : (
        <details className="av3-fold" style={{ order: 10 }} data-testid="covered-by">
          <summary>
            <span className="h">Covered by</span>
            <span className="one">{coveredName}{usageOne ? ` · ${usageOne}` : ''}</span>
            <Chev />
          </summary>
          <div className="av3-fold-body">
            <p><Link to="/mandates" className="av3-link-strong">{coveredName} ›</Link></p>
            {usage.state === 'ok' && (
              <dl className="av3-usage">
                {usage.lines.map((l) => (<Fragment key={l.label}><dt>{l.label}</dt><dd>{l.text}</dd></Fragment>))}
              </dl>
            )}
            {usage.state === 'none' && <p className="av3-quiet">No ticket under this mandate yet today.</p>}
            <MandateIntent intent={intent} loading={intentLoading} error={intentError} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
          </div>
        </details>
      )}

      {/* Request + History (AU10) as two folded rows. */}
      {readable && <RequestContextBox proposalId={proposal.id} layout="folds" onData={setRequestContextData} />}

      {/* Inspection links — judging the action needs something to look at,
          not just an identifier. Open, above the folded rows. */}
      {readable && inspectLinks.length > 0 && (
        <div className="av3-links" style={{ order: 9 }}>
          {inspectLinks.map(l => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="av3-link-btn"
              title={l.description ?? l.href}
            >
              {l.label} &#8599;
            </a>
          ))}
        </div>
      )}

      {readable && (
        <details className="av3-fold" style={{ order: 15 }} data-testid="technical-details">
          <summary>
            <span className="h">Technical details</span>
            <span className="one">{technicalOne}</span>
            <Chev />
          </summary>
          <div className="av3-fold-body proposal-args-fold">
            {/* Everything that is bound: the call's arguments (unless they are
                already open in the tile) and the execution-context fields the
                Gatekeeper checked — one fold, nothing hidden behind another. */}
            {isMandate && (parts.proposal || parts.profileVersion || parts.workspace) && (
              <dl className="av3-usage">
                {parts.proposal && <><dt>Proposal</dt><dd>{parts.proposal}</dd></>}
                {parts.profileVersion && <><dt>Version</dt><dd>{parts.profileVersion}</dd></>}
                {parts.workspace && <><dt>Workspace</dt><dd>{parts.workspace}</dd></>}
              </dl>
            )}
            {isMandate ? null : boundOpen
              ? boundsEntries.length > 0 && (
                <div className="av3-bound">
                  {boundsEntries.map(([k, v], i) => {
                    const { label, hint } = contextFieldLabel(k, profile);
                    return (<span key={k}>{i > 0 && ' · '}<span title={hint}>{label}={formatArgValue(v)}</span></span>);
                  })}
                </div>
              )
              : boundContent}
            {sourceNote && <p className="av3-quiet" data-testid="preview-source-note">{sourceNote}</p>}
            {/* UI spec §4.2.11: the legend lives here, not on the card. */}
            <p className="creation-legend" data-testid="au10-legend">
              <span><i className="creation-legend-dot creation-legend-dot-sealed" />sealed — approved and executed exactly so</span>
              <span><i className="creation-legend-dot creation-legend-dot-system" />from the system — read by the gateway, not by the AI</span>
              <span><i className="creation-legend-dot au10-dot-ai" />the AI's own claim or text — not checked</span>
              {content.sealed && <span>Decrypted on this device — suveren.ai stores only an unreadable copy and its fingerprint.</span>}
            </p>
          </div>
        </details>
      )}
    </>
  );
}

function Chev() {
  return <svg className="i chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>;
}

/** The covering mandate's own intent (the person's signed words), two lines, expandable. */
function MandateIntent({ intent, loading, error, expanded, onToggle }: {
  intent: string | null; loading: boolean; error: string | null; expanded: boolean; onToggle: () => void;
}) {
  return (
    <div className="av3-mintent">
      <div className="av3-quiet">Intent</div>
      {error ? (
        <p className="msg-error">{error}</p>
      ) : intent !== null ? (
        <>
          <p className={`intent-text${expanded ? '' : ' intent-clamped'}`}>{intent}</p>
          <button type="button" className="av3-link" onClick={onToggle}>{expanded ? 'Show less' : 'Show full intent'}</button>
        </>
      ) : loading ? (
        <p className="av3-quiet">Loading intent…</p>
      ) : (
        <p className="av3-quiet">No intent available for this mandate.</p>
      )}
    </div>
  );
}
