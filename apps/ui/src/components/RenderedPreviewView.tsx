/**
 * Generic renderer for a `RenderedPreview` (lib/preview-render.ts) —
 * labelled rows, nested arrays as compact lines, "All fields (n)" folding,
 * and the rounded-number hover titles. One component, shared by every
 * surface that shows a `PreviewBody`-shaped record: the approval card's
 * preview box (components/PreviewBox.tsx, AU5) and the ticket's "What was
 * done" box (components/TicketWhatWasDone.tsx, AU6) — so the two can never
 * render the same data two different ways.
 *
 * DL4 (temp/briefs/dl-delegation-brief.md) added three more row shapes, all
 * generic — no tool name ever appears here: `sublist` (a nested object of
 * scalars, one row per key), `diffLines` (a `text/x-diff` string, `-`
 * struck/red, `+` green, context plain) and `description` (a schema
 * property's own note, shown beside the label).
 */
import { Fragment } from 'react';
import type { PreviewFieldRow, RenderedPreview } from '../lib/preview-render';

function FieldLabel({ row }: { row: PreviewFieldRow }) {
  return (
    <dt style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', alignSelf: 'start' }}>
      {row.label}
      {row.description && (
        <div style={{ color: 'var(--text-tertiary)', fontSize: '0.72rem', fontWeight: 400, whiteSpace: 'normal', marginTop: '0.1rem' }}>
          {row.description}
        </div>
      )}
    </dt>
  );
}

function FieldValue({ row }: { row: PreviewFieldRow }) {
  if (row.sublist) {
    return (
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.15rem 0.6rem', margin: 0 }}>
        {row.sublist.map((s) => (
          <Fragment key={s.key}>
            <dt style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{s.label}</dt>
            <dd style={{ margin: 0, wordBreak: 'break-word' }} title={s.valueTitle}>{s.value}</dd>
          </Fragment>
        ))}
      </dl>
    );
  }
  if (row.diffLines) {
    return (
      <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.8rem' }}>
        {row.diffLines.map((l, i) => (
          <div
            key={i}
            style={
              l.kind === 'remove'
                ? { color: 'var(--danger)', textDecoration: 'line-through' }
                : l.kind === 'add'
                  ? { color: 'var(--success)' }
                  : undefined
            }
          >
            {l.text || ' '}
          </div>
        ))}
      </div>
    );
  }
  if (row.lines) {
    return (
      <div>
        {row.lines.map((l, i) => <div key={i} title={row.lineTitles?.[i]}>{l}</div>)}
      </div>
    );
  }
  return <span title={row.valueTitle}>{row.value}</span>;
}

export function PreviewFieldRows({ rows }: { rows: PreviewFieldRow[] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.3rem 0.75rem', fontSize: '0.85rem', margin: '0.4rem 0' }}>
      {rows.map((r) => (
        <Fragment key={r.key}>
          <FieldLabel row={r} />
          <dd style={{ margin: 0, wordBreak: 'break-word' }}>
            <FieldValue row={r} />
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
