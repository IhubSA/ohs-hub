// OHS Hub service worker: makes the app installable and lets it open
// quickly or without signal. Strategy: always try the network first, so
// every upload to GitHub is picked up straight away; fall back to the last
// copy saved on the device only when there's no connection.
// Never stores database, sign-in or file traffic (Supabase); those always go
// to the server so security rules apply and records are never stale.
const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `ohs-hub-${VERSION}`;
const SHELL = ['./', './index.html', './app.css', './manifest.webmanifest', './js/main.js', './js/version.js',
  './icons/icon-192.png', '../assets/css/site.css', '../assets/img/logo-light.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ohs-hub-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameSite = url.origin === self.location.origin;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const library = url.hostname === 'cdn.jsdelivr.net';
  if (!sameSite && !fonts && !library) return; // Supabase and everything else: straight to the network

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && (res.type === 'basic' || res.type === 'cors')) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error();
    }
  })());
});
