/**
 * Verification footer — appends a "Verified by Suveren · <link>" line to the
 * content of communicative agent actions, so a recipient can confirm on
 * suveren.ai that the action was authorized (link-only / Level 1).
 *
 * Design (see doc/receipt-verification-implementation-plan.md):
 *  - Applies to a tool IFF it declares `gating.message` (tool-gating-
 *    types.ts's `MessageGatingDeclaration`) — a manifest declaration, not a
 *    hardcoded profile allowlist. A tool with no human-readable text (a
 *    delete, a read) simply omits `message` and gets no footer.
 *  - The content field and the presentation verb ("Sent"/"Published") come
 *    straight from that declaration (`message.text`/`message.verb`) —
 *    nothing guessed from a fixed prose vocabulary, nothing hardcoded per
 *    connector/profile in this file.
 *  - Strip-and-replace: any existing Suveren footer is removed before appending,
 *    so it's idempotent AND an authorized edit regenerates the footer with its
 *    new receipt (live content ↔ current receipt).
 */

import { deriveIdentityLine, type Subject } from '@hap/core';
import type { DiscoveredTool } from './integration-manager';

// Env-only default so this module stays disk-free and independently
// testable (see receipt-footer.test.ts, which never sets SUVEREN_DATA_DIR
// and must not go looking for a real ~/.suveren/config.json). The real
// process (bin/http.ts) resolves the full precedence chain — env > saved
// config > default — via as-config.ts ONCE at startup and injects it here
// with setAsBaseUrl, so the footer's link and the resolver never disagree.
let AS_BASE = (process.env.SUVEREN_AS_URL ?? 'https://www.suveren.ai').replace(/\/$/, '');

/** Set once at process startup (bin/http.ts) to the fully-resolved AS URL. */
export function setAsBaseUrl(url: string): void {
  AS_BASE = url.replace(/\/$/, '');
}

// TODO(public-verification): once suveren.ai's public check page ships (see
// doc/self-hosted-as.md §9), the footer's link should switch from
// `<AS>/t/<id>` to the public-stamp form (`https://suveren.ai/v#<stamp>`) so
// a self-hosted customer's internal AS URL is never handed to an outside
// recipient who can't reach it. That is a separate, later step — not this
// one — and needs the AS to seal a redacted "public stamp" alongside the
// receipt (§9.1). Leaving today's `<AS>/t/<id>` link in place until then.
//
// v0.7 wire switch: the public page moved from /r/:id to /t/:id. /r/:id
// still answers (a permanent 308 redirect, for links already sent/published
// before this switch — unlike the internal API's hard 410), but a NEW
// footer links straight to the canonical path.

/** Operator display name for the footer ("verified by «operator»"). */
const OPERATOR_NAME = process.env.SUVEREN_OPERATOR_NAME ?? 'Suveren';

/**
 * Strip anchor — matches an already-appended Suveren footer through the end of
 * the content, regardless of identity variant, verb (Sent/Published), or
 * separator (legacy em-dash "—" or the current ASCII "--"). Used to remove a
 * prior footer before appending a fresh one (idempotent + regenerates on edit).
 */
// Matches BOTH footer wordings so verification/strip works across versions
// forever: v1 "…by an AI agent of «name»" (and the no-name "…by an AI agent
// via …"), and v1.1 "…by «name»'s AI agent". Already-sent content keeps its
// original footer; never retro-change it.
const FOOTER_RE = /\n*(?:—|--) (?:Sent|Published) by (?:an AI agent|[^\n]+?'s AI agent)[\s\S]*$/;

/** v1: footer on for everyone (free-tier behavior). Hook for paid opt-out later. */
export function shouldAttachFooter(): boolean {
  return true;
}

function receiptUrl(receiptId: string): string {
  return `${AS_BASE}/t/${receiptId}`;
}

function footerText(receiptId: string, verb: string, subject?: Subject): string {
  // deriveIdentityLine (hap-core) is the source of truth for the assurance
  // wording. It leads with "Sent …"; swap the verb for the channel. Full plain
  // URLs (no <a>) so links work across email / calendar / publishing.
  const identity = deriveIdentityLine(subject, { operatorName: OPERATOR_NAME }).replace(/^Sent\b/, verb);
  // One line only (Andreas 2026-10-21: the HAP promotion line was too much).
  return `\n\n-- ${identity}. Ticket: ${receiptUrl(receiptId)}`;
}

/**
 * The arg that holds user-facing content — the tool's own declared
 * `gating.message.text` (tool-gating-types.ts's `MessageGatingDeclaration`),
 * or `null` when the tool declares no `message` at all (nothing to footer or
 * auto-bind). Exported so content binding (`kind:"text"`) resolves the SAME
 * field the footer appends to — one resolver, no drift between the two.
 */
export function detectContentField(tool: DiscoveredTool): string | null {
  return tool.gating?.message?.text ?? null;
}

/** Remove a previously-appended Suveren footer (back through preceding blank lines). */
function stripFooter(value: string): string {
  return value.replace(FOOTER_RE, '').replace(/\n+$/, '');
}

/**
 * Return a copy of `args` with the verification footer appended to the
 * declared content field. Returns `args` unchanged when no footer applies:
 * the tool declares no `gating.message` at all (e.g. `send_draft`, a delete,
 * any non-communicative tool).
 */
export function appendVerificationFooter(
  tool: DiscoveredTool,
  args: Record<string, unknown>,
  receiptId: string,
  subject?: Subject,
): Record<string, unknown> {
  const message = tool.gating?.message;
  if (!message) return args;

  const field = message.text;
  const current = typeof args[field] === 'string' ? (args[field] as string) : '';
  return { ...args, [field]: stripFooter(current) + footerText(receiptId, message.verb, subject) };
}
