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
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { resolveProposalLinks, type ProposalLink } from '../lib/proposal-links';
import { spClient, type IntegrationManifest, type Proposal } from '../lib/sp-client';
import { ProposalArgs } from './ProposalArgs';
import { PreviewBox } from './PreviewBox';
import { contextFieldLabel, splitTool, systemDisplayName, toolHeadline, type ToolDisplay } from '../lib/approval-view';
import { useProfile } from '../lib/profile-cache';
import { useMandateBounds } from '../lib/mandate-bounds-cache';
import { useProposalIntent } from '../lib/use-proposal-intent';
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
}

/** DL6: tool-specific on purpose — this builtin is the gateway's own, so
 *  pre-filling the mandate screen from ITS particular argument shape (profile/
 *  limits/scope/intent/mode/duration_hours) is acceptable even though every
 *  other part of this module stays generic (brief decision 6). */
const CREATE_MANDATE_TOOL = 'setup__create_mandate';

export function ApprovalBody({ proposal, currentUserId, proposalLinks, toolDisplay, manifests }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [editingBeforeSigning, setEditingBeforeSigning] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { group, groupId, domain } = useAuth();

  const boundsEntries = Object.entries(proposal.executionContext);
  const profile = useProfile(proposal.profileId);
  const mandateBounds = useMandateBounds(proposal.authorizationId);
  const checks = limitChecks(proposal.executionContext, mandateBounds, profile);
  const inspectLinks = resolveProposalLinks(proposalLinks, proposal.toolArgs);
  const headline = toolHeadline(proposal.tool);
  const { integrationId } = splitTool(proposal.tool);
  const systemName = systemDisplayName(integrationId, manifests);
  const { intent, loading: intentLoading, error: intentError } = useProposalIntent(proposal.authorizationId, currentUserId);

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
      const args = proposal.toolArgs as CreateMandateProposalArgs;
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

  return (
    <>
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

      {/* DL6 — "Edit before signing": this proposal's own tool is the
          gateway's builtin mandate-creation proposal (CREATE_MANDATE_TOOL) —
          the only case where editing the intent before approving makes
          sense, since the intent becomes the person's own signed words.
          Approve/Reject (owned by the caller) stay exactly as they are;
          this is an additional way out, never a replacement for either. */}
      {proposal.tool === CREATE_MANDATE_TOOL && (
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
            <p style={{ color: 'var(--danger)', fontSize: '0.8rem', margin: '0.4rem 0 0' }}>{editError}</p>
          )}
        </div>
      )}
    </>
  );
}
