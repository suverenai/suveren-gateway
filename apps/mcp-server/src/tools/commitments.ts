/**
 * check-pending-commitments tool — lets agents check on deferred commitment proposals.
 *
 * With proposal_id: returns status of a specific proposal. If the proposal is
 *   committed (fully approved), the gateway requests a signed receipt from the
 *   SP (which atomically transitions the proposal committed→executed) and then
 *   executes the original tool call.
 * Without: returns all pending proposals across all domains.
 *
 * v0.4 flow:
 *   committed proposal → postReceipt(proposalId, toolArgs, executionContext)
 *   → SP verifies the match, atomically marks executed, issues receipt
 *   → gateway executes the tool
 *
 * The legacy updateProposalStatus('executed') call is gone — the state
 * transition is atomic with receipt issuance, not a separate step.
 */

import type { SharedState } from '../lib/shared-state';
import { lockedNotice } from '../lib/locked-notice';
import type { IntegrationManager } from '../lib/integration-manager';
import { SPReceiptError, type SPProposal } from '../lib/sp-client';
import { appendVerificationFooter, shouldAttachFooter } from '../lib/receipt-footer';
import { computeContentBinding, attachReceiptId } from '../lib/content-binding';
import { encodeOutgoingArgs } from '../lib/arg-encoding';
import { ContentBindingError } from '@hap/core';

/**
 * Ask the SP for a signed receipt bound to the committed proposal, then
 * execute the stored tool call. The SP does the atomic committed→executed
 * transition; the gateway runs the tool only if the receipt was issued.
 */
export async function executeCommitted(
  proposal: SPProposal,
  state: SharedState,
  integrationManager: IntegrationManager | undefined,
): Promise<{ text: string; isError?: boolean }> {
  if (!integrationManager) {
    return { text: `Proposal ${proposal.id} committed but integration manager unavailable for execution.`, isError: true };
  }

  // Parse namespaced tool name: "<integrationId>__<toolName>"
  const sep = proposal.tool.indexOf('__');
  if (sep < 0) {
    return { text: `Proposal ${proposal.id} has invalid tool name: ${proposal.tool}`, isError: true };
  }
  const integrationId = proposal.tool.slice(0, sep);
  const toolName = proposal.tool.slice(sep + 2);

  // Resolve the downstream tool once — used for the content binding (text kind
  // needs the tool's schema) and the verification footer below.
  const discovered = integrationManager
    .getAllTools()
    .find(t => t.integrationId === integrationId && t.originalName === toolName);

  // Request a signed receipt FIRST — this atomically transitions the
  // proposal to executed. If another path (e.g. the background loop) has
  // already consumed it, the SP returns PROPOSAL_ALREADY_EXECUTED.
  //
  // `action` MUST be proposal.tool (the full namespaced name) for the
  // SP's PROPOSAL_MISMATCH equality check. `actionType` comes from the
  // executionContext that was captured at proposal creation time (from
  // the manifest's staticExecution) — no prefix-based fallback.
  const proposalActionType =
    typeof proposal.executionContext.action_type === 'string'
      ? proposal.executionContext.action_type
      : undefined;
  if (!proposalActionType) {
    console.error(
      `[Suveren MCP] Warning: proposal ${proposal.id} has no action_type in executionContext. ` +
        `Bounds check may be skipped. Fix the integration manifest for ${proposal.tool}.`,
    );
  }

  // Receipt id captured here so the verification footer (Category-A profiles)
  // can be embedded on the review-mode send too — not just automatic sends.
  let receiptId: string | undefined;
  try {
    // The receipt references the grant by its per-ceremony id — no hash surgery.
    // v0.5 Content Provenance: hash the approved content (proposal.toolArgs is
    // the pre-footer content captured at proposal time) when the profile binds.
    const binding = computeContentBinding(
      proposal.profileId,
      discovered,
      proposal.toolArgs,
      proposalActionType,
    );
    const { receipt } = await state.spClient.postReceipt({
      authorizationId: proposal.authorizationId,
      profileId: proposal.profileId,
      action: proposal.tool,
      actionType: proposalActionType,
      executionContext: proposal.executionContext,
      amount: typeof proposal.executionContext.amount === 'number'
        ? proposal.executionContext.amount
        : undefined,
      proposalId: proposal.id,
      toolArgs: proposal.toolArgs,
      ...(binding ?? {}),
    });
    receiptId = typeof receipt?.id === 'string' ? receipt.id : undefined;
  } catch (err) {
    // Approved content that cannot be bound. Refuse rather than execute on a
    // receipt that would verify while committing to less than the approver saw.
    if (err instanceof ContentBindingError) {
      return {
        text: `Proposal ${proposal.id}: blocked — the approved content cannot be bound to the receipt. ${err.message}`,
        isError: true,
      };
    }
    if (err instanceof SPReceiptError) {
      const code = (err.body.errors as Array<{ code?: string }> | undefined)?.[0]?.code;
      if (code === 'PROPOSAL_ALREADY_EXECUTED') {
        return {
          text: `Proposal ${proposal.id} has already been executed by another request.`,
        };
      }
      return {
        text: `Proposal ${proposal.id}: SP rejected receipt — ${err.message}`,
        isError: true,
      };
    }
    return {
      text: `Proposal ${proposal.id}: receipt request failed — ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  // Receipt issued — now execute the tool, appending the verification footer
  // (Category-A profiles) just like the automatic-send path does.
  try {
    let outgoingArgs = proposal.toolArgs;
    if (discovered && receiptId) {
      if (shouldAttachFooter()) {
        outgoingArgs = appendVerificationFooter(discovered, outgoingArgs, receiptId);
      }
      outgoingArgs = attachReceiptId(discovered, outgoingArgs, receiptId);
      // LAST: transport encoding — see arg-encoding.ts for why order matters.
      outgoingArgs = encodeOutgoingArgs(discovered, outgoingArgs);
    }
    const result = await integrationManager.callTool(integrationId, toolName, outgoingArgs);
    // Record locally for cumulative tracking (parity with the automatic path).
    state.executionLog.record({
      profileId: proposal.profileId,
      path: proposal.path,
      execution: proposal.executionContext,
      timestamp: Math.floor(Date.now() / 1000),
    });
    const resultText = (result.content as Array<{ text: string }>)?.[0]?.text ?? JSON.stringify(result);
    return { text: `Proposal ${proposal.id} committed and executed.\nResult: ${resultText}` };
  } catch (err) {
    // Receipt is already signed at the SP — the user got credit for this
    // commitment. The tool itself failed, which is a local error.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: `Proposal ${proposal.id} receipt issued but tool execution failed: ${msg}`,
      isError: true,
    };
  }
}

export function checkPendingCommitmentsHandler(
  state: SharedState,
  integrationManager?: IntegrationManager,
) {
  return async (args: { proposal_id?: string }) => {
    if (!state.spClient.isUnlocked()) {
      return { content: [{ type: 'text' as const, text: lockedNotice('check commitments') }] };
    }
    try {
      if (args.proposal_id) {
        // Look the proposal up BY ID, not through the committed list. The old
        // path searched only `status=committed`, so pending, executed,
        // rejected, expired and a mistyped id all produced the same "still
        // pending or not found" — four states, one answer, useful for at most
        // one of them. An agent reads this and decides whether to wait, retry,
        // or stop; the ambiguity invited retrying work that had already run.
        const match = await state.spClient.getProposalById(args.proposal_id);

        if (!match) {
          return {
            content: [{
              type: 'text' as const,
              text: `No proposal with id ${args.proposal_id} — check the id. ` +
                `Do NOT retry the original tool call: if a proposal was created, it still exists ` +
                `under its own id, and calling the tool again would create a second one.`,
            }],
          };
        }

        // Ready to run — this call is what executes it.
        if (match.status === 'committed') {
          const { text, isError } = await executeCommitted(match, state, integrationManager);
          return {
            content: [{ type: 'text' as const, text }],
            ...(isError ? { isError: true } : {}),
          };
        }

        if (match.status === 'executed') {
          const result = match.executionResult
            ? `\nResult: ${JSON.stringify(match.executionResult, null, 2)}`
            : ' The action ran; the gateway did not retain its output.';
          return {
            content: [{
              type: 'text' as const,
              text: `Proposal ${match.id} was approved and has already been EXECUTED — ` +
                `it is finished, do not call the tool again.${result}`,
            }],
          };
        }

        if (match.status === 'rejected') {
          const by = match.approverRejectedBy ?? match.rejectedBy;
          const reason = match.approverRejectedBy?.reason;
          return {
            content: [{
              type: 'text' as const,
              text: `Proposal ${match.id} was REJECTED${by ? ` by ${by.userId}` : ''}` +
                `${reason ? `: ${reason}` : '.'} The action did not run and must not be retried — ` +
                `a decision owner declined it. Ask before proposing anything similar.`,
            }],
          };
        }

        if (match.status === 'expired') {
          return {
            content: [{
              type: 'text' as const,
              text: `Proposal ${match.id} EXPIRED before it was approved, so the action never ran. ` +
                `Re-submit the tool call if it is still wanted.`,
            }],
          };
        }

        // pending — say precisely who is still outstanding.
        const waitingOn = (match.pendingApprovers?.length ?? 0) > 0
          ? match.pendingApprovers!.filter(u => !(u in (match.approvedBy ?? {})))
          : match.pendingDomains.filter(d => !(d in match.committedBy));
        const done = (match.pendingApprovers?.length ?? 0) > 0
          ? Object.keys(match.approvedBy ?? {})
          : Object.keys(match.committedBy);
        return {
          content: [{
            type: 'text' as const,
            text: `Proposal ${match.id} is PENDING — awaiting approval, nothing has run.\n` +
              `Approved by: [${done.join(', ') || 'nobody yet'}]\n` +
              `Still waiting on: [${waitingOn.join(', ')}]\n` +
              `Wait for the human to approve; do not re-submit the tool call.`,
          }],
        };
      }

      // List all committed proposals (ready for execution or already executed)
      const committed = await state.spClient.getCommittedProposals();
      if (committed.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No pending commitments. All proposals are either still awaiting domain owner review, expired, or already executed.',
          }],
        };
      }

      const lines = committed.map(p =>
        `${p.id}: tool=${p.tool}, status=${p.status}, committed=[${Object.keys(p.committedBy).join(',')}]`
      );

      return {
        content: [{
          type: 'text' as const,
          text: `Proposals with commitments:\n${lines.join('\n')}`,
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Failed to check commitments: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }
  };
}
