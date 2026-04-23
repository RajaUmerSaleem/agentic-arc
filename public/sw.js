const CACHE_NAME = 'arc-swarm-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Helper: safely return a response, fallback to index.html for navigation
async function safeResponse(request, cacheResponsePromise) {
  try {
    const response = await cacheResponsePromise;
    if (response) return response;
  } catch (e) {
    // ignore
  }
  // For navigation requests, serve index.html (SPA fallback)
  if (request.mode === 'navigate') {
    const cache = await caches.open(CACHE_NAME);
    return cache.match('/index.html');
  }
  // Otherwise return a minimal error response
  return new Response('Network error', { status: 408, headers: { 'Content-Type': 'text/plain' } });
}

// Fetch event - network first for API, cache first for static, fallback for everything
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests for caching
  if (request.method !== 'GET') {
    return;
  }

  // API calls - network first, no cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        safeResponse(request, caches.match(request))
      )
    );
    return;
  }

  // Static assets - stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
