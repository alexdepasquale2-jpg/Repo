// Essence Protocol service worker: cache-first so the game and its merge database work offline.
const CACHE = 'essence-protocol-v13';
const SHARDS = ['FF', 'FW', 'FE', 'FA', 'WF', 'WW', 'WE', 'WA', 'EF', 'EW', 'EE', 'EA', 'AF', 'AW', 'AE', 'AA'].map(p => `db/${p}.json`);
const ASSETS = ['./', 'index.html', 'style.css', 'manifest.json', 'icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
  'js/essences.js', 'js/db.js', 'js/designs.js', 'js/engine.js', 'js/content.js', 'js/sprites.js', 'js/reveal.js', 'js/game.js', 'db/index.json'].concat(SHARDS);
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => new Request(a, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok && new URL(e.request.url).origin === location.origin) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  })));
});
