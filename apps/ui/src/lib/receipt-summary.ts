/**
 * Turning a receipt into something a human can scan.
 *
 * The audit list used to lead with three machine identifiers — the profile URL
 * (the widest thing on the row, and identical on every card), the namespaced
 * tool name, and an attestation hash. Nowhere did it say *an email went to
 * these two people*, which is the only question most people open this page to
 * answer.
 *
 * Two constraints shape what is possible here:
 *
 * 1. **A receipt carries no content.** By design it holds `executionContext`
 *    (the scope the Gatekeeper checked) and never the tool arguments. So a
 *    summary can say who a message went to, because recipients are scope — and
 *    can never say what it said, or name the record that was written.
 *
 * 2. **The action label must be declared, not guessed.** Gmail's `send_message`
 *    and `create_draft` both carry `action_type: "send"`, so deriving a label
 *    from the action type alone would report a saved draft as a sent email.
 *    Connectors therefore name their own actions; an undeclared tool falls back
 *    to something dull and true rather than fluent and wrong.
 */

import type { AgentProfile, ProfileBoundsField } from '@hap/core';
import type { ExecutionReceipt, IntegrationManifest } from './sp-client';
import { profileDisplayName } from './profile-display';

/** `gmail__send_message` → `{ integrationId: 'gmail', toolName: 'send_message' }`. */
export function splitAction(action: string): { integrationId: string; toolName: string } {
  const sep = action.indexOf('__');
  if (sep < 0) return { integrationId: '', toolName: action };
  return { integrationId: action.slice(0, sep), toolName: action.slice(sep + 2) };
}

/**
 * A plain-language name for what happened, e.g. "Email sent".
 *
 * Read from the connector manifest's per-tool `actionLabel`. When a tool has
 * not declared one, fall back to "<Profile> · <action_type>" — deliberately
 * flat, because a receipt that misdescribes an action is worse than one that
 * describes it drily.
 */
export function actionLabel(
  receipt: ExecutionReceipt,
  manifests: IntegrationManifest[],
): string {
  const { integrationId, toolName } = splitAction(receipt.action);
  const manifest = manifests.find(m => m.id === integrationId);
  const override = manifest?.toolGating?.overrides?.[toolName] as
    | { actionLabel?: string }
    | null
    | undefined;
  if (override?.actionLabel) return override.actionLabel;

  const profile = profileDisplayName(receipt.profileId);
  const actionType = receipt.executionContext?.action_type;
  return typeof actionType === 'string' && actionType
    ? `${profile} · ${actionType}`
    : `${profile} · ${toolName}`;
}

/**
 * The one line worth reading under the headline: the SCOPE this action ran
 * within — who it went to, which environment, which calendar.
 *
 * Which execution-context keys ARE scope is read from the profile's scope
 * schema (its field keys, declared there — not guessed from the key's shape:
 * `charge`'s scope fields are `currency`/`action_type`, with no `allowed_`
 * prefix at all). Without a profile (old grant, unknown id) there is nothing
 * to read that from, so nothing is shown — never a guess from the key's shape.
 */
export function scopeSummary(receipt: ExecutionReceipt, profile?: AgentProfile | null): string {
  const scopeFields = profile?.scopeSchema?.fields;
  if (!scopeFields) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(receipt.executionContext ?? {})) {
    if (!(key in scopeFields)) continue;
    const text = String(value ?? '').trim();
    if (!text) continue;
    parts.push(text.split(',').map(v => v.trim()).filter(Boolean).join(', '));
  }
  return parts.join(' · ');
}

/**
 * What the GRANT permits — as opposed to `scopeSummary`, which reports what
 * this one call touched. Built from the grant's local context values, which
 * exist only on this machine (the AS holds `scope_hash` alone).
 *
 * Labels come from the profile's scope schema `displayName` — never from
 * stripping a presumed `allowed_` prefix off the key, which is not a rule
 * every profile follows. Without the profile (old grant, unknown id) the
 * plain key is shown: honest, never a guess at what it means.
 *
 * `action_type` is dropped: it is the bounds category, already carried by the
 * headline, and reads as noise next to the dimensions a person chose.
 */
export function allowedSummary(
  context: Record<string, string | number> | undefined,
  profile?: AgentProfile | null,
): string {
  if (!context) return '';
  const scopeFields = profile?.scopeSchema?.fields ?? {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (key === 'action_type') continue;
    const text = String(value ?? '').trim();
    if (!text) continue;
    const label = scopeFields[key]?.displayName ?? key;
    parts.push(`${label} ${text.split(',').map(v => v.trim()).filter(Boolean).join(', ')}`);
  }
  return parts.join(' · ');
}

/**
 * Which action types a cumulative bound governs — `appliesTo` when declared;
 * otherwise every action type (protocol.md → Bounds Schema rule 7: absence on
 * a `cumulative_sum` bound, or on any bound in a pre-v0.7 profile, means "all").
 * Never a field-name suffix. hap-core exports the same read as
 * `boundActionTypes`, but its ESM bundle imports `node:crypto` at module level
 * (see lib/frame.ts) and cannot be pulled into this browser bundle even for
 * one unrelated function — so this is a deliberately minimal, browser-safe
 * copy of just the `appliesTo` read, with none of hap-core's own legacy
 * name-suffix fallback for pre-registry profiles (that fallback is itself the
 * pattern this rule forbids, so it has no place in the UI's display code).
 */
function cumulativeAppliesTo(fieldDef: ProfileBoundsField): readonly string[] | undefined {
  return fieldDef.appliesTo;
}

/**
 * Consumption paired with the limit it consumes — "2 of 5 today", never a bare
 * "2 calls". A count on its own says nothing about how close the agent is to
 * the ceiling the human set, which is the only reason to show it.
 *
 * Which bound governs is read from the profile's bounds schema: `boundType.kind`
 * says whether a field is a window bound at all and whether it pairs with the
 * summed amount (`cumulative_sum`) or the call count (`cumulative_count`);
 * `boundType.window` says which window; `appliesTo` says which action types it
 * governs — never a field-name suffix (HAP v0.7 Bounds Schema rule 3: a bound
 * named `weekly_cap` with `window: "daily"` is a DAILY bound, whatever its name
 * says). Without the profile there is no `boundType` to read, so no bound can
 * be identified — the bare call count is shown rather than a guess.
 */
export function usageSummary(
  receipt: ExecutionReceipt,
  bounds: Record<string, string | number> | undefined,
  profile?: AgentProfile | null,
): string {
  const windows: Array<{ window: 'daily' | 'monthly'; label: string }> = [
    { window: 'daily', label: 'today' },
    { window: 'monthly', label: 'this month' },
  ];
  const actionType =
    receipt.actionType ??
    (typeof receipt.executionContext?.action_type === 'string'
      ? (receipt.executionContext.action_type as string)
      : undefined);

  const boundsFields = profile?.boundsSchema?.fields;

  const parts: string[] = [];
  for (const { window, label } of windows) {
    const state = receipt.cumulativeState?.[window];
    if (!state) continue;

    let chosen: { key: string; isAmount: boolean } | undefined;
    if (boundsFields && bounds) {
      const candidates = Object.entries(boundsFields).filter(([key, def]) => {
        if (!(key in bounds)) return false;
        const bt = def.boundType;
        if (!bt || (bt.kind !== 'cumulative_sum' && bt.kind !== 'cumulative_count')) return false;
        if (bt.window !== window) return false;
        const governs = cumulativeAppliesTo(def);
        return !governs || !actionType || governs.includes(actionType);
      });
      // Prefer one declared for THIS action type; otherwise the only one present.
      const named = actionType
        ? candidates.find(([, def]) => cumulativeAppliesTo(def)?.includes(actionType))
        : undefined;
      const pick = named ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (pick) chosen = { key: pick[0], isAmount: pick[1].boundType?.kind === 'cumulative_sum' };
    }

    const used = chosen ? (chosen.isAmount ? state.amount : state.count) : undefined;
    const limit = chosen ? Number(bounds?.[chosen.key]) : NaN;

    if (chosen && Number.isFinite(limit)) {
      parts.push(`${used} of ${limit} ${label}`);
    } else {
      parts.push(`${state.count} ${state.count === 1 ? 'call' : 'calls'} ${label}`);
    }
  }
  return parts.join(' · ');
}

/** Review-mode receipts reference the proposal a human approved. */
export function wasReviewed(receipt: ExecutionReceipt): boolean {
  return typeof receipt.proposalId === 'string' && receipt.proposalId.length > 0;
}

/** `…/email@0.5` → `email@0.5`; the version is worth showing since 0.5 binds recipients. */
export function profileVersionLabel(profileId: string): string {
  const short = profileDisplayName(profileId);
  const version = profileId.split('@')[1];
  return version ? `${short}@${version}` : short;
}
