// Service worker: makes the app installable and able to open without a network.
//
// Deliberately NOT cache-first. Cache-first served a phone the previous version
// of style.css after an update and left the login screen stuck on top of the
// app - the exact failure this rewrite fixes. Network-first keeps one deploy
// meaning one refresh, and the cache is used only when the network is gone.
//
// /api and /cover are never intercepted: a stale "you don't own this" answer
// would be worse than a spinner, and the app keeps its own offline ISBN index
// in localStorage for the case that matters.
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/scanner.js',
  '/style.css',
  '/manifest.webmanifest',
  '/vendor/zxing.min.js',
];

const VERSION = 'v5';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

// A waiting worker can be told to take over immediately (pull to refresh does
// this), otherwise a phone could sit on the old build until every tab closes.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Versioned assets are immutable for a given build, so the network handles
  // them: no cache lookup, no fallback, nothing a stale worker can corrupt.
  if (url.pathname.startsWith('/v/')) return;

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cover/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      // The offline fallback must only ever answer a NAVIGATION with HTML.
      // Returning index.html for a failed /app.js request made the browser parse
      // HTML as JavaScript, which produced a completely blank page.
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') return caches.match('/index.html');
          return Response.error();
        }),
      ),
  );
});
