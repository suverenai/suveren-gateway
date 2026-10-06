/**
 * Resolves `sv-case start="email:MSG_ID" goal="ticket:TICKET_ID"
 * steps="TICKET_ID TICKET_ID"` — one business case, start to goal.
 *
 * Rules (work-plan "evidence-backed reports" decisions + fixed-elements table):
 *  - start MUST be a loaded case email: an inbox row carrying a `case_id`.
 *  - goal MUST be a verified ticket timestamped at or after start.
 *  - an EMAIL-SEND goal (a `sent` row whose `receipt_id` equals the goal
 *    ticket) must be a reply to start (`in_reply_to`) or addressed to
 *    start's sender — otherwise "warning: goal link not confirmed", not a
 *    hard failure (a human could still read and judge the case).
 *  - every step must verify and lie inside [start, goal] — a step that
 *    doesn't is a FACTUAL error in the report, not a soft link, so it fails
 *    the whole case closed (`unverifiable`), unlike the goal-link check.
 */
import type { EmailExport, EmailMessage } from './types';
import type { ReceiptArchiveReader } from './types';
import { checkTicket, resolveApprovalElement } from './ticket-resolvers';
import { parseTimestampSeconds } from './time';
import { formatActionLabel } from './format';

/** `"email:abc123"` -> `{ type: "email", id: "abc123" }`. No colon -> the
 *  whole value is the id and `type` is `undefined` (caller supplies the
 *  default the brief implies for that attribute). */
function parseRef(value: string | undefined): { type?: string; id: string } {
  if (!value) return { id: '' };
  const i = value.indexOf(':');
  if (i === -1) return { id: value.trim() };
  return { type: value.slice(0, i).trim(), id: value.slice(i + 1).trim() };
}

function parseStepRefs(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).filter(Boolean).map(s => parseRef(s).id || s);
}

function parseRecipients(toJson: string | null | undefined, ccJson: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of [toJson, ccJson]) {
    if (!raw) continue;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) out.push(...arr.filter((x): x is string => typeof x === 'string'));
    } catch {
      // malformed JSON in the export — treat as no recipients rather than throw
    }
  }
  return out.map(s => s.toLowerCase());
}

/** Parses an sv-case's three attributes without resolving anything — used by
 *  `verify-report.ts` to list every ticket an sv-case MENTIONS (for the proof
 *  panel's "tickets referenced"), including ones that turn out invalid. */
export function parseCaseAttrs(attrs: { start?: string; goal?: string; steps?: string }): {
  startId: string; goalId: string; stepIds: string[];
} {
  return {
    startId: parseRef(attrs.start).id,
    goalId: parseRef(attrs.goal).id,
    stepIds: parseStepRefs(attrs.steps),
  };
}

export interface TimelineEntry {
  type: 'start' | 'step' | 'approval' | 'goal';
  time: number;
  label: string;
}

export interface CaseApproval {
  ticketId: string;
  who: string[];
  createdAt?: number;
  decidedAt?: number;
  waitSeconds?: number;
  // The following mirror resolveApprovalElement's own display fields
  // (ticket-resolvers.ts) — present at runtime because this array is built
  // by spreading that resolver's `data`, kept optional here since this
  // interface predates them and some construction paths may not set them.
  whoLabel?: string;
  createdAtLabel?: string;
  decidedAtLabel?: string;
  waitLabel?: string;
}

/** Plain reason shown wherever a case time cannot be trusted. */
export const CASE_TIME_UNKNOWN_REASON =
  'Not verifiable: the time the test data was loaded is unknown, and the email\'s own date may be set by the test package.';

export interface CaseData {
  caseId: string;
  /**
   * `time` is the EFFECTIVE case start: max(email received_at, test-data
   * loaded_at). A test package backdates its emails (e.g. 08:33 for data
   * loaded at 09:24), so the email's own date alone would invent case
   * durations (review SR4, 2026-10-06). `emailTime` keeps the email's own
   * date for display ("Email dated …"). `basis` says which one `time` is:
   * 'email' (the email arrived after the load), 'loaded' (backdated email,
   * clamped to the load time) or 'load-unknown' (no load time — `time` is
   * the email's own date and every duration is withheld).
   */
  start: {
    id: string; time: number; sender: string; emailTime: number; basis: 'email' | 'loaded' | 'load-unknown';
    /** The inbox row's own signed-source values, verbatim (two-tag rule, RR6). */
    subject?: string; receivedAt?: string; loadedAt?: string;
  };
  goal: { ticketId: string; time: number; action: unknown; actionLabel?: string };
  steps: Array<{ ticketId: string; time: number; action: unknown; actionLabel?: string }>;
  approvals: CaseApproval[];
  timeline: TimelineEntry[];
  /** null when the start time cannot be trusted (`start.basis === 'load-unknown'`)
   *  — never a number computed from a possibly backdated email date. */
  totalDurationSeconds: number | null;
  /** Set whenever `totalDurationSeconds` is null — plain reason for the reader. */
  timeUnverifiableReason?: string;
}

export interface CaseResolution {
  status: 'verified' | 'unverifiable' | 'warning';
  reason?: string;
  /** Set whenever `start` resolved to a real, case-tagged inbox message —
   *  even if the case overall fails for an unrelated reason (a bad goal or
   *  step). Coverage counts a case as addressed once its start is real. */
  startCaseId?: string;
  data?: CaseData;
}

export async function resolveCaseElement(
  archive: ReceiptArchiveReader,
  emailExport: EmailExport,
  attrs: { start?: string; goal?: string; steps?: string },
): Promise<CaseResolution> {
  const start = parseRef(attrs.start);
  const startMessage: EmailMessage | undefined = emailExport.inbox.find(m => m.id === start.id);
  if (!startMessage || !startMessage.case_id) {
    return { status: 'unverifiable', reason: `start "${attrs.start ?? ''}" is not a loaded case email with a case_id.` };
  }
  const startCaseId = startMessage.case_id;
  const emailTime = parseTimestampSeconds(startMessage.received_at);
  if (emailTime === undefined) {
    return { status: 'unverifiable', reason: `start message "${start.id}" has an unparseable received_at.`, startCaseId };
  }
  // Effective start = max(email date, test-data load time). The case window
  // below (goal/step checks) uses the same value: a ticket from before the
  // test data existed cannot belong to this case.
  const loadedAt = parseTimestampSeconds(emailExport.simulation_load?.loaded_at);
  const startTime = loadedAt !== undefined ? Math.max(emailTime, loadedAt) : emailTime;
  const basis: CaseData['start']['basis'] = loadedAt === undefined ? 'load-unknown' : emailTime >= loadedAt ? 'email' : 'loaded';

  const goal = parseRef(attrs.goal);
  const goalCheck = await checkTicket(archive, goal.id);
  if (!goalCheck.ok) {
    return { status: 'unverifiable', reason: `goal: ${goalCheck.reason}`, startCaseId };
  }
  const goalReceipt = goalCheck.entry.receipt as Record<string, unknown>;
  const goalTime = typeof goalReceipt.timestamp === 'number' ? goalReceipt.timestamp : undefined;
  if (goalTime === undefined) {
    return { status: 'unverifiable', reason: `goal ticket "${goal.id}" has no numeric timestamp.`, startCaseId };
  }
  if (goalTime < startTime) {
    return { status: 'unverifiable', reason: `goal ticket "${goal.id}" is timestamped before start "${start.id}".`, startCaseId };
  }

  // Step tickets must each verify and lie inside [start, goal].
  const stepIds = parseStepRefs(attrs.steps);
  const steps: CaseData['steps'] = [];
  for (const stepId of stepIds) {
    const stepCheck = await checkTicket(archive, stepId);
    if (!stepCheck.ok) {
      return { status: 'unverifiable', reason: `step: ${stepCheck.reason}`, startCaseId };
    }
    const stepReceipt = stepCheck.entry.receipt as Record<string, unknown>;
    const stepTime = typeof stepReceipt.timestamp === 'number' ? stepReceipt.timestamp : undefined;
    if (stepTime === undefined || stepTime < startTime || stepTime > goalTime) {
      return { status: 'unverifiable', reason: `step ticket "${stepId}" is outside the case window [${startTime}, ${goalTime}].`, startCaseId };
    }
    steps.push({ ticketId: stepId, time: stepTime, action: stepReceipt.action, actionLabel: formatActionLabel(stepReceipt.action) });
  }

  // Goal-link check — only applies when the goal ticket is an email send.
  let warningReason: string | undefined;
  const sentForGoal = emailExport.sent.find(m => m.receipt_id === goal.id);
  if (sentForGoal) {
    const isReply = sentForGoal.in_reply_to === start.id;
    const recipients = parseRecipients(sentForGoal.to_json, sentForGoal.cc_json);
    const addressedToSender = recipients.includes(startMessage.from_email.toLowerCase());
    if (!isReply && !addressedToSender) {
      warningReason = 'goal link not confirmed';
    }
  }

  // Approvals — for the goal and every step that has one archived.
  const approvals: CaseApproval[] = [];
  for (const ticketId of [goal.id, ...stepIds]) {
    const approval = await resolveApprovalElement(archive, ticketId);
    if (approval.status === 'verified') {
      approvals.push({ ticketId, ...(approval.data as { who: string[]; createdAt?: number; decidedAt?: number; waitSeconds?: number }) });
    }
  }

  const timeline: TimelineEntry[] = [
    { type: 'start' as const, time: startTime, label: start.id },
    ...steps.map(s => ({ type: 'step' as const, time: s.time, label: s.ticketId })),
    ...approvals.map(a => ({ type: 'approval' as const, time: a.decidedAt ?? a.createdAt ?? 0, label: a.ticketId })),
    { type: 'goal' as const, time: goalTime, label: goal.id },
  ].sort((a, b) => a.time - b.time);

  return {
    status: warningReason ? 'warning' : 'verified',
    reason: warningReason,
    startCaseId,
    data: {
      caseId: startCaseId,
      start: {
        id: start.id, time: startTime, sender: startMessage.from_email, emailTime, basis,
        subject: startMessage.subject, receivedAt: startMessage.received_at,
        ...(emailExport.simulation_load?.loaded_at ? { loadedAt: emailExport.simulation_load.loaded_at } : {}),
      },
      goal: { ticketId: goal.id, time: goalTime, action: goalReceipt.action, actionLabel: formatActionLabel(goalReceipt.action) },
      steps,
      approvals,
      timeline,
      totalDurationSeconds: basis === 'load-unknown' ? null : goalTime - startTime,
      ...(basis === 'load-unknown' ? { timeUnverifiableReason: CASE_TIME_UNKNOWN_REASON } : {}),
    },
  };
}
