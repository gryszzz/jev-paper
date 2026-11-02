/* JEV Paper SW — network-first shell, cache fallback offline */
const CACHE = 'jev-paper-v18-20261102';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css?v=18',
  '/floor.js?v=18',
  '/app.js?v=18',
  '/manifest.json?v=18',
  '/icons/icon-192.png?v=18',
  '/icons/icon-512.png?v=18',
  '/img/j-logo.svg?v=18',
  '/img/j-mark.svg?v=18',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isShellRequest(request, url) {
  if (request.mode === 'navigate') return true;
  const p = url.pathname;
  if (p === '/' || p.endsWith('.html')) return true;
  if (p.endsWith('.js') || p.endsWith('.css')) return true;
  if (p.endsWith('manifest.json')) return true;
  return false;
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  // Never cache the SW script itself via this handler
  if (url.pathname.endsWith('/sw.js')) return;

  if (isShellRequest(e.request, url)) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request).then((cached) => cached || caches.match('/index.html') || caches.match('/'))
        )
    );
    return;
  }

  // Icons / images: cache-first, then network
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
