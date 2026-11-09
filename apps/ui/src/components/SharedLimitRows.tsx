/**
 * The shared limits that govern THIS action, on the approval card: one row per
 * cumulative bound of the mandate — "Team limit per day (3 of 5 used)". The
 * figures are the Authority Server's own running count (read from the newest
 * ticket under the mandate); without proof, the row says only that the limit
 * exists. Which bounds govern is read from the profile (`appliesTo`), never
 * from a field name.
 */
import type { AgentProfile } from '@hap/core';
import { useMandateReceipts, usedTodayNumbers } from '../lib/mandate-card-usage';
import { cumulativeBounds, sharedLimitLabel } from '../lib/limit-words';
import { useAuth } from '../contexts/AuthContext';

export function SharedLimitRows({ authorizationId, bounds, profile, actionType, style }: {
  authorizationId: string;
  bounds: Record<string, string | number> | undefined;
  profile: AgentProfile | null;
  actionType?: string;
  style?: React.CSSProperties;
}) {
  const { mode } = useAuth();
  const res = useMandateReceipts();
  if (!bounds || !profile) return null;
  const governing = cumulativeBounds(profile).filter((b) =>
    b.key in bounds && (!b.appliesTo || (actionType !== undefined && b.appliesTo.includes(actionType))));
  if (governing.length === 0) return null;
  const used = res.state === 'ok'
    ? usedTodayNumbers({ receipts: res.receipts, coversToday: res.coversToday, authorizationId, bounds, profile, nowMs: Date.now() })
    : {};
  return (
    <dl className="av3-shared-limits" style={style} data-testid="shared-limits">
      {governing.map((b) => {
        const label = sharedLimitLabel({ profile, key: b.key, team: mode === 'team', limit: bounds[b.key], used: used[b.key] })!;
        return (
          <div key={b.key} className="av3-shared-limit">
            <dt>{label.name}</dt>
            <dd>{label.figures ? <span className="shared-limit-figures">({label.figures})</span> : null}</dd>
          </div>
        );
      })}
    </dl>
  );
}
