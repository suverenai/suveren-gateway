/**
 * What the report-writing AI may read about a ticket (work-plan "regular
 * reporting", RR3; decision 3): what a working agent already sees about its
 * own mandates through `list-authorizations` — profile, limits, mode, running
 * totals, scope, intent — plus the approval facts (approved yes/no, asked and
 * decided time, waiting time) and the approver's name ONLY if that person
 * disclosed it.
 *
 * Built as ALLOW-LISTS: each projection names every field it passes on, so a
 * field added to a resolver or to the archive later stays out of the AI's view
 * until someone adds it here on purpose. Never passed on: internal ids (user,
 * group, mandate/authorization id), raw signatures, attestation blobs, owner
 * DIDs / account ids (`ownersRaw`, `who`), credentials.
 *
 * Ticket ids stay (the report references tickets by them) and so does the
 * public check link.
 *
 * Free-form maps that come from the signed ticket or mandate (the limits used,
 * the mandate's bounds) pass through `scrubForbidden` as a second line: a key
 * from FORBIDDEN_AGENT_KEYS is removed at any depth.
 */

/** Keys that must never reach the report AI, at any depth. Also what the
 *  field-allow-list tests grep every report tool output for. */
export const FORBIDDEN_AGENT_KEYS = [
  'userId', 'groupId', 'authorizationId', 'signature', 'approvalSignature',
  'blob', 'attestations', 'ownersRaw', 'who', 'subjects', 'asPublicKey',
  'credentials', 'proposalId', 'boundsHash', 'contextHash',
] as const;

const FORBIDDEN = new Set<string>(FORBIDDEN_AGENT_KEYS);

export function scrubForbidden(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubForbidden);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN.has(k)) continue;
      out[k] = scrubForbidden(v);
    }
    return out;
  }
  return value;
}

type Data = Record<string, unknown>;

/** One row of list_tickets — from the archived (window-scoped) ticket. */
export function agentTicketRow(receipt: Data, hasApproval: boolean, profileLabel: string): Data {
  return {
    id: typeof receipt.id === 'string' ? receipt.id : String(receipt.id ?? ''),
    time: typeof receipt.timestamp === 'number' ? receipt.timestamp : undefined,
    action: receipt.action,
    actionType: receipt.actionType ?? null,
    profile: receipt.profileId,
    profileLabel,
    limitsUsed: scrubForbidden(receipt.limits ?? receipt.executionContext ?? {}),
    hasApproval,
  };
}

/** get_ticket's `ticket` part — from resolveTicketElement's verified data. */
export function agentTicket(d: Data): Data {
  return {
    ticketId: d.ticketId,
    action: d.action,
    actionLabel: d.actionLabel,
    time: d.time,
    timeLabel: d.timeLabel,
    profile: d.profile,
    profileLabel: d.profileLabel,
    limitsUsed: scrubForbidden(d.limitsUsed ?? {}),
    checkUrl: d.checkUrl,
  };
}

const APPROVED_STATUSES = new Set(['committed', 'executed']);

/** get_ticket's `approval` part — approval facts only; the approver as the
 *  label identity.ts produced (a disclosed name, else a neutral label). */
export function agentApproval(d: Data): Data {
  const status = typeof d.status === 'string' ? d.status : undefined;
  return {
    approved: status !== undefined ? APPROVED_STATUSES.has(status) : d.decidedAt !== undefined,
    approvedBy: d.whoLabel,
    askedAt: d.createdAt,
    askedAtLabel: d.createdAtLabel,
    decidedAt: d.decidedAt,
    decidedAtLabel: d.decidedAtLabel,
    waitSeconds: d.waitSeconds,
    waitLabel: d.waitLabel,
  };
}

/** get_ticket's `mandate` part — what list-authorizations shows the working
 *  agent: profile, limits, mode, intent; owners as labels (names only when
 *  disclosed). */
export function agentMandate(d: Data): Data {
  return {
    profile: d.profile,
    profileLabel: d.profileLabel,
    limits: d.limits,
    rawLimits: scrubForbidden(d.rawLimits ?? {}),
    mode: d.mode,
    intent: d.intent,
    owners: d.owners,
  };
}
