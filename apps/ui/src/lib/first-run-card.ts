/**
 * The dashboard's first-run card — one card, three backend-truth steps, shown
 * while the person has no mandate besides (maybe) Delegation and hasn't
 * finished all three steps. Pure derivation; see components/FirstRunCard.tsx
 * for the rendering and hooks/useManaged.ts + useSimulationMode.ts for the
 * two inputs it doesn't already have from the dashboard's own data.
 *
 * Steps 1 and 2 are independent — either can be done first (a person might
 * connect their AI before or after giving the Delegation mandate, or IT might
 * set up the connection separately). Step 3 can't realistically be done
 * before both, but its completion is still checked independently (a proposal
 * either arrived or it didn't) rather than assumed from ordering. Only the
 * FIRST not-done step (by index) is ever "open" — the rest render as a single
 * muted line, so the card never asks for more than one thing at a time.
 */
export type FlowStepStatus = 'done' | 'open' | 'todo';
export type FirstRunVariant = 'self' | 'managed';

export interface FirstRunCardInput {
  /** Has any AI client ever completed an MCP handshake with this gateway? */
  hasContact: boolean;
  /** Does the person hold an active mandate for the Delegation profile? */
  hasDelegationMandate: boolean;
  /** Active mandates OTHER than Delegation. The card only shows at zero —
   *  once there's a real mandate, this is no longer a first-run dashboard. */
  otherMandateCount: number;
  /** Proposals ever raised under the Delegation profile, pending or decided. */
  delegationProposalCount: number;
  /** IT policy present (any locked key) — see hooks/useManaged.ts. */
  managed: boolean;
  /** Gateway-wide simulation mode — Delegation can only be given while this
   *  is on (apps/mcp-server/src/lib/builtins/setup.ts). */
  simulationOn: boolean;
}

export interface FirstRunStepState {
  status: FlowStepStatus;
  /** Set only when status is 'open'. */
  variant?: FirstRunVariant;
  /** Step 2 only, when status is 'open': can the button be used right now,
   *  or must the card explain that Delegation needs simulation mode? */
  simulationOn?: boolean;
}

export interface FirstRunCardState {
  /** False once there's another mandate, or all three steps are done — the
   *  card is removed entirely rather than lingering as a "well done" screen. */
  visible: boolean;
  step1: FirstRunStepState;
  step2: FirstRunStepState;
  step3: FirstRunStepState;
}

export function deriveFirstRunCard(input: FirstRunCardInput): FirstRunCardState {
  const done = [input.hasContact, input.hasDelegationMandate, input.delegationProposalCount > 0];
  const allDone = done.every(Boolean);
  const visible = input.otherMandateCount === 0 && !allDone;
  const firstOpenIndex = done.findIndex((d) => !d);
  const variant: FirstRunVariant = input.managed ? 'managed' : 'self';

  const stepAt = (i: number): FirstRunStepState => {
    if (done[i]) return { status: 'done' };
    if (i !== firstOpenIndex) return { status: 'todo' };
    if (i === 1) return { status: 'open', variant, simulationOn: input.simulationOn };
    if (i === 0) return { status: 'open', variant };
    return { status: 'open' }; // step 3 has no self/managed variant
  };

  return {
    visible,
    step1: stepAt(0),
    step2: stepAt(1),
    step3: stepAt(2),
  };
}
