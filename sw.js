// Offline support: everything is network-first (always the newest app and prices when online),
// falling back to the cached copy offline. 'no-cache' revalidates with GitHub instead of using a stale browser copy.
const CACHE = 'deckscan-v2';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/data.js', 'js/store.js', 'js/sync.js', 'js/config.js',
  'js/scanner.js', 'js/decks.js', 'lib/fp.js', 'vendor/ui.mjs', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // card API, images, Firebase: straight to network
  const key = url.pathname.includes('/data/') ? url.pathname : e.request;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return r;
  }).catch(() => caches.match(key).then(hit => hit || caches.match('index.html'))));
});
