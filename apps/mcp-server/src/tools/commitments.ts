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
import { computeContentBinding, attachTicketId } from '../lib/content-binding';
import { encodeOutgoingArgs } from '../lib/arg-encoding';
import { hashToolArgs } from '../lib/execution-journal';
import type { CommittedExecutor, ExecutionResult } from '../lib/committed-executor';
import { ContentBindingError } from '@hap/core';
import { AsKeyMismatchError } from '../lib/attestation-cache';
import { ArchiveWriteError } from '../lib/receipt-archive';
import { verifyTicket, TicketBindingMismatchError } from '../lib/ticket-verify';
import { notifyControlPlane } from '../lib/cp-notify';

/**
 * The message shown for a committed proposal this gateway has no local
 * submission record for — used both when an agent asks about it directly
 * (executeCommitted's skip path, below) and when listing every committed
 * proposal (checkPendingCommitmentsHandler), so the wording is the same
 * everywhere a human or agent might see it.
 *
 * Deliberately says "approved" up front: from the human's point of view they
 * DID approve the action, and nothing happening looks exactly like a bug
 * unless the reason is stated plainly. "Re-run the request here" is the only
 * recovery available today (see the design gap noted in executeCommitted).
 */
export function buildSkippedProposalNote(proposalId: string): string {
  return (
    `Proposal ${proposalId} was approved, but was submitted from another device/installation of ` +
    `this operator (or one whose local record is gone) — this gateway will not execute it. ` +
    `Re-run the same request here to execute it from this gateway.`
  );
}

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

  // Cross-check against what THIS gateway itself submitted
  // (proposal-submission-store.ts) — "never trust AS-supplied tool/args
  // alone" for the review path, where everything (tool, args, "committed"
  // status) comes from the server.
  //
  // No local record → SKIP, quietly, not an attack. A genuine Authority
  // Server legitimately lists every committed proposal for the operator, no
  // matter which of their gateways submitted it — the SAME person's laptop
  // and desktop both poll the same list. Refusing-and-locking here would fire
  // on that completely ordinary case every time, a false alarm that locks the
  // second gateway on every poll tick. So this gateway leaves a proposal it
  // never submitted for whichever one DID to pick up: no receipt is
  // requested (nothing is marked executed OR failed on the AS), nothing is
  // journaled, and the human is not interrupted.
  //
  // This does NOT weaken the impostor defense: an injected proposal has no
  // local record on ANY real gateway either, so it is skipped here exactly
  // the same way — it simply never gets a receipt requested for it, which is
  // what stops it from running. What DOES still refuse-and-lock is a local
  // record that EXISTS but disagrees with the proposal (below), and a ticket
  // whose signature or bound fields don't check out (further down) — those
  // are the cases that are never legitimate.
  //
  // Known gap this leaves open: this gateway has no way to tell "a proposal
  // legitimately submitted by my other device" apart from "an impostor's
  // injected proposal" other than by looking for its OWN record — so it
  // treats both identically (skip). A proposal genuinely meant for a
  // different device of the SAME operator is not executed here even after
  // approval; the operator has to wait for the submitting device, or
  // re-submit the same tool call from this one. Closing that gap for real
  // needs the Authority Server itself to attest who submitted a proposal.
  const submitted = state.proposalSubmissions.get(proposal.id);
  if (!submitted) {
    console.error(
      `[Suveren MCP] Proposal ${proposal.id} is committed but has no local submission record on this ` +
        'gateway — leaving it for whichever gateway submitted it (this is normal for a different device ' +
        'of the same operator, or the AS lists a proposal we never submitted).',
    );
    // Visible, not silent: the human approved this, and nothing ran — see
    // buildSkippedProposalNote's doc comment for why the wording matters.
    return { text: buildSkippedProposalNote(proposal.id) };
  }
  {
    const mismatches: string[] = [];
    if (submitted.tool !== proposal.tool) mismatches.push('tool');
    if (submitted.toolArgsHash !== hashToolArgs(proposal.toolArgs)) mismatches.push('arguments');
    if (submitted.executionContextHash !== hashToolArgs(proposal.executionContext)) mismatches.push('executionContext');
    if (submitted.authorizationId !== proposal.authorizationId) mismatches.push('authorizationId');
    if (submitted.profileId !== proposal.profileId) mismatches.push('profileId');
    if (mismatches.length > 0) {
      void notifyControlPlane('as-key-mismatch');
      return {
        text:
          `Blocked: proposal ${proposal.id} no longer matches what this gateway submitted ` +
          `(${mismatches.join(', ')} differ) — refusing to execute.`,
        isError: true,
      };
    }
  }

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

    // Verify the ticket BEFORE trusting it for anything — signature against
    // the PINNED key, and its own bound fields against the proposal,
    // INCLUDING proposalId: a receipt minted for some other request (or for
    // no proposal — a plain automatic-mode ticket) must never be accepted
    // just because its action/executionContext happen to match. This is the
    // review path's whole defense against a server that hands the gateway a
    // tool call it never approved: everything else here (tool name,
    // arguments, "committed" status) comes from the AS, so without this
    // check a receipt minted by ANY key at all — valid or not — would be
    // enough to make the gateway run it.
    // No `idempotencyKey` here, matching the postReceipt call above: this
    // path's retry-safe key is `proposalId`, not an idempotency key, so
    // ticket-verify.ts's idempotencyKey check (G4) simply does not apply —
    // `proposalId` above is this path's equivalent binding.
    await verifyTicket(state.cache, receipt, {
      action: proposal.tool,
      executionContext: proposal.executionContext,
      authorizationId: proposal.authorizationId,
      profileId: proposal.profileId,
      proposalId: proposal.id,
      contentHash: binding?.contentHash,
      contentBinding: binding?.contentBinding,
    });

    // Subject custody: archive the complete signed receipt locally (parity
    // with the automatic path). FAIL-CLOSED (V8) — written BEFORE the handler
    // runs; a throw here (ArchiveWriteError) refuses below, same as the
    // automatic path. cachedAuth may be evicted — the attestation blobs
    // merge in on a later call, but the entry itself still MUST write.
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
    // The ticket didn't verify — signature disagrees with the pinned
    // Authority Server key, or its own bound fields disagree with the
    // proposal. Refuse AND lock: a server that can do this is exactly what
    // pinning exists to catch, on the path with the least other protection.
    if (err instanceof AsKeyMismatchError || err instanceof TicketBindingMismatchError) {
      void notifyControlPlane('as-key-mismatch');
      return {
        text: `Proposal ${proposal.id}: blocked — ${err.message}`,
        isError: true,
      };
    }
    // V8: the local evidence archive could not be written before the
    // handler would have run. A local fault (disk, missing issuer key) —
    // not a statement about the Authority Server, so no lock/invalidate.
    if (err instanceof ArchiveWriteError) {
      return {
        text: `Proposal ${proposal.id}: blocked — the ticket could not be archived locally — ${err.message}. The action was not executed.`,
        isError: true,
      };
    }
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
      // Item 9 (re-approval UX) — see tool-proxy.ts's
      // isVersionUnsupportedRefusal doc comment: flag, never invalidate.
      if (err.statusCode === 409 && code === 'VERSION_UNSUPPORTED') {
        state.cache.markNeedsReapproval(proposal.authorizationId);
        return {
          text: `Proposal ${proposal.id}: blocked — mandate ${proposal.authorizationId} needs re-approval ` +
            `— the Authority Server no longer verifies its protocol version. Ask the decision owner to ` +
            `re-approve it (see list-authorizations). ${err.message}`,
          isError: true,
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
      outgoingArgs = attachTicketId(discovered, outgoingArgs, receiptId);
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
    const resultText = (result.content as Array<{ text: string }>)?.[0]?.text ?? JSON.stringify(result);
    // The connector answered but REFUSED (e.g. the ERP: "Quote Q-0001 is at
    // revision 2; this request is for revision 1"). The approved action did
    // not happen — never report it as executed, never count it. The ticket
    // is spent (one execution per ticket); a retry needs a new approval.
    if ((result as { isError?: boolean }).isError) {
      state.executionJournal.complete(receiptId, 'failed');
      return {
        text:
          `Proposal ${proposal.id} was approved, but ${integrationId} refused to run it — nothing was done.\n` +
          `Reason: ${resultText}`,
        isError: true,
      };
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
      return { content: [{ type: 'text' as const, text: lockedNotice('check commitments', state.spClient.getLockReason() ?? 'restart') }] };
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

      // A committed proposal with no local submission record will not be
      // executed here (see executeCommitted's skip path) — visible in the
      // list so an approved-but-nothing-happened proposal is never a silent
      // mystery to whoever is watching for it.
      const lines = committed.map(p => {
        const base = `${p.id}: tool=${p.tool}, status=${p.status}, committed=[${Object.keys(p.committedBy).join(',')}]`;
        if (p.status === 'committed' && !state.proposalSubmissions.get(p.id)) {
          return `${base} — SKIPPED HERE: ${buildSkippedProposalNote(p.id)}`;
        }
        return base;
      });

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
