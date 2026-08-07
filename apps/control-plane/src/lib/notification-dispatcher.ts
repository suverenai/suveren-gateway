/**
 * Desktop notifications for pending reviews.
 *
 * A doorbell, not a decision surface. It says that something is waiting; it
 * never says what, and it carries no approve/deny action. Two reasons, both
 * load-bearing:
 *
 * 1. **Content stays out.** OS notifications appear on lock screens and persist
 *    in notification databases. A proposal title or an amount there would leak
 *    exactly what the Authority Server is careful never to see. Everything below
 *    is a fixed literal — nothing agent-authored reaches this text, which also
 *    means there is nothing for an agent to inject into.
 * 2. **No action button, ever.** An approve button here would create an approval
 *    path outside the UI's context, and would give an agent flooding proposals a
 *    reflex target to train. The absence of that button IS the mitigation; the
 *    batching below only reduces the noise.
 *
 * Strings are English-only by choice: they are host-OS chrome, the gateway ships
 * no locale preference, and a mistranslated security prompt is worse than an
 * English one.
 */

import { eventBus, type EventType } from './event-bus';
import { notify } from './desktop-notify';
import { readSettings } from './gateway-settings';

/** Events that mean "a human now has something to decide". */
const TRIGGER_EVENTS: EventType[] = ['proposal-added', 'action-approval-needed'];

const TITLE = 'Suveren';

/*
 * No count in the message.
 *
 * The control plane proxies proposal mutations but caches nothing — it has no
 * view of how many items are pending, and inventing one would mean an
 * unattended authenticated call to the Authority Server on the CP's own behalf,
 * which is not something it does anywhere else. The badge in the UI carries the
 * count; a doorbell does not need to say how many people are outside.
 */
const WAITING_MESSAGE = 'Something is waiting for your review.';

/**
 * A flood is an anomaly, not just noise. Fifty requests in a minute is a broken
 * agent or a hostile one, and it should not arrive in the same tone as one. This
 * stays within the content rule: it reports presence and a count of events this
 * process observed — never what any of them were.
 */
const FLOOD_THRESHOLD = 10;
const floodMessage = (n: number) => `Unusual volume: ${n} requests in the last minute.`;

const DEBOUNCE_MS = 5_000;
const COOLDOWN_MS = 60_000;

export interface DispatcherOptions {
  /** Where a click should land. Best-effort: only macOS+terminal-notifier can attach it. */
  url?: string;
  /** Overridable for tests. */
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  notifyFn?: typeof notify;
  settingsFn?: typeof readSettings;
}

/**
 * Batching, stated plainly because the interaction gets reported as a bug
 * otherwise:
 *
 * - Events within a 5s window collapse into one notification.
 * - At most one notification per 60s. Events during the cooldown set a flag;
 *   when the cooldown ends, one summary fires.
 * - So: a proposal at t=0 notifies at t=5s. A second at t=10s produces nothing
 *   until t=60s. That is intended — the tab badge covers the gap, and the point
 *   is to keep the desktop quiet enough that a notification still means
 *   something.
 */
export class NotificationDispatcher {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWhileCoolingDown = false;
  /** Events observed since the current window opened — the flood signal only. */
  private observedInWindow = 0;
  private unsubscribe: (() => void) | null = null;

  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly notifyFn: typeof notify;
  private readonly settingsFn: typeof readSettings;
  private readonly url?: string;

  constructor(opts: DispatcherOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.notifyFn = opts.notifyFn ?? notify;
    this.settingsFn = opts.settingsFn ?? readSettings;
    this.url = opts.url;
  }

  /** Subscribe to the bus. Returns a stop function. */
  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe;
    const off = eventBus.subscribe(event => {
      if (TRIGGER_EVENTS.includes(event.type)) this.onTrigger();
    });
    this.unsubscribe = () => {
      off();
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
      this.debounceTimer = null;
      this.cooldownTimer = null;
      this.unsubscribe = null;
    };
    return this.unsubscribe;
  }

  /** Exposed for tests; the bus subscription calls this. */
  onTrigger(): void {
    this.observedInWindow += 1;

    if (this.cooldownTimer) {
      // Inside the quiet period — remember that something happened.
      this.pendingWhileCoolingDown = true;
      return;
    }
    if (this.debounceTimer) return; // window already open

    this.debounceTimer = this.setTimeoutFn(() => {
      this.debounceTimer = null;
      this.fire();
    }, DEBOUNCE_MS);
  }

  private fire(): void {
    const count = this.observedInWindow;
    this.observedInWindow = 0;

    // Checked at fire time, not at subscribe time, so toggling the setting
    // takes effect without restarting the gateway.
    let enabled = true;
    try {
      enabled = this.settingsFn().desktopNotifications;
    } catch {
      enabled = true; // a broken preferences file must not silence the doorbell
    }

    console.error(
      `[Control Plane] Review pending — desktop notification ${enabled ? 'sent' : 'suppressed (turned off)'}`,
    );

    if (enabled) {
      const message = count >= FLOOD_THRESHOLD ? floodMessage(count) : WAITING_MESSAGE;
      // notify() never throws and never blocks: a missing notify-send, a denied
      // macOS permission or a locked-down PowerShell must not affect the gateway.
      this.notifyFn(TITLE, message, process.platform, this.url);
    }

    // Open the quiet period regardless of whether anything was shown, so
    // toggling the setting cannot be used to change the rate limiting.
    this.cooldownTimer = this.setTimeoutFn(() => {
      this.cooldownTimer = null;
      if (this.pendingWhileCoolingDown) {
        this.pendingWhileCoolingDown = false;
        this.fire();
      }
    }, COOLDOWN_MS);
  }
}

/** Convenience for index.ts: build, subscribe, and hand back the stop function. */
export function startNotificationDispatcher(opts: DispatcherOptions = {}): () => void {
  return new NotificationDispatcher(opts).start();
}
