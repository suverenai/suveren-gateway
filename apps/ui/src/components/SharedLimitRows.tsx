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
import { cumulativeBounds, sharedLimitLabel, NOT_ALLOWED } from '../lib/limit-words';
import { useCumulativeUsage, usageEntryFor } from '../lib/cumulative-usage';
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
  const server = useCumulativeUsage(authorizationId);
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
        // The server's team-wide count wins; without it a team shows no figure.
        const entry = usageEntryFor(server, b.key, actionType);
        const label = sharedLimitLabel({
          profile, key: b.key, team: mode === 'team',
          limit: entry?.limit ?? bounds[b.key],
          used: entry ? entry.used : used[b.key],
          usedIsTeamWide: !!entry,
        })!;
        return (
          <div key={b.key} className="av3-shared-limit">
            <dt>{label.name}</dt>
            <dd>{label.figures === NOT_ALLOWED ? `(${NOT_ALLOWED})` : label.figures ? <span className="shared-limit-figures">({label.figures})</span> : null}</dd>
          </div>
        );
      })}
    </dl>
  );
}
