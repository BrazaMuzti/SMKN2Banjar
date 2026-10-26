/* ============================================================================
 * SISIP — install.js : modul PWA ("Pasang ke layar utama").
 * ----------------------------------------------------------------------------
 * Dimuat SETELAH js/app.js (lihat web/index.html). Berisi:
 *   1. Registrasi service worker (sw.js) → aset ter-cache, halaman bisa offline.
 *   2. Tombol "Pasang" di header dashboard + kartu ajakan di halaman dashboard.
 *   3. Petunjuk manual untuk iOS/iPadOS Safari (tidak mendukung
 *      beforeinstallprompt, jadi "Pasang" harus lewat menu Bagikan).
 *   4. Prompt izin notifikasi — hanya 1x per perangkat.
 *
 * Catatan: file ini sengaja TIDAK menyentuh js/app.js (file raksasa) — semua UI
 * disuntik dari sini lewat DOM supaya perubahan terisolasi dan mudah dilacak.
 * ========================================================================== */
(function () {
  'use strict';

  const KUNCI_TOLAK = 'sisip_pwa_kartu_ditolak'; // kartu dashboard diabaikan user
  const KUNCI_NOTIF = 'sisip_pwa_notif_ditanya'; // prompt notifikasi 1x per perangkat
  const ID_BTN = 'btn-install-pwa';
  const ID_KARTU = 'kartu-pwa-dashboard';

  /* Stempel build halaman. WAJIB selalu disamakan dengan `?v=` di web/index.html
   * (naikkan bersama `VERSION` di sw.js). Dipakai untuk:
   *   - log diagnosis: `[SISIP] build 20261030a` (terlihat di console perangkat),
   *   - membersihkan cache SEKALI per perubahan build → anti "versi nyangkut". */
  const BUILD = '20261030a';
  const KUNCI_BUILD = 'sisip_build';               // build yang terakhir dipasang di perangkat ini
  const KUNCI_RELOAD_CACHE = 'sisip_reload_build'; // penjaga muat-ulang setelah cache dibersihkan
  const KUNCI_RELOAD_SW = 'sisip_reload_sw';       // penjaga muat-ulang setelah SW baru aktif

  let promptPasang = null;        // event beforeinstallprompt yang disimpan
  let terpasangBaru = false;      // sudah dipasang pada sesi ini (event appinstalled)

  /* ───────────────────────── helper lingkungan ───────────────────────── */

  /** Berjalan sebagai aplikasi terpasang (standalone), bukan tab browser? */
  function sudahTerpasang() {
    return terpasangBaru
      || window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: minimal-ui)').matches
      || window.navigator.standalone === true; // iOS Safari
  }

  /** iOS/iPadOS? (iPadOS 13+ menyamar sebagai macOS → cek touch point) */
  function iniIOS() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua)
      || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  }

  function bacaKunci(kunci) {
    try { return localStorage.getItem(kunci) === '1'; } catch (e) { return false; }
  }
  function tulisKunci(kunci, nilai) {
    try { localStorage.setItem(kunci, nilai ? '1' : '0'); } catch (e) { /* abaikan */ }
  }

  /** Bisa dipasang sekarang? (Chrome/Edge/Opera Android: prompt tersedia) */
  function bisaDipasang() { return !!promptPasang; }

  /** Perlu panduan manual? (iOS/iPadOS Safari tidak punya beforeinstallprompt,
   *  jadi satu-satunya cara memasang lewat menu Bagikan → lihat petunjukIOS()).
   *  Dipakai oleh tombol header, kartu dashboard, dan pasangPWA(). */
  function butuhPetunjukManual() {
    return !sudahTerpasang() && iniIOS();
  }

  /* ─────────── 0. Stempel build & pembersih cache "versi nyangkut" ─────────── */

  /** Tulis stempel build ke DOM + console. Berguna saat menolong siswa/guru:
   *  perangkat yang menjalankan berkas lama akan menampilkan build lama. */
  function stempelBuild() {
    try { document.documentElement.setAttribute('data-sisip-build', BUILD); } catch (e) { /* abaikan */ }
    console.log('[SISIP] build', BUILD);
  }

  /** Buang cache service worker milik SISIP (`sisip-*`) bila perangkat ini masih
   *  memakai build lama, lalu muat ulang SEKALI.
   *
   *  Latar belakang (kasus "Simpan Perubahan" gagal / PGRST202): service worker
   *  lama yang gagal install (mis. daftar precache berisi path absolut `/web/…`
   *  yang 404) TIDAK pernah `activate`, sehingga cache lamanya tidak pernah
   *  dibersihkan dan perangkat bisa terus menjalankan `js/app.js` versi lama.
   *  Fungsi ini menyapu cache tersebut tanpa perlu pengguna menghapus data situs. */
  function bersihkanCacheBilaBedaBuild() {
    let terakhir = null;
    try { terakhir = localStorage.getItem(KUNCI_BUILD); } catch (e) { return Promise.resolve(); }
    if (terakhir === BUILD) return Promise.resolve(); // perangkat ini sudah se-build

    const hapus = (window.caches && caches.keys)
      ? caches.keys().then(function (keys) {
          // Hanya cache milik SISIP: origin GitHub Pages dipakai bersama oleh
          // project page lain, jadi cache aplikasi lain tidak boleh tersentuh.
          return Promise.all(keys
            .filter(function (k) { return k.indexOf('sisip-') === 0; })
            .map(function (k) {
              console.log('[SISIP] Hapus cache lama:', k);
              return caches.delete(k);
            }));
        }).catch(function (err) { console.warn('[SISIP] Gagal membersihkan cache:', err); })
      : Promise.resolve();

    return hapus.then(function () {
      try { localStorage.setItem(KUNCI_BUILD, BUILD); } catch (e) { /* abaikan */ }
      if (!terakhir) return; // kunjungan pertama: tidak ada yang perlu disegarkan
      let sudah = false;
      try { sudah = sessionStorage.getItem(KUNCI_RELOAD_CACHE) === BUILD; } catch (e) { /* abaikan */ }
      if (sudah) return;     // sudah dimuat ulang pada sesi ini → jangan ulangi
      try { sessionStorage.setItem(KUNCI_RELOAD_CACHE, BUILD); } catch (e) { /* abaikan */ }
      console.log('[SISIP] Build baru ' + BUILD + ' — memuat ulang sekali agar berkas segar.');
      window.location.reload();
    });
  }

  /* ─────────────────── 1. Registrasi service worker ─────────────────── */

  function daftarkanSW() {
    if (!('serviceWorker' in navigator)) {
      console.log('[PWA] Service worker tidak didukung browser ini.');
      return;
    }
    const adaKontrolSebelumnya = !!navigator.serviceWorker.controller;

    // SW baru langsung mengambil kendali → muat ulang SEKALI agar halaman
    // memakai aset baru (bukan berkas lama yang masih ada di memori).
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!adaKontrolSebelumnya) return; // pemasangan pertama: tidak perlu muat ulang
      let sudah = false;
      try { sudah = sessionStorage.getItem(KUNCI_RELOAD_SW) === BUILD; } catch (e) { /* abaikan */ }
      if (sudah) return;
      try { sessionStorage.setItem(KUNCI_RELOAD_SW, BUILD); } catch (e) { /* abaikan */ }
      console.log('[SISIP] Service worker baru aktif — memuat ulang sekali.');
      window.location.reload();
    });

    // Path relatif: situs ini project page GitHub Pages (/repo/), bukan root domain.
    // `updateViaCache: 'none'` → sw.js SELALU diambil dari jaringan (tidak pernah
    // disajikan dari cache HTTP), jadi versi baru tidak mungkin "nyangkut".
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then(function (reg) {
        console.log('[PWA] Service worker terdaftar. Scope:', reg.scope);
        aktifkanVersiBaru(reg);
        reg.addEventListener('updatefound', function () {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', function () {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[PWA] Versi baru tersedia — mengaktifkan sekarang…');
              aktifkanVersiBaru(reg);
            }
          });
        });
        // Paksa cek pembaruan tiap aplikasi dibuka (bawaannya hanya tiap 24 jam).
        reg.update().catch(function (err) { console.warn('[PWA] Gagal cek pembaruan SW:', err); });
      })
      .catch(function (err) { console.error('[PWA] Registrasi service worker gagal:', err); });
  }

  /** SW yang sedang "waiting" langsung diaktifkan (ditangani `message` di sw.js). */
  function aktifkanVersiBaru(reg) {
    if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  /* ───────────────── 2. Tangkap event install bawaan ────────────────── */

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();          // tahan prompt otomatis mini-infobar
    promptPasang = e;            // simpan supaya bisa dipicu dari tombol kita
    console.log('[PWA] Aplikasi bisa dipasang (beforeinstallprompt).');
    tampilkanTombolHeader(true);
    suntikKartuDashboard();
  });

  window.addEventListener('appinstalled', function () {
    terpasangBaru = true;
    promptPasang = null;
    console.log('[PWA] Aplikasi berhasil dipasang.');
    tampilkanTombolHeader(false);
    hapusKartuDashboard();
    if (window.Swal) {
      Swal.fire({
        icon: 'success', title: 'Berhasil Dipasang!',
        text: 'SISIP sudah ada di layar utama perangkat Anda.',
        background: '#1e293b', color: '#fff', confirmButtonColor: '#2563eb'
      });
    }
  });

  /* ─────────────── 3. UI: tombol header & kartu dashboard ──────────────── */

  /** Tampilkan/sembunyikan tombol Pasang di header dashboard (id: btn-install-pwa). */
  function tampilkanTombolHeader(show) {
    const btn = document.getElementById(ID_BTN);
    if (!btn) return;
    btn.style.display = (show && !sudahTerpasang()) ? 'flex' : 'none';
  }

  /** Suntik tombol Pasang ke grup kanan header dashboard (sekali saja). */
  function suntikTombolHeader() {
    if (document.getElementById(ID_BTN)) return;
    const header = document.querySelector('#view-dashboard header.glass-header')
      || document.querySelector('header.glass-header');
    if (!header) return;
    const grup = header.lastElementChild; // grup kanan (jam, sesi, profil)
    if (!grup) return;

    const btn = document.createElement('button');
    btn.id = ID_BTN;
    btn.type = 'button';
    btn.title = 'Pasang SISIP ke layar utama';
    btn.className = 'hidden items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition shadow-md pwa-denut';
    btn.style.display = 'none';
    btn.innerHTML = '<i class="fa-solid fa-download"></i><span class="hidden sm:inline">Pasang</span>';
    btn.addEventListener('click', function () { pasangPWA(); });
    grup.insertBefore(btn, grup.firstChild);

    tampilkanTombolHeader(bisaDipasang() || butuhPetunjukManual());
  }

  /** Menu aktif (currentMenuId dideklarasikan app.js) — aman kalau belum ada. */
  function menuSekarang() {
    try { return (typeof currentMenuId === 'string' && currentMenuId) ? currentMenuId : ''; }
    catch (e) { return ''; }
  }

  /** Halaman dashboard (admin/guru = 'dashboard', murid = 'dashboard-murid')? */
  function diDashboard() {
    const m = menuSekarang();
    if (m === 'dashboard' || m === 'dashboard-murid') return true;
    // Fallback bila nama menu berbeda: cek view yang sedang tampil.
    const v = document.getElementById('view-dashboard');
    return !!v && !v.classList.contains('hidden') && m === '';
  }

  /** Kartu dashboard layak ditampilkan? */
  function kartuLayak() {
    if (sudahTerpasang()) return false;             // sudah dipasang → tak perlu
    if (bacaKunci(KUNCI_TOLAK)) return false;       // user memilih "Nanti saja"
    if (!bisaDipasang() && !butuhPetunjukManual()) return false; // tak ada cara pasang
    if (!diDashboard()) return false;
    const mc = document.getElementById('main-content');
    return !!mc && mc.children.length > 0;          // konten dashboard sudah jadi
  }

  function hapusKartuDashboard() {
    const k = document.getElementById(ID_KARTU);
    if (k && k.parentNode) k.parentNode.removeChild(k);
  }

  /** Buat & sisipkan kartu ajakan pasang di paling atas #main-content. */
  function suntikKartuDashboard() {
    if (document.getElementById(ID_KARTU)) return;
    if (!kartuLayak()) return;
    const mc = document.getElementById('main-content');
    if (!mc) return;

    const div = document.createElement('div');
    div.id = ID_KARTU;
    div.className = 'glass-card rounded-xl p-3 sm:p-4 mb-4 border border-blue-500/30';
    div.innerHTML = [
      '<div class="flex items-start gap-3">',
      '  <img src="assets/icon-192.png" alt="Ikon SISIP" class="w-10 h-10 rounded-lg shadow-md flex-shrink-0">',
      '  <div class="flex-1 min-w-0">',
      '    <p class="text-sm font-bold text-white flex items-center gap-1.5"><i class="fa-solid fa-mobile-screen-button text-blue-400"></i> Pasang Aplikasi SISIP</p>',
      '    <p class="text-[11px] text-slate-400 mt-0.5">Akses lebih cepat dari layar utama, tampil penuh tanpa alamat browser, dan tetap bisa dibuka saat sinyal lemah.</p>',
      '    <div class="flex items-center gap-2 mt-2">',
      '      <button type="button" data-pwa="pasang" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-[11px] font-bold transition shadow-md pwa-denut"><i class="fa-solid fa-download mr-1"></i> Pasang Sekarang</button>',
      '      <button type="button" data-pwa="nanti" class="text-slate-400 hover:text-slate-200 text-[11px] font-semibold px-2 py-1.5 transition">Nanti saja</button>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('\n');

    // Pakai listener (bukan onclick inline) supaya tidak bergantung CSP 'unsafe-inline'.
    div.querySelector('[data-pwa="pasang"]').addEventListener('click', function () { pasangPWA(); });
    div.querySelector('[data-pwa="nanti"]').addEventListener('click', function () { nantiPasangPWA(); });

    mc.insertBefore(div, mc.firstChild);
  }

  /* ─────────────────── 4. Aksi: pasang / nanti / petunjuk ──────────────── */

  /** Tombol "Pasang Sekarang" — pakai prompt bawaan atau petunjuk manual. */
  function pasangPWA() {
    if (bisaDipasang()) {
      promptPasang.prompt();
      promptPasang.userChoice.then(function (hasil) {
        console.log('[PWA] Pilihan pengguna pada prompt pasang:', hasil && hasil.outcome);
        promptPasang = null;
        tampilkanTombolHeader(false);
        hapusKartuDashboard();
      }).catch(function (err) { console.error('[PWA] userChoice gagal:', err); });
      return;
    }
    if (iniIOS()) { petunjukIOS(); return; }
    // Browser lain (mis. Firefox) → tak ada API pemasangan otomatis.
    if (window.Swal) {
      Swal.fire({
        icon: 'info', title: 'Pasang Lewat Menu Browser',
        html: '<div style="text-align:left;font-size:12px;line-height:1.7">Buka menu browser (titik tiga / <b>⋮</b>) lalu pilih <b>Pasang aplikasi</b> atau <b>Tambahkan ke layar utama</b>.</div>',
        background: '#1e293b', color: '#fff', confirmButtonColor: '#2563eb'
      });
    }
  }

  /** Tombol "Nanti saja" → sembunyikan kartu, jangan tanya lagi di perangkat ini. */
  function nantiPasangPWA() {
    tulisKunci(KUNCI_TOLAK, true);
    hapusKartuDashboard();
  }

  /** Petunjuk langkah demi langkah untuk iPhone/iPad (Safari). */
  function petunjukIOS() {
    if (!window.Swal) { alert('Buka menu Bagikan di Safari, lalu pilih "Tambahkan ke Layar Utama".'); return; }
    Swal.fire({
      title: 'Pasang di iPhone / iPad',
      html: [
        '<div style="text-align:left;font-size:12px;line-height:1.8">',
        '  <p><b>1.</b> Pastikan SISIP dibuka lewat <b>Safari</b>.</p>',
        '  <p><b>2.</b> Tekan tombol <b>Bagikan</b> <i class="fa-solid fa-arrow-up-from-bracket"></i> di bawah layar.</p>',
        '  <p><b>3.</b> Pilih <b>Tambahkan ke Layar Utama</b> <i class="fa-solid fa-square-plus"></i>.</p>',
        '  <p><b>4.</b> Tekan <b>Tambah</b> di kanan atas.</p>',
        '  <p style="margin-top:8px;color:#94a3b8">Setelah itu ikon SISIP muncul di layar utama seperti aplikasi biasa.</p>',
        '</div>'
      ].join('\n'),
      background: '#1e293b', color: '#fff', confirmButtonColor: '#2563eb', confirmButtonText: 'Mengerti'
    });
  }

  /* ─────────────── 5. Izin notifikasi (1x per perangkat) ───────────────── */

  function tanyaNotifikasi() {
    if (!('Notification' in window)) return;
    if (!diDashboard() || bacaKunci(KUNCI_NOTIF)) return;
    if (Notification.permission !== 'default') return;
    tulisKunci(KUNCI_NOTIF, true); // tandai sudah ditanya walau user belum menjawab

    if (!window.Swal) return;
    Swal.fire({
      icon: 'question', title: 'Aktifkan Notifikasi?',
      text: 'Izinkan SISIP mengirim pemberitahuan penting (mis. pengumuman sekolah) ke perangkat ini.',
      background: '#1e293b', color: '#fff',
      showCancelButton: true, confirmButtonText: 'Izinkan', cancelButtonText: 'Tidak',
      confirmButtonColor: '#2563eb', cancelButtonColor: '#475569'
    }).then(function (res) {
      if (!res.isConfirmed) return;
      Notification.requestPermission().then(function (izin) {
        console.log('[PWA] Izin notifikasi:', izin);
      }).catch(function (err) { console.warn('[PWA] Gagal minta izin notifikasi:', err); });
    });
  }

  /* ─────────────────────────── 6. Inisialisasi ─────────────────────────── */

  function mulaiPengamatan() {
    const mc = document.getElementById('main-content');
    if (!mc) return;
    const observer = new MutationObserver(function () {
      suntikKartuDashboard();
      tanyaNotifikasi();
    });
    // childList saja: kartu menghilang saat app.js mengganti isi #main-content.
    observer.observe(mc, { childList: true });
  }

  function init() {
    stempelBuild();
    bersihkanCacheBilaBedaBuild().catch(function (err) { console.warn('[SISIP] Pembersih cache gagal:', err); });
    daftarkanSW();
    suntikTombolHeader();
    tampilkanTombolHeader(bisaDipasang() || butuhPetunjukManual());
    mulaiPengamatan();
    suntikKartuDashboard();
    // Sebagian browser memicu beforeinstallprompt agak lambat → cek ulang.
    setTimeout(function () {
      tampilkanTombolHeader(bisaDipasang() || butuhPetunjukManual());
      suntikKartuDashboard();
      tanyaNotifikasi();
    }, 3000);
  }

  window.pasangPWA = pasangPWA;
  window.nantiPasangPWA = nantiPasangPWA;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
