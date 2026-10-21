/**
 * The preview each open approval card already read, shared by proposal id —
 * so the row's summary sentence can name a record the card resolved
 * (`{customer_id|ref}` → "Steiner Landtechnik GmbH (c-1007)") without a
 * second connector read. Holds only what a card fetched; never fetches.
 */
import { useSyncExternalStore } from 'react';
import type { PreviewResponse } from './sp-client';
import { resolveAttachedIdentity } from './preview-render';

const previews = new Map<string, PreviewResponse>();
const listeners = new Set<() => void>();

export function setProposalPreview(proposalId: string, resp: PreviewResponse | null): void {
  if (resp === null) return; // keep the last good read while a card reloads
  previews.set(proposalId, resp);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useProposalPreview(proposalId: string): PreviewResponse | undefined {
  return useSyncExternalStore(subscribe, () => previews.get(proposalId));
}

/**
 * The name an attached read resolved for a bound arg (`attach === argPath`),
 * or undefined — never guessed. Only plain top-level args are attach keys.
 */
export function refNameFrom(resp: PreviewResponse | undefined, toolArgs: Record<string, unknown> | null | undefined): (argPath: string) => string | undefined {
  return (argPath) => {
    if (!resp || resp.status !== 'ok' || !('reads' in resp) || !toolArgs) return undefined;
    const section = resp.reads.find((s) => s.attach === argPath && !s.forEach && !s.displayOnly);
    if (!section) return undefined;
    return resolveAttachedIdentity(section.result, toolArgs[argPath]).name;
  };
}
