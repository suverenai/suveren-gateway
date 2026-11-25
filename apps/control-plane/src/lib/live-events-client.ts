/**
 * The gateway's live connection to the Authority Server (0.46.1, DEC-107).
 *
 * One outbound stream, `GET /api/events` (Server-Sent Events), held by the control plane with its ordinary AS
 * session. The server says WHAT changed (a kind and an id, never content); the gateway then reads that the ordinary
 * way. While the stream is up, the page and the MCP server stop asking every few seconds and keep only a 5-minute
 * backup (`onStatus`). The stream ends itself every few minutes by design (the server's maxStreamS); the client
 * reconnects at once and reports `resync` so everything is read once to catch up.
 *
 * Offered or not is the server's choice: a 404 (an AS without live events, or with SUVEREN_LIVE_EVENTS off) means
 * "keep polling as before", re-checked every 5 minutes. A gateway that is locked or signed out does not connect.
 */

export type LiveKind = 'proposal' | 'mandates' | 'devices' | 'team' | 'resync';
const KINDS: ReadonlySet<string> = new Set(['proposal', 'mandates', 'devices', 'team', 'resync']);

export interface LiveEventsDeps {
  /** True while the gateway may talk to the AS (unlocked, signed in). */
  ready: () => boolean;
  /** Open the stream: the AS fetch with this process's session, TLS pin and a long bound. */
  open: (signal: AbortSignal) => Promise<Response>;
  /** A change the server announced. `id` is the proposal or mandate id when the server names one. */
  onChange: (kind: LiveKind, id: string | null) => void;
  /** The stream came up (true) or went away (false). */
  onStatus: (up: boolean) => void;
  log?: (line: string) => void;
  /** Tests only. */
  sleep?: (ms: number) => Promise<void>;
}

export const NOT_OFFERED_RECHECK_MS = 5 * 60_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

export class LiveEventsClient {
  private stopped = true;
  private up = false;
  private abort: AbortController | null = null;
  private failures = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private wake: (() => void) | null = null;

  constructor(private readonly deps: LiveEventsDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      (t as { unref?: () => void }).unref?.();
      this.wake = () => { clearTimeout(t); resolve(); };
    }));
  }

  get isUp(): boolean { return this.up; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.wake?.();
    this.setUp(false);
  }

  /** Reconnect now (e.g. right after sign-in) instead of waiting out a backoff. */
  poke(): void { this.wake?.(); }

  private setUp(up: boolean): void {
    if (this.up === up) return;
    this.up = up;
    try { this.deps.onStatus(up); } catch { /* a listener's failure must not stop the stream */ }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (!this.deps.ready()) {
        this.setUp(false);
        await this.sleep(2_000);
        continue;
      }
      const began = Date.now();
      const outcome = await this.once();
      if (this.stopped) break;
      if (outcome === 'ended') {
        // A planned end: reconnect at once — but never in a tight loop if a server ends streams immediately.
        this.failures = 0;
        if (Date.now() - began < 5_000) await this.sleep(1_000);
        continue;
      }
      if (outcome === 'not-offered') { this.setUp(false); this.failures = 0; await this.sleep(NOT_OFFERED_RECHECK_MS); continue; }
      this.setUp(false);
      await this.sleep(BACKOFF_MS[Math.min(this.failures++, BACKOFF_MS.length - 1)]);
    }
  }

  /** One connection: 'ended' (the server closed it, as planned), 'not-offered' (404) or 'failed'. */
  private async once(): Promise<'ended' | 'not-offered' | 'failed'> {
    const ac = new AbortController();
    this.abort = ac;
    // Locked or signed out while the stream is open: close it (the session behind it is no longer this gateway's).
    const guard = setInterval(() => { if (!this.deps.ready()) ac.abort(); }, 2_000);
    (guard as { unref?: () => void }).unref?.();
    let res: Response;
    try {
      res = await this.deps.open(ac.signal);
    } catch (err) {
      clearInterval(guard);
      this.deps.log?.(`[Control Plane] live events: could not connect (${err instanceof Error ? err.message : String(err)})`);
      return 'failed';
    }
    if (res.status === 404) { clearInterval(guard); await res.body?.cancel().catch(() => {}); return 'not-offered'; }
    if (!res.ok || !res.body) { clearInterval(guard); await res.body?.cancel().catch(() => {}); return 'failed'; }
    let gotHello = false;
    try {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const ev = parseFrame(frame);
          if (!ev) continue;
          if (ev.event === 'hello') {
            gotHello = true;
            this.failures = 0;
            this.setUp(true);
            // Connected (or reconnected): read everything once — something may have changed while no stream was open.
            this.deps.onChange('resync', null);
          } else if (ev.event === 'change' && gotHello) {
            const c = parseChange(ev.data);
            if (c) this.deps.onChange(c.kind, c.id);
          }
        }
      }
      return gotHello ? 'ended' : 'failed';
    } catch {
      return gotHello && !this.stopped ? 'ended' : 'failed';
    } finally {
      clearInterval(guard);
      this.abort = null;
    }
  }
}

function parseFrame(frame: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (event === 'message' && data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/** Only known kinds and a plain id string pass — nothing else from the server reaches the gateway. */
export function parseChange(data: string): { kind: LiveKind; id: string | null } | null {
  try {
    const p = JSON.parse(data) as { t?: unknown; i?: unknown };
    if (typeof p.t !== 'string' || !KINDS.has(p.t)) return null;
    const id = typeof p.i === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(p.i) ? p.i : null;
    return { kind: p.t as LiveKind, id };
  } catch {
    return null;
  }
}
