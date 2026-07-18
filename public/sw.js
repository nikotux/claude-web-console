// Service Worker de Mi Consola — Capa 1 de "aprovechar el navegador como
// caché persistente". Cachea los estáticos propios (/js, /css, /vendor) para
// que en cada carga/reconexión salgan del navegador (0 round-trips) en vez de
// revalidarse uno por uno contra el server. Se auto-invalida por BUILD_ID: el
// server inyecta el hash de git HEAD al servir /sw.js, así que tras un deploy
// el navegador ve un /sw.js distinto byte-a-byte y dispara install -> activate,
// que purga el caché viejo. NUNCA cachea /api (datos) ni las navegaciones.
const BUILD_ID = '__BUILD_ID__';
const CACHE = 'cwc-' + BUILD_ID;

// App-shell mínimo precacheado en install (best-effort). El resto de los ~47
// módulos JS se cachea on-demand en el fetch handler la primera vez que se
// piden (evita un install gigante y frágil).
const SHELL = [
  '/css/tokens.css', '/css/ui.css', '/css/style.css',
  '/js/main.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {})) // un 404/401 no aborta la instalación
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('cwc-') && k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Navegaciones SIEMPRE a la red: no romper el redirect a /login ni servir el
  // shell a un usuario deslogueado.
  if (req.mode === 'navigate') return;
  // Datos y auth: nunca cachear.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/login') || url.pathname.startsWith('/logout')) return;
  // Solo estáticos cacheables: /js, /css, /vendor.
  if (!/^\/(js|css|vendor)\//.test(url.pathname)) return;
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((resp) => {
          // Solo cachear respuestas propias exitosas (nunca 401/404/opacas).
          if (resp && resp.status === 200 && resp.type === 'basic') cache.put(req, resp.clone());
          return resp;
        });
      }),
    ),
  );
});
