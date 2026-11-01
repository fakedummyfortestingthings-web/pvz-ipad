/*!
 * PvZ2 Gardendless – service worker (offline play)
 *
 * Must be served from the same folder as the page's index.html (site root on GitHub Pages;
 * build-pages-lite.mjs copies it there and stamps CACHE_VERSION with the commit SHA, so every
 * deploy gets fresh caches automatically). For other hosting, bump CACHE_VERSION by hand on
 * each new game build. Old caches are deleted on activate.
 */
const CACHE_VERSION = 'v1';

const SHELL_CACHE = `pvz-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `pvz-assets-${CACHE_VERSION}`;
const FIREBASE_SDK = '10.14.1'; // keep in sync with sync/cloud-sync.js
const LIB_CACHE = `pvz-lib-firebase-${FIREBASE_SDK}`;
const KEEP = [SHELL_CACHE, ASSET_CACHE, LIB_CACHE];

const SCOPE = new URL(self.registration.scope);
const INDEX_URL = new URL('index.html', SCOPE).href;
const ROOT_URL = SCOPE.href;

// Small files that change with each build: served stale-while-revalidate.
// Matched by file name because on GitHub Pages they live under releases/<commit>/.
const SHELL_NAMES = ['index.html', 'ipad.css', 'ipad.js', 'save-store.js', 'pvz-ui.js',
  'manifest.webmanifest', 'cloud-sync.js', 'firebase-config.js'];
function isShell(url) {
  const name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  return SHELL_NAMES.includes(name);
}

// ---------- install / activate ----------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Everything else is cached at runtime (and by pvz-ui.js right after the first load).
    await Promise.allSettled(
      [ROOT_URL, INDEX_URL].map((url) => cache.add(new Request(url, { cache: 'reload' })))
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('pvz-') && !KEEP.includes(n)).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});

// ---------- fetch ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Firebase SDK modules from gstatic: cache-first so cloud-sync.js loads offline.
  if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(cacheFirst(req, LIB_CACHE));
    return;
  }

  // Everything else cross-origin (Firestore, Auth, analytics…) goes straight to the network.
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE.pathname)) return;

  if (url.pathname.endsWith('/asset-list.json')) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL_CACHE, INDEX_URL));
    return;
  }

  if (isShell(url)) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE, event));
    return;
  }

  if (req.headers.has('range')) {
    event.respondWith(rangeFromCache(req, event));
    return;
  }

  event.respondWith(cacheFirst(req, ASSET_CACHE));
});

// ---------- strategies ----------
function cacheable(res) {
  return res && res.ok && res.status === 200 && (res.type === 'basic' || res.type === 'cors');
}

async function cacheFirst(req, cacheName) {
  const hit = await caches.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) {
    const cache = await caches.open(cacheName);
    cache.put(req, res.clone()).catch(() => {});
  }
  return res;
}

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  const network = fetch(req).then((res) => {
    if (cacheable(res)) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  network.catch(() => {}); // avoid unhandled-rejection noise when we answer from cache
  try {
    // Slow network: fall back to cache after 4 s, but only if a cached copy exists.
    return await withTimeout(network, 4000);
  } catch (e) {
    const hit = (await caches.match(req, { ignoreSearch: req.mode === 'navigate' })) ||
                (fallbackUrl && (await caches.match(fallbackUrl))) ||
                (fallbackUrl && (await caches.match(ROOT_URL)));
    if (hit) return hit;
    return network; // no cached copy: keep waiting for the network (or surface its error)
  }
}

async function staleWhileRevalidate(req, cacheName, event) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  const update = fetch(req).then((res) => {
    if (cacheable(res)) return cache.put(req, res.clone()).then(() => res);
    return res;
  });
  if (hit) {
    event.waitUntil(update.catch(() => {}));
    return hit;
  }
  return update;
}

// Safari requests <audio>/<video> with Range headers; serve slices of the full cached file.
async function rangeFromCache(req, event) {
  const full = await caches.match(req.url, { ignoreVary: true });
  if (!full) {
    // Cache the whole file in the background for next time, answer this request from the network.
    event.waitUntil((async () => {
      try {
        const res = await fetch(req.url);
        if (cacheable(res)) await (await caches.open(ASSET_CACHE)).put(req.url, res);
      } catch (e) {}
    })());
    return fetch(req);
  }
  const buf = await full.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
  end = Math.min(end, size - 1);
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': full.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}
