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
import { hashToolArgs } from '../lib/execution-journal';
import type { CommittedExecutor, ExecutionResult } from '../lib/committed-executor';
import { ContentBindingError } from '@hap/core';

// ─── The one executor ────────────────────────────────────────────────────────
// Installed by the HTTP entrypoint once the integration manager exists. Every
// trigger — poll loop, control-plane nudge, agent's check-pending call — goes
// through it so the same proposal cannot run twice in this process. Absent
// (a test harness, or an entrypoint that never installed one), execution is
// direct; the execution journal still refuses a repeat.
let installedExecutor: CommittedExecutor<SPProposal> | null = null;

export function installCommittedExecutor(executor: CommittedExecutor<SPProposal>): void {
  installedExecutor = executor;
}

function runCommitted(
  proposal: SPProposal,
  state: SharedState,
  integrationManager: IntegrationManager | undefined,
): Promise<ExecutionResult> {
  return installedExecutor
    ? installedExecutor.execute(proposal)
    : executeCommitted(proposal, state, integrationManager);
}

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

  // Look up the cached authorization for this grant — parity with the
  // automatic path, which sends the boundsHash cross-check and the subject
  // for the footer's identity line. Absent (e.g. cache evicted) is fine:
  // both are optional, and the SP still enforces bounds from its own record.
  const cachedAuth = state.cache
    .getAllAuthorizations()
    .find(a => a.authorizationId === proposal.authorizationId);

  // Receipt id captured here so the verification footer (Category-A profiles)
  // can be embedded on the review-mode send too — not just automatic sends.
  let receiptId: string | undefined;
  // True when the AS replayed a ticket it had already issued for this
  // proposal instead of minting one — i.e. someone (possibly this process,
  // moments ago) already got this far. Not by itself proof the tool ran;
  // the execution journal below is.
  let replayed = false;
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
    const { receipt, idempotent } = await state.spClient.postReceipt({
      authorizationId: proposal.authorizationId,
      // Optional cross-check — the AS fails closed on a mismatch. Parity
      // with the automatic path (tool-proxy.ts).
      boundsHash: cachedAuth?.boundsHash,
      profileId: proposal.profileId,
      action: proposal.tool,
      actionType: proposalActionType,
      executionContext: proposal.executionContext,
      amount: typeof proposal.executionContext.amount === 'number'
        ? proposal.executionContext.amount
        : undefined,
      proposalId: proposal.id,
      toolArgs: proposal.toolArgs,
      // Deliberately NO idempotencyKey: the spec has review-mode commits carry
      // a proposalId INSTEAD of a key — the proposal's committed→executed
      // transition is their replay protection, and the AS replays the ORIGINAL
      // receipt to the same caller if a retry arrives after it committed.
      // SPClient therefore treats proposalId as retry-safe on its own; a
      // PROPOSAL_ALREADY_EXECUTED answer is still a definitive rejection
      // (never retried) and means a *different* caller consumed the proposal.
      // Privacy: hash + how to reproduce it only. `binding.boundContent` is
      // the plaintext preimage (what the human approved) and never leaves
      // this machine — see the archive call below.
      ...(binding
        ? { contentHash: binding.contentHash, contentBinding: binding.contentBinding }
        : {}),
    });
    receiptId = typeof receipt?.id === 'string' ? receipt.id : undefined;
    replayed = idempotent;

    // Subject custody: archive the complete signed receipt locally (parity
    // with the automatic path). cachedAuth may be evicted — archive the
    // receipt anyway; the attestation blobs merge in on a later call.
    await state.archiveReceipt(receipt, {
      authorizationId: proposal.authorizationId,
      profileId: proposal.profileId,
      boundsHash: cachedAuth?.boundsHash,
      contextHash: cachedAuth?.contextHash,
      bounds: cachedAuth?.bounds ?? cachedAuth?.frame,
      context: cachedAuth?.context,
      attestations: cachedAuth?.attestations,
      // What the human actually approved, kept next to the receipt that cites
      // it — otherwise `proposalId` is a pointer to a server we may not have.
      proposal: proposal as unknown as Record<string, unknown>,
      boundContent: binding?.boundContent,
    });
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

  // A ticket without an id cannot be journaled, so it cannot be proven to have
  // run once. Refuse rather than execute unrecorded.
  if (!receiptId) {
    return {
      text: `Proposal ${proposal.id}: the ticket carries no id — refusing to execute an action that could not be recorded.`,
      isError: true,
    };
  }

  // ── One execution per ticket ──────────────────────────────────────────────
  // The AS guarantees one ticket per execution; this journal row is what
  // guarantees one execution per ticket. Written BEFORE the tool is called.
  const begun = state.executionJournal.begin({
    ticketId: receiptId,
    proposalId: proposal.id,
    tool: proposal.tool,
    argsHash: hashToolArgs(proposal.toolArgs),
  });
  if (!begun.ok) {
    const prior = begun.existing;
    const when = new Date(prior.startedAt * 1000).toISOString();
    if (prior.state === 'done') {
      return {
        text:
          `Proposal ${proposal.id} was already executed under ticket ${receiptId} at ${when}. ` +
          'Not running it again.',
      };
    }
    // `intent` or `failed`: an earlier attempt got as far as calling the tool
    // and this process cannot know whether the effect happened. Guessing
    // either way is wrong; the person who approved it has to look.
    return {
      text:
        `Proposal ${proposal.id}: an execution under ticket ${receiptId} started at ${when} ` +
        `(pid ${prior.pid}) and ${prior.state === 'failed' ? 'reported failure' : 'never reported completion'}. ` +
        'Not re-running: the action may already have taken effect. Check the downstream system before deciding.',
      isError: true,
    };
  }
  if (replayed) {
    // The AS replayed the ticket but we hold no record of executing under it:
    // an earlier attempt lost the AS response before it could record intent.
    // Executing now is the recovery the replay exists for — and it is the
    // only case in which a replayed ticket is allowed to run anything.
    console.error(
      `[Suveren MCP] Proposal ${proposal.id}: ticket ${receiptId} was replayed by the AS with no local ` +
        'execution record — executing once (lost-response recovery).',
    );
  }

  // Receipt issued — now execute the tool, appending the verification footer
  // (Category-A profiles) just like the automatic-send path does.
  try {
    let outgoingArgs = proposal.toolArgs;
    if (discovered && receiptId) {
      if (shouldAttachFooter()) {
        // Parity with the automatic path: pass the cached authorization's
        // subject so an approved send footers with the verified identity
        // line instead of always footering as anonymous.
        outgoingArgs = appendVerificationFooter(discovered, outgoingArgs, receiptId, cachedAuth?.subjects?.[0]);
      }
      outgoingArgs = attachReceiptId(discovered, outgoingArgs, receiptId);
      // LAST: transport encoding — see arg-encoding.ts for why order matters.
      outgoingArgs = encodeOutgoingArgs(discovered, outgoingArgs);
    }
    let result;
    try {
      result = await integrationManager.callTool(integrationId, toolName, outgoingArgs);
    } catch (err) {
      // The tool threw. Whether the effect happened is unknown — record that
      // honestly so no later trigger re-runs it on the same ticket.
      state.executionJournal.complete(receiptId, 'failed');
      throw err;
    }
    state.executionJournal.complete(receiptId, 'done');
    // Record locally for cumulative tracking (parity with the automatic path).
    // Reached once per ticket, by construction of the journal above.
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
          const { text, isError } = await runCommitted(match, state, integrationManager);
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
