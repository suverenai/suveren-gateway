/**
 * Reads that hang or cannot reach the server are tried again instead of leaving a page on "Loading..." forever.
 *
 * A reload is no way out: the key lives only in memory, so a reload means signing in again. Only plain reads go
 * through here, so a retry can never do anything twice. One silent second try; after that the person is told
 * (ConnectionNotice) and one shared timer drives every waiting read, so there is one countdown and one burst.
 * Identical reads share one try, so a page that polls during an outage does not pile up new ones.
 */

export const ATTEMPT_TIMEOUT_MS = 15_000;
export const WAIT_BETWEEN_TRIES_MS = 15_000;

/** Gateway answers that mean "the server did not answer", not "the server said no". */
const UNREACHABLE_STATUS = new Set([502, 503, 504]);

/** Reads that may legitimately take long (a whole export, a file) keep their own behaviour. */
export function isRetriableRead(path: string): boolean {
  return path.startsWith('/api/') && !path.includes('export') && !path.includes('attachment-preview');
}

export interface ConnectionState {
  /** At least one read could not reach the server and is being tried again. */
  waiting: boolean;
  /** When the next try starts; null while a try is running. */
  nextTryAt: number | null;
}

const ALL_CLEAR: ConnectionState = { waiting: false, nextTryAt: null };

export class SignedOutDuringRetry extends Error {
  constructor() { super('Signed out while waiting for the server'); }
}

export class UnreachableRetry {
  private state: ConnectionState = ALL_CLEAR;
  private listeners = new Set<() => void>();
  private inFlight = new Map<string, Promise<Response>>();
  private waitingPaths = new Set<string>();
  private releases: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getState = (): ConnectionState => this.state;

  private set(next: ConnectionState): void {
    if (next.waiting === this.state.waiting && next.nextTryAt === this.state.nextTryAt) return;
    this.state = next.waiting ? next : ALL_CLEAR;
    this.listeners.forEach((l) => l());
  }

  /** One read, tried until it is answered. Every caller gets its own readable copy of the response. */
  read(path: string, attempt: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    let shared = this.inFlight.get(path);
    if (!shared) {
      shared = this.tryUntilAnswered(path, attempt).finally(() => { this.inFlight.delete(path); });
      this.inFlight.set(path, shared);
    }
    return shared.then((res) => res.clone());
  }

  /** The person pressed "Try now". */
  tryNow = (): void => { this.releaseWaiters(); };

  /** Signed out: nobody is waiting for these answers any more. */
  cancelAll(): void {
    this.generation += 1;
    this.waitingPaths.clear();
    this.releaseWaiters();
    this.set(ALL_CLEAR);
  }

  private async tryUntilAnswered(path: string, attempt: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const generation = this.generation;
    for (let failures = 0; ; ) {
      const res = await this.tryOnce(attempt);
      if (generation !== this.generation) throw new SignedOutDuringRetry();
      if (res) {
        this.waitingPaths.delete(path);
        if (this.waitingPaths.size === 0) this.finishWaiting();
        return res;
      }
      failures += 1;
      if (failures === 1) continue; // one silent second try: most hangs end here
      this.waitingPaths.add(path);
      await this.untilNextTry();
      if (generation !== this.generation) throw new SignedOutDuringRetry();
    }
  }

  /** The response, or null when the server did not answer. */
  private async tryOnce(attempt: (signal: AbortSignal) => Promise<Response>): Promise<Response | null> {
    const controller = new AbortController();
    const limit = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await attempt(controller.signal);
      return UNREACHABLE_STATUS.has(res.status) ? null : res;
    } catch {
      return null; // timed out, or the gateway itself is unreachable
    } finally {
      clearTimeout(limit);
    }
  }

  private untilNextTry(): Promise<void> {
    return new Promise((resolve) => {
      this.releases.push(resolve);
      if (!this.timer) this.armTimer();
    });
  }

  private armTimer(): void {
    this.set({ waiting: true, nextTryAt: Date.now() + WAIT_BETWEEN_TRIES_MS });
    this.timer = setTimeout(() => {
      this.timer = null;
      // A tab nobody is looking at costs nothing: it waits here and tries once it is visible.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { this.armTimer(); return; }
      this.releaseWaiters();
    }, WAIT_BETWEEN_TRIES_MS);
  }

  private releaseWaiters(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const releases = this.releases;
    this.releases = [];
    if (this.state.waiting) this.set({ waiting: true, nextTryAt: null });
    releases.forEach((release) => release());
  }

  private finishWaiting(): void {
    if (this.releases.length > 0) return; // others still wait for the next try
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.set(ALL_CLEAR);
  }
}

export const unreachableRetry = new UnreachableRetry();
