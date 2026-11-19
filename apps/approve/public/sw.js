// Service worker of the phone approval app (device-keys plan section 8, "Updates").
//
// It keeps the app's own static files (the shell) so the app opens without a network, and fetches a new
// version in the background: a file is answered from the cache at once and refreshed behind it, so a new
// version is used from the next start. It does not call skipWaiting().
//
// It never touches the Authority Server: only same-origin GET requests are handled, and the server is another
// origin. It never stores decrypted content (the app never hands it any) and no response of a signed-in call.
// Push (stage D4) is not here yet.
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
