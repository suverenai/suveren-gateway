/**
 * The one thing on an approval that stands out, for its list row (UI spec
 * §17.1: "Price above list +11%"). Read only from the card's own preview
 * read, once a card has fetched it (lib/preview-store.ts) — never fetched or
 * guessed for the row, never AI text. The order of attention: a failed
 * check, a "not checked" line, then a notice. A passed check never stands out.
 *
 * It carries the check's status exactly as the card words it: a "not checked"
 * line reads "<label>: not checked" (never the bare label, which would read
 * like a passed check); a failed one is led by ✕ and rendered in the failed
 * form (the one red, bold, with its mark — same as on the card).
 */
import type { PreviewResponse } from './sp-client';

export interface StandOut {
  text: string;
  status: 'fail' | 'not_checked' | 'notice';
}

export function standOut(resp: PreviewResponse | undefined): StandOut | undefined {
  if (!resp || resp.status !== 'ok') return undefined;
  const checks = (resp as { checks?: { status: string; label: string }[] }).checks;
  if (!checks || checks.length === 0) return undefined;
  const fail = checks.find((c) => c.status === 'fail');
  if (fail) return { text: `✕ ${fail.label}: failed`, status: 'fail' };
  const nc = checks.find((c) => c.status === 'not_checked');
  if (nc) return { text: `${nc.label}: not checked`, status: 'not_checked' };
  const notice = checks.find((c) => c.status === 'notice');
  if (notice) return { text: notice.label, status: 'notice' };
  return undefined;
}
