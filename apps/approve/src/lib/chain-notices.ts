/**
 * The notices every other device shows (plan 20.17 "honest record", step 14; mockup F1–F3): a device was added or removed, the
 * recovery code was replaced. Computed from the chain this phone verified itself, never from a server message: every entry of the
 * last 14 days (the same window as the "added in the last 14 days" mark, RECENT_SECONDS) that this phone did not make. Nothing is
 * stored: a notice goes away when its entry is older than 14 days.
 */
import type { ChainEntry, ChainState } from '@hap/core/device-keys';
import { RECENT_SECONDS } from './chain-view';

export type ChainNotice =
  | { kind: 'added'; seq: number; label: string; by: string | null; at: number }
  | { kind: 'removed'; seq: number; label: string; by: string | null; at: number }
  | { kind: 'rotated'; seq: number; by: string | null; at: number };

/**
 * `by`: the label of the device that signed the entry; null when the recovery code signed it (`signer: "root"`).
 * Newest first. The genesis, a `set` (a check key changed) and a `reset` are left out: a reset removes this phone, which then sees
 * "removed elsewhere" instead.
 */
export function chainNotices(entries: readonly ChainEntry[], state: ChainState, ownKeyId: string, now: number): ChainNotice[] {
  const labelOf = (k: string | null): string | null => (k && state.devices[k] ? state.devices[k].label : null);
  const out: ChainNotice[] = [];
  for (const e of entries) {
    if (e.seq === 0 || now - e.created_at >= RECENT_SECONDS) continue;
    // What this phone did itself it already saw on its own screen.
    if (e.signer === ownKeyId) continue;
    const by = e.signer === 'root' ? null : labelOf(e.signer);
    if (e.op === 'add' && e.device) out.push({ kind: 'added', seq: e.seq, label: e.device.label, by, at: e.created_at });
    else if (e.op === 'remove' && e.target) {
      const label = labelOf(e.target);
      // A device that removed itself: "X was removed", by itself.
      if (label) out.push({ kind: 'removed', seq: e.seq, label, by, at: e.created_at });
    } else if (e.op === 'rotate-root') {
      const granter = e.sigs.find((s) => s.by !== 'root')?.by ?? null;
      if (granter === ownKeyId) continue;
      out.push({ kind: 'rotated', seq: e.seq, by: labelOf(granter), at: e.created_at });
    }
  }
  return out.sort((a, b) => b.seq - a.seq);
}
