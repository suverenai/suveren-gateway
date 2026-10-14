/**
 * TR5 (work-plan "Added 2026-10-14 — Team: permissions, above-cap approval,
 * read limits") — everything ApproverProposalCard needs about the TEAM's
 * current cap configuration for a given above-cap proposal: how many
 * distinct approvals it needs (default 1), who the configured approvers
 * are (by display name), and — when it can be determined from real data —
 * why this specific proposal is above cap at all.
 *
 * Scoped to the viewer's OWN active workspace's groupId (useAuth) — the AS
 * only ever returns an above-cap proposal via `GET /api/proposals?approver=me`
 * when it is scoped to the caller's active workspace group (WS2), so the
 * authorization's own groupId and the viewer's active one are the same
 * group by construction; no separate authorization lookup is needed.
 */
import { useEffect, useState } from 'react';
import { spClient, type Proposal, type ProfileConfig } from './sp-client';
import { effectiveApprovals } from './sp-client';
import { useAuth } from '../contexts/AuthContext';
import { useProfile } from './profile-cache';
import { findAboveCapViolation, type AboveCapReason } from './team-caps';
import { buildMemberNameMap, namesFor } from './member-names';

export interface ApprovalTeamInfo {
  /** Still loading the team config / member names. */
  loading: boolean;
  profileConfig: ProfileConfig | null;
  /** `config.approvals`, defaulted to 1. */
  requiredApprovals: number;
  /** `pendingApprovers`, resolved to display names (falls back to the raw
   *  userId when unresolved) — parallel array to `proposal.pendingApprovers`. */
  approverNames: string[];
  /** userId → display name, for the proposer line. */
  nameOf: (userId: string) => string;
  /** Why this proposal is above cap — null when it cannot be determined
   *  from real data (see team-caps.ts's `findAboveCapViolation`). */
  aboveCapReason: AboveCapReason | null;
}

export function useApprovalTeamInfo(proposal: Proposal): ApprovalTeamInfo {
  const { groupId } = useAuth();
  const profile = useProfile(proposal.profileId);
  const [profileConfig, setProfileConfig] = useState<ProfileConfig | null>(null);
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    if (!groupId) { setLoading(false); return; }
    setLoading(true);
    Promise.all([
      spClient.getTeamProfileConfig(groupId, proposal.profileId).catch(() => null),
      spClient.getGroupById(groupId).catch(() => null),
      spClient.listUsers().catch(() => []),
    ]).then(([config, groupData, users]) => {
      if (!live) return;
      setProfileConfig(config);
      setNameMap(buildMemberNameMap(users, groupData?.members ?? []));
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, proposal.profileId]);

  const requiredApprovals = effectiveApprovals(profileConfig ?? { approvers: [] });
  const approverNames = namesFor(proposal.pendingApprovers ?? [], nameMap);
  const nameOf = (userId: string): string => nameMap.get(userId) ?? userId;

  const aboveCapReason =
    profileConfig && profile?.boundsSchema?.fields
      ? findAboveCapViolation(proposal.executionContext, profileConfig, profile.boundsSchema.fields)
      : null;

  return { loading, profileConfig, requiredApprovals, approverNames, nameOf, aboveCapReason };
}
