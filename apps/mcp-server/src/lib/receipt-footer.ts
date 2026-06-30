/**
 * Verification footer — appends a "Verified by Suveren · <link>" line to the
 * content of communicative agent actions, so a recipient can confirm on
 * suveren.ai that the action was authorized (link-only / Level 1).
 *
 * Design (see doc/receipt-verification-implementation-plan.md):
 *  - Applies ONLY to Category-A "communicative" profiles: email, calendar, publish.
 *    CRM/records/charge get no footer.
 *  - The content field is AUTO-DETECTED from the tool's live input schema
 *    (body → text → description) — nothing hardcoded per integration, nothing in
 *    manifests. (Grounded: gmail=body, calendar=description, linkedin=text.)
 *  - Strip-and-replace: any existing Suveren footer is removed before appending,
 *    so it's idempotent AND an authorized edit regenerates the footer with its
 *    new receipt (live content ↔ current receipt).
 */

import { deriveIdentityLine, type Subject } from '@hap/core';
import type { DiscoveredTool } from './integration-manager';

const AS_BASE = (process.env.SUVEREN_AS_URL ?? 'https://www.suveren.ai').replace(/\/$/, '');

/** Operator display name for the footer ("verified by «operator»"). */
const OPERATOR_NAME = process.env.SUVEREN_OPERATOR_NAME ?? 'Suveren';

/** Communicative profiles — the only ones that get a footer. */
const FOOTER_PROFILES = new Set(['email', 'calendar', 'publish']);

/**
 * Content field auto-detection: first string property among these, in order.
 * `body`/`text`/`description` cover the live Category-A integrations
 * (gmail=body, linkedin=text, calendar=description); `content` is a common
 * fallback name and is last so the more specific names always win.
 */
const CONTENT_FIELD_CANDIDATES = ['body', 'text', 'description', 'content'];

/**
 * Stable strip anchor — the prefix common to every footer variant (low, and
 * `high`'s "…of «name» — verified by …"), so a prior footer is found and
 * replaced regardless of the identity disclosed.
 */
const FOOTER_MARKER = '— Sent by an AI agent';

/** v1: footer on for everyone (free-tier behavior). Hook for paid opt-out later. */
export function shouldAttachFooter(): boolean {
  return true;
}

function verifyUrl(receiptId: string): string {
  return `${AS_BASE}/r/${receiptId}`;
}

function footerText(receiptId: string, subject?: Subject): string {
  // deriveIdentityLine is the single source of truth: "Sent by an AI agent via
  // «operator»" at low, "…of «name» — verified by «operator»" at high.
  const line = deriveIdentityLine(subject, { operatorName: OPERATOR_NAME });
  return `\n\n— ${line}. Verify: ${verifyUrl(receiptId)}`;
}

function isStringType(t: unknown): boolean {
  return t === 'string' || (Array.isArray(t) && t.includes('string'));
}

/**
 * The arg that holds user-facing content, from the tool's input schema.
 * Exported so content binding (`kind:"text"`) resolves the SAME field the
 * footer appends to — one resolver, no drift between the two.
 */
export function detectContentField(tool: DiscoveredTool): string | null {
  const schema = tool.inputSchema as { properties?: Record<string, { type?: unknown }> } | undefined;
  const props = schema?.properties ?? {};
  for (const candidate of CONTENT_FIELD_CANDIDATES) {
    const prop = props[candidate];
    if (prop && isStringType(prop.type)) return candidate;
  }
  return null;
}

/** Remove a previously-appended Suveren footer (back through preceding blank lines). */
function stripFooter(value: string): string {
  const i = value.indexOf(FOOTER_MARKER);
  if (i === -1) return value;
  return value.slice(0, i).replace(/\n+$/, '');
}

/**
 * Return a copy of `args` with the verification footer appended to the detected
 * content field. Returns `args` unchanged when no footer applies: the tool's
 * profile isn't Category A, or no content field is detected (e.g. `send_draft`).
 */
export function appendVerificationFooter(
  tool: DiscoveredTool,
  args: Record<string, unknown>,
  receiptId: string,
  subject?: Subject,
): Record<string, unknown> {
  const profile = tool.gating?.profile;
  if (!profile || !FOOTER_PROFILES.has(profile)) return args;

  const field = detectContentField(tool);
  if (!field) return args;

  const current = typeof args[field] === 'string' ? (args[field] as string) : '';
  return { ...args, [field]: stripFooter(current) + footerText(receiptId, subject) };
}
