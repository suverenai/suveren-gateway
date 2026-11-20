/**
 * Notifications on this phone (device-keys plan 8 "Notifications", step 15, stage D4).
 *
 * - Turned on by the person, after the phone was added to the account: the permission prompt needs a tap (iOS asks
 *   only from one), so `turnOn` is called from a button, never on its own.
 * - The subscription goes to the Authority Server (`PUT /api/devices/me/push`); it sends one notification per waiting
 *   request this phone can read, payload `{ ids }` encrypted to this phone. The service worker (public/sw.js) shows a
 *   fixed, generic text (texts.ts `pushTitle`, `pushOne`, `pushMany`) and opens the app at the request; it records each
 *   id it was told about under {@link SEEN_KEY}.
 * - {@link PushControl.missed} counts the waiting requests that came without a notification since it was turned on
 *   (plan 8: grouped or over the hourly cap, or lost on the way).
 *
 * The Kv holds only public facts here: proposal ids and a time. Never content.
 */
import type { Kv } from './kv';
import type { AsApi } from './as-api';

/** Written by the service worker: the ids it was told about, newest last (at most {@link SEEN_MAX}). */
export const SEEN_KEY = 'push:seen';
/** When notifications were turned on (seconds). Requests older than that are not counted as missed. */
export const SINCE_KEY = 'push:since';
/** Set by the service worker when the browser replaced the subscription (`pushsubscriptionchange`): send it again. */
export const RESYNC_KEY = 'push:resync';
/** The person said "not now" to the offer on the requests screen. */
export const DISMISSED_KEY = 'push:offer-dismissed';
export const SEEN_MAX = 500;

export type PushState = 'unsupported' | 'denied' | 'off' | 'on';

/** The browser's subscription, as far as the app uses it. */
export interface SubscriptionLike {
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
  options?: { applicationServerKey?: ArrayBuffer | null };
}

/** The browser's push and notification APIs, so a test can stand in for them. */
export interface PushPlatform {
  supported(): boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  getSubscription(): Promise<SubscriptionLike | null>;
  subscribe(applicationServerKey: Uint8Array): Promise<SubscriptionLike>;
}

export type PushResult = { ok: true } | { ok: false; code: string };

const fromB64u = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The real platform: the service worker's PushManager and the Notification API. */
export function browserPushPlatform(): PushPlatform {
  const reg = () => navigator.serviceWorker.ready;
  return {
    supported: () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    getSubscription: async () => (await reg()).pushManager.getSubscription(),
    subscribe: async (key) => (await reg()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource }),
  };
}

function subscriptionBody(s: SubscriptionLike): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const j = s.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return null;
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } };
}

export class PushControl {
  constructor(private readonly d: { platform: PushPlatform; api: AsApi; kv: Kv; now: () => number }) {}

  async state(): Promise<PushState> {
    const p = this.d.platform;
    if (!p.supported()) return 'unsupported';
    if (p.permission() === 'denied') return 'denied';
    if (p.permission() !== 'granted') return 'off';
    const sub = await p.getSubscription().catch(() => null);
    return sub && (await this.d.kv.get(SINCE_KEY)) !== undefined ? 'on' : 'off';
  }

  /** From a tap: ask for the permission, subscribe with the AS's key, store the subscription at the AS. Never throws. */
  async turnOn(bearer: string): Promise<PushResult> {
    try {
      return await this.turnOnInner(bearer);
    } catch {
      return { ok: false, code: 'push_subscribe_failed' };
    }
  }

  /** Subscribe with the AS's current key (replacing one made with another key) and store it at the AS. */
  private async subscribeAndStore(bearer: string): Promise<PushResult> {
    const p = this.d.platform;
    const k = await this.d.api.pushKey();
    if (!k.ok) return { ok: false, code: k.code };
    let key: Uint8Array;
    try {
      key = fromB64u(k.data.key);
    } catch {
      return { ok: false, code: 'push_subscribe_failed' };
    }
    let sub = await p.getSubscription().catch(() => null);
    // A subscription made with another server key cannot be used for this one.
    const had = sub?.options?.applicationServerKey;
    if (sub && had && !sameBytes(new Uint8Array(had), key)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    try {
      sub ??= await p.subscribe(key);
    } catch {
      return { ok: false, code: 'push_subscribe_failed' };
    }
    const body = subscriptionBody(sub);
    if (!body) return { ok: false, code: 'push_subscribe_failed' };
    const r = await this.d.api.putPush(body, bearer);
    if (!r.ok) return { ok: false, code: r.code };
    return { ok: true };
  }

  private async turnOnInner(bearer: string): Promise<PushResult> {
    const p = this.d.platform;
    if (!p.supported()) return { ok: false, code: 'push_unsupported' };
    const perm = p.permission() === 'granted' ? 'granted' : await p.requestPermission();
    if (perm !== 'granted') return { ok: false, code: perm === 'denied' ? 'push_denied' : 'push_dismissed' };
    const r = await this.subscribeAndStore(bearer);
    if (!r.ok) return r;
    if ((await this.d.kv.get(SINCE_KEY)) === undefined) await this.d.kv.set(SINCE_KEY, this.d.now());
    return { ok: true };
  }

  /** From a tap: remove the subscription at the AS and in the browser. Never throws. */
  async turnOff(bearer: string): Promise<PushResult> {
    try {
      return await this.turnOffInner(bearer);
    } catch {
      return { ok: false, code: 'generic' };
    }
  }

  private async turnOffInner(bearer: string): Promise<PushResult> {
    const r = await this.d.api.deletePush(bearer);
    if (!r.ok) return { ok: false, code: r.code };
    const sub = await this.d.platform.getSubscription().catch(() => null);
    await sub?.unsubscribe().catch(() => false);
    await this.d.kv.delete(SINCE_KEY);
    return { ok: true };
  }

  /**
   * After a session opens: if the person turned notifications on (and the permission still holds), send the
   * subscription again: the browser may have renewed it (the service worker marks that), or the AS deleted it after a
   * 410. A subscription the browser dropped is made again. Quiet and never throws: a failure only means the next
   * session tries again.
   */
  async resync(bearer: string): Promise<void> {
    try {
      const p = this.d.platform;
      if (!p.supported() || p.permission() !== 'granted') return;
      if ((await this.d.kv.get(SINCE_KEY)) === undefined) return;
      const r = await this.subscribeAndStore(bearer);
      if (r.ok) await this.d.kv.delete(RESYNC_KEY);
    } catch {
      // the next session tries again
    }
  }

  /** Waiting requests, created since notifications were turned on, that no notification named. */
  async missed(waiting: ReadonlyArray<{ id: string; createdAt: number }>): Promise<number> {
    const since = await this.d.kv.get<number>(SINCE_KEY);
    if (since === undefined) return 0;
    const seen = new Set((await this.d.kv.get<string[]>(SEEN_KEY)) ?? []);
    return waiting.filter((w) => w.createdAt >= since && !seen.has(w.id)).length;
  }

  async offerDismissed(): Promise<boolean> {
    return (await this.d.kv.get(DISMISSED_KEY)) === true;
  }

  async dismissOffer(): Promise<void> {
    await this.d.kv.set(DISMISSED_KEY, true);
  }
}

/** The id of the request a notification opened the app at (`#request=<id>`), or null. */
export function requestFromHash(hash: string): string | null {
  const m = /^#request=([A-Za-z0-9_-]{1,128})$/.exec(hash);
  return m ? m[1] : null;
}
