/* Cache-first service worker. CACHE_VERSION is substituted at build time
 * from the git short SHA (see pc/CMakeLists.txt) so each new build evicts
 * the previous cache automatically. */

const CACHE_VERSION = '@PC_WEB_CACHE_VERSION@';
const CORE_ASSETS = [
    './',
    './index.html',
    './index.js',
    './index.wasm',
    './index.data',
    './manifest.webmanifest',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
    './nipplejs.min.js',
    /* The shell is loaded as separate <link>/<script> from the HTML, so it
     * must be pre-cached here too — otherwise an old runtime-cached copy
     * lingers across builds (until activate's eviction sweep) and clients
     * see stale CSS/JS when the wasm has already updated. */
    './shell.css',
    './shell-touch.js',
    './shell-saves.js',
    './shell-rom.js',
    /* Self-hosted webfonts referenced by shell.css @font-face blocks.
     * Pre-caching them is the only way to keep typography correct
     * offline — the SW's runtime fetch handler skips opaque/cors
     * responses and same-origin .woff2 isn't navigated to organically. */
    './fonts/work-sans-400.woff2',
    './fonts/work-sans-500.woff2',
    './fonts/work-sans-600.woff2',
    './fonts/fragment-mono-400.woff2',
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

// Cache-first with a true fallback path. The previous version only fell
// back to cache on fetch *rejection* (offline / DNS fail). When the host
// returns a 5xx or 404 (deploy in progress, GitHub Pages hiccup, CF
// interstitial), fetch *resolves* with that error and the response would
// be passed straight through to the browser. Now we treat any non-OK
// response as cache-eligible for navigation, and always fall back to a
// cached index for navigation when network gives us anything bad.
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const tryCache = (matchOpts) =>
        caches.match(req, matchOpts || { ignoreSearch: true });

    const navFallback = () =>
        caches.match('./index.html', { ignoreSearch: true })
            .then((cached) => cached || caches.match('./', { ignoreSearch: true }));

    event.respondWith(
        tryCache().then((cached) => {
            if (cached) return cached;
            return fetch(req)
                .then((res) => {
                    if (res && res.ok && res.type === 'basic') {
                        const copy = res.clone();
                        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
                        return res;
                    }
                    // Network responded with an error status. For
                    // navigation requests, prefer cached HTML over the
                    // host's error page so the PWA stays usable.
                    if (req.mode === 'navigate') {
                        return navFallback().then((fb) => fb || res);
                    }
                    return res;
                })
                .catch(() => {
                    // True network failure (offline, DNS, TCP). Same
                    // navigation fallback path.
                    if (req.mode === 'navigate') return navFallback();
                    return Response.error();
                });
        })
    );
});
