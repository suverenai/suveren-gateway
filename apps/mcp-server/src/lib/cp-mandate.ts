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
  authorizationId?: string;
  profileId?: string;
  groupName?: string;
  mode?: string;
  ttlSeconds?: number;
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
    return { ok: false, message: typeof body.message === 'string' ? body.message : `control plane answered ${res.status}` };
  } catch (err) {
    return { ok: false, message: `the control plane could not be reached (${err instanceof Error ? err.message : String(err)}).` };
  }
}
