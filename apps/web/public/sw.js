// Minimal PWA service worker for ZenNotes Web.
//
// Strategy:
//   - App shell (HTML / JS / CSS bundles): cache-first after first load
//     so the PWA opens instantly and works offline for reads.
//   - API requests (/api/*): always hit the network; those responses
//     are not cached here (the IndexedDB layer inside the app can do
//     smarter per-note caching later).
//
// This file is deliberately small — Workbox or similar can replace it
// later without changing the UI.

const CACHE_NAME = 'zennotes-shell-v1'
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // Never cache API or websocket traffic.
  if (url.pathname.startsWith('/api/')) return

  // Same-origin assets: cache-first with background refresh.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type === 'basic') {
              const copy = res.clone()
              caches.open(CACHE_NAME).then((cache) => cache.put(req, copy))
            }
            return res
          })
          .catch(() => cached)
        return cached || network
      })
    )
  }
})
