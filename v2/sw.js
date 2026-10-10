// Service worker da versão 2. Troque VERSION a cada publicação para o
// celular pegar a versão nova (o cache antigo é apagado na ativação).
const VERSION = 'v2-001';
const CACHE_NAME = `controle-financeiro-${VERSION}`;

const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.json',
  './logo-192.png',
  './logo-512.png'
];

const EXTERNAL_ASSETS = [
  'https://cdn.tailwindcss.com/',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap'
];

async function cacheCore(cache) {
  await Promise.allSettled(CORE_ASSETS.map(async (url) => {
    const response = await fetch(new Request(url, { cache: 'reload' }));
    if (response && response.ok) await cache.put(url, response.clone());
  }));
}

async function cacheExternal(cache) {
  await Promise.allSettled(EXTERNAL_ASSETS.map(async (url) => {
    try {
      const request = new Request(url, { cache: 'no-cache', mode: 'no-cors' });
      const response = await fetch(request);
      if (response) await cache.put(request, response.clone());
    } catch (_) {
      return;
    }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cacheCore(cache);
    await cacheExternal(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(new Request(request, { cache: 'reload' }));
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (_) {
    return (await cache.match(request)) || (await cache.match('./index.html'));
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Nunca guardar chamadas ao banco.
  if (url.hostname.endsWith('.supabase.co')) return;

  const sameOrigin = url.origin === self.location.origin;
  const isDocument = request.mode === 'navigate';
  const isAsset = ['style', 'script', 'font', 'image'].includes(request.destination)
    || url.hostname.includes('fonts.g') || url.hostname.includes('cdn.');

  if (isDocument) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (sameOrigin || isAsset) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

// Clique numa notificação abre (ou foca) o aplicativo.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = all.find((c) => 'focus' in c);
    if (target) return target.focus();
    return self.clients.openWindow('./index.html');
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
