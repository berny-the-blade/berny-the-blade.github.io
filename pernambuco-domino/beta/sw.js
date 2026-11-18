const CACHE_NAME = 'domino-pernambuco-v12';
// Don't pre-cache index.html — always fetch fresh so updates show up immediately.
const ASSETS_TO_CACHE = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './domino_model.bin',
  './symbolic-belief.js',
  'https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&display=swap',
  'https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.0/firebase-database-compat.js'
];

// Install — cache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache assets individually so one failure doesn't block all
      return Promise.allSettled(
        ASSETS_TO_CACHE.map(url => cache.add(url).catch(e => console.warn('SW cache miss:', url, e)))
      );
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch — network-first for static assets so updates land on reload, with cache fallback for offline.
// Firebase Realtime DB always goes to network. Navigation requests always go to network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Always go to network for Firebase Realtime Database (live game state)
  if (url.hostname.includes('firebaseio.com') || url.hostname.includes('firebasedatabase.app')) {
    return;
  }

  // Navigation requests + index.html: always network, never cache.
  // This guarantees code updates show up on the next reload.
  // same origin only: 'https://cdn.tailwindcss.com/' also ends with '/', and was being treated (and offline, answered) as the page
  const isNav = req.mode === 'navigate' || (url.origin === self.location.origin && (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')));
  if (isNav) {
    // 2026-11-18: still always from the network when there is one, but the last page fetched is
    // kept, so the game opens without a connection (a solo game against the bots works offline).
    event.respondWith(
      fetch(req, { cache: 'no-store' }).then((response) => {
        if (response.ok && req.method === 'GET') { const clone = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', clone)).catch(() => {}); }
        return response;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // All other static assets: network-first, fall back to cache when offline.
  event.respondWith(
    fetch(req)
      .then((response) => {
        // opaque = a script or style from another site (React, Firebase, fonts) loaded the plain way:
        // its status cannot be read, but it has to be kept or the page cannot start offline
        if ((response.ok || response.type === 'opaque') && req.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(req))
  );
});
