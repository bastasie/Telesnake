// sw.js - best-effort offline caching for the Mini App (no server-side).
// Note: Some Telegram WebViews may restrict Service Workers; app still works without this.

const CACHE = 'ppu-snake-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './ppujpeg.js',
  './vm.js',
  './sw.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async ()=>{
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async ()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  event.respondWith((async ()=>{
    const req = event.request;
    const cached = await caches.match(req);
    if(cached) return cached;
    try{
      const res = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
      return res;
    } catch {
      return cached || new Response('offline', {status: 503});
    }
  })());
});
