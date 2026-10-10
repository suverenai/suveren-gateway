/**
 * "Edit before signing" (DL6, temp/briefs/dl-delegation-brief.md) — the pure
 * parts of opening the mandate screen pre-filled from a pending
 * `setup__create_mandate` proposal's own arguments, instead of approving the
 * proposal as-is. Mirrors AuthorizationsPage.handleCopy (Copy/Edit), which
 * already prefills this same wizard from an EXISTING grant:
 *
 *  - the profile is resolved to the NEWEST version of its short name (never
 *    the proposal's own, possibly now-stale, profile id) via
 *    lib/profile-upgrade.ts `newestProfileOf`, and the proposed limits/scope
 *    are carried onto that version's schema with `carryBoundsForward` /
 *    `carryContextForward` — both reused as-is, not duplicated here;
 *  - the workspace is always the person's CURRENT active group, exactly as
 *    every other entry into this wizard works (AuthorizePicker, Copy/Edit) —
 *    never resolved from the proposal's own `team` argument, which may name
 *    a workspace this browser session is not even looking at. The component
 *    reads that from `useAuth()`, same as AuthorizePicker.
 *
 * This module only maps the proposal's OWN arguments (limits/scope/intent/
 * mode/duration) to the sessionStorage `agentGate` shape GateWizardPage and
 * AgentReviewPage already read (`gate.bounds`, `gate.context`,
 * `gate.gateContent.intent`, `gate.templateMode`, `gate.templateTtl` — the
 * same fields handleCopy writes). The async profile lookup and the actual
 * `sessionStorage`/`navigate` calls stay in the component — this module
 * never touches either, so every branch here is a plain function of its
 * arguments.
 */

/** The subset of `setup__create_mandate`'s own tool arguments this module
 *  reads — exactly the proposal's `toolArgs`, loosely typed since a proposal
 *  predates whatever validation ran at call time and nothing here should
 *  throw on a malformed value (an unreadable field is simply dropped, same
 *  as `scalarRecord`). */
export interface CreateMandateProposalArgs {
  team?: unknown;
  profile?: unknown;
  limits?: unknown;
  scope?: unknown;
  intent?: unknown;
  mode?: unknown;
  duration_hours?: unknown;
  title?: unknown;
}

export interface MandatePrefillGate {
  bounds: Record<string, string | number>;
  context: Record<string, string | number>;
  gateContent: { intent: string };
  /** Read by AgentReviewPage the same way Copy/Edit's `templateMode` is. */
  templateMode?: 'automatic' | 'review';
  /** Seconds — read by AgentReviewPage the same way Copy/Edit's `templateTtl` is. */
  templateTtl?: number;
}

/** A plain object's own string/number entries — anything else (an object, an
 *  array, a boolean) is dropped rather than carried into `bounds`/`context`,
 *  which are themselves flat string-or-number records. Not an object at all
 *  (including `undefined`) reads as "nothing proposed" (`{}`). */
export function scalarRecord(value: unknown): Record<string, string | number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

/**
 * Maps a pending `setup__create_mandate` proposal's own arguments to the
 * sessionStorage `agentGate` shape — everything EXCEPT the resolved profile
 * id itself (the caller fetches the live catalog and applies
 * `carryBoundsForward`/`carryContextForward` onto it, same as Copy/Edit,
 * so `bounds`/`context` here are the RAW proposed values, before that step).
 */
export function mandatePrefillGate(args: CreateMandateProposalArgs): MandatePrefillGate {
  const bounds = scalarRecord(args.limits);
  const context = scalarRecord(args.scope);
  const intent = typeof args.intent === 'string' ? args.intent : '';
  const gate: MandatePrefillGate = { bounds, context, gateContent: { intent } };
  if (args.mode === 'automatic' || args.mode === 'review') gate.templateMode = args.mode;
  if (typeof args.duration_hours === 'number' && args.duration_hours > 0) {
    gate.templateTtl = Math.round(args.duration_hours * 3600);
  }
  return gate;
}

/** Text passed to `spClient.rejectProposal` once the person has actually
 *  signed on the mandate screen (DL6 decision 6) — fixed, so every "Edit
 *  before signing" withdrawal reads the same, recognisable reason under
 *  Blocked/history. */
export const EDIT_BEFORE_SIGNING_WITHDRAWAL_REASON = 'Signed by the person on the mandate screen instead';

/**
 * Whether finishing the mandate screen should withdraw (reject) the
 * proposal "Edit before signing" opened it from. Only ever `true` for
 * `'signed'` — a cancelled visit or a failed sign leaves the proposal
 * exactly as it was (decision 6: "nothing is created until the person
 * signs there"), so there is never a moment where neither the proposal nor
 * a mandate exists.
 */
export type MandateScreenOutcome = 'signed' | 'cancelled' | 'failed';

export function shouldWithdrawProposalAfter(outcome: MandateScreenOutcome): boolean {
  return outcome === 'signed';
}
