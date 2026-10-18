/**
 * AU8 — the combined "What will be created" view for a several-reads
 * preview (temp/briefs/au8-brief.md, mockup temp/mockups/approval-card-au8-v1.html).
 * Renders exactly what `lib/preview-render.ts`'s `buildCreationView` produces
 * — generic, no per-connector code: a bound field linked to a read shows as
 * an identity row or a table; every other bound field shows as itself; a
 * read with no attach gets its own section below.
 *
 * Marking: every value is either SEALED (bound — approved and executed
 * exactly so) or FROM THE SYSTEM (read by the gateway, not by the AI) — the
 * mockup's "bold black" vs "blue" marking, here `.src-tag-sealed` (existing)
 * vs `.src-tag-system` (new, see design-system.css). The legend itself is
 * NOT rendered here (AU10 F1) — one legend for the whole card, after the
 * History block — see ApprovalBody.tsx's `CardLegend`.
 */
import { Fragment } from 'react';
import type { AttachedIdentity, CreationView } from '../lib/preview-render';
import { PreviewFieldRows } from './RenderedPreviewView';
import { PreviewTableView } from './PreviewTableView';
import { DocumentPreviewBox } from './DocumentPreviewBox';

function Identity({ identity }: { identity: AttachedIdentity }) {
  if (identity.unresolved) {
    return (
      <span>
        <span className="id-raw">{identity.rawId}</span>{' '}
        <span style={{ color: 'var(--text-tertiary)' }}>— {identity.unresolved}</span>
      </span>
    );
  }
  return (
    <span>
      {identity.name && <span className="src-tag-value src-tag-system-cell">{identity.name}</span>}
      {' '}
      <span className="id-raw">{identity.rawId}</span>
      {identity.context.length > 0 && (
        <span className="creation-context">
          {identity.context.map((c) => (
            <span key={c.key}>
              {' · '}{c.label} {c.value}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

export function RenderedCreationView({ view, systemName }: { view: CreationView; systemName?: string }) {
  return (
    <>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.3rem 0.75rem', fontSize: '0.85rem', margin: '0.4rem 0' }}>
        {view.rows.map((row) => {
          if (row.kind === 'table') return null; // tables render full-width, below the dl — see second pass
          return (
            <Fragment key={row.key}>
              <dt style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', alignSelf: 'start' }}>{row.label}</dt>
              <dd style={{ margin: 0, wordBreak: 'break-word' }}>
                {row.kind === 'identity'
                  ? <Identity identity={row.identity} />
                  : <span className="src-tag-value src-tag-sealed-cell" title={row.valueTitle}>{row.value}</span>}
              </dd>
            </Fragment>
          );
        })}
      </dl>
      {view.rows.filter((r) => r.kind === 'table').map((row) => (
        <div key={row.key} style={{ margin: '0.5rem 0' }}>
          <div style={{ color: 'var(--text-tertiary)', fontSize: '0.78rem', marginBottom: '0.2rem' }}>{row.label}</div>
          <PreviewTableView table={row.table} />
        </div>
      ))}
      {view.sections.map((section, i) => (
        <div key={i} className="creation-own-section">
          {section.document ? (
            // UI spec §15.1 — the document box carries its own label/frame;
            // no generic "<tool> — from the system" heading on top of it.
            <DocumentPreviewBox doc={section.document} systemName={systemName} />
          ) : (
            <>
              <h5>{section.heading} <span className="src-tag src-tag-system">from the system</span></h5>
              {section.table && <PreviewTableView table={section.table} />}
              {section.body && <PreviewFieldRows rows={section.body.fields} />}
              {section.note && <p className="preview-note">{section.note}</p>}
            </>
          )}
        </div>
      ))}
    </>
  );
}
