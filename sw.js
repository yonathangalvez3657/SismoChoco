const CACHE_NAME = 'sismo-choco-v67';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/styles.css',
  './js/core-oop.js',
  './js/main.js',
  './lib/deck.gl.min.js',
  './lib/maplibre-gl.js',
  './lib/maplibre-gl.css',
  './lib/chart.js',
  './sismicidad_choco_consolidado.geojson',
  './data/choco_base_offline.geojson',
  './data/fallas.geojson',
  './data/municipios_choco_nsr10.json',
  './data/vias_infraestructura.geojson',
  './data/ml_clusters_fallback.json',
  './icon.svg',
  './manifest.json'
];

const API_OFFLINE_FALLBACKS = {
  '/api/sismos': './sismicidad_choco_consolidado.geojson',
  '/api/fallas': './data/fallas.geojson',
  '/api/municipios_nsr10': './data/municipios_choco_nsr10.json',
  '/api/infraestructura': './data/vias_infraestructura.geojson',
  '/api/ml_clusters': './data/ml_clusters_fallback.json'
};

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('Precaching offline PWA assets:', CACHE_NAME);
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.action === 'PURGE_ALL_CACHES') {
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => {
          if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({ status: 'PURGED' });
          }
        })
    );
  }
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // API endpoints: network-first con respaldo offline automático hacia archivos locales precacheados
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    const fallbackAsset = API_OFFLINE_FALLBACKS[url.pathname];
    const cacheKey = new Request(url.origin + url.pathname);
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.ok && fallbackAsset && url.pathname !== '/api/sismos') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, clone));
          }
          return response;
        })
        .catch(async () => {
          const cachedApi = await caches.match(cacheKey, { ignoreSearch: true });
          if (cachedApi) return cachedApi;
          if (fallbackAsset) {
            const fb = await caches.match(fallbackAsset, { ignoreSearch: true });
            if (fb) return fb;
          }
          return new Response(JSON.stringify({ offline: true, error: 'Offline sin respaldo' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  // Solo cachear recursos del mismo origen (tiles externos y APIs FDSN externas no bloquean)
  if (url.origin === self.location.origin) {
    const staticKey = url.search ? new Request(url.origin + url.pathname) : event.request;
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(staticKey, clone));
          }
          return response;
        })
        .catch(() => caches.match(staticKey, { ignoreSearch: true }))
    );
  }
});
