/**
 * The one thing on an approval that stands out, for its list row (UI spec
 * §17.1: "Price above list +11%"). Read only from the card's own preview
 * read, once a card has fetched it (lib/preview-store.ts) — never fetched or
 * guessed for the row, never AI text. The order of attention: a failed
 * check, a "not checked" line, then a notice.
 */
import type { PreviewResponse } from './sp-client';

export function standOut(resp: PreviewResponse | undefined): string | undefined {
  if (!resp || resp.status !== 'ok') return undefined;
  const checks = (resp as { checks?: { status: string; label: string; detail?: string; reason?: string }[] }).checks;
  if (!checks || checks.length === 0) return undefined;
  for (const status of ['fail', 'not_checked', 'notice']) {
    const hit = checks.find((c) => c.status === status);
    if (hit) return hit.label;
  }
  return undefined;
}
