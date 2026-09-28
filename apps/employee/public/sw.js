/**
 * Service worker for the employee PWA (spec §1).
 *
 * Deliberately conservative. This app's whole value is live data, so nothing
 * from the API is ever served from cache — a cached ETA is worse than no ETA,
 * because the user cannot tell it is stale. Only the app shell is precached, so
 * the PWA opens instantly and can show an honest offline message.
 */

const VERSION = 'shuttle-v1';
const SHELL_CACHE = `${VERSION}-shell`;

/** Files that make the app openable. Kept small so install never stalls. */
const SHELL_ASSETS = [
  '/',
  '/offline',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/assets/wiwynn-logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll fails the whole install if any single request 404s, so add
      // individually and tolerate a miss.
      await Promise.allSettled(SHELL_ASSETS.map((asset) => cache.add(asset)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache the API or the socket: live data only.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // Cross-origin requests (the API on another port/host) are left alone.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, falling back to the cached shell so a tunnel or
  // a lift does not produce the browser's error page.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('/offline')) ??
            (await cache.match('/')) ??
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
          );
        }
      })(),
    );
    return;
  }

  // Static build output is content-hashed, so cache-first is safe and fast.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const hit = await cache.match(request);
        if (hit != null) return hit;

        const response = await fetch(request);
        if (response.ok) void cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});
