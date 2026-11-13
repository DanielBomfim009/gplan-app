// Service worker da versão 2. Troque VERSION a cada publicação para o
// celular pegar a versão nova (o cache antigo é apagado na ativação).
const VERSION = 'v2-007';
const CACHE_NAME = `controle-financeiro-${VERSION}`;

const CORE_ASSETS = [
  './',
  './index.html',
  './tailwind.css',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.json',
  './logo-192.png',
  './logo-512.png'
];

const EXTERNAL_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js',
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

// A página em si sai do cache na hora (abre sem tela branca, mesmo com
// internet lenta) e é atualizada por trás. A versão nova entra pela troca
// de VERSION (install -> activate), que a página trata com o aviso "Atualizar".
async function documentStrategy(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = (await cache.match(request, { ignoreSearch: true })) || (await cache.match('./index.html'));
  const network = fetch(new Request(request, { cache: 'reload' })).then((response) => {
    if (response && response.ok) cache.put('./index.html', response.clone());
    return response;
  }).catch(() => null);
  if (cached) return cached;
  return (await network) || new Response('Sem conexão. Abra de novo quando a internet voltar.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
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
    event.respondWith(documentStrategy(request));
    return;
  }
  if (sameOrigin || isAsset) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

// ---------------------------------------------------------------------
// Avisos em segundo plano (enviados pela função enviar-push do Supabase)
// ---------------------------------------------------------------------
function lerDadosDoPush(event) {
  if (!event.data) return { title: 'Controle Financeiro', body: '' };
  try {
    const dados = event.data.json();
    if (dados && typeof dados === 'object') return dados;
  } catch (_) { /* não era JSON */ }
  let texto = '';
  try { texto = event.data.text(); } catch (_) { texto = ''; }
  return { title: 'Controle Financeiro', body: texto };
}

async function mostrarAviso(dados) {
  const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // Com o app na frente, a própria tela mostra o aviso (tempo real); não duplicar.
  if (janelas.some((c) => c.visibilityState === 'visible')) {
    janelas.forEach((c) => { try { c.postMessage({ type: 'PUSH_VISTO', dados }); } catch (_) { /* ok */ } });
    return;
  }
  return self.registration.showNotification(dados.title || 'Controle Financeiro', {
    body: dados.body || '',
    icon: './logo-192.png',
    badge: './logo-192.png',
    tag: dados.tag || 'gplan',
    renotify: true,
    lang: 'pt-BR',
    data: { url: dados.url || './index.html' }
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(mostrarAviso(lerDadosDoPush(event)));
});

// Clique numa notificação abre (ou traz para a frente) o aplicativo.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = all.find((c) => 'focus' in c);
    if (target) return target.focus();
    return self.clients.openWindow(url);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
