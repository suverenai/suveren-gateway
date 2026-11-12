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
 *  - The gateway's own trailing footer is removed when a call ARRIVES (an
 *    edit carrying the old one, e.g. a calendar description), before the
 *    card and the content hash; at send the footer is only appended. Any
 *    other line that looks like the mark is refused (markLikeLine).
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
 * The gateway's OWN footer, exactly as it writes it (and has written it), at
 * the very end of a text — nothing else. Line-anchored: it starts on a line
 * of its own, after the text.
 *
 *   now:        "\n\n-- <identity>. Ticket: <AS>/t/<id>"
 *   before:     the same with "Receipt:" and /r/<id>, followed by a second
 *               line "\n\n-- <operator> … Human Agency Protocol …" (two
 *               wordings of that line were shipped)
 *   first:      "\n\n— Sent by an AI agent via <operator>. Verify: <AS>/r/<id>"
 *
 * <identity> is hap-core's deriveIdentityLine ("Sent by an AI agent via X",
 * "Sent by N's AI agent, verified by X", older "…an AI agent of N…") with the
 * verb swapped to "Published" on publishing tools — always one line. Group 1
 * is the ticket id the footer names.
 *
 * Replaces the earlier greedy anchor that removed everything from the first
 * footer-like text to the end, including approved text after it.
 */
const OWN_TRAILING_FOOTER_RE =
  /(?:^|\n+)(?:—|--) (?:Sent|Published) by [^\n]+?\. (?:Ticket|Receipt|Verify): https?:\/\/[^\s]+?\/[rt]\/([A-Za-z0-9_-]+)(?:\n+-- [^\n]*Human Agency Protocol[^\n]*)?[ \t]*\n*$/;

/**
 * A line that starts like the gateway's mark ("-- Sent by …", "— Published by
 * …"), at the start of a line. A quoted line ("> -- Sent by …") does not.
 */
const MARK_LIKE_LINE_RE = /^[ \t]*(?:—|--) (?:Sent|Published) by\b.*$/m;

/**
 * Remove the gateway's own trailing footer (see OWN_TRAILING_FOOTER_RE) and
 * the blank lines before it. Text with no such footer is returned unchanged.
 * Applied when a call ARRIVES, before the card and the content hash — never
 * at send — so the text approved, hashed and sent is one text.
 */
export function stripOwnTrailingFooter(value: string): string {
  return OWN_TRAILING_FOOTER_RE.test(value) ? value.replace(OWN_TRAILING_FOOTER_RE, '') : value;
}

/** The first line of `value` that starts like the gateway's mark, or null. */
export function markLikeLine(value: string): string | null {
  const m = MARK_LIKE_LINE_RE.exec(value);
  return m ? m[0].trim() : null;
}

/** The AI-facing refusal for a text that carries a mark-like line of its own. */
export function markLikeLineRefusalText(toolName: string, field: string, line: string): string {
  const shown = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  return `Refused: the "${field}" of ${toolName} contains a line that looks like the gateway's AI mark: "${shown}". ` +
    `Remove that line from the text. The gateway adds the mark itself, once, at the end; the AI adds no mark or footer of its own. ` +
    `Nothing ran and no ticket was requested.`;
}

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
  // Append only. Any earlier footer of the gateway's own was removed when the
  // call arrived (stripOwnTrailingFooter), before the card and the hash.
  return { ...args, [field]: current + footerText(receiptId, message.verb, subject) };
}
