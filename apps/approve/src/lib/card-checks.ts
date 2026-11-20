/**
 * The checks before a decision is offered (device-keys plan 8, "What the app verifies before it offers a decision"; build step 12).
 *
 * One call per card, run when the person opens a request and run again by the decider just before it signs. Every check is
 * made on this phone, from the bytes it holds, and the first one that fails names its reason and the card shows NO buttons:
 *
 *   1. pending       the request is still waiting
 *   2. content       the content opens with this phone's own key and hashes to the proposal's fingerprint (rule 8)
 *   3. context       the card context the gateway sealed opens, and belongs to this very proposal (its fingerprint is in the sealed data)
 *   4. mandate       the signed mandate of the request's authorization verifies under the Authority Server key this phone PINNED,
 *                    is not revoked or expired, and is the mandate the request names (profile)
 *   5. profile       the profile bytes the server gives hash to the mandate's `profile_hash`
 *   6. owner         the mandate's owner is this person's own identity (a colleague's mandate needs the owner's chain: stage B)
 *   7. action type   the request carries its action type, and the profile's registry (when it has one) contains it
 *   8. execution     the execution context rebuilt from the decrypted arguments with the mapping in the sealed context (numeric strings of
 *                    declared numeric fields parsed as the gateway parses them), reduced to the fields a bound reads, equals what the
 *                    request carries reduced the same way: the SAME fields with the SAME values. The card then draws the rebuilt values,
 *                    never the server's copy.
 *
 * KNOWN GAPS (not checked here; decided, listed so nobody assumes them):
 *   - the owner's grant of the mandate (plan 4.4): needs a browser-safe hap-core. The gateway that runs the action checks it (step 13).
 *   - a pin of the highest grant version (a rollback to an older grant is not noticed here).
 *   - M3: the proposal's profile id is compared with the mandate's, but nothing ties the request's `path`/`pendingDomains` to the mandate.
 *   - L2: the newest mandate is chosen by `issued_at` among those that verify, as the AS does; an older still-valid one is not asked about.
 *   - L3: a bound-read field produced by the manifest's STATIC execution (not by an argument) cannot be rebuilt: the sealed context
 *     carries the mapping only. Such a request shows `context_mismatch` and no buttons until the context carries those fields.
 *   - a colleague's mandate (needs the owner's chain): `owner_not_you`.
 *
 * Nothing here is stored. Content, context and arguments live in the returned object, which the screen drops with the card.
 */
import { jcs, sha256Hash, utf8 } from '@hap/core/device-keys';
import { mapExecutionArgs, coerceNumericFields, type MappingValue } from '@hap/core/execution-mapping';
import { readProposalHead } from '@hap/core/decision-input';
import type { Proposal } from '@suveren/approval-card/types';
import type { ToolDisplay, ApprovalView } from '@suveren/approval-card/lib/approval-view';
import type { AsApi } from './as-api';
import type { AccountStore } from './account-store';
import type { DeviceKeyStore } from './key-store';
import type { DeviceSession } from './session';
import { openContent, openContext, NoWrapError, ContentMismatchError, type CardContext, type ContentWire } from './content';
import { verifyMandateBlob, profileHashOf, wireFilter, type MandatePayloadView } from './mandate-check';

export type CardReason =
  | 'not_pending' | 'content_not_here' | 'content_unreadable' | 'content_mismatch'
  | 'context_missing' | 'context_unreadable' | 'context_mismatch'
  | 'mandate_unavailable' | 'mandate_invalid' | 'mandate_signature' | 'mandate_expired' | 'mandate_ended'
  | 'profile_unavailable' | 'profile_mismatch' | 'owner_not_you' | 'action_type_missing' | 'action_type_unknown'
  | 'session_ended' | 'reads_failed' | 'proposal_invalid';

/** Which of the Authority Server's routes carries this decision. */
export type DecisionRoute =
  | { kind: 'approver' }                                // above-cap approver: `approve` / `reject`
  | { kind: 'domain'; domain: string };                 // the proposal's own queue: `resolve` with `action` and `domain`

export interface ReadyCard {
  /** The mandate and the action type a decision names. */
  facts: { mandateId: string; actionType: string };
  /** The fingerprint of the content this phone opened and hashed itself: what the person sees is what is signed. */
  contentHash: string;
  /** The opened arguments, kept in memory for the card's lifetime only. */
  args: Record<string, unknown>;
  /** The execution context rebuilt from the arguments (bound-read fields only): what the card draws as "in the ticket". */
  executionContext: Record<string, string | number>;
  /** What the card shows the arguments with (labels, order, money), from the gateway's own sealed context. */
  display: ToolDisplay;
  route: DecisionRoute;
}

export type CardCheck = { ok: true; ready: ReadyCard } | { ok: false; reason: CardReason };

export interface CheckDeps {
  api: AsApi;
  session: DeviceSession;
  keys: DeviceKeyStore;
  accounts: AccountStore;
  now: () => number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const no = (reason: CardReason): CardCheck => ({ ok: false, reason });

/** The Authority Server's answer to a read, as a reason when it failed. */
function readFailure(r: { status: number; code: string }, session: DeviceSession): CardReason {
  if (r.status === 401 || r.code === 'SESSION_EXPIRED') { session.lost(); return 'session_ended'; }
  return 'reads_failed';
}

/** A mapping value the shared mapper may run on: a field name, an entry, or a list of entries; anything else is not a mapping. */
function isMapping(v: unknown): v is Record<string, MappingValue> {
  if (!isObj(v)) return false;
  const entry = (e: unknown): boolean => isObj(e) && typeof e.field === 'string' && e.field.length > 0;
  return Object.values(v).every((m) => typeof m === 'string' || entry(m) || (Array.isArray(m) && m.every(entry)));
}

/**
 * The card's layout from the display hints the gateway sealed (a connector's `display`, AU8): labels, order and money of top-level
 * arguments, and the AI-text argument. A hint that names an argument the request does not carry is dropped, and so is an `aiText` that
 * is not a non-empty string argument (that argument would otherwise leave the table and show nowhere). Hints about the preview's read
 * data (nested paths, attached reads) are ignored: this phone has no preview. A hint never hides an argument.
 */
export function toolDisplayOf(display: unknown, executionMapping: Record<string, MappingValue>, args: Record<string, unknown> = {}): ToolDisplay {
  const out: ToolDisplay = { executionMapping: executionMapping as ToolDisplay['executionMapping'] };
  if (!isObj(display)) return out;
  const top = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && !/[.[\]]/.test(k) && Object.prototype.hasOwnProperty.call(args, k);
  const labels = isObj(display.labels) ? display.labels : {};
  const order = Array.isArray(display.order) ? display.order.filter(top) : [];
  const money = new Set(Array.isArray(display.money) ? display.money.filter(top) : []);
  const view: ApprovalView = {};
  for (const k of [...order, ...Object.keys(labels).filter(top), ...money]) {
    if (k in view) continue;
    const label = typeof labels[k] === 'string' ? (labels[k] as string) : undefined;
    view[k] = {
      ...(label ? { label } : {}),
      ...(money.has(k) ? { kind: 'money' as const, ...(top(display.currencyField) ? { currencyArg: display.currencyField } : {}) } : {}),
    };
  }
  if (Object.keys(view).length) out.approvalView = view;
  if (top(display.aiText) && typeof args[display.aiText] === 'string' && (args[display.aiText] as string).length > 0) out.aiTextArg = display.aiText;
  return out;
}

/** Which route decides this proposal for this person (`pendingApprovers` names them: above-cap; else their own queue). */
export function routeFor(proposal: Proposal, userId: string): DecisionRoute | null {
  if ((proposal.pendingApprovers ?? []).includes(userId)) return { kind: 'approver' };
  const domains = proposal.pendingDomains ?? [];
  // The Personal domain is the account id or the placeholder `owner` (the AS accepts both for the owner).
  const domain = domains.includes(userId) ? userId : domains.includes('owner') ? 'owner' : domains[0];
  return domain ? { kind: 'domain', domain } : null;
}

export async function checkCard(d: CheckDeps, proposal: Proposal): Promise<CardCheck> {
  const bearer = d.session.bearer();
  const open = d.session.current();
  const account = await d.accounts.read();
  if (!bearer || !open || !account) return no('session_ended');

  // 1. the request is the one asked for and still waits
  const head = readProposalHead(proposal, proposal.id);
  if (!head.ok) return no(head.code === 'proposal_not_pending' ? 'not_pending' : 'proposal_invalid');
  const route = routeFor(proposal, open.user.id);
  if (!route) return no('proposal_invalid');

  // 2. the content, opened with this phone's key, must hash to the proposal's fingerprint
  const wire = proposal.content as unknown as ContentWire | undefined;
  if (!wire) return no('content_unreadable');
  let args: Record<string, unknown>;
  try {
    const { plaintext } = await openContent(wire, account.key_id, d.keys);
    args = JSON.parse(plaintext) as Record<string, unknown>;
    // `openContent` compared with the fingerprint named INSIDE the content; a decision names the PROPOSAL's.
    if ((await sha256Hash(utf8(jcs(args)))) !== head.head.contentHash) return no('content_mismatch');
  } catch (e) {
    return no(e instanceof NoWrapError ? 'content_not_here' : e instanceof ContentMismatchError ? 'content_mismatch' : 'content_unreadable');
  }

  // 3. the card context
  const ctx = await openContext(wire, account.key_id, d.keys);
  if (ctx === null) return no('context_missing');
  if ('contextError' in ctx) return no('context_unreadable');
  const context: CardContext = ctx.context;
  if (!isMapping(context.execution_mapping)) return no('context_unreadable');

  // 4. the signed mandate
  const mandates = await d.api.mandates(proposal.authorizationId, bearer);
  if (!mandates.ok) return no(readFailure(mandates, d.session));
  if (mandates.data.revoked) return no('mandate_ended');
  const blobs = (Array.isArray(mandates.data.mandates) ? mandates.data.mandates : [])
    .map((m) => (isObj(m) && typeof m.blob === 'string' ? m.blob : null)).filter((b): b is string => b !== null);
  if (blobs.length === 0) return no('mandate_unavailable');
  let payload: MandatePayloadView | null = null;
  let firstFailure: CardReason = 'mandate_invalid';
  let failed = false;
  for (const blob of blobs) {
    const v = await verifyMandateBlob(blob, account.as_key, d.now());
    if (!v.ok) { if (!failed) { firstFailure = v.code; failed = true; } continue; }
    // The AS checks a decision against the most recently issued mandate: so does this phone.
    if (!payload || v.payload.issued_at > payload.issued_at) payload = v.payload;
  }
  if (!payload) return no(firstFailure);
  if (payload.profile_id !== proposal.profileId) return no('mandate_invalid');

  // 5. the profile bytes
  const profile = await d.api.profile(payload.profile_id);
  if (!profile.ok) return no(profile.status === 404 ? 'profile_unavailable' : 'reads_failed');
  if ((await profileHashOf(profile.data)) !== payload.profile_hash) return no('profile_mismatch');

  // 6. the owner is this person (the decider set: the owner; a colleague's mandate needs the owner's chain, stage B)
  if (payload.mandate_owners[0].did !== account.root_did) return no('owner_not_you');

  // 7. the action type
  const actionType = head.head.actionType;
  if (!actionType) return no('action_type_missing');
  const registry = (profile.data as { boundsSchema?: { actionTypes?: unknown } } | null)?.boundsSchema?.actionTypes;
  if (Array.isArray(registry) && registry.length > 0 && !registry.includes(actionType)) return no('action_type_unknown');

  // 8. the execution context, rebuilt exactly as the gateway builds it, and reduced to what a bound reads on both sides
  let rebuilt: Record<string, string | number>;
  try {
    const mapped = mapExecutionArgs(context.execution_mapping, args);
    coerceNumericFields(profile.data, mapped);
    rebuilt = wireFilter(mapped, profile.data) as Record<string, string | number>;
  } catch {
    return no('context_unreadable');
  }
  const carried = wireFilter(isObj(proposal.executionContext) ? proposal.executionContext : {}, profile.data);
  const rk = Object.keys(rebuilt).sort();
  const ck = Object.keys(carried).sort();
  if (rk.length !== ck.length || rk.some((k, i) => k !== ck[i] || carried[k] !== rebuilt[k])) return no('context_mismatch');

  return {
    ok: true,
    ready: { facts: { mandateId: payload.mandate_id, actionType }, contentHash: head.head.contentHash, args, executionContext: rebuilt, display: toolDisplayOf(context.display, context.execution_mapping, args), route },
  };
}
