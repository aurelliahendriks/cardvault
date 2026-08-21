/**
 * Service worker: make the app open when the network does not.
 *
 * Two very different kinds of request, so two very different strategies. Getting this
 * distinction wrong is how offline support turns into "why is it showing me yesterday's price".
 *
 * **The shell** — the HTML, the crop module, the icons — is cached on install and served
 * cache-first. It changes only when I ship a new version, so serving it from disk is both
 * faster and the thing that makes the app open at all with no signal.
 *
 * **The data** — everything under `/api/` — is network-first, and only falls back to the cache
 * when the network genuinely fails. A card's value is a live number; showing a stale one without
 * saying so would be worse than showing nothing, so a cached API response is served with an
 * `X-From-Cache` header that the page uses to say plainly that you are looking at a snapshot.
 *
 * **Writes are never cached and never queued here.** A POST that fails offline fails visibly.
 * Silently replaying a "sold this card" hours later, against a collection that has since
 * changed, is the kind of helpfulness that loses data. Queued writes are a separate, deliberate
 * piece of work with its own conflict rules.
 */

const VERSION = 'cv-3';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;

/**
 * Cached on install. Deliberately short: the icons and the two files the app cannot start
 * without. Everything else arrives through the fetch handler on first use, so a single missing
 * URL here cannot make installation fail — which is exactly what a long list risks.
 */
const SHELL_URLS = [
  '/',
  '/index.html',
  '/cardcrop.js',
  '/manifest.webmanifest',
  '/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // Individually, not addAll: addAll rejects as a unit, so one 404 would leave the app with
    // no cached shell at all and no offline support whatsoever.
    await Promise.all(SHELL_URLS.map((u) => c.add(new Request(u, { cache: 'reload' }))
      .catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, DATA]);
    await Promise.all((await caches.keys()).filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/** API paths whose answers are worth keeping for an offline read. */
const CACHEABLE_API = /^\/api\/(portfolio|gallery|overview|cards|players|recommendations|facets|health|auth\/state|img)/;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;       // never touch third-party requests

  // Writes go straight to the network, always. See the note at the top of this file.
  if (req.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(req, url));
    return;
  }
  e.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cached = await caches.match(req, { ignoreSearch: true });
  if (cached) {
    // Refresh in the background so the next launch is current, without delaying this one.
    fetch(req).then((r) => r.ok && caches.open(SHELL).then((c) => c.put(req, r.clone())))
      .catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
    return res;
  } catch {
    // A navigation with nothing cached and no network: hand back the app shell rather than the
    // browser's dinosaur, so the page itself can explain the situation.
    const shell = await caches.match('/index.html');
    if (shell && req.mode === 'navigate') return shell;
    return new Response('offline', { status: 503, statusText: 'offline' });
  }
}

async function networkFirst(req, url) {
  try {
    const res = await fetch(req);
    // 401 must never be cached. Caching a "sign in" response would serve it back after the
    // person has signed in, and the app would insist they are logged out.
    if (res.ok && CACHEABLE_API.test(url.pathname)) {
      (await caches.open(DATA)).put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (!cached) throw err;
    // Re-wrap so the page can tell this is a snapshot and say so out loud.
    const body = await cached.blob();
    const headers = new Headers(cached.headers);
    headers.set('X-From-Cache', '1');
    return new Response(body, { status: 200, headers });
  }
}
