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
// The words are a copy of texts.ts (`pushTitle`, `pushOne`, `pushMany`); texts.test.ts fails when they drift.
// BEGIN PUSH TEXTS
const PUSH_TEXT = {
  title: 'Suveren',
  one: 'A request is waiting for you.',
  many: '{n} requests are waiting for you.',
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

self.addEventListener('push', (event) => {
  const ids = idsOf(event);
  // A push without a notice is not allowed (userVisibleOnly): even an unreadable message shows the generic one.
  const body = ids.length > 1 ? PUSH_TEXT.many.replace('{n}', String(ids.length)) : PUSH_TEXT.one;
  event.waitUntil(Promise.all([
    kvUpdate(SEEN_KEY, (old) => [...(Array.isArray(old) ? old : []).filter((x) => !ids.includes(x)), ...ids].slice(-SEEN_MAX)),
    self.registration.showNotification(PUSH_TEXT.title, {
      body,
      tag: 'suveren-waiting',
      renotify: true,
      icon: '/icons/icon-192.png',
      data: { ids },
    }),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const ids = (event.notification.data && event.notification.data.ids) || [];
  const target = ids.length === 1 ? `/#request=${ids[0]}` : '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      await w.focus();
      w.postMessage({ t: 'open-request', id: ids.length === 1 ? ids[0] : null });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
