/**
 * The arguments of a proposal on the approval screen — one renderer for every
 * tool (see lib/approval-view.ts). Never truncates: the person approves exactly
 * what they can read here.
 */
import { nestedValueView } from '../lib/preview-render';
import { PreviewTableView } from './PreviewTableView';
import { Fragment } from 'react';
import { argRows, fieldNotes, profileFieldLines, type ArgRow, type ToolDisplay } from '../lib/approval-view';
import { profileDisplayName } from '../lib/profile-display';
import { useProfile } from '../lib/profile-cache';
import { useSourceManifests } from '../lib/source-manifests';

const IMAGE_FIELD_RE = /^(image|img|photo|picture|thumbnail)(_?url)?$/i;
function isImageArg(key: string, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^data:image\//i.test(value)) return true;
  if (IMAGE_FIELD_RE.test(key)) return /^https?:\/\//.test(value);
  return /^https?:\/\/.+\.(jpe?g|png|gif|webp|svg|avif)(\?|$)/i.test(value);
}

function plain(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function ProfileFields({ row, which }: { row: ArgRow; which: 'limits' | 'scope' }) {
  const profile = useProfile(row.profileRef);
  const sourceManifests = useSourceManifests();
  const lines = profileFieldLines(row.value, profile, which, sourceManifests);
  if (lines.length === 0) return <span style={{ color: 'var(--text-tertiary)' }}>none</span>;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.15rem 0.75rem', margin: 0 }}>
      {lines.map(l => (
        <Fragment key={l.key}>
          <dt style={{ color: 'var(--text-secondary)' }} title={l.hint}>{l.label}</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>
            {l.value}
            {l.unknown && <span className="msg-error" style={{ marginLeft: '0.5rem' }}>not defined by this profile</span>}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function ProfileName({ row }: { row: ArgRow }) {
  const profile = useProfile(row.profileRef);
  const id = profile?.id ?? row.profileRef ?? '';
  return (
    <>
      {profile?.name ?? profileDisplayName(id)}
      <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{id}</div>
    </>
  );
}

/** One argument's value, rendered by its display kind — shared with the
 *  ticket's "What was sent" box (TicketWhatWasDone, UI spec §14) so the two
 *  can never show the same value differently. */
export function ArgValue({ row, altText }: { row: ArgRow; altText?: string }) {
  // Records and lists of records read the same here as on the approval card
  // (preview-render.ts): a table / one compact line — never raw JSON.
  if (row.kind === 'list' || row.kind === 'object') {
    const nested = nestedValueView(row.value);
    if (nested && 'table' in nested) return <PreviewTableView table={nested.table} />;
    if (nested) return <>{nested.text}</>;
  }
  switch (row.kind) {
    case 'profile': return <ProfileName row={row} />;
    case 'profile-limits': return <ProfileFields row={row} which="limits" />;
    case 'profile-scope': return <ProfileFields row={row} which="scope" />;
    case 'markdown':
      return (
        <div style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-main)', border: '1px solid var(--border)', borderRadius: '0.375rem', padding: '0.5rem 0.625rem' }}>
          {plain(row.value)}
        </div>
      );
    case 'list':
      return Array.isArray(row.value)
        ? <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>{row.value.map((x, i) => <li key={i}>{plain(x)}</li>)}</ul>
        : <>{plain(row.value)}</>;
    case 'money':
      return <>{plain(row.value)}{row.currency ? ` ${row.currency}` : ''}</>;
    case 'object':
      return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '0.8rem' }}>{plain(row.value)}</pre>;
    default:
      // An image with a note is not sealed as bytes: NotSealedArgs shows it, not this row.
      if (isImageArg(row.key, row.value) && !row.note) {
        return (
          <img src={row.value as string} alt={altText ?? row.key}
            style={{ display: 'block', maxWidth: '100%', maxHeight: '240px', borderRadius: '0.375rem', border: '1px solid var(--border)' }} />
        );
      }
      return <>{plain(row.value)}</>;
  }
}

/** An image the card renders whose field carries a manifest `note` is not sealed as
 *  bytes (only its name is), so it must not sit in the sealed tile: it goes to the
 *  "Not sealed" block with its note. Decided by the presence of the note — the
 *  manifest has no other signal for "bytes not sealed". */
export function unsealedPreviews(args: Record<string, unknown>, display?: ToolDisplay): { src: string; alt: string; notes: string[] }[] {
  const alt = typeof args.altText === 'string' ? args.altText : 'image preview';
  const out: { src: string; alt: string; notes: string[] }[] = [];
  const urlRows = argRows(args, display).filter(r => r.note && isImageArg(r.key, r.value));
  for (const r of urlRows) out.push({ src: r.value as string, alt, notes: [r.note!] });
  const local = args._imagePreview;
  if (typeof local === 'string') {
    const notes = fieldNotes(args, display, urlRows.map(r => r.key));
    if (notes.length > 0) out.push({ src: local, alt, notes });
  }
  return out;
}

/** True when the card shows its local `_imagePreview` in the Not sealed block instead of the tile. */
export function localPreviewIsUnsealed(args: Record<string, unknown>, display?: ToolDisplay): boolean {
  return typeof args._imagePreview === 'string' && fieldNotes(args, display).length > 0;
}

/** Everything shown but not sealed: arguments the manifest declares `nonContentArgs`,
 *  and image previews whose bytes are not sealed. Apart from the sealed tile, in the
 *  quiet style of the ticket card's "Also sent" block. */
export function NotSealedArgs({ args, display }: { args: Record<string, unknown>; display?: ToolDisplay }) {
  const rows = argRows(args, display, { part: 'unsealed' });
  const previews = unsealedPreviews(args, display);
  if (rows.length === 0 && previews.length === 0) return null;
  return (
    <div data-testid="not-sealed-args">
      <p className="ob-lbl ob-gap">Not sealed</p>
      {rows.length > 0 && (
        <dl className="ob-kv">
          {rows.map(row => (
            <Fragment key={row.key}>
              <dt title={row.hint}>{row.label}</dt>
              <dd className="ob-plain">
                <ArgValue row={row} />
                {row.note && <p className="ob-quiet">{row.note}</p>}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {previews.map((pv, i) => (
        <div key={i} style={{ marginTop: 'var(--space-2)' }} data-testid="unsealed-image">
          <img src={pv.src} alt={pv.alt} className="av3-image" style={{ marginBottom: 'var(--space-1)' }} />
          {pv.notes.map(n => <p key={n} className="ob-quiet">{n}</p>)}
        </div>
      ))}
    </div>
  );
}

interface ProposalArgsProps {
  args: Record<string, unknown>;
  display?: ToolDisplay;
  /** Section heading. AU5 passes '' to omit it (e.g. nested inside its own
   *  <details> fold, "Details (exactly what is bound)" — see
   *  ApproverProposalCard). */
  heading?: string;
  /** The argument the connector manifest declares as the link to the request
   *  (`sourceFromArg.arg`, e.g. mail's `in_reply_to`): it IS sent, but its raw
   *  id means nothing to a person — it reads "Replying to" and points to the
   *  Request box, the id kept as a tooltip. */
  requestRefArg?: string;
}

export function ProposalArgs({ args, display, heading = 'Details', requestRefArg }: ProposalArgsProps) {
  const rows = argRows(args, display);
  if (rows.length === 0) return null;
  const altText = typeof args.altText === 'string' ? args.altText : undefined;

  return (
    <div style={{ marginBottom: '0.75rem' }}>
      {heading && (
        <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.35rem' }}>
          {heading}
        </div>
      )}
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.35rem 0.75rem', fontSize: '0.85rem', margin: 0 }}>
        {rows.map(row => (
          <Fragment key={row.key}>
            <dt style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', alignSelf: 'start' }} title={row.hint}>
              {row.key === requestRefArg ? 'Replying to' : row.label}
            </dt>
            <dd style={{ color: 'var(--text-primary)', margin: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
              {row.key === requestRefArg
                ? <span data-testid="request-ref" title={plain(row.value)}>the message shown under Request</span>
                : <ArgValue row={row} altText={altText} />}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
