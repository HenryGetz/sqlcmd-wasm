const CACHE_PREFIX = 'sqlcmd-wasm';
const CACHE_VERSION = 'v1';
const PAGE_CACHE = `${CACHE_PREFIX}-pages-${CACHE_VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const BINARY_CACHE = `${CACHE_PREFIX}-binary-${CACHE_VERSION}`;

const APP_SHELL_URL = new URL('./index.html', self.registration.scope).toString();
const ROOT_URL = new URL('./', self.registration.scope).toString();
const MANIFEST_URL = new URL('./manifest.webmanifest', self.registration.scope).toString();
const FAVICON_URL = new URL('./favicon.svg', self.registration.scope).toString();
const ICON_URL = new URL('./pwa-icon.svg', self.registration.scope).toString();

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const pageCache = await caches.open(PAGE_CACHE);
      await pageCache.addAll([
        new Request(ROOT_URL, { cache: 'reload' }),
        new Request(APP_SHELL_URL, { cache: 'reload' }),
      ]);

      const staticCache = await caches.open(STATIC_CACHE);
      await staticCache.addAll([MANIFEST_URL, FAVICON_URL, ICON_URL]);

      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const deletions = names
        .filter((cacheName) => cacheName.startsWith(CACHE_PREFIX) && !cacheName.endsWith(CACHE_VERSION))
        .map((cacheName) => caches.delete(cacheName));

      await Promise.all(deletions);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'worker'
  ) {
    event.respondWith(handleStaleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  if (request.destination === 'font' || request.destination === 'image') {
    event.respondWith(handleCacheFirst(request, BINARY_CACHE));
    return;
  }

  if (
    url.pathname.endsWith('.wasm') ||
    url.pathname.endsWith('.sqlite') ||
    url.pathname.endsWith('.sql') ||
    url.pathname.endsWith('.txt')
  ) {
    event.respondWith(handleCacheFirst(request, BINARY_CACHE));
  }
});

async function handleNavigationRequest(request) {
  const cache = await caches.open(PAGE_CACHE);

  try {
    const networkResponse = await fetch(request);
    cache.put(request, networkResponse.clone());
    return networkResponse;
  } catch (_error) {
    const fallback =
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match(APP_SHELL_URL)) ||
      (await cache.match(ROOT_URL));

    return fallback || Response.error();
  }
}

async function handleStaleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((networkResponse) => {
      cache.put(request, networkResponse.clone());
      return networkResponse;
    })
    .catch(() => undefined);

  if (cached) {
    return cached;
  }

  const networkResponse = await networkPromise;
  return networkResponse || Response.error();
}

async function handleCacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  const networkResponse = await fetch(request);
  cache.put(request, networkResponse.clone());
  return networkResponse;
}
