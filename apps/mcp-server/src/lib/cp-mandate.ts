/**
 * Asks the control plane to check or create a mandate for the signed-in person
 * (POST /internal/mandate — control-plane routes/internal-mandate.ts). The
 * control plane holds the person's Authority Server session and runs the sign
 * page's steps; this process only relays the request.
 */
const CP_PORT = process.env.SUVEREN_CP_PORT ?? '3402';
const CP_BASE = process.env.SUVEREN_CP_INTERNAL_URL ?? `http://127.0.0.1:${CP_PORT}`;

export interface MandateResult {
  ok: boolean;
  /** Refusal or failure text, when !ok. */
  message?: string;
  /** Why the control plane refused, when it said (`profile_not_enabled`, `not_a_grantor`). */
  code?: string;
  authorizationId?: string;
  profileId?: string;
  groupName?: string;
  mode?: string;
  ttlSeconds?: number;
  /** A change's differences, computed from the signed old mandate. */
  diff?: unknown;
  /** The new mandate is live but the old one could not be revoked. */
  revokeError?: string;
  /** The old mandate is no longer honoured on this gateway (its revoke is retried). */
  oldStoppedLocally?: boolean;
  /** This computer cannot grant it (no Touch ID): it was sent to the person's phone and goes live with their touch there (DEC-90). */
}

export async function controlPlaneMandate(dryRun: boolean, request: Record<string, unknown>): Promise<MandateResult> {
  const secret = process.env.SUVEREN_INTERNAL_SECRET ?? '';
  if (!secret) return { ok: false, message: 'the gateway is not fully started (no control plane connection).' };
  try {
    const res = await fetch(`${CP_BASE}/internal/mandate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({ dryRun, request }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, ...(body as Omit<MandateResult, 'ok'>) };
    return {
      ok: false,
      message: typeof body.message === 'string' ? body.message : `control plane answered ${res.status}`,
      ...(typeof body.code === 'string' ? { code: body.code } : {}),
    };
  } catch (err) {
    return { ok: false, message: `the control plane could not be reached (${err instanceof Error ? err.message : String(err)}).` };
  }
}

/**
 * An AI proposed a mandate or a change: ask the control plane to prepare its give for the person's phone now (POST
 * /internal/mandate/offer), so the phone shows it in the request's place. Best effort: no answer changes the proposal.
 */
export async function controlPlaneMandateOffer(o: { proposalId: string; tool: 'create' | 'change'; args: Record<string, unknown>; old?: unknown }): Promise<{ ok: boolean; code?: string }> {
  const secret = process.env.SUVEREN_INTERNAL_SECRET ?? '';
  if (!secret) return { ok: false, code: 'no_control_plane' };
  try {
    const res = await fetch(`${CP_BASE}/internal/mandate/offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify(o),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: unknown; code?: unknown };
    const out = { ok: res.ok && body.ok === true, ...(typeof body.code === 'string' ? { code: body.code } : {}) };
    // Not offered: the card on the computer still gives it. Said once in the log, by code only (no content).
    if (!out.ok && out.code !== 'no_chain') console.warn(`[Suveren MCP] proposal ${o.proposalId}: not offered to the phone (${out.code ?? res.status})`);
    return out;
  } catch {
    return { ok: false, code: 'unreachable' };
  }
}
