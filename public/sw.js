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

const VERSION = 'v2';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
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
      .catch(() => caches.match(request).then((cached) => cached ?? caches.match('/index.html'))),
  );
});
