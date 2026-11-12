/**
 * Sealed arguments — the rule that nothing the approver did not see can change
 * what is sent.
 *
 * When a tool's content is sealed (the profile's content_binding applies to
 * it), the ticket commits to a hash of that content. Anything else the AI
 * passes that still changes what goes out — a thread id that makes the
 * connector add a subject and a quote of its own, a bcc, an image URL — is
 * outside the hash and outside the card. A manifest author cannot be trusted
 * to remember every such argument (`blockedArgs` lists only the holes already
 * found), so the rule is the other way round: EVERY argument must be
 *
 *   1. bound and shown       — in the binding's fields (or its content field),
 *   2. a declared reference  — shown on the card: the attachments argument,
 *                              `insert`, the source link, a mapped bound
 *                              (executionMapping), the gateway's own
 *                              `_source` / `ticket_id`,
 *   3. declared "not content" — the manifest's `nonContentArgs`
 *                              (ids, paging, flags that change nothing sent).
 *
 * Anything else is refused BEFORE any proposal or ticket.
 *
 * Generic: no connector, tool or field name appears here. The names come from
 * the manifest (gating) and the profile (binding).
 *
 * Which tools are sealed depends on the mandate's profile VERSION (email@0.4
 * binds the body only, email@0.9 binds recipients, subject, body and
 * attachments), so the rule takes the binding as an input.
 */
import { isFieldBinding, bindingAppliesTo, type ContentBinding } from '@hap/core';

/**
 * Arguments the gateway itself owns: `_source` is the AI's link to the one
 * record it acts on (read by the gateway, shown on the card), `ticket_id` is
 * overwritten by the gateway after the ticket is issued (content-binding.ts
 * `attachTicketId`), so whatever the AI passes never reaches the connector.
 */
export const GATEWAY_OWNED_ARGS: readonly string[] = ['_source', 'ticket_id'];

/** The `insert` argument is the reference list for `insertFields` (insert-values.ts). */
const INSERT_ARG = 'insert';

/** The slice of a tool's gating this rule reads. */
export interface SealedArgsGating {
  category?: string;
  staticExecution?: Record<string, unknown>;
  executionMapping?: Record<string, unknown>;
  contentField?: string;
  message?: { text: string; to?: string; cc?: string; subject?: string };
  attachmentsArg?: string;
  insertFields?: string[];
  sourceFromArg?: { arg: string };
  blockedArgs?: string[];
  nonContentArgs?: string[];
  sealedOnlyArgs?: string[];
}

export type ArgClass = 'bound' | 'reference' | 'not-content';

export interface SealedClassification {
  /** True when the rule applies: the tool's content is sealed by this binding and not wholly bound. */
  sealed: boolean;
  /** Why it does not apply, when `sealed` is false. */
  exempt?: 'not-a-write' | 'no-binding' | 'binding-not-applicable' | 'nothing-bound' | 'whole-payload';
  /** Argument name -> how it is classified (only meaningful when `sealed`). */
  classes: Map<string, ArgClass>;
}

/** Classify the arguments a sealed tool may carry, given the mandate profile's binding. */
export function classifySealedArgs(
  gating: SealedArgsGating,
  binding: ContentBinding | undefined,
): SealedClassification {
  const classes = new Map<string, ArgClass>();
  if (gating.category === 'read' || gating.category === 'disabled') {
    return { sealed: false, exempt: 'not-a-write', classes };
  }
  if (!binding) return { sealed: false, exempt: 'no-binding', classes };

  if (isFieldBinding(binding)) {
    const actionType = typeof gating.staticExecution?.action_type === 'string'
      ? gating.staticExecution.action_type
      : undefined;
    if (!bindingAppliesTo(binding, actionType)) {
      return { sealed: false, exempt: 'binding-not-applicable', classes };
    }
    for (const f of binding.fields ?? []) classes.set(f, 'bound');
  } else if (binding.kind === 'jcs') {
    // The whole record payload is hashed: every argument is bound.
    return { sealed: false, exempt: 'whole-payload', classes };
  } else {
    // text: only the content field is hashed (content-binding.ts).
    const field = gating.contentField ?? gating.message?.text;
    if (!field) return { sealed: false, exempt: 'nothing-bound', classes };
    classes.set(field, 'bound');
  }

  const ref = (name: string | undefined) => { if (name && !classes.has(name)) classes.set(name, 'reference'); };
  ref(gating.attachmentsArg);
  ref(gating.sourceFromArg?.arg);
  if (gating.insertFields?.length) ref(INSERT_ARG);
  // A mapped argument is a reference — unless the manifest declares it
  // sealed-only: then only the binding itself makes it allowed.
  const sealedOnly = new Set(gating.sealedOnlyArgs ?? []);
  for (const name of Object.keys(gating.executionMapping ?? {})) if (!sealedOnly.has(name)) ref(name);
  for (const name of GATEWAY_OWNED_ARGS) ref(name);
  for (const name of gating.nonContentArgs ?? []) if (!classes.has(name)) classes.set(name, 'not-content');
  return { sealed: true, classes };
}

/**
 * The arguments in `args` that are neither bound, a reference nor declared
 * not-content. Empty when the tool is not sealed under this binding.
 * (`blockedArgs` are refused earlier, by their own guard.)
 */
export function unclassifiedArgs(
  gating: SealedArgsGating,
  binding: ContentBinding | undefined,
  args: Record<string, unknown> | undefined,
): string[] {
  const c = classifySealedArgs(gating, binding);
  if (!c.sealed) return [];
  return Object.keys(args ?? {}).filter(a => !c.classes.has(a));
}

/** The neutral refusal text for the AI. Names the argument, never the content. */
export function sealedArgsRefusalText(toolName: string, offending: string[]): string {
  const names = offending.map(a => `"${a}"`).join(', ');
  return (
    `Refused: "${toolName}" was called with ${names}, which would change what is sent ` +
    `without being shown to the approver or sealed in the ticket. No ticket was requested. ` +
    `Call it again without ${offending.length === 1 ? 'that argument' : 'those arguments'}.`
  );
}
