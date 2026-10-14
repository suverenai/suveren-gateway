/**
 * userId → display name, built the same way GateWizardPage.tsx and
 * AgentReviewPage.tsx already resolve approver names (mandate editor):
 * prefer per-GROUP members (works on a freshly-deployed AS), fall back to
 * the global user list (works on an older AS deployment — same data,
 * looser privacy scope, but already public via `/api/users`). Extracted
 * so TR5's approval card (ApproverProposalCard) resolves names the SAME
 * way the mandate editor does, rather than drifting with its own copy.
 */

export interface MemberLike {
  id: string;
  name?: string;
  email?: string;
}

/** A group member as `GET /api/groups/:id` returns it — `userId` on some
 *  AS versions, `id` on others; never assume one or the other. */
export interface GroupMemberLike {
  userId?: string;
  id?: string;
  name?: string;
  email?: string;
}

export function buildMemberNameMap(
  users: MemberLike[],
  groupMembers: GroupMemberLike[] = [],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const u of users) {
    const label = u.name && u.email ? `${u.name} (${u.email})` : (u.name || u.email || u.id);
    map.set(u.id, label);
  }
  for (const m of groupMembers) {
    const id = m.userId ?? m.id;
    if (!id) continue;
    if (m.name && m.email) map.set(id, `${m.name} (${m.email})`);
    else if (m.name) map.set(id, m.name);
    // else leave whatever the global user list already gave us.
  }
  return map;
}

/** Resolve a list of userIds through the map — a userId with no entry
 *  falls back to itself (never dropped, never blank). */
export function namesFor(ids: string[], map: Map<string, string>): string[] {
  return ids.map(id => map.get(id) ?? id);
}

/** One userId, with "(you)" appended when it is the viewer's own id —
 *  matches the signed-off mockup's "Lisa (you)" / "Tom (you)". */
export function nameWithYou(id: string, map: Map<string, string>, currentUserId: string | undefined): string {
  const name = map.get(id) ?? id;
  return id === currentUserId ? `${name} (you)` : name;
}
