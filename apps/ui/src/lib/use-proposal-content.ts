/**
 * PE1 (temp/briefs/pe1-encryption-brief.md) — decrypt a proposal's sealed
 * content (toolArgs) locally, for display and for computing the fingerprint
 * a decision sends back. A legacy (pre-encryption) row's plain `toolArgs`
 * passes straight through — this module has no opinion about which shape
 * a given proposal is in, every caller goes through it either way so that
 * never drifts again.
 *
 * `decryptProposalArgs` is a plain async function (not a hook) so decision
 * handlers (approve/reject/change-needed — mandate-ceremony-adjacent code,
 * not components) can compute the content_hash of what was JUST decrypted
 * without re-rendering anything. `useProposalContent` is the component-facing
 * wrapper, used for display (mockup §4: the card shows "end-to-end encrypted
 * · decrypted on this device", or "Encrypted for another device" with no
 * decision buttons when this device has no key wrap for it).
 */
import { useEffect, useState } from 'react';
import { spClient, type Proposal } from './sp-client';
import { computeContentHashBrowser } from './content-hash';

export type ProposalForContent = Pick<Proposal, 'toolArgs' | 'content'>;

export interface ProposalContentState {
  /** Resolved toolArgs, or null while loading or when this device cannot decrypt it. */
  toolArgs: Record<string, unknown> | null;
  loading: boolean;
  /** True once we know this row carries sealed `content` rather than plain `toolArgs`. */
  sealed: boolean;
  /** True once decryption has settled and failed (sealed, not loading, toolArgs null). */
  undecryptable: boolean;
}

/**
 * Resolve a proposal's toolArgs: the plain field on a legacy row, or decrypt
 * `content` with this device's own vault key (CP's /api/decrypt-proposal-content,
 * same construction as /api/decrypt-intent). Returns null — never throws —
 * when this device has no key wrap for it; callers render "Encrypted for
 * another device" rather than treating it as an error.
 */
export async function decryptProposalArgs(proposal: ProposalForContent): Promise<Record<string, unknown> | null> {
  if (proposal.toolArgs) return proposal.toolArgs;
  if (!proposal.content) return null;
  try {
    const { plaintext } = await spClient.decryptProposalContent(proposal.content);
    const parsed = JSON.parse(plaintext);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * G4 — who this proposal was INTENDED to reach but could not be sealed for
 * (no registered end-to-end key at submit time), computed purely from
 * fields already on the wire: the recipient roster (the mandate owner, via
 * `createdBy`, plus every approver the proposal names) minus whoever DOES
 * have a key wrap in `content.keys`. No lookup, no new field — "UI shows
 * backend truth" (decision 10). Empty for a legacy row (no `content`) or
 * when everyone named could be reached.
 */
export function missingRecipients(proposal: Pick<Proposal, 'content' | 'createdBy' | 'pendingApprovers'>): string[] {
  if (!proposal.content) return [];
  const roster = new Set<string>([
    ...(proposal.createdBy ? [proposal.createdBy] : []),
    ...(proposal.pendingApprovers ?? []),
  ]);
  const haveKeys = new Set(Object.keys(proposal.content.keys));
  return Array.from(roster).filter((id) => !haveKeys.has(id));
}

/**
 * PE1 wire contract — "Decisions send content_hash of what was decrypted
 * and shown". Re-decrypts (independently of whatever a card's own display
 * hook already resolved — same "separate, best-effort decrypt" philosophy
 * ApproverProposalCard already uses for the approved-intent record) and
 * hashes it the same way the gateway and the AS do (hap-core JCS mirror —
 * content-hash.ts). Undefined (never a guess) when this device cannot
 * decrypt it — the decision call then simply omits content_hash, same as a
 * legacy gateway would.
 */
export async function contentHashForDecision(proposal: ProposalForContent): Promise<string | undefined> {
  const toolArgs = await decryptProposalArgs(proposal);
  if (!toolArgs) return undefined;
  return computeContentHashBrowser('jcs', toolArgs);
}

/** A note-carrying decision — rejectedBy or approverRejectedBy, whichever is set. */
type NoteCarrier = Pick<NonNullable<Proposal['rejectedBy']>, 'note' | 'noteEncrypted'>;

/**
 * Decrypt a change-needed note for display — the submitter/owner's own
 * read of what the approved/then-rejected proposal's "CHANGE NEEDED" note
 * said (ActionCard's after-state, mockup §3). A legacy row's plain `note`
 * passes through unchanged. Null while loading or undecryptable.
 */
export function useDecryptedNote(by: NoteCarrier | null | undefined): string | null {
  const [note, setNote] = useState<string | null>(by?.note ?? null);
  useEffect(() => {
    let live = true;
    if (by?.note) { setNote(by.note); return; }
    if (!by?.noteEncrypted) { setNote(null); return; }
    setNote(null);
    spClient.decryptProposalContent(by.noteEncrypted)
      .then(({ plaintext }) => { if (live) setNote(plaintext); })
      .catch(() => { if (live) setNote(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [by?.note, by?.noteEncrypted?.ciphertext]);
  return note;
}

const INITIAL: ProposalContentState = { toolArgs: null, loading: false, sealed: false, undecryptable: false };

export function useProposalContent(proposal: ProposalForContent): ProposalContentState {
  const [state, setState] = useState<ProposalContentState>(INITIAL);

  useEffect(() => {
    let live = true;
    if (proposal.toolArgs) {
      setState({ toolArgs: proposal.toolArgs, loading: false, sealed: false, undecryptable: false });
      return;
    }
    if (!proposal.content) {
      setState({ toolArgs: null, loading: false, sealed: false, undecryptable: false });
      return;
    }
    setState({ toolArgs: null, loading: true, sealed: true, undecryptable: false });
    (async () => {
      const toolArgs = await decryptProposalArgs(proposal);
      if (!live) return;
      setState({ toolArgs, loading: false, sealed: true, undecryptable: toolArgs === null });
    })();
    return () => { live = false; };
    // Re-run exactly when the sealed payload (or the legacy field) actually
    // changes — not on every re-render of the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal.content?.ciphertext, proposal.toolArgs]);

  return state;
}
