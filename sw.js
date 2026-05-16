const VERSION = 'v52';
const CACHE_NAME = `controle-financeiro-${VERSION}`;
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

const OPTIONAL_ASSETS = [
  './logo-192.png',
  './logo-512.png'
];

const EXTERNAL_ASSETS = [
  'https://cdn.tailwindcss.com/',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap'
];

async function cacheMany(cache, urls) {
  await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const request = new Request(url, { cache: 'no-cache', mode: 'no-cors' });
        const response = await fetch(request);
        if (response) {
          await cache.put(request, response.clone());
        }
      } catch (_) {
        return;
      }
    })
  );
}

async function cacheCoreAssets(cache) {
  await Promise.allSettled(
    CORE_ASSETS.map(async (url) => {
      const request = new Request(url, { cache: 'reload' });
      const response = await fetch(request);
      if (response && response.ok) {
        await cache.put(url, response.clone());
      }
    })
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cacheCoreAssets(cache);
      await cacheMany(cache, OPTIONAL_ASSETS);
      await cacheMany(cache, EXTERNAL_ASSETS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || networkPromise || caches.match('./index.html');
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(new Request(request, { cache: 'reload' }));
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await cache.match(request);
    return cached || caches.match('./index.html');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isDocument = request.mode === 'navigate';
  const isStyleLike =
    request.destination === 'style' ||
    request.destination === 'script' ||
    request.destination === 'font' ||
    request.url.includes('fonts.googleapis.com') ||
    request.url.includes('fonts.gstatic.com') ||
    request.url.includes('cdn.tailwindcss.com');

  if (isDocument) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (isSameOrigin || isStyleLike) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
