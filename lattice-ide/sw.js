/* Lattice service worker — shell cache only. Never touches worker API traffic. */
const VERSION = 'lattice-v1.0.0';
const SHELL_CACHE = VERSION + '-shell';
const FONT_CACHE = VERSION + '-fonts';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.json', 'icon.svg'];
const SCOPE = new URL(self.registration ? self.registration.scope : './', self.location).pathname;
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.registration ? self.registration.scope : self.location).pathname));
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('lattice-') && k !== SHELL_CACHE && k !== FONT_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request, key) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(key || request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok && res.type === 'basic') cache.put(key || request, res.clone());
  return res;
}

async function navigate(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('index.html', res.clone());
    }
    return res;
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(event.request);
  const network = fetch(event.request)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(event.request, res.clone());
      return res;
    })
    .catch(() => hit);
  if (hit) {
    event.waitUntil(network.then(() => undefined));
    return hit;
  }
  return network;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // pass through untouched
  const url = new URL(req.url);

  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }
  if (url.origin !== self.location.origin) return; // worker API on another origin: untouched

  const isShellPath = SHELL_PATHS.has(url.pathname);
  if (req.mode === 'navigate' && (isShellPath || url.pathname === SCOPE)) {
    event.respondWith(navigate(req));
    return;
  }
  if (isShellPath) {
    event.respondWith(cacheFirst(req, url.pathname === SCOPE ? './' : undefined));
  }
  // Anything else (/jobs, /health, /runs, ...) falls through to the network.
});
