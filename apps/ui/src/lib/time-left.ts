/**
 * Approval countdown for pending proposals. The AS gives every proposal an
 * approval deadline (`expiresAt`, unix seconds — 72h by default, capped at
 * the grant's expiry). The review surfaces show how much of that window is
 * left so the human knows the request is not open-ended.
 */

export interface TimeLeft {
  /** e.g. "expires in 2d 3h", "expires in 45m" */
  label: string;
  /** Under 2 hours — render warning-colored. */
  urgent: boolean;
  /** Already past the deadline. */
  expired: boolean;
}

export function formatTimeLeft(expiresAtSeconds: number, nowMs: number): TimeLeft {
  const leftSec = expiresAtSeconds - Math.floor(nowMs / 1000);
  if (leftSec <= 0) return { label: 'expired', urgent: false, expired: true };

  const days = Math.floor(leftSec / 86_400);
  const hours = Math.floor((leftSec % 86_400) / 3_600);
  const mins = Math.floor((leftSec % 3_600) / 60);

  let label: string;
  if (days > 0) label = `expires in ${days}d ${hours}h`;
  else if (hours > 0) label = `expires in ${hours}h ${mins}m`;
  else label = `expires in ${Math.max(1, mins)}m`;

  return { label, urgent: leftSec < 2 * 3_600, expired: false };
}
