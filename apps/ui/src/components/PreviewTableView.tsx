/**
 * Shared table renderer for a `PreviewTable` (lib/preview-render.ts) —
 * used both by RenderedPreviewView.tsx (an array-of-objects field inside any
 * preview, e.g. send_quote's `lines` — AU8 "send_quote card gets the table
 * rendering") and RenderedCreationView.tsx (AU8's several-reads "What will
 * be created" view) — one table look, never duplicated.
 */
import type { PreviewTable } from '../lib/preview-render';

export function PreviewTableView({ table }: { table: PreviewTable }) {
  if (table.columns.length === 0) {
    return <p className="preview-note">Nothing to show.</p>;
  }
  return (
    <>
      <table className="preview-table">
        <thead>
          <tr>
            {table.columns.map((c) => <th key={c.key}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.cells.map((cell, j) => (
                <td
                  key={j}
                  className={cell.sealed ? 'src-tag-value src-tag-sealed-cell' : 'src-tag-value src-tag-system-cell'}
                  title={cell.valueTitle}
                >
                  {cell.value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.overflowNote && <p className="preview-note">{table.overflowNote}</p>}
    </>
  );
}
