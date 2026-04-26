/* Cache-first service worker. CACHE_VERSION is substituted at build time
 * from the git short SHA (see pc/CMakeLists.txt) so each new build evicts
 * the previous cache automatically. */

const CACHE_VERSION = '@PC_WEB_CACHE_VERSION@';
const CORE_ASSETS = [
    './',
    './AnimalCrossing.html',
    './AnimalCrossing.js',
    './AnimalCrossing.wasm',
    './AnimalCrossing.data',
    './manifest.webmanifest',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => {
            // Best-effort: don't fail install if an optional asset (e.g. an
            // icon) is missing — the core wasm/data are what matters.
            return Promise.allSettled(
                CORE_ASSETS.map((url) =>
                    cache.add(url).catch((err) => {
                        console.warn('[sw] failed to cache', url, err);
                    })
                )
            );
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((k) => k !== CACHE_VERSION)
                    .map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    event.respondWith(
        caches.match(req).then((cached) => {
            if (cached) return cached;
            return fetch(req)
                .then((res) => {
                    if (!res || res.status !== 200 || res.type !== 'basic') return res;
                    const copy = res.clone();
                    caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
                    return res;
                })
                .catch(() => caches.match('./AnimalCrossing.html'));
        })
    );
});
