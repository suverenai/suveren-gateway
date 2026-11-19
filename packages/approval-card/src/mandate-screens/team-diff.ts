/**
 * The part of a mandate change the profile diff does not cover: who must approve, how many, and the team limits
 * (step 13 rule; open Q15 of the mockup). Computed from the old signed terms and the new ones, both read by the gateway.
 * Pure.
 */
import type { TeamTerms } from './interface';
import { S13 } from './texts';

export type TeamTag = 'More' | 'Less' | 'Changed' | 'New' | 'Removed';
export interface TeamRow {
  key: string;
  label: string;
  /** A list change: added and removed values. */
  added?: string[]; removed?: string[];
  /** A number change. */
  before?: string; after?: string;
  tag: TeamTag;
}

const unit = (v: number, u?: string): string => (u ? `${v} ${u}` : String(v));

export function teamDiff(before: TeamTerms | null, after: TeamTerms | null): TeamRow[] {
  const b: TeamTerms = before ?? { approvers: [], approvals: 0, limits: [] };
  const a: TeamTerms = after ?? { approvers: [], approvals: 0, limits: [] };
  const rows: TeamRow[] = [];
  const added = a.approvers.filter(x => !b.approvers.includes(x));
  const removed = b.approvers.filter(x => !a.approvers.includes(x));
  if (added.length || removed.length) rows.push({ key: 'approvers', label: S13.changeApprovers, added, removed, tag: removed.length && !added.length ? 'Removed' : added.length && !removed.length ? 'New' : 'Changed' });
  if (a.approvals !== b.approvals) rows.push({ key: 'approvals', label: S13.changeApprovalCount, before: String(b.approvals), after: String(a.approvals), tag: 'Changed' });
  for (const l of a.limits) {
    const old = b.limits.find(x => x.field === l.field);
    if (!old) rows.push({ key: `limit:${l.field}`, label: S13.changeTeamLimit(l.label), after: unit(l.value, l.unit), tag: 'New' });
    else if (old.value !== l.value) rows.push({ key: `limit:${l.field}`, label: S13.changeTeamLimit(l.label), before: unit(old.value, old.unit), after: unit(l.value, l.unit), tag: l.value > old.value ? 'More' : 'Less' });
  }
  for (const old of b.limits) {
    if (!a.limits.some(x => x.field === old.field)) rows.push({ key: `limit:${old.field}`, label: S13.changeTeamLimit(old.label), before: unit(old.value, old.unit), tag: 'Removed' });
  }
  return rows;
}

export const tagWord = (t: TeamTag): string => ({ More: S13.tagMore, Less: S13.tagLess, Changed: S13.tagChanged, New: S13.tagNew, Removed: S13.tagRemoved })[t];
