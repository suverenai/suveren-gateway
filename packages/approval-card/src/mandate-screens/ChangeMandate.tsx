/**
 * Screen 5: change (or only extend) a mandate. Only the differences: limits, scope, how long, the why word by word,
 * and the team's approvers, approval count and team limits. Every row is computed by the gateway from the old signed
 * mandate and the new one; the AI's words appear only in the "why", marked as the AI's.
 */
import type { ChangeRow, ChangeTag, MandateDiff } from '@hap/core/mandate-change';
import type { NameSources } from '../lib/display-names';
import { dateText, modeWord, rowLabel, rowValue, staysLines, valueName } from '../lib/mandate-change-view';
import { WordDiff } from '../components/MandateChangeCard';
import { S13 } from './texts';
import { tagWord, type TeamRow } from './team-diff';

export type ChangeState = { phase: 'review' } | { phase: 'busy' } | { phase: 'done' } | { phase: 'error'; code: ChangeError };
export type ChangeError = 'changed_since_proposal' | 'no_change' | 'not_your_mandate' | 'mandate_not_active' | 'cancelled' | 'other';

export function changeErrorText(code: ChangeError): string {
  switch (code) {
    case 'changed_since_proposal': return S13.changeChangedSince;
    case 'no_change': return S13.changeNoChange;
    case 'not_your_mandate': return S13.changeNotYours;
    case 'mandate_not_active': return S13.changeNotActive;
    case 'cancelled': return S13.changeCancelled;
    default: return S13.endOther; // DRAFT text, see texts.ts
  }
}

const tag = (t: ChangeTag): string => (t === 'Gone' ? S13.tagRemoved : t === 'More' ? S13.tagMore : t === 'Less' ? S13.tagLess : t === 'New' ? S13.tagNew : S13.tagChanged);

function Tag({ text }: { text: string }) {
  return <span className="mc-tag" data-testid="change-tag">{text}</span>;
}

function Line({ label, children, tagText }: { label: string; children: React.ReactNode; tagText: string }) {
  return (
    <div data-testid="change-row" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem 0.75rem', alignItems: 'baseline', padding: '0.5rem 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ flex: '1 1 10rem' }}>{label}</span>
      <span>{children}</span>
      <Tag text={tagText} />
    </div>
  );
}

function RowView({ row, names }: { row: ChangeRow; names: NameSources }) {
  if (row.added || row.removed) {
    return (
      <Line label={rowLabel(row)} tagText={tag(row.tag)}>
        {(row.added ?? []).map(v => <span key={`a${v}`} className="mc-add" style={{ marginRight: 6 }}>{valueName(row, v, names)}</span>)}
        {(row.removed ?? []).map(v => <del key={`r${v}`} className="mc-rem" style={{ marginRight: 6 }}>{valueName(row, v, names)}</del>)}
      </Line>
    );
  }
  return (
    <Line label={rowLabel(row)} tagText={tag(row.tag)}>
      {row.before !== null && <><del>{rowValue(row, row.before)}</del>{' → '}</>}
      <strong>{rowValue(row, row.after)}</strong>
    </Line>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section style={{ marginTop: '1rem' }}><h4 style={{ margin: 0 }}>{title}</h4>{children}</section>;
}

export interface ChangeMandateProps {
  profileName: string;
  diff: MandateDiff;
  /** Approvers, approval count and team limits that differ (see `teamDiff`). */
  team: TeamRow[];
  /** The why was written by the AI: marked as such. */
  intentByAi?: boolean;
  names?: NameSources;
  state: ChangeState;
  onChange: () => void;
  onCancel: () => void;
}

/** Only the end date moves. */
export function isExtendOnly(diff: MandateDiff, team: TeamRow[]): boolean {
  return !!diff.lastsUntil && diff.rows.length === 0 && !diff.mode && !diff.intent && !diff.versionMove && team.length === 0;
}

export function ChangeMandate({ profileName, diff, team, intentByAi, names = {}, state, onChange, onCancel }: ChangeMandateProps) {
  if (state.phase === 'done') return <p role="status" data-testid="change-done" className="msg-success">{S13.changeDone(profileName)}</p>;
  const extend = isExtendOnly(diff, team);
  const limits = diff.rows.filter(r => r.section === 'limit');
  const scope = diff.rows.filter(r => r.section === 'scope');
  const busy = state.phase === 'busy';
  const stays = staysLines(diff, names);
  return (
    <div className="card" data-testid={extend ? 'extend-mandate' : 'change-mandate'} style={{ maxWidth: 560 }}>
      <h3 className="card-title">{extend ? S13.extendTitle(profileName) : S13.changeTitle(profileName)}</h3>
      {!extend && <p>{S13.changeOnlyListed}</p>}
      <p data-testid="change-owner-only" style={{ color: 'var(--text-secondary)' }}>{S13.changeOnlyOwner}</p>
      {limits.length > 0 && <Section title={S13.changeLimits}>{limits.map(r => <RowView key={r.field} row={r} names={names} />)}</Section>}
      {scope.length > 0 && <Section title={S13.changeScope}>{scope.map(r => <RowView key={r.field} row={r} names={names} />)}</Section>}
      {team.length > 0 && (
        <Section title={S13.changeApprovals}>
          {team.map(r => (
            <Line key={r.key} label={r.label} tagText={tagWord(r.tag)}>
              {r.added || r.removed ? <>
                {(r.added ?? []).map(v => <span key={`a${v}`} className="mc-add" style={{ marginRight: 6 }}>{v}</span>)}
                {(r.removed ?? []).map(v => <del key={`r${v}`} className="mc-rem" style={{ marginRight: 6 }}>{v}</del>)}
              </> : <>{r.before !== undefined && <><del>{r.before}</del>{' → '}</>}{r.after !== undefined ? <strong>{r.after}</strong> : null}</>}
            </Line>
          ))}
        </Section>
      )}
      {diff.mode && (
        <Section title={S13.changeApprovals}>
          <Line label={S13.changeMode} tagText={tag(diff.mode.tag)}>
            <del>{modeWord(diff.mode.before)}</del>{' → '}<strong>{modeWord(diff.mode.after)}</strong>
          </Line>
        </Section>
      )}
      {diff.lastsUntil && (
        <Section title={S13.changeHowLong}>
          <Line label={S13.changeUntil} tagText={tag(diff.lastsUntil.tag)}><del>{dateText(diff.lastsUntil.before)}</del>{' → '}<strong>{dateText(diff.lastsUntil.after)}</strong></Line>
        </Section>
      )}
      {diff.intent && (
        <Section title={S13.changeWhy}>
          <div data-testid="change-why" style={intentByAi ? { borderLeft: '3px solid var(--warning, #b45309)', paddingLeft: '0.5rem' } : undefined}>
            <WordDiff parts={diff.intent} />
            {intentByAi && <small>{S13.changeFromAi}</small>}
          </div>
        </Section>
      )}
      {diff.versionMove && <p data-testid="change-version">{S13.changeVersionMove(diff.versionMove.from, diff.versionMove.to)}</p>}
      {extend ? <p>{S13.extendNothingElse}</p> : stays.length > 0 && (
        <Section title={S13.changeStays}><p data-testid="change-stays">{stays.join(' · ')}</p></Section>
      )}
      <p style={{ marginTop: '1rem' }}>{S13.changeWhenTouch}</p>
      {state.phase === 'error' && <p role="alert" data-testid="change-error" className="msg-error">{changeErrorText(state.code)}</p>}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" onClick={onChange} disabled={busy}>{extend ? S13.extendButton : S13.changeButton}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>{S13.changeCancel}</button>
      </div>
    </div>
  );
}
