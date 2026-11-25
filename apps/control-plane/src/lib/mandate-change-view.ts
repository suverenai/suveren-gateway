/**
 * What the page's Change screen shows besides the profile diff: the team's approvers, approval count and team limits,
 * before (what the owner SIGNED) and after (what the team's settings say now). Computed here from the signed mandate and the
 * team settings; labels come from the team's member list and the profile's own field names, never from the AI or free text.
 * The page turns the two sides into rows (`teamDiff` in packages/approval-card/src/mandate-screens).
 */
import type { AgentProfile } from '@hap/core';

export interface TeamTerms {
  approvers: string[];
  approvals: number;
  limits: Array<{ field: string; label: string; value: number; unit?: string }>;
}

type CapShape = { enforcedBy?: string; boundType?: { kind?: string }; displayName?: string; unit?: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The team's caps that need an approver (the Authority Server's forcing rules: no approvers, a gatekeeper-enforced field or an enum is a hard cap). */
export function approvalCapsOf(team: { approvers: string[]; caps: Record<string, unknown> }, profile: AgentProfile): Record<string, number> {
  const defs = (profile.boundsSchema?.fields ?? {}) as unknown as Record<string, CapShape>;
  const out: Record<string, number> = {};
  for (const [field, raw] of Object.entries(team.caps ?? {})) {
    const cfg = isObj(raw) ? raw : { value: raw };
    const def = defs[field];
    const kind = team.approvers.length === 0 || def?.enforcedBy === 'gatekeeper' || def?.boundType?.kind === 'enum' ? 'hard' : (cfg.kind === 'hard' ? 'hard' : 'approval');
    if (kind === 'approval' && typeof cfg.value === 'number') out[field] = cfg.value;
  }
  return out;
}

export function limitsOf(caps: Record<string, number>, profile: AgentProfile): TeamTerms['limits'] {
  const defs = (profile.boundsSchema?.fields ?? {}) as unknown as Record<string, CapShape>;
  return Object.entries(caps).sort(([a], [b]) => (a < b ? -1 : 1)).map(([field, value]) => ({
    field, label: defs[field]?.displayName ?? field, value, ...(defs[field]?.unit ? { unit: defs[field]!.unit } : {}),
  }));
}

/** A person's label: their name, else their email, else their id. */
export function memberLabel(m: { id: string; name?: string; email?: string }): string {
  return (m.name && m.name.trim()) || (m.email && m.email.trim()) || m.id;
}
