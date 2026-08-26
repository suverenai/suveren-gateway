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
 * Built from `allowed_*` execution-context fields, which is where every profile
 * puts the values checked against the grant's context. Profile-agnostic by
 * construction: no field names, no per-connector cases. Profiles with no scope
 * dimension (records has none) correctly produce nothing rather than filler.
 */
export function scopeSummary(receipt: ExecutionReceipt): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(receipt.executionContext ?? {})) {
    if (!key.startsWith('allowed_')) continue;
    const text = String(value ?? '').trim();
    if (!text) continue;
    parts.push(text.split(',').map(v => v.trim()).filter(Boolean).join(', '));
  }
  return parts.join(' · ');
}

/**
 * What the GRANT permits — as opposed to `scopeSummary`, which reports what
 * this one call touched. Built from the grant's local context values, which
 * exist only on this machine (the AS holds `context_hash` alone).
 *
 * `action_type` is dropped: it is the bounds category, already carried by the
 * headline, and reads as noise next to the dimensions a person chose.
 */
export function allowedSummary(context: Record<string, string | number> | undefined): string {
  if (!context) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (key === 'action_type') continue;
    const text = String(value ?? '').trim();
    if (!text) continue;
    const label = key.replace(/^allowed_/, '').replace(/_/g, ' ');
    parts.push(`${label} ${text.split(',').map(v => v.trim()).filter(Boolean).join(', ')}`);
  }
  return parts.join(' · ');
}

/**
 * Consumption paired with the limit it consumes — "2 of 5 today", never a bare
 * "2 calls". A count on its own says nothing about how close the agent is to
 * the ceiling the human set, which is the only reason to show it.
 *
 * Which bound governs is read from the bounds keys, preferring one that starts
 * with this receipt's `actionType` (a grant may carry several windows, e.g.
 * `release_daily_max` beside `write_daily_max`). Amount-shaped bounds pair with
 * the summed amount; everything else counts calls. With no matching bound the
 * raw count is shown rather than a fabricated denominator.
 */
export function usageSummary(
  receipt: ExecutionReceipt,
  bounds: Record<string, string | number> | undefined,
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

  const parts: string[] = [];
  for (const { window, label } of windows) {
    const state = receipt.cumulativeState?.[window];
    if (!state) continue;

    const suffix = `_${window}_max`;
    const keys = Object.keys(bounds ?? {}).filter(k => k.endsWith(suffix));
    // Prefer the bound for THIS action type; otherwise the only one present.
    const key =
      (actionType && keys.find(k => k.startsWith(`${actionType}_`))) ??
      (keys.length === 1 ? keys[0] : undefined);

    const isAmount = key ? /^(amount|spend)_/.test(key) : false;
    const used = isAmount ? state.amount : state.count;
    const limit = key ? Number(bounds?.[key]) : NaN;

    if (key && Number.isFinite(limit)) {
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
