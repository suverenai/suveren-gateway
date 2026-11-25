import { S13 } from './texts';
import type { ApproverLine } from './give-view';

/** The approvers of a team mandate: who must approve above the limit, and whether the admin confirmed each. Gateway data only. */
export function GiveApprovers({ capText, count, approvers, adminName, ownId, mode }: {
  /** The cap in words ("500 EUR"), or null when the team set none. */
  capText: string | null; count: number; approvers: ApproverLine[]; adminName: string; ownId?: string; mode?: 'review' | 'automatic';
}) {
  const others = approvers.filter(a => a.userId !== ownId);
  const you = ownId !== undefined && approvers.some(a => a.userId === ownId);
  const blocked = others.filter(a => a.state === 'unconfirmed');
  return (
    <div data-testid="give-approvers">
      {capText && mode === 'automatic' && <p style={{ margin: '0 0 0.25rem' }}>{S13.giveWithinCaps(capText)}</p>}
      <p style={{ margin: '0 0 0.25rem' }}>{capText ? S13.giveApproversAbove(capText, count) : S13.giveApproversAll(count)}</p>
      <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
        {others.map(a => (
          <li key={a.userId} data-testid="give-approver" data-state={a.state}>
            {a.name}{' '}
            {a.state === 'confirmed' && <small>{S13.giveApproverConfirmed(adminName)}</small>}
            {a.state === 'unconfirmed' && <small className="msg-error">{S13.giveApproverUnconfirmed}</small>}
          </li>
        ))}
        {you && <li data-testid="give-you">{S13.giveYou}: <small>{S13.giveYouNote}</small></li>}
      </ul>
      {others.every(a => a.state === 'unknown') && others.length > 0 && <small style={{ color: 'var(--text-tertiary)' }} data-testid="give-interim">{S13.giveApproversChecked}</small>}
      {blocked.map(a => (
        <p key={a.userId} role="alert" data-testid="give-blocked" className="msg-error" style={{ margin: '0.5rem 0 0' }}>
          {S13.giveUnconfirmedReason(a.name, adminName)} {S13.giveUnconfirmedStep(adminName)}
        </p>
      ))}
    </div>
  );
}

/** The button is blocked while an approver is not confirmed. */
export function giveBlocked(approvers: ApproverLine[], ownId?: string): boolean {
  return approvers.some(a => a.userId !== ownId && a.state === 'unconfirmed');
}
