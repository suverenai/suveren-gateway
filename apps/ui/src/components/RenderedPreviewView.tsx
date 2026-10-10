/**
 * Generic renderer for a `RenderedPreview` (lib/preview-render.ts) —
 * labelled rows, nested arrays as compact lines, "All fields (n)" folding,
 * and the rounded-number hover titles. One component, shared by every
 * surface that shows a `PreviewBody`-shaped record: the approval card's
 * preview box (components/PreviewBox.tsx, AU5) and the ticket's "What was
 * done" box (components/TicketWhatWasDone.tsx, AU6) — so the two can never
 * render the same data two different ways.
 */
import { Fragment } from 'react';
import type { PreviewFieldRow, RenderedPreview } from '../lib/preview-render';

export function PreviewFieldRows({ rows }: { rows: PreviewFieldRow[] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.3rem 0.75rem', fontSize: '0.85rem', margin: '0.4rem 0' }}>
      {rows.map((r) => (
        <Fragment key={r.key}>
          <dt style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', alignSelf: 'start' }}>{r.label}</dt>
          <dd style={{ margin: 0, wordBreak: 'break-word' }}>
            {r.lines ? (
              <div>
                {r.lines.map((l, i) => <div key={i} title={r.lineTitles?.[i]}>{l}</div>)}
              </div>
            ) : (
              <span title={r.valueTitle}>{r.value}</span>
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function RenderedPreviewView({ rendered }: { rendered: RenderedPreview }) {
  if (rendered.kind === 'empty') {
    return <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', margin: '0.4rem 0' }}>No fields returned.</p>;
  }
  if (rendered.kind === 'text') {
    return <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem', margin: '0.4rem 0' }}>{rendered.text}</div>;
  }
  return (
    <>
      <PreviewFieldRows rows={rendered.fields} />
      {rendered.moreFields.length > 0 && (
        <details style={{ fontSize: '0.8rem' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-tertiary)' }}>All fields ({rendered.totalFields})</summary>
          <PreviewFieldRows rows={rendered.moreFields} />
        </details>
      )}
    </>
  );
}
