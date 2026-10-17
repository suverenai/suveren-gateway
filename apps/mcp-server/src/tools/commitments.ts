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
import { previewChangedSinceSubmission } from '../lib/preview';
import { stripSourceLink } from '../lib/request-context';
import { finalizeAttachmentsForExecution, stripAttachmentsSealedMeta } from '../lib/attachment-resolution';
import type { CommittedExecutor, ExecutionResult } from '../lib/committed-executor';
import { ContentBindingError } from '@hap/core';
import { AsKeyMismatchError } from '../lib/attestation-cache';
import { ArchiveWriteError } from '../lib/receipt-archive';
import { verifyTicket, TicketBindingMismatchError } from '../lib/ticket-verify';
import { notifyControlPlane } from '../lib/cp-notify';
import { resolveWhoLabel } from '../lib/who-label';
import { resolveProposalToolArgs, decryptRejectionNote, computeProposalContentHash, ProposalContentError } from '../lib/proposal-content';

/**
 * Retain what a committed proposal's execution actually produced — the
 * content half of the execution journal's done/failed row (see
 * execution-result-store.ts's doc comment for why this exists). Best-effort:
 * a store write failure must never be why an already-decided outcome fails
 * to return to the caller, so this swallows its own errors. Optional
 * chaining on `state.executionResults` keeps every existing test fixture
 * (partial `SharedState` mocks) working unchanged.
 */
function recordExecutionOutcome(
  state: SharedState,
  proposalId: string,
  ticketId: string,
  ok: boolean,
  text: string,
  structuredContent?: Record<string, unknown>,
): void {
  try {
    state.executionResults?.record({ proposalId, ticketId, ok, text, structuredContent });
  } catch (err) {
    console.error(`[Suveren MCP] Could not record the execution result for proposal ${proposalId}:`, err);
  }
}

/**
 * One line to gateway.log per execution attempt — presence and a short,
 * generic classification, never the tool's actual content (no args, no
 * amounts, no connector response text). `shortMessage` must stay a fixed
 * label or an error's type name — never `err.message`/the connector's own
 * text, which can carry whatever the downstream system put in it.
 */
function logExecutionOutcome(proposalId: string, ok: boolean, shortMessage?: string): void {
  console.error(
    `[Suveren MCP] Proposal ${proposalId}: execution outcome=${ok ? 'ok' : `error (${shortMessage ?? 'unknown'})`}`,
  );
}

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

// Proposal ids already explained as "skipped, submitted elsewhere" — so the
// reason is logged at most once per proposal, not on every 5s poll tick.
const warnedSkippedProposalIds = new Set<string>();

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
): Promise<ExecutionResult> {
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
    // The poll loop calls executeCommitted again every 5s for as long as
    // this proposal stays committed (skipping never transitions it to
    // executed) — log the explanation at most once per proposal, not on
    // every tick.
    if (!warnedSkippedProposalIds.has(proposal.id)) {
      warnedSkippedProposalIds.add(proposal.id);
      console.error(
        `[Suveren MCP] Proposal ${proposal.id} is committed but has no local submission record on this ` +
          'gateway — leaving it for whichever gateway submitted it (this is normal for a different device ' +
          'of the same operator, or the AS lists a proposal we never submitted).',
      );
    }
    // Visible, not silent: the human approved this, and nothing ran — see
    // buildSkippedProposalNote's doc comment for why the wording matters.
    // `skipped: true` tells callers (the poll loop) that nothing ran, so it
    // must not be logged as "Auto-executed" — see describeAutoExecutionLog.
    return { text: buildSkippedProposalNote(proposal.id), skipped: true };
  }
  // PE1 — resolve the approved content: the plain field on a legacy row, or
  // decrypt + verify the fingerprint on an encrypted one. Every later
  // reference to what was approved uses this local, resolved copy — never
  // `proposal.toolArgs`/`proposal.content` directly.
  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = await resolveProposalToolArgs(proposal);
  } catch (err) {
    const msg = err instanceof ProposalContentError ? err.message : `Could not resolve the approved content on this device: ${err instanceof Error ? err.message : String(err)}`;
    return {
      text: `Proposal ${proposal.id}: blocked — ${msg} The action was not executed.`,
      isError: true,
    };
  }

  {
    const mismatches: string[] = [];
    if (submitted.tool !== proposal.tool) mismatches.push('tool');
    if (submitted.toolArgsHash !== hashToolArgs(toolArgs)) mismatches.push('arguments');
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
  let binding: ReturnType<typeof computeContentBinding>;
  let receipt: Record<string, unknown>;
  try {
    // The receipt references the grant by its per-ceremony id — no hash surgery.
    // v0.5 Content Provenance: hash the approved content (toolArgs is the
    // pre-footer content captured at proposal time, resolved above) when the
    // profile binds.
    binding = computeContentBinding(
      proposal.profileId,
      discovered,
      toolArgs,
      proposalActionType,
    );
    const { receipt: r, idempotent } = await state.spClient.postReceipt({
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
      toolArgs,
      // PE1 — the fingerprint of what THIS gateway resolved (decrypted, or
      // read plain on a legacy row) and is about to execute. The AS compares
      // it against its own stored content_hash and refuses without echoing
      // content on a mismatch.
      proposalContentHash: computeProposalContentHash(toolArgs),
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
    receipt = r;
    receiptId = typeof receipt?.id === 'string' ? receipt.id : undefined;
    replayed = idempotent;
  } catch (err) {
    // Approved content that cannot be bound. Refuse rather than execute on a
    // receipt that would verify while committing to less than the approver saw.
    // (computeContentBinding is the only thing in this block that can throw
    // this — postReceipt never does.)
    if (err instanceof ContentBindingError) {
      return {
        text: `Proposal ${proposal.id}: blocked — the approved content cannot be bound to the receipt. ${err.message}`,
        isError: true,
      };
    }
    if (err instanceof SPReceiptError) {
      const code = (err.body.errors as Array<{ code?: string }> | undefined)?.[0]?.code;
      if (code === 'PROPOSAL_ALREADY_EXECUTED') {
        const local = localOutcomeOfExecuted(proposal, state);
        if (local) return local;
        return {
          text: `Proposal ${proposal.id} has already been executed by another request.`,
        };
      }
      // 2026-10-12 fix (AS docs/architecture.md §3.4): this gateway (or
      // another one for the same operator) already had this exact proposal
      // refused by the Authority Server — a terminal state, same footing as
      // PROPOSAL_ALREADY_EXECUTED above. Never retried.
      if (code === 'PROPOSAL_REFUSED') {
        return {
          text: `Proposal ${proposal.id}: the Authority Server refused this proposal's ticket earlier — ${err.message} ` +
            `Nothing ran. Do not retry the same values; ask the person (e.g. for a higher limit).`,
          isError: true,
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
      // Every OTHER refusal here (BOUND_EXCEEDED, CUMULATIVE_LIMIT_EXCEEDED,
      // APPROVAL_REQUIRED, ...) means the Authority Server refused THIS
      // request's ticket — see the live bug this fixes in the file header.
      // For a review-mode request riding an approved proposal, the AS has
      // (2026-10-12 fix) ALSO just marked that proposal `refused` — so a
      // LATER check-pending-commitments(proposal_id) call reads that status
      // directly (see checkPendingCommitmentsHandler below) and needs
      // nothing from this gateway. This local journal row exists ONLY for
      // the deploy-window/compat case: an AS that has not yet deployed its
      // own fix still (incorrectly) marks the proposal `executed` — without
      // this row, `localOutcomeOfExecuted` would have nothing to override
      // that with, and a later call would repeat the original bug. Keyed by
      // the proposalId (there is no ticketId — none was ever issued), not by
      // a real ticket: `begin()`'s dedup on that synthetic id keeps a second
      // identical write here a no-op rather than an error.
      if (proposal.id) {
        const asRefusedTicketId = `as_refused:${proposal.id}`;
        const begun = state.executionJournal.begin({
          ticketId: asRefusedTicketId,
          proposalId: proposal.id,
          tool: proposal.tool,
          argsHash: hashToolArgs(toolArgs),
        });
        if (begun.ok) {
          state.executionJournal.complete(asRefusedTicketId, 'failed', 'as_refused', `${code ?? 'TICKET_REFUSED'}: ${err.message}`);
        }
      }
      return {
        text: `Proposal ${proposal.id}: the Authority Server refused its ticket — ${err.message} Nothing ran. ` +
          `Do not retry the same values; ask the person (e.g. for a higher limit).`,
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
  // guarantees one execution per ticket. Written BEFORE the tool is called —
  // and, just as importantly, BEFORE verifyTicket/archiveReceipt below: by
  // the time postReceipt returns, the AS has ALREADY committed the
  // committed→executed transition (status is "executed" there from this
  // point on), whatever happens next on this gateway. Originally this begin()
  // ran only after verifyTicket/archiveReceipt succeeded, so a throw in that
  // window (a ticket-binding mismatch, a local archive-write failure) left
  // the AS saying "executed" with NO local record at all and the downstream
  // tool never called. A later check-pending-commitments(proposal_id) call
  // then found no journal entry, fell through to the generic "approved and
  // has already been EXECUTED ... the gateway did not retain its output"
  // text (checkPendingCommitmentsHandler) — reading exactly like a quiet
  // success for an action that never ran. Beginning the journal entry here,
  // before that window, means any failure in it is captured below and
  // surfaces honestly instead.
  const begun = state.executionJournal.begin({
    ticketId: receiptId,
    proposalId: proposal.id,
    tool: proposal.tool,
    argsHash: hashToolArgs(toolArgs),
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

  try {
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
      // PE1: the archived copy carries the RESOLVED (decrypted on an
      // encrypted row) toolArgs, never the sealed `content` — this archive
      // is this gateway's own local evidence and has always stored it
      // readable, same as every legacy row.
      proposal: { ...proposal, toolArgs } as unknown as Record<string, unknown>,
      boundContent: binding?.boundContent,
    });
  } catch (err) {
    // The ticket is already begun in the journal (above) — close it as
    // 'failed' so a LATER check-pending-commitments call finds this record
    // instead of the ambiguous "approved and already EXECUTED ... the
    // gateway did not retain its output" default (see the comment on begin()
    // above). The downstream tool was never called in this branch, so
    // nothing happened — the detail (surfaced by localOutcomeOfExecuted)
    // says why.
    const detail = err instanceof Error ? err.message : String(err);
    state.executionJournal.complete(receiptId, 'failed', undefined, detail);
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
    return {
      text: `Proposal ${proposal.id}: blocked — ${detail}`,
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

  // AU4 fallback — for a tool whose declared preview carries NO `version`
  // (the connector has no revision enforcement of its own, unlike ERP
  // 0.6.0's send_quote/convert_quote_to_order), re-read now and compare
  // against the hash snapshotted at submission (tool-proxy.ts). Any
  // difference — or a read that cannot positively confirm "unchanged" —
  // refuses rather than running on a record the approver no longer saw.
  // The ticket is already spent (journal row written above); a retry needs
  // a fresh request and approval, same as a connector 'refused' outcome.
  if (submitted.previewHash) {
    const changed = await previewChangedSinceSubmission(
      integrationManager,
      integrationId,
      toolName,
      toolArgs,
      submitted.previewHash,
    );
    if (changed) {
      // Detail (not just the outcome tag) so a LATER check-pending-commitments
      // call — localOutcomeOfExecuted below — can say WHY, not just THAT.
      state.executionJournal.complete(receiptId, 'failed', 'changed', `The record changed in ${integrationId} since it was requested.`);
      return {
        text:
          `Proposal ${proposal.id} was approved, but the record changed in ${integrationId} since it was ` +
          `requested — nothing was done. A new attempt needs a new request and approval.`,
        isError: true,
      };
    }
  }

  // Documents/inserts by reference, item 3 of "emails carry documents by
  // reference" — finalize now, after approval: re-resolve every sealed
  // attachment/insert reference FRESH and refuse (nothing sent) if a
  // document's fingerprint or an inserted value no longer matches what was
  // shown/sealed at proposal time, then build the transport payload. Same
  // posture as the AU4 check above (ticket already spent; a retry needs a
  // fresh request and approval) — a no-op when this proposal carried no
  // attachment/insert references at all.
  let finalToolArgs = toolArgs;
  {
    const finalized = await finalizeAttachmentsForExecution(integrationManager, integrationId, toolArgs);
    if (!finalized.ok) {
      state.executionJournal.complete(receiptId, 'failed', 'changed', finalized.message);
      recordExecutionOutcome(state, proposal.id, receiptId, false, finalized.message);
      logExecutionOutcome(proposal.id, false, 'attachment or inserted value changed since approval');
      void notifyControlPlane('execution-failed');
      return {
        text: `Proposal ${proposal.id} was approved, but ${finalized.message} Nothing was sent.`,
        isError: true,
      };
    }
    finalToolArgs = finalized.args;
  }

  // Receipt issued — now execute the tool, appending the verification footer
  // (Category-A profiles) just like the automatic-send path does.
  try {
    let outgoingArgs = finalToolArgs;
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
    // AU10 — `_source` never reaches the downstream tool (doc §1), on this
    // path too — the review/committed executor, not just the automatic one.
    outgoingArgs = stripSourceLink(outgoingArgs);
    // Same reasoning — `_attachmentsSealed` is a local display-only summary
    // (ticket view), never a valid downstream argument, on this path too.
    outgoingArgs = stripAttachmentsSealedMeta(outgoingArgs);
    let result;
    try {
      result = await integrationManager.callTool(integrationId, toolName, outgoingArgs);
    } catch (err) {
      // The tool threw. Whether the effect happened is unknown — record that
      // honestly so no later trigger re-runs it on the same ticket. Retain
      // the error text (capped, encrypted) so a LATER check-pending-commitments
      // call can still say what went wrong, not just that something did.
      const msg = err instanceof Error ? err.message : String(err);
      state.executionJournal.complete(receiptId, 'failed');
      recordExecutionOutcome(state, proposal.id, receiptId, false, `The tool call threw: ${msg}`);
      logExecutionOutcome(proposal.id, false, err instanceof Error ? err.name : 'thrown error');
      void notifyControlPlane('execution-failed');
      throw err;
    }
    const resultText = (result.content as Array<{ text: string }>)?.[0]?.text ?? JSON.stringify(result);
    // The connector answered but REFUSED (e.g. the ERP: "Quote Q-0001 is at
    // revision 2; this request is for revision 1"). The approved action did
    // not happen — never report it as executed, never count it. The ticket
    // is spent (one execution per ticket); a retry needs a new approval.
    if ((result as { isError?: boolean }).isError) {
      state.executionJournal.complete(receiptId, 'failed', 'refused', resultText);
      recordExecutionOutcome(state, proposal.id, receiptId, false, resultText);
      logExecutionOutcome(proposal.id, false, 'the connector returned an error');
      void notifyControlPlane('execution-failed');
      return {
        text:
          `Proposal ${proposal.id} was approved, but ${integrationId} refused to run it — nothing was done.\n` +
          `Reason: ${resultText}`,
        isError: true,
      };
    }
    state.executionJournal.complete(receiptId, 'done');
    recordExecutionOutcome(state, proposal.id, receiptId, true, resultText, (result as { structuredContent?: Record<string, unknown> }).structuredContent);
    logExecutionOutcome(proposal.id, true);
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
    // The inner try above already journals/retains/notifies for every error
    // that originates from the actual tool call. This outer catch ALSO
    // catches errors from the footer/ticket-id/encoding steps BEFORE the
    // tool is ever called — those never ran the inner try, so the journal
    // row (begun above, still 'intent') and the retained result would
    // otherwise be left incomplete. Idempotent: `complete()` on an
    // already-'failed' row from the inner catch is a harmless overwrite with
    // the same state.
    if (state.executionJournal.get(receiptId)?.state === 'intent') {
      state.executionJournal.complete(receiptId, 'failed');
      recordExecutionOutcome(state, proposal.id, receiptId, false, `Receipt issued but tool execution failed: ${msg}`);
      logExecutionOutcome(proposal.id, false, err instanceof Error ? err.name : 'error');
      void notifyControlPlane('execution-failed');
    }
    return {
      text: `Proposal ${proposal.id} receipt issued but tool execution failed: ${msg}`,
      isError: true,
    };
  }
}

/**
 * What really happened to a proposal the AS reports as executed. The AS marks
 * "executed" when it issues the ticket — before the action runs — so the
 * gateway's own execution journal decides what to say. Null when this
 * gateway holds no failed / unfinished record (then the AS status stands).
 */
function localOutcomeOfExecuted(proposal: SPProposal, state: SharedState): { text: string; isError: boolean } | null {
  const entry = state.executionJournal?.findByProposal?.(proposal.id);
  if (!entry) return null;
  const integration = proposal.tool.split('__')[0];
  if (entry.state === 'done') {
    // 2026-10-13 fix: this used to return null here unconditionally, so a
    // LATER check-pending-commitments(proposal_id) call fell through to the
    // AS's own (always-null) `executionResult` field and said "the gateway
    // did not retain its output" — on a SUCCESSFUL execution, not just a
    // failed one. The execution result store (execution-result-store.ts) is
    // the gateway's own retained copy of what the tool actually returned;
    // null here only when this row predates that store, or the vault is
    // still locked — in which case the AS-field fallback below stands.
    const stored = state.executionResults?.get(proposal.id);
    if (!stored || !stored.ok) return null;
    return {
      text: `Proposal ${proposal.id} was approved and executed.\nResult: ${stored.text}`,
      isError: false,
    };
  }
  if (entry.state === 'failed') {
    // The execution journal is the only place that stores WHY (row.detail) —
    // the connector's own refusal text, or why AU4 called it stale. Without
    // it, a LATER check-pending-commitments(proposal_id) call (this
    // function) said only THAT it was refused/changed, dropping the reason
    // the FIRST call's own response showed — someone reading only this later
    // check never learns it. Prefer the execution result store's full text
    // (up to 16 KB) over the journal's own short, capped `detail` when both
    // exist — same reason the store exists at all.
    const stored = state.executionResults?.get(proposal.id);
    const detail = (stored && !stored.ok ? stored.text : undefined) ?? entry.detail;
    const reasonSuffix = detail ? `\nReason: ${detail}` : '';
    return {
      text: entry.outcome === 'as_refused'
        // 2026-10-12 fix — the AS itself refused this proposal's ticket (a
        // bound exceeded after approval), not the connector: never say
        // EXECUTED for it. Only reached via this LOCAL journal row when an
        // older/not-yet-fixed AS still reports `status: 'executed'` here —
        // see checkPendingCommitmentsHandler's `refused` branch below for
        // the normal (fixed-AS) path, which reads the AS's own status/
        // refusal fields directly.
        ? `Proposal ${proposal.id} was approved, but the Authority Server refused its ticket — nothing ran. ` +
          `Do not retry the same values; ask the person (e.g. for a higher limit).${reasonSuffix}`
        : entry.outcome === 'refused'
        ? `Proposal ${proposal.id} was approved, but ${integration} refused to run it — nothing was done. ` +
          `Do not call the tool again with the same values; a new attempt needs a new request and approval.${reasonSuffix}`
        : entry.outcome === 'changed'
        ? `Proposal ${proposal.id} was approved, but the record changed in ${integration} since it was ` +
          `requested — nothing was done. A new attempt needs a new request and approval.${reasonSuffix}`
        : `Proposal ${proposal.id} was approved, but running it failed — whether anything happened in ${integration} is unknown. ` +
          `Check ${integration} before trying again; a new attempt needs a new request and approval.${reasonSuffix}`,
      isError: true,
    };
  }
  return {
    text: `Proposal ${proposal.id} was approved and started running; the outcome is not known yet. Do not call the tool again.`,
    isError: false,
  };
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
          const local = localOutcomeOfExecuted(match, state);
          if (local) {
            return {
              content: [{ type: 'text' as const, text: local.text }],
              ...(local.isError ? { isError: true } : {}),
            };
          }
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

        // 2026-10-12 fix — the Authority Server refused this proposal's
        // ticket AFTER it was approved (a bound exceeded; see
        // docs/architecture.md §3.4 on the AS). Distinct from `rejected`
        // (a human decision before commit) and `executed` (the AS's own
        // status, is never wrong about this once fixed): read straight off
        // the AS's own `refusal` field — backend truth, no local lookup
        // needed for a fixed AS. Never EXECUTED for it.
        if (match.status === 'refused') {
          const detail = match.refusal ? match.refusal.message : 'a bound was exceeded';
          return {
            content: [{
              type: 'text' as const,
              text: `Proposal ${match.id} was approved, but the Authority Server refused its ticket — ${detail} ` +
                `Nothing ran. Do not retry the same values; ask the person (e.g. for a higher limit).`,
            }],
            isError: true,
          };
        }

        if (match.status === 'rejected') {
          // RJ3 — three outcomes under one status (decisions 1-2 of the
          // 2026-10-11 "Reject or ask for a change" brief). A row with no
          // `outcome` at all predates this feature and reads as 'rejected',
          // same as the AS stores it.
          const by = match.approverRejectedBy ?? match.rejectedBy;
          const outcome = by?.outcome ?? 'rejected';
          const legacyReason = match.approverRejectedBy?.reason;
          const who = by
            ? await resolveWhoLabel(
                state.receiptArchive,
                'domain' in by ? by.domain : by.userId,
                by.userId,
              )
            : 'a person';

          if (outcome === 'change_needed') {
            // PE1 G5 — the note is sealed for the submitter + owner; decrypt
            // it for the AI line (legacy plaintext rows pass through).
            const note = await decryptRejectionNote(by);
            return {
              content: [{
                type: 'text' as const,
                text: `Proposal ${match.id} was SENT BACK FOR A CHANGE by ${who}: "${note ?? ''}". ` +
                  `The action did not run. You may adjust it and propose again — a new proposal the ` +
                  `person approves again. Do not resend the same values.`,
              }],
            };
          }

          if (outcome === 'replaced') {
            return {
              content: [{
                type: 'text' as const,
                text: `Proposal ${match.id} was REPLACED: the person signed their own version of this ` +
                  `mandate on the mandate screen. Nothing was created from this proposal. Use the ` +
                  `person's mandate — check list-authorizations.`,
              }],
            };
          }

          const reasonSuffix = legacyReason ? `: "${legacyReason}".` : '.';
          return {
            content: [{
              type: 'text' as const,
              text: `Proposal ${match.id} was REJECTED by ${who}${reasonSuffix} The action did not run ` +
                `and must not be retried. Ask the person before proposing anything similar.`,
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
