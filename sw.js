/* systemDesingo service worker — network-first so the app is never stale while
   online, with a cached fallback for offline. API calls are never touched. */
const CACHE = 'sd-v1';

self.addEventListener('install', function (e) {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never intercept POST/PUT/etc.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let cross-origin (fonts) pass through
  if (url.pathname.startsWith('/api/')) return;     // never cache the API

  e.respondWith((async function () {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.status === 200) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('/');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
