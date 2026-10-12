/**
 * PE1 — resolving an encrypted proposal's toolArgs (or a change-needed
 * note) back to plaintext on the executing gateway. Decryption itself
 * happens in the control plane (cp-content-client.ts); this module is what
 * every reader on the MCP-server side goes through, so "decrypt, verify,
 * parse" cannot drift between the committed executor, check-pending-
 * commitments, and the outcome outbox.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '@hap/core';
import { cpDecryptContent, type ProposalContentWire } from './cp-content-client';
import type { SPProposal } from './sp-client';

/** A proposal's content could not be resolved to plaintext toolArgs — always a refusal to execute, never a downgrade. */
export class ProposalContentError extends Error {}

/**
 * `content_hash` fingerprint: `sha256:` + hex of SHA-256 over JCS(toolArgs).
 * Uses hap-core's `canonicalize` — the Authority Server computes the SAME
 * hash independently (over its own stored/decrypted copy), so the two sides
 * agree without exchanging the preimage (decision 4 of the PE1 brief).
 */
export function computeProposalContentHash(toolArgs: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(canonicalize(toolArgs)).digest('hex')}`;
}

/**
 * Resolve a proposal's toolArgs: the plain field on a legacy row, or
 * decrypt-and-parse `content` on a PE1 row. Re-derives the fingerprint
 * locally and refuses on a mismatch — a defense independent of the AS's own
 * ticket-time check (POST /api/as/ticket's `proposal_content_hash`), since
 * this one runs against what THIS gateway is about to execute.
 */
export async function resolveProposalToolArgs(proposal: SPProposal): Promise<Record<string, unknown>> {
  if (proposal.toolArgs) return proposal.toolArgs;
  if (!proposal.content) {
    throw new ProposalContentError(`Proposal ${proposal.id} carries neither tool_args nor content — cannot execute.`);
  }
  let plaintext: string;
  try {
    plaintext = await cpDecryptContent(proposal.content);
  } catch (err) {
    throw new ProposalContentError(`Could not decrypt the approved content on this device: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new ProposalContentError(`Proposal ${proposal.id}: decrypted content is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProposalContentError(`Proposal ${proposal.id}: decrypted content is not a JSON object.`);
  }
  const toolArgs = parsed as Record<string, unknown>;
  if (proposal.content.hash) {
    const actual = computeProposalContentHash(toolArgs);
    if (actual !== proposal.content.hash) {
      throw new ProposalContentError(
        `Proposal ${proposal.id}: decrypted content does not match its own fingerprint — refusing to execute.`,
      );
    }
  }
  return toolArgs;
}

/** A note-carrying decision — rejectedBy or approverRejectedBy — as the AS returns it (sp-client.ts). */
interface NoteCarrier {
  note?: string;
  noteEncrypted?: { ciphertext: string; keys: Record<string, { ct: string; enc: string }> };
}

/**
 * Decrypt a change-needed note for display/relay to the AI. A legacy row's
 * plain `note` passes through unchanged. Never throws: a note this device
 * cannot decrypt (G4's analogue for notes) degrades to a visible marker
 * rather than crashing the poll tick or the tool reply that carries it.
 */
export async function decryptRejectionNote(by: NoteCarrier | null | undefined): Promise<string | undefined> {
  if (!by) return undefined;
  if (typeof by.note === 'string') return by.note;
  if (!by.noteEncrypted) return undefined;
  try {
    return await cpDecryptContent(by.noteEncrypted);
  } catch (err) {
    console.error('[Suveren MCP] Failed to decrypt a change-needed note:', err);
    return '(could not decrypt this note on this device)';
  }
}

export type { ProposalContentWire };
