/**
 * The arguments of a proposal on the approval screen — one renderer for every
 * tool (see lib/approval-view.ts). Never truncates: the person approves exactly
 * what they can read here.
 */
import { Fragment } from 'react';
import { argRows, profileFieldLines, type ArgRow, type ToolDisplay } from '../lib/approval-view';
import { profileDisplayName } from '../lib/profile-display';
import { useProfile } from '../lib/profile-cache';

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
  const lines = profileFieldLines(row.value, profile, which);
  if (lines.length === 0) return <span style={{ color: 'var(--text-tertiary)' }}>none</span>;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.15rem 0.75rem', margin: 0 }}>
      {lines.map(l => (
        <Fragment key={l.key}>
          <dt style={{ color: 'var(--text-secondary)' }} title={l.hint}>{l.label}</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>
            {l.value}
            {l.unknown && <span style={{ color: 'var(--danger)', fontWeight: 400, marginLeft: '0.5rem' }}>not defined by this profile</span>}
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

function Value({ row, altText }: { row: ArgRow; altText?: string }) {
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
      if (isImageArg(row.key, row.value)) {
        return (
          <img src={row.value as string} alt={altText ?? row.key}
            style={{ display: 'block', maxWidth: '100%', maxHeight: '240px', borderRadius: '0.375rem', border: '1px solid var(--border)' }} />
        );
      }
      return <>{plain(row.value)}</>;
  }
}

interface ProposalArgsProps {
  args: Record<string, unknown>;
  display?: ToolDisplay;
  /** Section heading. AU5 passes '' to omit it (e.g. nested inside its own
   *  <details> fold, "Details (exactly what is bound)" — see
   *  ApproverProposalCard). */
  heading?: string;
}

export function ProposalArgs({ args, display, heading = 'Details' }: ProposalArgsProps) {
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
            <dt style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', alignSelf: 'start' }} title={row.hint}>{row.label}</dt>
            <dd style={{ color: 'var(--text-primary)', margin: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
              <Value row={row} altText={altText} />
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
