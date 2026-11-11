/**
 * The preview each open approval card already read, shared by proposal id —
 * so the row's summary sentence can name a record the card resolved
 * (`{customer_id|ref}` → "Steiner Landtechnik GmbH") without a
 * second connector read. Holds only what a card fetched; never fetches.
 */
import { useSyncExternalStore } from 'react';
import type { PreviewResponse } from './sp-client';
import { resolveAttachedIdentity, resolveBodyObject } from './preview-render';
import type { SummaryPreview } from './approval-summary';

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
    return resolveAttachedIdentity(section.result, toolArgs[argPath], { pathPrefix: argPath, displayHints: resp.display }).name;
  };
}

/**
 * What the title may take from the card's read: the attached record's name
 * (`{x|ref}`) and the attached record's raw body (a `currencyField` such as
 * "id.currency"). Only non-forEach, non-display-only attaches — the same
 * reads the card's Now / New table uses.
 */
export function summaryPreviewFrom(resp: PreviewResponse | undefined, toolArgs: Record<string, unknown> | null | undefined): SummaryPreview {
  return {
    refName: refNameFrom(resp, toolArgs),
    attachedBody: (topKey) => {
      if (!resp || resp.status !== 'ok' || !('reads' in resp)) return undefined;
      const result = resp.reads.find((s) => s.attach === topKey && !s.forEach && !s.displayOnly)?.result;
      return result && result.status === 'ok' ? resolveBodyObject(result.body)?.obj : undefined;
    },
  };
}
