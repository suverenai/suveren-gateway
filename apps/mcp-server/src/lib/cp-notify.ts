/**
 * Tell the control plane that something now needs a human.
 *
 * The MCP server creates proposals by calling the Authority Server directly.
 * The control plane — which owns the SSE stream, the browser tab badge and the
 * desktop notification — is a separate process with an in-process event bus, so
 * without this call it never finds out. That is exactly how the v0.7.0
 * notification feature came to work in every test and never once in real use.
 *
 * Deliberately minimal:
 *
 * - **A type, and nothing else.** No tool name, no recipient, no amount. The
 *   whole notification path is "presence, never content"; this is the first
 *   link in it and the easiest place to quietly break the rule.
 * - **Fire and forget.** A proposal that was created successfully must not
 *   fail, or even be delayed, because a doorbell did not ring. Every error path
 *   here is a no-op.
 */

/*
 * The default MUST match the control plane's own default (index.ts: 3402).
 *
 * It did not, at first: this said 3400 — correct for the npm bundle, where
 * bundle/server.js sets SUVEREN_CP_PORT=3400 for both children — but in dev
 * nothing sets it, the control plane listens on its own default of 3402, and
 * every ping went to a port the dev stack does not serve. It failed silently,
 * because this call is fire-and-forget by design.
 *
 * Both sides deriving from the same default is the invariant. Where the env var
 * IS set (npm bundle, Docker) both processes receive the same value.
 */
const CP_PORT = process.env.SUVEREN_CP_PORT ?? '3402';
const CP_BASE = process.env.SUVEREN_CP_INTERNAL_URL ?? `http://127.0.0.1:${CP_PORT}`;
const TIMEOUT_MS = 2_000;

export type NotifiableEvent =
  | 'proposal-added'
  | 'action-approval-needed'
  | 'session-expired'
  | 'as-key-mismatch'
  | 'as-tls-mismatch'
  // An approved proposal's downstream tool call failed (isError or thrown)
  // AFTER the Authority Server already issued the ticket — see
  // commitments.ts. Presence only, like every other event here: the human
  // learns something failed, never what or how much.
  | 'execution-failed'
  // A refusal of a gated call was just appended to the denial log (AU2) —
  // local Gatekeeper refusal, Authority Server ticket refusal, simulation
  // block, or "no matching mandate". See denial-log.ts, the single place
  // every kind of denial funnels through. Deliberately NOT one of the
  // review/failure events the desktop doorbell reacts to — a block is
  // "nothing happened", not "something needs you" — so this exists only to
  // move the Blocked sidebar badge and an open Blocked page, never to ring
  // anything.
  | 'denial-recorded'
  // A ticket was just archived locally (UI spec §12): moves the Tickets
  // "new since your last visit" marks and the dashboard's "Done
  // automatically" column. Presence only, never content; not a doorbell
  // event either — a ticket is "something ran", not "something needs you".
  | 'ticket-recorded';

export async function notifyControlPlane(type: NotifiableEvent): Promise<void> {
  const secret = process.env.SUVEREN_INTERNAL_SECRET ?? '';
  // No secret means the pair was never wired together (e.g. a standalone MCP
  // server in a test). Stay silent rather than firing unauthenticated calls.
  if (!secret) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      await fetch(`${CP_BASE}/internal/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': secret,
        },
        body: JSON.stringify({ type }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // The control plane may legitimately be down (MCP started alone, restart in
    // progress). The proposal exists either way; the human will see it in the UI.
  }
}
