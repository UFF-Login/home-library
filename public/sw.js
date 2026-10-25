// Service worker: keeps the shell installable and fast to open on a phone.
//
// Deliberately does NOT cache /api responses. A stale "you don't own this"
// answer would be worse than a spinner, and the app already keeps its own
// offline ISBN index in localStorage for the case that matters.
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/scanner.js',
  '/style.css',
  '/manifest.webmanifest',
  '/vendor/zxing.min.js',
];

const VERSION = 'v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
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
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});
