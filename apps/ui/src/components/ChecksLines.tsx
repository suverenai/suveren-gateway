/**
 * The card's checks (UI spec §4.2.2 as changed by §17, lib/checks-view.ts).
 *
 * `placement="top"` renders only the failed checks (red, bold, ✕, above the
 * title). `"body"` renders the rest: what needs a look stays visible — a
 * "not checked" line in its dashed frame, a notice as a bold line led by ⓘ,
 * no box — and the passed checks fold into one row, "✓ N checks passed".
 *
 * The body is one `data-testid="card-checks-body"` element that lays out
 * through its parent (`display: contents`): the visible lines sit above the
 * sealed tile, the folded row among the other folded rows (the parent orders
 * them — `order` below).
 */
import type { CheckLine } from '../lib/checks-view';
import { checkLineText } from '../lib/checks-view';

const INFO = (
  <svg className="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><path d="M8 7.5v3.5M8 5h0" /></svg>
);
const CHEV = (
  <svg className="i chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
);

function Line({ l }: { l: CheckLine }) {
  if (l.status === 'notice') {
    return (
      <div className="check-line check-notice" data-check-status="notice">
        {INFO}
        <span>{l.text ? <><strong>{l.label}:</strong> {l.text}</> : <strong>{l.label}</strong>}</span>
      </div>
    );
  }
  const mark = l.status === 'pass' ? '✓' : l.status === 'fail' ? '✕' : '–';
  return (
    <div className={`check-line check-${l.status.replace('_', '-')}`} data-check-status={l.status}>
      <span className="check-mark" aria-hidden="true">{mark}</span>
      <span>{checkLineText(l)}</span>
    </div>
  );
}

export function ChecksLines({ lines, placement }: { lines: CheckLine[]; placement: 'top' | 'body' }) {
  if (placement === 'top') {
    const failed = lines.filter((l) => l.status === 'fail');
    if (failed.length === 0) return null;
    return (
      <div className="card-checks card-checks-top" data-testid="card-checks-top" style={{ order: 2 }}>
        {failed.map((l) => <Line key={l.key} l={l} />)}
      </div>
    );
  }
  const rank = { not_checked: 0, notice: 1 } as const;
  const attention = lines
    .filter((l) => l.status === 'not_checked' || l.status === 'notice')
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank[a.l.status as 'not_checked' | 'notice'] - rank[b.l.status as 'not_checked' | 'notice'] || a.i - b.i)
    .map(({ l }) => l);
  const passed = lines.filter((l) => l.status === 'pass');
  if (attention.length === 0 && passed.length === 0) return null;
  return (
    <div className="card-checks card-checks-body" data-testid="card-checks-body">
      {attention.length > 0 && (
        <div className="av3-attention" style={{ order: 4 }}>
          {attention.map((l) => <Line key={l.key} l={l} />)}
        </div>
      )}
      {passed.length > 0 && (
        <details className="av3-fold" style={{ order: 11 }} data-testid="checks-passed">
          <summary>
            <span className="h">✓ {passed.length} {passed.length === 1 ? 'check' : 'checks'} passed</span>
            <span className="one">{passed.map((l) => l.label).join(' · ')}</span>
            {CHEV}
          </summary>
          <div className="av3-fold-body">
            {passed.map((l) => <Line key={l.key} l={l} />)}
          </div>
        </details>
      )}
    </div>
  );
}
