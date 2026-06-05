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
import type { IntegrationManager } from '../lib/integration-manager';
import { SPReceiptError, type SPProposal } from '../lib/sp-client';
import { appendVerificationFooter, shouldAttachFooter } from '../lib/receipt-footer';
import { computeContentBinding, attachReceiptId } from '../lib/content-binding';

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
    // v0.5: the receipt request uses the bare content address. proposal.frameHash
    // is the per-user storage key `${boundsHash}:${userId}` (boundsHash is
    // `sha256:<hex>`, exactly one colon), so the first two colon-segments are the
    // boundsHash; a legacy bare frameHash already equals boundsHash.
    const boundsHash = proposal.frameHash.split(':').slice(0, 2).join(':');
    // v0.5 Content Provenance: hash the approved content (proposal.toolArgs is
    // the pre-footer content captured at proposal time) when the profile binds.
    const binding = computeContentBinding(proposal.profileId, discovered, proposal.toolArgs);
    const { receipt } = await state.spClient.postReceipt({
      boundsHash,
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
    try {
      if (args.proposal_id) {
        const committed = await state.spClient.getCommittedProposals();
        const match = committed.find(p => p.id === args.proposal_id);
        if (match) {
          if (match.status === 'executed' && match.executionResult) {
            return {
              content: [{
                type: 'text' as const,
                text: `Proposal ${match.id} committed and executed.\nResult: ${JSON.stringify(match.executionResult, null, 2)}`,
              }],
            };
          }

          // Status is 'committed' — execute now
          if (match.status === 'committed') {
            const { text, isError } = await executeCommitted(match, state, integrationManager);
            return {
              content: [{ type: 'text' as const, text }],
              ...(isError ? { isError: true } : {}),
            };
          }

          return {
            content: [{
              type: 'text' as const,
              text: `Proposal ${match.id}: status=${match.status}, ` +
                `committed by: [${Object.keys(match.committedBy).join(', ')}], ` +
                `remaining: [${match.pendingDomains.filter(d => !(d in match.committedBy)).join(', ')}]`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Proposal ${args.proposal_id} is still pending or not found. Domain owners have not yet committed.`,
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
