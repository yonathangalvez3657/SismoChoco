const CACHE_NAME = 'sismo-choco-v36';
const ASSETS_TO_CACHE = [
  './index.html',
  './css/styles.css',
  './js/core-oop.js',
  './js/main.js',
  './lib/deck.gl.min.js',
  './lib/maplibre-gl.js',
  './lib/maplibre-gl.css',
  './lib/chart.js',
  './data/fallas.geojson',
  './data/oq_resultados.geojson',
  './data/municipios_choco_nsr10.json',
  './data/vias_infraestructura.geojson',
  './icon.svg',
  './manifest.json'
];

// Instalación del Service Worker con activación forzada inmediata
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Archivos en caché para modo offline (v36)');
        return cache.addAll(ASSETS_TO_CACHE);
      })
  );
});

// Limpieza de cachés antiguas y toma de control inmediata
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Eliminando caché antigua:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Estrategia Network-First con fallback a Caché para evitar discrepancias de versión
self.addEventListener('fetch', event => {
  // Excluir llamadas a la API de la caché
  if (event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
