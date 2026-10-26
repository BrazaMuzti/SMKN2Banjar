/* ============================================================================
 * SISIP Service Worker — cache aset statis + fallback halaman offline.
 * ----------------------------------------------------------------------------
 * PENTING (jangan diubah): situs ini di-deploy ke GitHub Pages sebagai
 * PROJECT PAGE → https://<user>.github.io/Administrasi-Sekolah/
 * Artifact CI = folder `web/` (lihat .github/workflows/static.yml → path: 'web').
 * Maka SEMUA path di bawah HARUS relatif terhadap scope SW (pakai `new URL`),
 * JANGAN pakai '/index.html' (itu menunjuk root domain GitHub Pages = 404).
 *
 * Cakupan cache: hanya aset statis same-origin. Request ke Supabase/CDN
 * (beda origin) dilewatkan langsung ke jaringan (data selalu real-time).
 * ========================================================================== */

const VERSION = 'v6'; // ← WAJIB dinaikkan setiap index.html berubah (lihat PRECACHE)
const STATIC_CACHE = `sisip-static-${VERSION}`;
const RUNTIME_CACHE = `sisip-runtime-${VERSION}`;

/** Scope SW — mis. https://user.github.io/Administrasi-Sekolah/ */
const BASE = new URL('./', self.location.href).href;
const abs = (p) => new URL(p, BASE).href;

/** Halaman fallback bila offline (ada di web/offline.html). */
const OFFLINE_URL = abs('offline.html');

/* Aset inti yang di-precache saat install.
 * ── Setiap kali web/index.html berubah (versi ?v=... naik), VERSION di atas
 *    WAJIB dinaikkan & daftar di bawah WAJIB disinkronkan. */
const PRECACHE = [
  './',
  'index.html',
  'offline.html',
  'manifest.json',
  'css/style.css?v=20261031a',
  'js/utils.js?v=20261031a',
  'js/app.js?v=20261031a',
  'js/face.js?v=20261031a',
  'js/install.js?v=20261031a',
  'vendor/face-api.min.js?v=20261014a',
  'vendor/mediapipe/vision_bundle.js?v=20261020c',
  'vendor/onnx/ort.min.js?v=20261020c',
  'assets/logo.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/icon-192-maskable.png',
  'assets/icon-512-maskable.png',
  'assets/apple-touch-icon.png'
];

/* Folder yang TIDAK di-cache (model wajah besar) — ambil dari jaringan saja. */
const SKIP_PREFIX = [abs('models/')];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // `cache.add` satu per satu: satu file 404 tidak menggagalkan seluruh install.
    await Promise.all(PRECACHE.map((url) =>
      cache.add(abs(url)).catch((err) => console.warn('[SW] Gagal precache:', url, err))
    ));
    await self.skipWaiting(); // versi baru langsung menunggu aktif (lihat activate)
  })());
  console.log('[SW] install selesai — cache:', STATIC_CACHE);
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) =>
      (k.startsWith('sisip-') && k !== STATIC_CACHE && k !== RUNTIME_CACHE)
        ? (console.log('[SW] Hapus cache lama:', k), caches.delete(k))
        : null
    ));
    await self.clients.claim(); // langsung kendalikan tab yang sudah terbuka
  })());
  console.log('[SW] activate selesai.');
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Beda origin (Supabase, Font Awesome, jsdelivr, unpkg) → lewat ke jaringan.
  if (url.origin !== self.location.origin) return;
  if (SKIP_PREFIX.some((p) => url.href.startsWith(p))) return;

  // ── Navigasi (buka/ganti halaman) → network-first, fallback cache → offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === 'basic') {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch (e) {
        return (await caches.match(req))
          || (await caches.match(abs('index.html')))
          || (await caches.match(OFFLINE_URL))
          || new Response('<h1>Offline</h1>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // ── Aset statis → cache-first (sudah ada di precache), update di belakang.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const dariJaringan = fetch(req).then(async (res) => {
      if (res && res.ok && res.type === 'basic') {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    }).catch(() => null);

    if (cached) return cached; // instan + hemat kuota
    const res = await dariJaringan;
    return res || Response.error();
  })());
});

/* ─── Push notification (disiapkan utk masa depan; belum dipakai) ────────── */
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { body: event.data && event.data.text() }; }
  const title = payload.title || 'SISIP';
  const options = {
    body: payload.body || 'Ada pembaruan baru di SISIP.',
    icon: payload.icon || abs('assets/icon-192.png'),
    badge: abs('assets/icon-192-maskable.png'),
    data: payload.data || { url: abs('index.html') }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* ─── Klik notifikasi → fokuskan tab SISIP yang sudah terbuka ────────────── */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || BASE;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(BASE) && 'focus' in c) return c.focus();
    }
    return clients.openWindow(target);
  }));
});

/* ─── Pesan dari halaman (mis. minta skipWaiting saat update tersedia) ───── */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

