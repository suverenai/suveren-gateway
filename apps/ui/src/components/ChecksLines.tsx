/**
 * The card's checks, one line per check, in the four forms of UI spec
 * §4.2.2 (lib/checks-view.ts). `placement="top"` renders only the failed
 * checks (red, above the summary sentence); `"body"` renders the rest.
 */
import type { CheckLine } from '../lib/checks-view';
import { checkLineText } from '../lib/checks-view';

export function ChecksLines({ lines, placement }: { lines: CheckLine[]; placement: 'top' | 'body' }) {
  // Mockup order (signed off 2026-10-21): what needs attention first, then
  // the passed checks, then the notices — stable within each group.
  const rank = { not_checked: 0, pass: 1, notice: 2, fail: -1 } as const;
  const shown = lines
    .filter((l) => (placement === 'top' ? l.status === 'fail' : l.status !== 'fail'))
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank[a.l.status] - rank[b.l.status] || a.i - b.i)
    .map(({ l }) => l);
  if (shown.length === 0) return null;
  return (
    <div className={`card-checks card-checks-${placement}`} data-testid={`card-checks-${placement}`}>
      {shown.map((l) => {
        if (l.status === 'notice') {
          return (
            <div key={l.key} className="check-line check-notice" data-check-status="notice">
              {l.text ? <><strong>{l.label}:</strong> {l.text}</> : <strong>{l.label}</strong>}
            </div>
          );
        }
        const mark = l.status === 'pass' ? '✓' : l.status === 'fail' ? '✕' : '–';
        return (
          <div key={l.key} className={`check-line check-${l.status.replace('_', '-')}`} data-check-status={l.status}>
            <span className="check-mark" aria-hidden="true">{mark}</span>
            <span>{checkLineText(l)}</span>
          </div>
        );
      })}
    </div>
  );
}
