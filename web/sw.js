// SISIP Service Worker — Cache statis, fallback offline, & jaringan utk data.
// Berbasis https://github.com/GoogleChrome/samples/blob/gh-pages/service-worker/basic/service-worker.js

const STATIC_CACHE_NAME = 'sisip-v1';
const DYNAMIC_CACHE_NAME = 'sisip-api-v1';
const OFFLINE_PAGE = '/offline.html'; // File fallback bila jaringan mati

// Daftar file statis yang akan di-cache saat instalasi.
// Perlu diperbarui bila ada perubahan di `web/index.html` (CSS/JS/ikon).
const STATIC_FILES = [
  '/', // Harus ada! Ini halaman utama index.html.
  '/index.html',
  '/web/css/style.css?v=20261024b', // Versi CSS harus cocok dg di index.html
  '/web/js/utils.js?v=20261028e',   // Versi JS harus cocok
  '/web/js/app.js?v=20261028f',     // Versi JS harus cocok
  '/web/js/face.js?v=20261028e',
  '/web/js/utils.example.js',
  '/web/vendor/supabase.js?v=2.45.4',
  '/web/vendor/face-api.min.js?v=20261014a',
  '/web/vendor/cropper.min.js',
  '/web/vendor/xlsx.full.min.js',
  '/web/vendor/html5-qrcode.min.js',
  '/web/vendor/mediapipe/vision_bundle.js?v=20261020c',
  '/web/vendor/onnx/ort.min.js?v=20261020c',
  '/web/js/face.js?v=20261028e',
  // ... tambahkan ikon PWA yang sudah dibuat
  '/web/assets/logo.svg',
  '/web/assets/icon-192.png',
  '/web/assets/icon-512.png',
  '/web/assets/icon-192-maskable.png',
  '/web/assets/icon-512-maskable.png',
  '/web/assets/apple-touch-icon.png',
  // ... file lain yang dipakai saat offline (mis. font awesome)
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  // ... (font Awesome JS tidak di-cache di sini karena CSP)
];

// Cache saat service worker diinstal
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Precaching static assets...');
        return cache.addAll(STATIC_FILES);
      })
  );
});

// Bersihkan cache lama saat service worker diaktifkan
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== STATIC_CACHE_NAME && cacheName !== DYNAMIC_CACHE_NAME) {
            console.log('[Service Worker] Cleaning old cache: ' + cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Tangani permintaan jaringan (strategi cache: Network first, fallback cache)
self.addEventListener('fetch', (event) => {
  // Hanya tangani permintaan navigasi (HTML) dan GET request
  if (event.request.mode !== 'navigate' && event.request.method !== 'GET') {
    return;
  }

  // Abaikan permintaan ke domain eksternal (CDN, API lain) — tidak di-cache di sini
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) {
    return;
  }

  event.respondWith(
    caches.open(DYNAMIC_CACHE_NAME).then((cache) => {
      // Coba ambil dari jaringan dulu
      return fetch(event.request).then((response) => {
        // Bila sukses, simpan ke cache dinamis
        if (response.ok) {
          cache.put(event.request, response.clone());
        }
        return response;
      }).catch(() => {
        // Bila jaringan gagal, coba ambil dari cache dinamis
        return cache.match(event.request).then((cachedResponse) => {
          // Bila masih tidak ada di cache, berikan fallback offline
          if (!cachedResponse) {
            return caches.match(OFFLINE_PAGE);
          }
          return cachedResponse;
        });
      });
    })
  );
});

// Handle push notifications (jika ada di masa depan)
self.addEventListener('push', (event) => {
  console.log('[Service Worker] Push notification received:', event);
  const payload = event.data ? JSON.parse(event.data.text()) : {};
  const title = payload.title || 'SISIP Notification';
  const options = {
    body: payload.body || 'Pesan baru diterima.',
    icon: payload.icon || '/web/assets/icon-192.png',
    data: payload.data || {}
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  console.log('[Service Worker] Notification click:', event);
  const notificationData = event.notification.data;
  const url = notificationData.url || '/'; // Default ke root jika tidak ada URL
  event.notification.close(); // Tutup notifikasi
  // Buka aplikasi atau tab baru dengan URL yang ditentukan
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.startsWith(location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
