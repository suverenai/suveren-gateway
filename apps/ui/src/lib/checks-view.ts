/**
 * The approval card's checks — UI spec §4.2.2/§6.2 as revised 2026-10-21
 * (suveren-as #110; mockup temp/erp-checks-mockup). One line per check:
 * the card's own limit/attachment checks first, then the manifest checks the
 * gateway evaluated over its own reads (`PreviewResponse.checks`). Never AI
 * text: every label and detail comes from the profile, the manifest or the
 * gateway's evaluation.
 *
 * States: `pass` quiet; `not_checked` bold in a dashed frame, monochrome;
 * `notice` a plain line with a thin edge; `fail` the one red line, shown
 * ABOVE the summary sentence. A failed BLOCKING check never reaches a card
 * (the gateway refuses the request) — if one did, it renders as a fail.
 */
import type { LimitCheckLike } from './attachment-sealed';
import type { CheckResult, CheckStatus } from './sp-client';

export interface CheckLine {
  key: string;
  status: CheckStatus;
  label: string;
  /** What follows the label — the value vs. limit, the detail, or the reason. */
  text?: string;
}

export function checkLines(limits: LimitCheckLike[], manifestChecks: CheckResult[] | undefined): CheckLine[] {
  const fromLimits = limits.map((c): CheckLine => ({
    key: `limit:${c.key}`,
    status: c.ok ? 'pass' : 'fail',
    label: c.label,
    ...(c.valueText || c.limitText ? { text: `${c.valueText} — your limit ${c.limitText}`.trim() } : {}),
  }));
  const fromManifest = (manifestChecks ?? []).map((c): CheckLine => {
    const text = c.detail ?? c.reason;
    return { key: `check:${c.key}${c.index !== undefined ? `:${c.index}` : ''}`, status: c.status, label: c.label, ...(text ? { text } : {}) };
  });
  return [...fromLimits, ...fromManifest];
}

/** The one-line wording per state (the component adds the marks and form). */
export function checkLineText(line: CheckLine): string {
  switch (line.status) {
    case 'pass': return line.text ? `${line.label} — ${line.text}` : line.label;
    case 'fail': return line.text ? `${line.label}: ${line.text}` : line.label;
    case 'not_checked': return `${line.label}: not checked${line.text ? ` — ${line.text}` : ''}`;
    case 'notice': return line.text ? `${line.label}: ${line.text}` : line.label;
  }
}
