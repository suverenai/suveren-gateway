/**
 * WS4 (work-plan "Added 2026-10-11 — an account is Personal OR in one
 * team"): a managed gateway is locked to one team by IT policy (`Team`,
 * lib/policy.ts) — see docs/managed-settings.md. Two uses:
 *
 *  - At sign-in (routes/auth.ts): refuse before the session is established
 *    unless the account's active workspace IS that team.
 *  - While signed in (index.ts, {@link ManagedTeamScheduler}): a coarse
 *    periodic check catches the account leaving/being removed from the
 *    team in the browser — the Authority Server has no channel to PUSH
 *    this to the gateway, so the gateway polls instead, same reasoning as
 *    session-expiry-scheduler.ts's coarse timer.
 *
 * Both read the SAME fact: `GET /api/groups/me`'s `group.id` — the
 * account's ACTIVE team, or null when it is Personal. `Team` is always an
 * id (never a name — names are not unique across accounts, see
 * lib/policy.ts's doc comment), so the comparison is exact string equality,
 * no normalization.
 */
import { fetchAs, type AsFetchPinning } from './as-tls-pin';

/**
 * The account's active TEAM id (never Personal) — null when it has none.
 * Throws on any network/HTTP/shape failure so each call site decides for
 * itself how to treat "could not check" (sign-in refuses either way;
 * the periodic check deliberately does NOT, to avoid locking a working
 * session over a transient network blip — see ManagedTeamScheduler).
 */
export async function activeTeamId(
  asUrl: string,
  cookie: string,
  pinning: AsFetchPinning,
): Promise<string | null> {
  const { res } = await fetchAs(
    `${asUrl}/api/groups/me`,
    { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10_000) },
    pinning,
  );
  if (!res.ok) throw new Error(`GET /api/groups/me answered ${res.status}`);
  const data = (await res.json()) as { group?: { id?: string } | null };
  return data.group?.id ?? null;
}

export interface ManagedTeamSchedulerOptions {
  /** How often the periodic check runs. Default 5 minutes — same cadence
   *  as session-expiry-scheduler.ts's coarse safety net. */
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/**
 * Runs `check` on a coarse interval. The check itself (index.ts's wiring)
 * is responsible for reading the CURRENT session state each time — this
 * class only owns the timer, so there is nothing here that goes stale
 * across a login/logout/lock.
 */
export class ManagedTeamScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly intervalMs: number;

  constructor(
    private readonly check: () => void | Promise<void>,
    opts: ManagedTeamSchedulerOptions = {},
  ) {
    this.setIntervalFn = opts.setIntervalFn ?? setInterval;
    this.clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
    this.intervalMs = opts.intervalMs ?? 5 * 60_000;
  }

  start(): void {
    if (this.timer) return; // already started
    this.timer = this.setIntervalFn(() => {
      void this.check();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  /** Test-only: run the check immediately, bypassing the timer. */
  runNow(): void | Promise<void> {
    return this.check();
  }
}
