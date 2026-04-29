const CACHE_NAME = 'papelaria-v2';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './login.html',
  './estilo.css',
  './script.js',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

// Instala e pré-carrega assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        ASSETS_TO_CACHE.map(url => cache.add(url).catch(() => {}))
      );
    })
  );
  self.skipWaiting();
});

// Limpa caches antigos quando ativa
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Estratégia "Network First" — sempre tenta buscar a versão mais nova,
// e usa o cache só como fallback se estiver offline
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Não intercepta requisições do Firebase
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('firestore') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    event.request.method !== 'GET'
  ) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Se conseguiu buscar online, atualiza o cache e retorna
        if (response && response.status === 200 && response.type !== 'opaque') {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        }
        return response;
      })
      .catch(() => {
        // Se está offline, usa o que tiver no cache
        return caches.match(event.request);
      })
  );
});

// Permite que a página force a atualização do service worker
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});