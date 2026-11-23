// Service worker of the phone approval app (device-keys plan section 8, "Updates").
//
// It keeps the app's own static files (the shell) so the app opens without a network, and fetches a new
// version in the background: a file is answered from the cache at once and refreshed behind it, so a new
// version is used from the next start. It does not call skipWaiting().
//
// It never touches the Authority Server: only same-origin GET requests are handled, and the server is another
// origin. It never stores decrypted content (the app never hands it any) and no response of a signed-in call.
// Push (stage D4): see the end of this file.
const CACHE = 'suveren-approve-shell-v1';

self.addEventListener('install', () => {
  // No precache list: the built files have hashed names, so the cache fills as they are fetched.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Every page request is the one shell page.
  const key = req.mode === 'navigate' ? new Request('/') : req;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    const refresh = fetch(req).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    });
    if (cached) {
      event.waitUntil(refresh.catch(() => undefined));
      return cached;
    }
    return refresh;
  })());
});

// ─── Push (stage D4, device-keys plan 8 "Notifications") ──────────────────────────────────────────────────────────
//
// The Authority Server sends `{ "ids": [<request id>, ...] }`, encrypted to this phone; the browser decrypts it. The
// text shown is fixed and generic: no name, no amount, no "Approve" action (F14). Tapping opens the app at the request
// (one id) or at the list. Each id is recorded so the app can count requests that came without a notice.
// The words are a copy of texts.ts (`pushTitle`, `pushOne`, `pushMany`, `pushDevicesChanged`, `pushRecoveryStarted`,
// `pushIdentityReset`); texts.test.ts fails when they drift.
// BEGIN PUSH TEXTS
const PUSH_TEXT = {
  title: 'Suveren',
  one: 'A request is waiting for you.',
  many: '{n} requests are waiting for you.',
  devicesChanged: 'Your devices changed. Open Suveren to see what changed.',
  recoveryStarted: 'Someone started a change with your recovery code. If this was not you, open Suveren now.',
  identityReset: 'Someone asked for a new identity for your account. If this was not you, open Suveren now.',
};
// END PUSH TEXTS
const SEEN_KEY = 'push:seen';
const SEEN_MAX = 500;
const ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

function idsOf(event) {
  try {
    const body = event.data ? event.data.json() : null;
    const ids = body && Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string' && ID_SHAPE.test(x)) : [];
    return ids.slice(0, 100);
  } catch {
    return [];
  }
}

// The app's own IndexedDB store (src/lib/idb.ts: database `suveren-approve`, store `kv`).
function kvUpdate(key, fn) {
  return new Promise((resolve) => {
    const r = indexedDB.open('suveren-approve', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); };
    r.onerror = () => resolve();
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const get = store.get(key);
      get.onsuccess = () => store.put(fn(get.result), key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); resolve(); };
    };
  });
}

const TAG = 'suveren-waiting';

// A device notice (`{ "notice": <kind> }`): the device list changed, a recovery was started with the recovery code, or a
// new identity was asked for. Its own tag and a fixed text per kind; nothing from the message is shown. A tap opens Devices.
const NOTICE_TAG = 'suveren-devices';
const NOTICE_TEXT = { 'devices-changed': 'devicesChanged', 'recovery-started': 'recoveryStarted', 'identity-reset': 'identityReset' };
function noticeOf(event) {
  try {
    const body = event.data ? event.data.json() : null;
    return body && typeof body.notice === 'string' && Object.prototype.hasOwnProperty.call(NOTICE_TEXT, body.notice) ? body.notice : null;
  } catch {
    return null;
  }
}

async function tellOpenWindows(message) {
  try {
    for (const w of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (new URL(w.url).origin === self.location.origin) w.postMessage(message);
    }
  } catch {
    // nothing open, or not allowed: the app reads its list at its next refresh
  }
}

self.addEventListener('push', (event) => {
  const notice = noticeOf(event);
  if (notice) {
    event.waitUntil(self.registration.showNotification(PUSH_TEXT.title, {
      body: PUSH_TEXT[NOTICE_TEXT[notice]], tag: NOTICE_TAG, renotify: true, icon: '/icons/icon-192.png', data: { devices: true },
    }));
    return;
  }
  const ids = idsOf(event);
  event.waitUntil((async () => {
    // One notice at a time (one tag): a new one replaces the one still shown, so it carries that one's ids too and a
    // tap opens the list when more than one request waits.
    let shown = [];
    try {
      for (const n of await self.registration.getNotifications({ tag: TAG })) {
        const prev = n.data && Array.isArray(n.data.ids) ? n.data.ids : [];
        shown = shown.concat(prev.filter((x) => typeof x === 'string' && ID_SHAPE.test(x)));
      }
    } catch {
      shown = [];
    }
    const all = [...new Set([...shown, ...ids])].slice(-100);
    // A push without a notice is not allowed (userVisibleOnly): even an unreadable message shows the generic one.
    const body = all.length > 1 ? PUSH_TEXT.many.replace('{n}', String(all.length)) : PUSH_TEXT.one;
    await Promise.all([
      kvUpdate(SEEN_KEY, (old) => [...(Array.isArray(old) ? old : []).filter((x) => !ids.includes(x)), ...ids].slice(-SEEN_MAX)),
      self.registration.showNotification(PUSH_TEXT.title, { body, tag: TAG, renotify: true, icon: '/icons/icon-192.png', data: { ids: all } }),
      // An open app reads its list again at once (no ids: it reads them itself, with its own session).
      tellOpenWindows({ t: 'pushed' }),
    ]);
  })());
});

// The browser replaced or dropped the subscription. The worker has no session (the token lives in the app's memory
// only), so it subscribes again where it can and marks the app to send the subscription to suveren.ai at its next
// session (lib/push.ts RESYNC_KEY, PushControl.resync).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
      if (!event.newSubscription && key) await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch {
      // the app's next session subscribes again
    }
    await kvUpdate('push:resync', () => true);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const devices = Boolean(event.notification.data && event.notification.data.devices);
  const ids = (event.notification.data && event.notification.data.ids) || [];
  const target = devices ? '/#devices' : ids.length === 1 ? `/#request=${ids[0]}` : '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      await w.focus();
      w.postMessage(devices ? { t: 'open-devices' } : { t: 'open-request', id: ids.length === 1 ? ids[0] : null });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
