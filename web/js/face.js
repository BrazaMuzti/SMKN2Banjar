/* =====================================================================
 * face.js — Pengenalan Wajah (face-api.js) untuk SISIP
 * ---------------------------------------------------------------------
 * Fitur:
 *   1. Tab "Registrasi Wajah" di halaman Manajemen Akun Murid:
 *        - daftar murid + status wajah (Aktif / Nonaktif / Belum)
 *        - ekstraksi descriptor dari foto Drive (via lh3 CORS-safe)
 *          ATAU langsung dari kamera, lalu simpan via RPC
 *          `simpan_wajah_murid` (security definer).
 *   2. Pemindaian wajah live di modal absensi (tombol "Face"):
 *        - daftar descriptor murid kelas diambil dari DB,
 *        - video kamera diproses di browser (tanpa kirim gambar),
 *        - pencocokan jarak Euclidean via faceapi.FaceMatcher,
 *        - saat cocok → set radio "H" (Hadir) + suara + highlight,
 *          memakai jalur simpan absen yang sudah ada (save_absen_masal).
 *
 * Library & model dimuat dari folder lokal (vendor/ + models/),
 * bukan CDN — ramah jaringan sekolah (offline setelah cache pertama).
 * ===================================================================== */

(() => {
  'use strict';

  // ------------------------------------------------------------------
  // 0. Konstanta
  // ------------------------------------------------------------------
  const MODELS_DIR = (document.baseURI || location.href).replace(/[^/]*$/, '') + 'models/';
  const JARAK_COCOK = 0.5;          // ambang jarak Euclidean utk "Hadir" (FaceMatcher default 0.6)
  const JARAK_KENAL = 0.6;          // ambang utk membuat matcher (di luar ini dianggap tak dikenal)
  const COOLDOWN_MS = 2500;         // jeda antar-matching orang yang sama
  const DETECT_INTERVAL_MS = 400;   // jeda antar-frame analisis saat pindai live (dulu 180 ms — terlalu berat utk ponsel kelas menengah)
  const JUMLAH_SAMPEL_MAKS = 6;     // jumlah maksimal sampel descriptor per murid (array-of-arrays, adopsi multi-pose repo referensi)

  let modelsLoaded = false;
  let modelsPromise = null;
  let modelsRinganPromise = null;   // promise muat model RINGAN (modal registrasi): detektor + landmarks saja
  let petaWajahCache = null;        // { nis: { descriptor:[128], status } } — cache tab registrasi
  let scanAktif = null;             // state pindai live (dihentikan total sebelum mulai ulang)
  let deteksiLoopToken = 0;         // membatalkan loop deteksi ringan kamera modal (naikkan utk berhenti)
  let hasilDeteksiLive = null;      // { descriptor:[128], skor, waktu } — descriptor terbaru loop ringan
  let bisuStatusLoop = false;       // bungkam pesan loop setelah wajah diambil (hindari menimpa pesan sukses)

  // ------------------------------------------------------------------
  // 1. Helper kecil (fallback bila globals app.js belum tersedia)
  // ------------------------------------------------------------------
  function fxEscape(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(s);
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fxToast(icon, title) {
    if (typeof showToast === 'function') return showToast(icon, title);
    if (typeof Swal !== 'undefined') {
      Swal.fire({ toast: true, position: 'top-end', icon, title: String(title || ''),
        showConfirmButton: false, timer: 2500, background: '#1e293b', color: '#fff' });
    } else {
      console.log('[' + icon + '] ' + title);
    }
  }
  function fxSupabase() {
    if (typeof supaClient !== 'undefined' && supaClient) return supaClient;
    throw new Error('Supabase belum siap. Muat ulang halaman.');
  }
  async function fxAmbilSemua(builder) {
    if (typeof supaAmbilSemua === 'function') return supaAmbilSemua(builder);
    const { data, error } = await builder;
    if (error) throw error;
    return data || [];
  }

  /** Deteksi error fetch yang gagal di LEVEL JARINGAN (bukan HTTP status).
   *  Contoh: Firefox "NetworkError when attempting to fetch resource.",
   *  Chrome "Failed to fetch", supabase "fetch failed", dsb.
   *  Mengenali pola ini → kembalikan pesan pengganti yang mudah dipahami;
   *  selain itu kembalikan null agar pemanggil memakai pesan aslinya. */
  function perjelasErrorJaringan(e, pesanPengganti) {
    const m = String((e && e.message) || e || '');
    const n = (e && e.name) || '';
    const indikasiJaringan = /networkerror|failed to fetch|fetch failed|load failed|net::err_|aborterror/i.test(m) || /networkerror|aborterror/i.test(n);
    return indikasiJaringan ? pesanPengganti : null;
  }

  // ------------------------------------------------------------------
  // 2. Pemuatan model (lokal, sekali pakai)
  // ------------------------------------------------------------------
  /** Pastikan library face-api sudah tersedia (throw bila belum dimuat). */
  function wajahApiAda() {
    if (!window.faceapi || typeof window.faceapi.nets === 'undefined') {
      throw new Error('Library pengenalan wajah belum dimuat. Periksa file vendor/face-api.min.js.');
    }
    return window.faceapi;
  }

  /** Muat satu "tugas unduhan model" dengan retry ber-backoff (percobaan = jeda.length + 1).
   *  Unduhan .bin besar (terutama face_recognition_model.bin ±6,4 MB) mudah terputus
   *  di jaringan lambat/bergoyang — backoff bertahap jauh lebih andal dari satu percobaan ulang. */
  async function muatModelDenganRetry(tugas, nama, jeda) {
    const jedaList = jeda || [];
    let percobaan = 0;
    for (;;) {
      try {
        await tugas();
        return;
      } catch (e) {
        percobaan++;
        if (percobaan > jedaList.length) throw e;
        console.warn('Muat ' + nama + ' gagal (percobaan ' + percobaan + '), mencoba ulang:', (e && e.message) || e);
        await new Promise(r => setTimeout(r, jedaList[percobaan - 1]));
      }
    }
  }

  async function pastikanModels() {
    if (modelsLoaded) return true;
    wajahApiAda();
    if (modelsPromise) return modelsPromise;
    const fa = window.faceapi;
    const muatSekali = async () => {
      // Guard isLoaded: net yang sudah dimuat (mis. oleh modal registrasi) tidak
      // diunduh ulang — hemat bandwidth & waktu di jaringan sekolah.
      if (!fa.nets.tinyFaceDetector.isLoaded) await fa.nets.tinyFaceDetector.loadFromUri(MODELS_DIR);
      if (!fa.nets.faceLandmark68Net.isLoaded) await fa.nets.faceLandmark68Net.loadFromUri(MODELS_DIR);
      if (!fa.nets.faceLandmark68TinyNet.isLoaded) await fa.nets.faceLandmark68TinyNet.loadFromUri(MODELS_DIR);
      if (!fa.nets.faceRecognitionNet.isLoaded) await fa.nets.faceRecognitionNet.loadFromUri(MODELS_DIR);
    };
    modelsPromise = (async () => {
      // 3 percobaan total (awal + 2 retry) dengan backoff 0,8 dtk → 2,5 dtk.
      await muatModelDenganRetry(muatSekali, 'model wajah', [800, 2500]);
      modelsLoaded = true;
    })();
    try {
      await modelsPromise;
    } catch (e) {
      modelsPromise = null;
      throw new Error('Gagal memuat model wajah: ' + (e && e.message ? e.message : e));
    }
    return true;
  }

  /**
   * Muat model RINGAN untuk modal Registrasi Wajah: hanya tiny face detector +
   * landmark 68 titik (±550 KB). Cukup untuk loop indikator & kotak scan kamera.
   * FaceRecognitionNet (±6,4 MB) sengaja TIDAK dimuat di sini — dipanggil
   * on-demand lewat pastikanNetRecok() tepat sebelum descriptor dihitung, sehingga
   * tombol "Gunakan Kamera" aktif jauh lebih cepat, terutama di jaringan sekolah.
   * Tidak mengubah modelsLoaded (jalur lengkap tetap dimuat saat absensi).
   */
  function pastikanModelsRingan() {
    if (modelsLoaded) return Promise.resolve(true); // sudah lengkap → tak perlu apa-apa
    wajahApiAda();
    if (modelsRinganPromise) return modelsRinganPromise;
    const fa = window.faceapi;
    const muatSekali = async () => {
      if (!fa.nets.tinyFaceDetector.isLoaded) await fa.nets.tinyFaceDetector.loadFromUri(MODELS_DIR);
      if (!fa.nets.faceLandmark68Net.isLoaded) await fa.nets.faceLandmark68Net.loadFromUri(MODELS_DIR);
      if (!fa.nets.faceLandmark68TinyNet.isLoaded) await fa.nets.faceLandmark68TinyNet.loadFromUri(MODELS_DIR);
    };
    modelsRinganPromise = (async () => {
      // 3 percobaan total (awal + 2 retry) dengan backoff bertahap, sama seperti jalur lengkap.
      await muatModelDenganRetry(muatSekali, 'model wajah (ringan)', [800, 2000]);
    })();
    return modelsRinganPromise;
  }

  /** Pastikan FaceRecognitionNet (net berat, descriptor 128 dimensi) sudah dimuat. */
  async function pastikanNetRecok() {
    const fa = wajahApiAda();
    if (fa.nets.faceRecognitionNet.isLoaded) return;
    await fa.nets.faceRecognitionNet.loadFromUri(MODELS_DIR);
  }

  // ------------------------------------------------------------------
  // 3. Foto siswa dari Google Drive — konversi CORS-safe
  // ------------------------------------------------------------------
  // drive.google.com/file/d/{ID}/view → lh3.googleusercontent.com/d/{ID}=w1200
  // (lh3 mengirim header Access-Control-Allow-Origin: * sehingga fetch lintas
  //  origin + canvas tidak "dikotori" — syarat membaca pixel wajah.)
  /** Ekstrak file ID Google Drive dari beragam bentuk tautan Drive. */
  function ekstrakIdDrive(url) {
    const u = String(url || '').trim();
    if (!u) return null;
    let m;
    // drive.google.com/file/d/{ID}/view|preview
    m = u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{6,})/);
    if (m) return m[1];
    // drive.google.com/uc|open|view|file → ...?id={ID} atau ...&id={ID}
    m = u.match(/drive\.google\.com\/[^?#]*[?&]id=([a-zA-Z0-9_-]{6,})/);
    if (m) return m[1];
    // drive.google.com/d/{ID} (tautan pendek dari beberapa menu berbagi)
    m = u.match(/drive\.google\.com\/d\/([a-zA-Z0-9_-]{6,})/);
    if (m) return m[1];
    // lh3.googleusercontent.com/d/{ID}=w... / =s...
    m = u.match(/googleusercontent\.com\/d\/([a-zA-Z0-9_-]{6,})/);
    if (m) return m[1];
    // drive.usercontent.google.com/download?id={ID}
    m = u.match(/usercontent\.google\.com\/[^?#]*[?&]id=([a-zA-Z0-9_-]{6,})/);
    if (m) return m[1];
    return null;
  }

  function urlFotoUntukCanvas(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    // Sudah domain CORS-aman milik Google — lewatkan apa adanya.
    if (/googleusercontent\.com/.test(u)) return u;
    const id = ekstrakIdDrive(u);
    if (id) return 'https://lh3.googleusercontent.com/d/' + id + '=w1200';
    return u; // domain lain diizinkan; fetch bisa gagal tanpa CORS → pesan jelas
  }

  /**
   * Muat URL foto menjadi HTMLImageElement siap deteksi (blob via fetch → objectURL).
   * Mencoba beberapa kandidat URL agar tahan terhadap perbedaan perilaku Google terhadap
   * permintaan anonim (fetch lintas origin TIDAK membawa cookie login Google, sedangkan
   * <img> di pratinjau ikut membawa cookie → foto bisa tampil namun fetch ditolak):
   *   1. lh3 w1200  (yang dipakai pratinjau; CORS-aman)
   *   2. lh3 s0      (ukuran asli, sering tersaji lebih longgar)
   *   3. ambil-foto-drive (edge function supabase dengan service account Google —
   *      SATU-SATUNYA jalur yang bisa menembus blokir berbagi anonim organisasi,
   *      karena SA tampil sebagai identitas Google yang sah, bukan browser anonim)
   *   4. drive.usercontent.google.com ...&export=download (endpoint unduhan anonim)
   *   5. URL mentah yang tersimpan (mis. drive.google.com/thumbnail?id=...&sz=w1000 —
   *      endpoint yang memang untuk penampil tanpa login)
   * Decode yang gagal TIDAK menghentikan loop: kandidat berikut tetap dicoba (satu
   * endpoint sering membalas halaman HTML sahaja padahal yang lain menyajikan gambarnya).
   * Penyebab kegagalan dibedakan: HTTP / bukan-gambar (file tak publik / diblokir server)
   * vs jaringan (fetch reject). Pesan error dari proxy (mis. "file di-lock organisasi")
   * ikut dipertahankan untuk menjelaskan kepada admin.
   */
  async function muatGambarDariUrl(url) {
    const sumber = String(url || '').trim();
    if (!sumber) throw new Error('Murid belum punya foto. Gunakan kamera.');
    const id = ekstrakIdDrive(sumber);
    const kandidat = [];
    if (id) {
      kandidat.push('https://lh3.googleusercontent.com/d/' + id + '=w1200');
      kandidat.push('https://lh3.googleusercontent.com/d/' + id + '=s0');
      // Proxy via service account — jalur andalan saat kebijakan organisasi memblokir
      // berbagi anonim (lihat komentar fungsi). Dipanggil fetch apa adanya; bila fungsi
      // belum di-deploy, fetch balas 404/HTML dan loop melanjutkan ke kandidat lain.
      if (typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL) {
        kandidat.push(String(SUPABASE_URL).replace(/\/+$/, '') + '/functions/v1/ambil-foto-drive?fileId=' + encodeURIComponent(id));
      }
      kandidat.push('https://drive.usercontent.google.com/download?id=' + id + '&export=download');
    }
    // URL mentah yang disimpan di DB (thumbnail anonim) — ukuran kecil, jadi cadangan terakhir.
    if (id && /^https?:\/\//i.test(sumber) && kandidat.indexOf(sumber) === -1) kandidat.push(sumber);
    const utama = urlFotoUntukCanvas(sumber);
    if (utama && kandidat.indexOf(utama) === -1) kandidat.push(utama);

    let httpStatus = 0;
    let gagalDecode = 0;
    let pesanProxy = ''; // pesan error server dari edge function (jalur service account)
    for (const t of kandidat) {
      if (!t) continue;
      const viaProxy = t.indexOf('/ambil-foto-drive?') !== -1;
      let resp;
      try {
        resp = await fetch(t, { mode: 'cors', referrerPolicy: 'no-referrer' });
      } catch (e) {
        console.warn('muatGambarDariUrl fetch (' + t + '):', e);
        continue; // coba kandidat berikutnya
      }
      if (!resp.ok) {
        httpStatus = resp.status;
        // Error dari proxy bermakna (mis. "file di-lock kebijakan organisasi") →
        // tangkap untuk pesan akhir yang menjelaskan daripada menyalahkan berbagi.
        if (viaProxy) {
          try { const j = await resp.json(); if (j && j.message) pesanProxy = String(j.message); } catch (e) { /* bukan JSON */ }
        }
        continue;
      }
      let blob;
      try {
        blob = await resp.blob();
      } catch (e) { continue; }
      if (!blob || !blob.size) continue;
      // Halaman HTML / JSON (mis. "buat akun" atau halaman verifikasi) bukan gambar —
      // tandai dan lanjut ke kandidat berikutnya (BUKAN throw).
      if (blob.type && !/^image\//i.test(blob.type)) { gagalDecode++; continue; }
      try {
        // blob: diblokir CSP (img-src di index.html tidak memuat blob:); data: diizinkan.
        // Decode lewat FileReader agar foto tetap tampil & pixel-nya bisa dibaca canvas.
        const dataUrl = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = () => rej(fr.error || new Error('FileReader gagal membaca blob'));
          fr.readAsDataURL(blob);
        });
        const img = new Image();
        img.src = dataUrl;
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
        return img;
      } catch (e) {
        console.warn('muatGambarDariUrl decode (' + t + '):', e && e.message ? e.message : e);
        gagalDecode++;
        continue; // jangan putus di kandidat pertama — kandidat lain mungkin tersaji
      }
    }

    const pesanShare = 'Kemungkinan file tidak di-share publik, tak lagi tersedia, atau kebijakan organisasi Google menonaktifkan berbagi tanpa login. Solusi cepat: gunakan tombol Kamera untuk memindai wajah langsung (tidak butuh akses foto).';
    if (pesanProxy) {
      throw new Error('Foto siswa gagal dimuat melalui semua jalur. ' + pesanProxy);
    }
    if (httpStatus === 403 || httpStatus === 404 || httpStatus === 410) {
      throw new Error('Foto tidak dapat diunduh (HTTP ' + httpStatus + '). ' + pesanShare);
    }
    if (gagalDecode) {
      throw new Error('Foto tidak dapat dibaca — server mengirim halaman/bukan gambar padahal pratinjau tampil lewat cookie login (berbagi anonim kemungkinan diblokir kebijakan organisasi). ' + pesanShare);
    }
    if (httpStatus) {
      throw new Error('Foto tidak dapat diunduh (HTTP ' + httpStatus + '). Coba lagi beberapa saat; bila tetap gagal, periksa izin berbagi file di Google Drive.');
    }
    throw new Error('Foto tidak dapat diunduh — koneksi/izin jaringan terganggu. ' + pesanShare);
  }

  // ------------------------------------------------------------------
  // 4. Deteksi + descriptor (sumber: Image / video / canvas)
  // ------------------------------------------------------------------
  async function deteksiSatuWajah(el, opts) {
    const fa = window.faceapi;
    const o = opts || {};
    const conf = o.scoreThreshold || 0.35;
    const inputSize = o.inputSize || 320;
    await pastikanNetRecok(); // descriptor 128-d butuh FaceRecognitionNet — muat on-demand bila belum ada
    const deteksi = await fa.detectSingleFace(el, new fa.TinyFaceDetectorOptions({ inputSize, scoreThreshold: conf }))
      .withFaceLandmarks(true)
      .withFaceDescriptor();
    return deteksi; // null bila tidak ada wajah
  }

  /**
   * Normalisasi wajah_descriptor dari DB (jsonb) → array berisi SATU ATAU LEBIH
   * vektor 128 angka. Data lama (flat [128 angka]) otomatis dibungkus → [[...]],
   * sehingga pembacaan tetap kompatibel sebelum/sesudah migrasi multi-sampel.
   * Mengembalikan `null` bila nilai tidak valid.
   */
  function normalisasiDescriptorWajah(d) {
    if (!d || !Array.isArray(d) || !d.length) return null;
    if (typeof d[0] === 'number') {
      return (d.length === 128 && d.every(x => typeof x === 'number')) ? [Array.from(d)] : null;
    }
    if (Array.isArray(d[0])) {
      const list = d
        .filter(x => Array.isArray(x) && x.length === 128 && x.every(n => typeof n === 'number'))
        .map(x => Array.from(x));
      return list.length ? list : null;
    }
    return null;
  }

  /** Jarak Euclidean dua vektor 128 (semakin kecil semakin mirip). */
  function jarakEuclidean(a, b) {
    const n = Math.min(a && a.length, b && b.length);
    let s = 0;
    for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s);
  }

  /** Perkiraan persentase kemiripan dari jarak Euclidean face-api (0.0 = identik). */
  function persenKemiripan(jarak) {
    const p = (1 - jarak) * 100;
    return Math.max(0, Math.min(99, Math.round(p)));
  }

  /** Bangun FaceMatcher dari daftar { nis, descriptor } (dari DB wajah_descriptor jsonb).
   *  Setiap NIS memakai SEMUA sampel descriptor-nya — FaceMatcher mengambil jarak
   *  MINIMUM ke semua sampel (min-distance matching). Satu pose tampak berbeda bagi
   *  model, makin banyak sampel makin tahan perubahan sudut/pencahayaan. */
  function buatMatcherDariPeta(peta) {
    const fa = window.faceapi;
    const labeled = [];
    Object.keys(peta || {}).forEach(nis => {
      const list = normalisasiDescriptorWajah(peta[nis] && peta[nis].descriptor);
      if (list && list.length) {
        labeled.push(new fa.LabeledFaceDescriptors(String(nis), list));
      }
    });
    if (!labeled.length) return null;
    return new fa.FaceMatcher(labeled, JARAK_KENAL);
  }

  // ------------------------------------------------------------------
  // 5. Akses data wajah di database
  // ------------------------------------------------------------------
  function pemanggilKini() {
    const cur = (typeof currentUser !== 'undefined') ? currentUser : null;
    if (!cur) return { nis: '', tipe: 'admin' };
    return {
      nis: String((cur.user && (cur.user['NIS'] || cur.user.NIS)) || cur.nis || cur.username || ''),
      tipe: String(cur.role || ((cur.user && cur.user['Jabatan']) || '') || '')
    };
  }

  /** Simpan/hapus data wajah lewat RPC (security definer).
   *  @param descriptor - satu vektor 128 ATAU array-of-arrays (multi-sampel, maks 6).
   *  @param mode       - 'ganti' (default): timpa seluruh data wajah murid;
   *                      'tambah': sisipkan 1 sampel di belakang data yang ada. */
  async function simpanWajahKeDb(nis, descriptor, status, mode) {
    const fa = fxSupabase();
    const pgl = pemanggilKini();
    const payload = {
      p_nis: String(nis),
      p_descriptor: descriptor ? descriptor : null,
      p_status: status || 'aktif',
      p_pemanggil_nis: pgl.nis,
      p_pemanggil_tipe: pgl.tipe,
      p_mode: mode || 'ganti'
    };
    const { data, error } = await fa.rpc('simpan_wajah_murid', payload);
    if (error) throw new Error(error.message || 'RPC simpan_wajah_murid gagal.');
    const hasil = (data && (data.status === 'success' || data.message)) ? data : { status: 'success' };
    if (hasil.status !== 'success') throw new Error(hasil.message || 'Server menolak penyimpanan.');
    return hasil;
  }

  /** Muat peta wajah semua murid terdaftar ({ nis_nip: {descriptor, status} }). */
  async function muatPetaWajah() {
    if (petaWajahCache) return petaWajahCache;
    const fa = fxSupabase();
    const rows = await fxAmbilSemua(
      fa.from('akun').select('nis_nip, wajah_descriptor, wajah_status')
        .eq('tipe', 'murid').not('wajah_descriptor', 'is', null)
    );
    const peta = {};
    (rows || []).forEach(r => {
      if (!r.wajah_descriptor) return;
      peta[String(r.nis_nip)] = {
        descriptor: normalisasiDescriptorWajah(r.wajah_descriptor),
        status: r.wajah_status || 'aktif'
      };
    });
    petaWajahCache = peta;
    return peta;
  }

  function statusMurid(peta, nis) {
    const w = peta && peta[String(nis)];
    if (!w || !w.descriptor) return 'belum';
    return w.status === 'aktif' ? 'aktif' : 'nonaktif';
  }

  /** Status wajah untuk sekumpulan NIS ({ nis: 'aktif'|'nonaktif'|'belum' }) — dipakai kolom "Status Wajah" pada tabel Daftar Murid. */
  async function ambilStatusWajah(nisList) {
    const peta = petaWajahCache || await muatPetaWajah();
    const hasil = {};
    (nisList || []).forEach(nis => { hasil[String(nis)] = statusMurid(peta, nis); });
    return hasil;
  }

  /** HTML badge status wajah utk disisipkan di tabel (dari BADGE_STATUS). */
  function htmlBadgeWajah(status) {
    return BADGE_STATUS[status] || BADGE_STATUS.belum;
  }

  /** Ikon status registrasi wajah (compact): check aktif / pause nonaktif / cross belum — dengan tooltip. */
  const IKON_STATUS_WAJAH = {
    aktif: '<span class="status-wajah-aktif inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500/15 text-green-400" title="Wajah terdaftar &amp; aktif — dipakai untuk absen wajah"><i class="fa-solid fa-check text-[11px]"></i></span>',
    nonaktif: '<span class="status-wajah-nonaktif inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-500/15 text-amber-400" title="Wajah terdaftar tapi dinonaktifkan — absen wajah dilewati"><i class="fa-solid fa-pause text-[11px]"></i></span>',
    belum: '<span class="status-wajah-belum inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/5 text-slate-500" title="Belum terdaftar wajah"><i class="fa-solid fa-xmark text-[11px]"></i></span>'
  };

  /** Ikon status wajah utk kolom status di tabel murid (fallback ke "belum" bila status tak dikenal). */
  function ikonStatusWajah(status) {
    return IKON_STATUS_WAJAH[status] || IKON_STATUS_WAJAH.belum;
  }

  /** Beri tahu app.js bahwa data wajah suatu murid berubah — utk segarkan kolom status tanpa reload halaman. */
  function beriTahuWajahTersimpan(nis, status) {
    if (typeof window.FaceWajahOnTersimpan !== 'function') return;
    try { window.FaceWajahOnTersimpan(String(nis), status); } catch (e) { console.error('FaceWajahOnTersimpan:', e); }
  }

  // ==================================================================
  // 6. TAB "REGISTRASI WAJAH" (halaman Manajemen Akun Murid)
  // ==================================================================
  const BADGE_STATUS = {
    aktif:  '<span class="px-2 py-0.5 rounded-full bg-green-500/20 text-green-300 border border-green-500/40 text-[9px] font-bold uppercase tracking-wider"><i class="fa-solid fa-check mr-1"></i>Aktif</span>',
    nonaktif: '<span class="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[9px] font-bold uppercase tracking-wider"><i class="fa-solid fa-pause mr-1"></i>Nonaktif</span>',
    belum:  '<span class="px-2 py-0.5 rounded-full bg-slate-600/30 text-slate-400 border border-white/10 text-[9px] font-bold uppercase tracking-wider"><i class="fa-solid fa-user-plus mr-1"></i>Belum</span>'
  };

  function barisMuridWajah(m, i) {
    const nis = String(m.nis_nip || '');
    const st = statusMurid(petaWajahCache, nis);
    const mini = m.url_foto
      ? `<img src="${fxEscape(urlFotoUntukCanvas(m.url_foto))}" alt="" class="w-7 h-7 rounded object-cover mr-2 inline-block align-middle bg-slate-700" loading="lazy" onerror="this.style.visibility='hidden'">`
      : '<span class="w-7 h-7 rounded mr-2 inline-flex items-center justify-center bg-slate-700 text-slate-500 text-[9px] align-middle"><i class="fa-solid fa-user"></i></span>';
    const tombolHapus = st !== 'belum'
      ? `<button onclick="if(window.FaceWajah)window.FaceWajah.hapusDataWajah('${nis.replace(/'/g, "\\'")}','${fxEscape(m.nama_lengkap || '')}')" class="px-2 py-1 rounded bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white text-[9px] font-bold transition" title="Hapus data wajah">Hapus</button>`
      : '';
    return `<tr class="hover:bg-white/5 border-b border-white/5">
        <td class="px-3 py-2 text-center text-slate-500">${i + 1}</td>
        <td class="px-3 py-2 font-mono text-slate-300">${nis}</td>
        <td class="px-3 py-2 text-slate-100">${mini}${fxEscape(m.nama_lengkap || '')}</td>
        <td class="px-3 py-2 text-center text-slate-400">${fxEscape(m.tingkat_kelas || '-')}</td>
        <td class="px-3 py-2 text-center">${BADGE_STATUS[st] || BADGE_STATUS.belum}</td>
        <td class="px-3 py-2 text-center">
          <button onclick="if(window.FaceWajah)window.FaceWajah.kelolaWajah('${nis.replace(/'/g, "\\'")}')" class="px-2 py-1 rounded bg-cyan-600/30 hover:bg-cyan-600 text-cyan-300 hover:text-white text-[9px] font-bold transition" title="Registrasi/kelola data wajah">${st === 'aktif' ? 'Kelola' : 'Registrasi'}</button>
          ${tombolHapus}
        </td>
      </tr>`;
  }

  async function renderRegistrasiWajah() {
    const panel = document.getElementById('tab-panel-wajah');
    if (!panel) return;
    panel.innerHTML = `<div class="p-4 text-center text-slate-300"><i class="fa-solid fa-circle-notch fa-spin text-xl mb-2"></i><br>Menyiapkan data wajah...</div>`;
    try {
      await pastikanModels();
      const fa = fxSupabase();
      const [daftar, peta] = await Promise.all([
        fxAmbilSemua(fa.from('akun').select('nis_nip, nama_lengkap, tingkat_kelas, url_foto').eq('tipe', 'murid')),
        muatPetaWajah()
      ]);
      petaWajahCache = peta;
      const kelasList = [...new Set((daftar || []).map(m => m.tingkat_kelas).filter(Boolean))]
        .sort((a, b) => String(a).localeCompare(String(b), 'id'));
      const selKelas = document.getElementById('wajah-filter-kelas');
      const kelasTerpilih = selKelas ? selKelas.value : 'ALL';
      const terfilter = (daftar || []).filter(m => kelasTerpilih === 'ALL' || String(m.tingkat_kelas) === String(kelasTerpilih));

      panel.innerHTML = `
        <div class="p-3 flex flex-col gap-3 h-full">
          <div class="flex flex-wrap items-center gap-2">
            <div class="flex-1 min-w-[180px]">
              <label class="text-[10px] uppercase tracking-wider text-slate-400 font-bold block mb-1"><i class="fa-solid fa-id-card mr-1"></i> Pendaftaran Wajah Siswa</label>
              <div class="flex flex-wrap items-center gap-2">
                <select id="wajah-filter-kelas" onchange="if(window.FaceWajah)window.FaceWajah.renderRegistrasiWajah()" class="h-8 bg-slate-700 border border-white/20 rounded-lg px-2 text-[10px] sm:text-[11px] text-white outline-none focus:border-cyan-400 cursor-pointer">
                  <option value="ALL">Semua Kelas</option>
                  ${kelasList.map(k => `<option value="${fxEscape(k)}" ${String(k) === String(kelasTerpilih) ? 'selected' : ''}>${fxEscape(k)}</option>`).join('')}
                </select>
                <button onclick="if(window.FaceWajah)window.FaceWajah.muatUlangPetaWajah()" class="h-8 bg-slate-600 hover:bg-slate-500 text-white px-3 rounded-lg text-[10px] font-bold transition" title="Muat ulang data wajah dari server"><i class="fa-solid fa-rotate-right mr-1"></i>Muat Ulang</button>
              </div>
            </div>
            <div class="text-[10px] text-slate-400 leading-relaxed text-right">
              <p><i class="fa-solid fa-circle-info text-cyan-400 mr-1"></i>Wajah terdaftar: <b class="text-white">${Object.keys(peta || {}).length}</b> murid.</p>
              <p class="max-w-[300px]">Pendaftaran memakai foto Drive siswa <b>atau</b> kamera. Pencocokan hanya di perangkat (gambar wajah tidak dikirim).</p>
            </div>
          </div>
          <div class="flex-1 overflow-auto custom-scrollbar bg-[#0b1220] rounded-lg border border-white/10">
            <table class="w-full text-left whitespace-nowrap">
              <thead class="sticky top-0 bg-slate-900 z-10 text-[10px] uppercase text-slate-400 shadow-md">
                <tr>
                  <th class="px-3 py-2 border-b border-white/10 text-center">#</th>
                  <th class="px-3 py-2 border-b border-white/10">NIS</th>
                  <th class="px-3 py-2 border-b border-white/10">Nama Lengkap</th>
                  <th class="px-3 py-2 border-b border-white/10 text-center">Kelas</th>
                  <th class="px-3 py-2 border-b border-white/10 text-center">Status Wajah</th>
                  <th class="px-3 py-2 border-b border-white/10 text-center">Aksi</th>
                </tr>
              </thead>
              <tbody class="text-xs text-slate-200">
                ${terfilter.map(barisMuridWajah).join('') || `<tr><td colspan="6" class="p-4 text-center text-slate-500 italic">Tidak ada murid.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>`;
    } catch (e) {
      console.error('renderRegistrasiWajah:', e);
      panel.innerHTML = `<div class="p-6 text-center text-red-400"><i class="fa-solid fa-triangle-exclamation text-2xl mb-2"></i><br>Gagal menyiapkan pendaftaran wajah.<br><span class="text-xs">${fxEscape(e && e.message ? e.message : e)}</span></div>`;
    }
  }

  function muatUlangPetaWajah() {
    petaWajahCache = null;
    renderRegistrasiWajah();
  }

  // ==================================================================
  // 7. KELOLA WAJAH per murid (form registrasi di halaman murid)
  // ==================================================================
  const SKOR_MIN_FOTO = 0.5; // skor deteksi minimal utk mengambil wajah dari foto
  const TIPS_POSE = [ // urutan saran pose registrasi multi-sampel (Fase 2 — adopsi repo referensi)
    'hadapkan wajah lurus ke kamera, cahaya dari depan',
    'miringkan kepala sedikit ke KIRI',
    'miringkan kepala sedikit ke KANAN',
    'menunduk sedikit ke bawah',
    'tengadahkan sedikit ke atas',
    'mendekat (≈40 cm) dengan ekspresi netral'
  ];
  let kameraBerjalan = null; // { stream, video } aktif saat ini

  /** Terjemahkan error getUserMedia menjadi pesan Indonesia yang bisa ditindaklanjuti. */
  function pesanKameraError(e) {
    const n = (e && e.name) || '';
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError') {
      return 'Izin kamera ditolak peramban. Klik ikon gembok di address bar → izinkan kamera, lalu coba lagi.';
    }
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') {
      return 'Tidak ada kamera terdeteksi di perangkat ini. Gunakan tombol "Gunakan Foto".';
    }
    if (n === 'NotReadableError' || n === 'TrackStartError') {
      return 'Kamera sedang dipakai aplikasi/peramban lain. Tutup aplikasi itu lalu klik "Gunakan Kamera" lagi.';
    }
    if (n === 'OverconstrainedError') {
      return 'Kamera tidak mendukung pengaturan yang diminta. Pilih kamera lain dari daftar.';
    }
    if (n === 'SecurityError' || n === 'PermissionDismissedError') {
      return 'Peramban memblokir akses kamera (butuh HTTPS atau localhost).';
    }
    return (e && e.message) ? e.message : String(e);
  }

  /** Buka stream kamera dengan FALLBACK BERANTAI.
   *  `kandidat` adalah daftar string facingMode ('environment'/'user') ATAU objek
   *  constraint video (mis. { deviceId: { exact } }). Kegagalan satu kandidat
   *  (perangkat tanpa kamera belakang → 'environment' tidak tersedia) TIDAK boleh
   *  menggagalkan pemindaian — lanjut ke kandidat berikutnya. Semua gagal → pesan
   *  ramah via pesanKameraError (dengan sekali percobaan ulang utk NotReadable
   *  transien, mis. kamera baru dilepas aplikasi lain). */
  async function bukaStreamKamera(kandidat, ukuran) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Kamera tidak tersedia di peramban ini (butuh HTTPS atau localhost).');
    }
    const size = ukuran || { width: { ideal: 1280 }, height: { ideal: 720 } };
    const daftar = (kandidat && kandidat.length) ? kandidat : ['user'];
    let errTerakhir = null;
    for (let putaran = 0; putaran < 2; putaran++) {
      for (const k of daftar) {
        try {
          const videoCfg = (typeof k === 'string')
            ? Object.assign({ facingMode: k }, size)
            : Object.assign({}, size, k || {});
          return await navigator.mediaDevices.getUserMedia({ video: videoCfg, audio: false });
        } catch (e) {
          errTerakhir = e;
          console.warn('bukaStreamKamera (putaran ' + putaran + ') kandidat ' + JSON.stringify(k) + ':', (e && e.message) || e);
        }
      }
      const transien = errTerakhir && (errTerakhir.name === 'NotReadableError' || errTerakhir.name === 'TrackStartError');
      if (!transien) break;
      await new Promise(r => setTimeout(r, 900));
    }
    const errAkhir = errTerakhir || new Error('Kamera tidak dapat diakses.');
    throw new Error(pesanKameraError(errAkhir));
  }

  async function mulaiKameraKe(videoEl, deviceId) {
    hentikanKamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Kamera tidak tersedia di peramban ini (butuh HTTPS atau localhost).');
    }
    const videoCfg = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
      : { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } };
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoCfg, audio: false });
    } catch (ePertama) {
      // NotReadableError sering transien (kamera baru saja dilepas aplikasi lain/
      // driver) → beri kesempatan kedua setelah jeda singkat sebelum menyerah.
      if (ePertama && (ePertama.name === 'NotReadableError' || ePertama.name === 'TrackStartError')) {
        await new Promise(r => setTimeout(r, 900));
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: videoCfg, audio: false });
        } catch (eKedua) {
          throw new Error(pesanKameraError(eKedua));
        }
      } else {
        throw new Error(pesanKameraError(ePertama));
      }
    }
    videoEl.srcObject = stream;
    videoEl.setAttribute('playsinline', 'true');
    await videoEl.play();
    kameraBerjalan = { stream, video: videoEl };
    return stream;
  }

  function hentikanKamera() {
    if (kameraBerjalan && kameraBerjalan.stream) {
      kameraBerjalan.stream.getTracks().forEach(t => t.stop());
    }
    // Bersihkan kotak scan dari overlay kamera (bila ada) — tidak boleh ada sisa bekas.
    if (kameraBerjalan && kameraBerjalan.overlay) {
      const ov = kameraBerjalan.overlay;
      const ctx = ov.getContext && ov.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, ov.width, ov.height);
    }
    deteksiLoopToken++;     // hentikan loop deteksi ringan kamera modal
    hasilDeteksiLive = null;
    bisuStatusLoop = false; // modal berikutnya menampilkan pesan loop kembali
    kameraBerjalan = null;
  }

  /** Gambar kotak deteksi + kerangka landmark pada overlay (mirror object-cover),
   *  memetakan koordinat frame video ke ukuran tampilan area kamera — sama seperti
   *  overlay modal absensi, sehingga "scan" kamera terlihat jelas oleh admin. */
  function gambarScanKamera(ctx, hasilDeteksi, oW, oH, videoEl) {
    if (!ctx || !hasilDeteksi || !videoEl) return;
    const vw = videoEl.videoWidth || 640;
    const vh = videoEl.videoHeight || 480;
    const elW = videoEl.clientWidth || oW;
    const elH = videoEl.clientHeight || oH;
    if (!elW || !elH) return;
    const s = Math.max(elW / vw, elH / vh);   // skala object-cover
    const offX = (elW - vw * s) / 2;
    const offY = (elH - vh * s) / 2;
    const b = hasilDeteksi.detection && hasilDeteksi.detection.box;
    const pts = hasilDeteksi.landmarks && hasilDeteksi.landmarks.positions;
    if (!b && !pts) return;
    if (b) {
      ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.strokeRect(offX + b.x * s, offY + b.y * s, b.width * s, b.height * s);
    }
    if (pts && pts.length) {
      ctx.fillStyle = 'rgba(34,211,238,0.30)';
      ctx.strokeStyle = 'rgba(34,211,238,0.50)';
      ctx.lineWidth = 1;
      for (let i = 0; i < pts.length; i++) {
        const px = offX + pts[i].x * s;
        const py = offY + pts[i].y * s;
        ctx.beginPath(); ctx.arc(px, py, 1.2, 0, Math.PI * 2); ctx.fill();
        if (i > 0) {
          ctx.beginPath();
          ctx.moveTo(offX + pts[i - 1].x * s, offY + pts[i - 1].y * s);
          ctx.lineTo(px, py); ctx.stroke();
        }
      }
    }
  }

  /**
   * Loop deteksi RINGAN untuk kamera depan (modal Registrasi Wajah).
   * inputSize 160 + TANPA FaceRecognitionNet per frame (net terberat) → indikator
   * hijau segar dalam 1–3 dtk di perangkat lemah. Descriptor dihitung sekali saat
   * klik dari deteksi+landmarks tersimpan (extractFaces), hasil tetap setara karena
   * FaceRecognitionNet membaca crop wajah ~150×150 dari kotak deteksi.
   * Status berubah begitu wajah terlihat. Tombol "Deteksi dari Kamera" MENUNGGU
   * hasil loop ini (jangan meluncurkan deteksi kedua yang bersaing di GPU/CPU).
   * Setelah wajah diambil, pesan loop dibungkam (bisuStatusLoop) agar tidak menimpa
   * pesan sukses; loop tetap berjalan supaya klik berikutnya instan.
   * overlayEl (opsional): canvas tempat kotak deteksi + landmark digambar live —
   * tanpa overlay ini modal registrasi tidak pernah menampilkan indikator visual.
   */
  async function loopDeteksiKameraLive(videoEl, setHasil, overlayEl) {
    const fa = window.faceapi;
    if (!fa || !videoEl) return;
    const token = ++deteksiLoopToken;
    hasilDeteksiLive = null;
    const opts = new fa.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.2 });
    let terakhir = 0;
    let pernahTerdeteksi = false;
    let gagalStreak = 0;          // frame gagal beruntun — di luarnya pesan error muncul
    let pesanGagalDitampilkan = false;
    if (overlayEl && kameraBerjalan) kameraBerjalan.overlay = overlayEl; // ikut dibersihkan saat kamera berhenti
    while (token === deteksiLoopToken && videoEl.isConnected && kameraBerjalan && kameraBerjalan.video === videoEl) {
      const now = Date.now();
      // Sinkronkan ukuran + bersihkan overlay tiap iterasi → kotak hilang saat wajah tak terlihat.
      let ctxOverlay = null;
      let oW = 0, oH = 0;
      if (overlayEl && overlayEl.isConnected) {
        oW = videoEl.clientWidth || 0;
        oH = videoEl.clientHeight || 0;
        if (oW && oH) {
          if (overlayEl.width !== oW) overlayEl.width = oW;
          if (overlayEl.height !== oH) overlayEl.height = oH;
          ctxOverlay = overlayEl.getContext('2d');
          if (ctxOverlay) ctxOverlay.clearRect(0, 0, oW, oH);
        }
      }
      if (now - terakhir < 120) { await new Promise(r => setTimeout(r, 60)); continue; }
      terakhir = now;
      if (videoEl.readyState < 2) { await new Promise(r => setTimeout(r, 200)); continue; }
      try {
        // Loop TIDAK menghitung descriptor (FaceRecognitionNet = bagian terberat).
        // Cukup deteksi + landmarks → indikator hijau muncul 1–3 dtk di perangkat
        // lemah. Descriptor dihitung SEKALI saat klik, dari box yang sudah ada.
        const d = await fa.detectSingleFace(videoEl, opts).withFaceLandmarks(true);
        if (token !== deteksiLoopToken) break;
        if (d) {
          gagalStreak = 0;
          pesanGagalDitampilkan = false;
          if (ctxOverlay) gambarScanKamera(ctxOverlay, d, oW, oH, videoEl);
          hasilDeteksiLive = { deteksi: d.detection, landmarks: d.landmarks, skor: d.detection.score, waktu: Date.now() };
          if (!pernahTerdeteksi) {
            pernahTerdeteksi = true;
            if (!bisuStatusLoop && typeof setHasil === 'function') setHasil('<i class="fa-solid fa-face-smile text-green-400 mr-1"></i>Wajah terdeteksi — klik <b>Deteksi dari Kamera</b> untuk mengambil.', 'text-green-300');
          }
        } else if (pernahTerdeteksi) {
          pernahTerdeteksi = false;
          if (!bisuStatusLoop && typeof setHasil === 'function') setHasil('<i class="fa-solid fa-video mr-1"></i>Wajah sempat terdeteksi — arahkan wajah kembali ke kamera bila indikator hilang.', 'text-amber-200');
        }
      } catch (e) {
        // Error frame TIDAK lagi ditelan senyap: dilaporkan ke konsol + pesan satu
        // kali per rentetan gagal — kondisi bermasalah tidak lagi membuat modal diam.
        gagalStreak++;
        console.error('loopDeteksiKameraLive frame #' + gagalStreak + ':', e);
        if (!pesanGagalDitampilkan && gagalStreak >= 5 && !bisuStatusLoop && typeof setHasil === 'function') {
          pesanGagalDitampilkan = true;
          setHasil('<i class="fa-solid fa-triangle-exclamation text-red-300 mr-1"></i>Gagal memproses frame kamera berulang kali. ' + fxEscape(e && e.message ? e.message : e), 'text-red-300');
        }
      }
      // Jeda singkat tetap diberikan walau deteksi lebih lambat dari interval: UI bernapas
      // dan beban inferensi tidak menumpuk saat perangkat lambat.
      await new Promise(r => setTimeout(r, 60));
    }
    // Bersihkan sisa gambar scan bila loop berhenti (modal/kamera ditutup).
    if (overlayEl) {
      const ctx = overlayEl.getContext && overlayEl.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, overlayEl.width, overlayEl.height);
    }
  }

  /** deviceId kamera yang sedang benar-benar dipakai (dari track stream aktif). */
  function kameraAktifDeviceId() {
    if (kameraBerjalan && kameraBerjalan.stream) {
      const track = kameraBerjalan.stream.getVideoTracks()[0];
      if (track && typeof track.getSettings === 'function') return track.getSettings().deviceId || '';
    }
    return '';
  }

  /** Isi dropdown pilihan kamera & pasang listener ganti kamera (sekali per modal).
   *  @param aktifIdOpsi - deviceId stream yang sedang dipakai pemanggil (selain modal
   *                       registrasi yang memakai kameraBerjalan), mis. pindai live. */
  async function isiDaftarKamera(selectEl, onGanti, aktifIdOpsi) {
    if (!selectEl || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    if (selectEl.dataset.terisi === '1') return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = (devices || []).filter(d => d.kind === 'videoinput');
      if (!videoDevices.length) return;
      const aktifId = aktifIdOpsi || kameraAktifDeviceId();
      const pilihanLama = selectEl.value || '';
      selectEl.innerHTML = '';
      videoDevices.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label && d.label.trim() ? d.label.trim() : ('Kamera ' + (i + 1));
        if (aktifId && d.deviceId === aktifId) opt.selected = true;
        selectEl.appendChild(opt);
      });
      if (!aktifId) selectEl.value = pilihanLama || (videoDevices[0] ? videoDevices[0].deviceId : '');
      selectEl.dataset.terisi = '1';
      if (selectEl.dataset.dipasang !== '1') {
        selectEl.dataset.dipasang = '1';
        selectEl.addEventListener('change', () => {
          const id = selectEl.value || '';
          if (id && id !== kameraAktifDeviceId() && typeof onGanti === 'function') onGanti(id);
        });
      }
    } catch (e) {
      console.error('isiDaftarKamera:', e);
    }
  }

  /** Rekam descriptor dari elemen (img/video) → { descriptor, skor } / throw. */
  async function hasilDeteksiKuat(el, label) {
    const d = await deteksiSatuWajah(el, { inputSize: 320, scoreThreshold: 0.2 });
    if (!d) throw new Error('Tidak ada wajah terdeteksi pada ' + label + '. Coba posisi wajah menghadap kamera & pencahayaan cukup.');
    // face-api menyimpan skor di detection.score — TIDAK ada d.score di tingkat atas.
    // Guard "kurang jelas" ini baru bekerja lewat detection.score (d.score undefined
    // dulu membuatnya selalu lolos & mematikan jalur kamera/foto).
    const skor = (d.detection && d.detection.score != null) ? d.detection.score : 0;
    if (skor < SKOR_MIN_FOTO) {
      throw new Error('Wajah terdeteksi tapi kurang jelas (skor ' + skor.toFixed(2) + '). Gunakan foto lebih terang/tajam.');
    }
    return { descriptor: Array.from(d.descriptor), skor };
  }

  /** Muat model face-api dengan batas waktu — modal tetap terbuka meski model lambat/gagal. */
  function pastikanModelsTepatWaktu(ms = 12000) {
    const pesanTimeout = 'Memuat model wajah terlalu lama (lebih dari ' + Math.round(ms / 1000) + ' detik). Periksa koneksi dan pastikan folder "models" tersaji oleh server, lalu muat ulang halaman dan coba lagi.';
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(pesanTimeout)), ms));
    return Promise.race([pastikanModels(), timeout]);
  }

  /** Muat model RINGAN dengan batas waktu (modal registrasi — lebih longgar: 25 dtk). */
  function pastikanModelsRinganTepatWaktu(ms = 25000) {
    const pesanTimeout = 'Memuat model wajah terlalu lama (lebih dari ' + Math.round(ms / 1000) + ' detik). Periksa koneksi dan pastikan folder "models" tersaji oleh server, lalu muat ulang halaman dan coba lagi.';
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(pesanTimeout)), ms));
    return Promise.race([pastikanModelsRingan(), timeout]);
  }

  async function kelolaWajah(nis) {
    const murid = (typeof cacheAkunMurid !== 'undefined' && cacheAkunMurid.find)
      ? cacheAkunMurid.find(m => String(m.nis_nip) === String(nis))
      : null;
    if (!murid) { fxToast('error', 'Data murid tidak ditemukan.'); return; }

    // Modal dibuka SEKETIKA (tanpa await di depan) — klik tombol tabel selalu diberi respons.
    // Model face-api dimuat di dalam modal (didOpen) supaya tombol "Gunakan Foto"/"Gunakan Kamera"
    // siap dipakai begitu model siap, tanpa menahan pembukaan modal.
    let sampelWajah = [];             // daftar descriptor (maks JUMLAH_SAMPEL_MAKS) — data multi-pose
    let skorSementara = 0;
    const st = statusMurid(petaWajahCache, nis);
    const nama = murid.nama_lengkap || '';
    const kelas = murid.tingkat_kelas || '';

    Swal.fire({
      title: `<div class="text-sm font-bold mt-1"><i class="fa-solid fa-face-viewfinder text-cyan-400 mr-2"></i>Foto Siswa</div>`,
      html: `
        <div class="flex items-start gap-3 justify-between mb-2">
          <div class="text-left flex-1">
            <p class="text-xs font-bold text-white">${fxEscape(nama)}</p>
            <p class="text-[10px] text-slate-400 font-mono">NIS ${nis} · ${fxEscape(kelas)}</p>
            <p class="mt-1">${BADGE_STATUS[st] || BADGE_STATUS.belum}</p>
          </div>
          <img id="wajah-preview" class="w-24 h-28 rounded-lg object-cover bg-slate-700 border border-white/10" src="" alt="Foto siswa">
        </div>
        <div class="flex justify-center items-center gap-1.5 bg-black/60 p-1 rounded-lg mb-2">
          <button id="btn-wajah-foto" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded px-2 py-1.5 text-[10px] font-bold transition" title="Gunakan foto siswa yang tersimpan di akun"><i class="fa-solid fa-image mr-1"></i>Gunakan Foto</button>
          <button id="btn-wajah-kamera" class="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white rounded px-2 py-1.5 text-[10px] font-bold transition" title="Pindai langsung dari kamera"><i class="fa-solid fa-camera mr-1"></i>Gunakan Kamera</button>
        </div>
        <div id="wajah-camera-area" class="hidden relative rounded-lg overflow-hidden border border-cyan-500 bg-black mb-2" style="display:none">
          <div class="flex items-center gap-2 bg-slate-900/80 px-2 py-1.5">
            <span class="text-[9px] uppercase tracking-wider text-slate-400 shrink-0"><i class="fa-solid fa-camera-rotate mr-1"></i>Kamera</span>
            <select id="camera-select" class="bg-slate-800 border border-white/10 text-white text-[10px] rounded px-1.5 py-1 flex-1 min-w-0 focus:outline-none focus:border-cyan-500" title="Pilih kamera"><option value="">Kamera bawaan</option></select>
          </div>
          <div class="relative">
            <video id="wajah-video" autoplay playsinline muted class="w-full h-52 object-cover" style="transform:scaleX(-1)"></video>
            <canvas id="wajah-overlay" class="absolute inset-0 w-full h-full pointer-events-none" style="transform:scaleX(-1)"></canvas>
          </div>
          <div id="wajah-panduan" class="px-2 py-1.5 bg-slate-900/70 border-t border-white/10 text-[10px] leading-relaxed text-slate-300">
            <b class="text-cyan-300">Posisi &amp; perintah:</b> hadapkan wajah lurus ke kamera · cahaya cukup dari depan · jarak 40–80 cm · tanpa masker/kacamata gelap. Gerakan kepala boleh pelan; begitu indikator hijau muncul, klik <b>Deteksi dari Kamera</b>.
          </div>
          <button id="btn-wajah-tangkap" class="w-full bg-cyan-600 hover:bg-cyan-700 text-white px-3 py-2.5 rounded-lg text-[11px] font-bold transition" title="Deteksi wajah dari frame kamera"><i class="fa-solid fa-camera mr-1"></i>Deteksi dari Kamera</button>
        </div>
        <div id="wajah-hasil" class="text-center text-[11px] min-h-[16px] mb-2 text-slate-300">${st === 'aktif' ? '<i class="fa-solid fa-circle-check text-green-400 mr-1"></i>Sudah terdaftar — menyimpan ulang akan menimpa wajah lama.' : 'Pilih sumber wajah (foto siswa atau kamera).'}</div>
        <div id="wajah-sampel-info" class="hidden mt-1 mb-2 text-[10px] text-slate-300 bg-slate-800/60 border border-white/10 rounded px-2 py-1.5 leading-relaxed"></div>
        <div class="flex gap-2">
          <button id="btn-wajah-simpan" disabled class="flex-1 bg-green-600 hover:bg-green-700 text-white rounded px-2 py-2 text-[10px] font-bold transition disabled:opacity-40 disabled:cursor-not-allowed"><i class="fa-solid fa-floppy-disk mr-1"></i>Simpan Data Wajah</button>
          ${st === 'aktif' ? `<button id="btn-wajah-nonaktif" class="bg-amber-600/30 hover:bg-amber-600 text-amber-300 hover:text-white rounded px-2 py-2 text-[10px] font-bold transition"><i class="fa-solid fa-pause mr-1"></i>Nonaktifkan</button>` : ''}
        </div>
      `,
      background: '#1e293b', color: '#fff', width: '440px',
      showConfirmButton: false, showCancelButton: true,
      cancelButtonText: 'Tutup',
      didOpen: async (popup) => {
        const cari = (id) => popup.querySelector('#' + id);
        const pratinjau = cari('wajah-preview');
        const hasilEl  = cari('wajah-hasil');
        const btnFoto  = cari('btn-wajah-foto');
        const btnKam   = cari('btn-wajah-kamera');
        const areaKam  = cari('wajah-camera-area');
        const videoEl  = cari('wajah-video');
        const btnTangkap = cari('btn-wajah-tangkap');
        const btnSimpan  = cari('btn-wajah-simpan');
        const btnNonaktif = cari('btn-wajah-nonaktif');
        const kameraPilih = cari('camera-select');
        const overlayEl = cari('wajah-overlay');
        const sampelInfoEl = cari('wajah-sampel-info');
        // Guard: elemen modal yang hilang TIDAK boleh terjadi senyap.
        ['wajah-preview','wajah-hasil','btn-wajah-foto','btn-wajah-kamera',
         'wajah-camera-area','wajah-video','btn-wajah-tangkap','btn-wajah-simpan',
         'wajah-overlay','wajah-sampel-info'].forEach((id) => {
          if (!cari(id)) console.error('[FaceWajah] Elemen #' + id + ' tidak ditemukan di dalam modal.');
        });

        const setHasil = (teks, warna) => {
          if (!hasilEl) return;
          hasilEl.innerHTML = teks;
          hasilEl.className = 'text-center text-[11px] min-h-[16px] mb-2 ' + (warna || 'text-slate-300');
        };
        const aktifkanSimpan = () => {
          if (!btnSimpan) return;
          const n = sampelWajah.length;
          btnSimpan.disabled = !n;
          if (!n) {
            btnSimpan.innerHTML = '<i class="fa-solid fa-floppy-disk mr-1"></i>Simpan Data Wajah';
          } else if (n === 1) {
            btnSimpan.innerHTML = '<i class="fa-solid fa-floppy-disk mr-1"></i>Simpan Wajah (skor ' + skorSementara.toFixed(2) + ')';
          } else {
            btnSimpan.innerHTML = '<i class="fa-solid fa-floppy-disk mr-1"></i>Simpan Wajah (' + n + ' sampel' + (n >= 3 ? ' — siap' : '') + ')';
          }
        };
        /** Tampilkan kemajuan sampel (jumlah, pose berikutnya, tombol bersihkan). */
        const renderInfoSampel = () => {
          if (!sampelInfoEl) return;
          const n = sampelWajah.length;
          if (!n) {
            sampelInfoEl.className = 'hidden';
            sampelInfoEl.innerHTML = '';
            return;
          }
          const pose = n < JUMLAH_SAMPEL_MAKS
            ? TIPS_POSE[(n - 1) % TIPS_POSE.length]
            : 'sudah maksimal — klik Simpan Data Wajah.';
          sampelInfoEl.className = 'mt-1 mb-2 text-[10px] text-slate-300 bg-slate-800/60 border border-white/10 rounded px-2 py-1.5 leading-relaxed';
          sampelInfoEl.innerHTML = '<i class="fa-solid fa-layer-group text-cyan-400 mr-1"></i><b>' + n + '/' + JUMLAH_SAMPEL_MAKS + ' sampel</b>' +
            (n < JUMLAH_SAMPEL_MAKS
              ? ' — pose berikutnya: <i class="text-cyan-200">' + pose + '</i>.'
              : ' · <i>' + pose + '</i>') +
            ' <button id="btn-wajah-kosongkan" class="underline text-red-300 hover:text-red-200 ml-1" title="Hapus semua sampel">hapus semua</button>';
          const btnKosong = sampelInfoEl.querySelector('#btn-wajah-kosongkan');
          if (btnKosong) btnKosong.addEventListener('click', () => {
            sampelWajah = [];
            skorSementara = 0;
            renderInfoSampel();
            aktifkanSimpan();
            setHasil('<i class="fa-solid fa-broom text-amber-300 mr-1"></i>Sampel dibersihkan. Deteksi dari kamera lagi atau gunakan foto.', 'text-amber-200');
          });
        };

        // Foto siswa: tampilkan fallback "Tanpa foto" bila akun tidak punya url_foto.
        if (pratinjau) {
          if (!murid.url_foto) {
            pratinjau.outerHTML = '<span id="wajah-preview" class="w-24 h-28 rounded-lg bg-slate-800 border border-white/10 flex items-center justify-center text-slate-500 text-xs"><i class="fa-solid fa-user-slash text-xl mb-1"></i><br>Tanpa foto</span>';
          } else {
            // Tampilkan via lh3 (ramah CORS). Bila peramban admin tidak login Google, lh3
            // bisa menolak → fallback ke URL mentah yang tersimpan (drive.google.com/thumbnail
            // memang dirancang untuk penampil anonim).
            pratinjau.src = urlFotoUntukCanvas(murid.url_foto);
            pratinjau.addEventListener('error', function fallbackFotoPratinjau() {
              if (this.src !== murid.url_foto && murid.url_foto) this.src = murid.url_foto;
            }, { once: true });
          }
        }

        // ===== Muat model DI DALAM modal — tidak lagi memblokir pembukaannya. =====
        if (btnFoto) btnFoto.disabled = true;
        if (btnKam) btnKam.disabled = true;
        setHasil('<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Menyiapkan model wajah…');
        try {
          await pastikanModelsRinganTepatWaktu(25000);
          if (btnFoto) btnFoto.disabled = false;
          if (btnKam) btnKam.disabled = false;
          setHasil(st === 'aktif'
            ? '<i class="fa-solid fa-circle-check text-green-400 mr-1"></i>Sudah terdaftar — menyimpan ulang akan menimpa wajah lama.'
            : 'Pilih sumber wajah (foto siswa atau kamera).');
        } catch (e) {
          console.error(e);
          setHasil(fxEscape(e.message || e), 'text-red-300');
          return;
        }

        // ===== Tombol "Gunakan Foto" — deteksi dari foto siswa (Drive) =====
        if (btnFoto) btnFoto.addEventListener('click', async () => {
          if (!murid.url_foto) {
            setHasil('<i class="fa-solid fa-triangle-exclamation text-amber-300 mr-1"></i>Murid belum punya foto profil. Gunakan <b>Gunakan Kamera</b> untuk memindai langsung.', 'text-amber-300');
            return;
          }
          try {
            const img = await muatGambarDariUrl(murid.url_foto);
            pratinjau.src = img.src;
            setHasil('<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Mendeteksi wajah pada foto...');
            const hasil = await hasilDeteksiKuat(img, 'foto');
            // Foto = mengganti SELURUH data wajah dengan 1 sampel (admin dianggap
            // memberi data sekali jalan; sampel kamera ditambahkan setelahnya).
            sampelWajah = [Array.isArray(hasil.descriptor) ? Array.from(hasil.descriptor) : hasil.descriptor];
            skorSementara = hasil.skor;
            renderInfoSampel();
            setHasil('<i class="fa-solid fa-check text-green-400 mr-1"></i>Wajah terdeteksi dari foto (skor ' + hasil.skor.toFixed(2) + ') — 1 sampel. Klik <b>Simpan Data Wajah</b> (menggantikan seluruh data wajah); untuk akurasi lebih tinggi tambah sampel kamera (berbagai sudut).', 'text-green-300');
            aktifkanSimpan();
          } catch (e) {
            console.error(e);
            setHasil(fxEscape(e.message || e), 'text-red-300');
          }
        });

        // ===== Tombol "Gunakan Kamera" — cek secure context dulu =====
        if (btnKam) btnKam.addEventListener('click', async () => {
          if (!window.isSecureContext) {
            setHasil('<i class="fa-solid fa-triangle-exclamation text-amber-300 mr-1"></i>Kamera hanya berfungsi di HTTPS atau localhost. Halaman ini dibuka lewat HTTP — gunakan <b>Gunakan Foto</b>, atau buka aplikasi lewat https:// / localhost.', 'text-amber-300');
            return;
          }
          try {
            setHasil('<i class="fa-solid fa-video mr-1"></i>Menunggu izin kamera — klik <b>Izinkan</b> bila peramban meminta…', 'text-amber-200');
            await mulaiKameraKe(videoEl);
            areaKam.classList.remove('hidden');
            areaKam.style.display = 'block';
            btnKam.disabled = true;
            // Isi daftar kamera setelah izin diberikan (label baru muncul saat itu),
            // lalu pasang listener ganti kamera → mulai ulang stream dengan device baru.
            await isiDaftarKamera(kameraPilih, async (deviceId) => {
              try {
                await mulaiKameraKe(videoEl, deviceId);
                setHasil('<i class="fa-solid fa-video mr-1"></i>Kamera diganti. Atur posisi wajah lalu klik <b>Deteksi dari Kamera</b>.');
              } catch (e) {
                console.error(e);
                setHasil(fxEscape(e.message || e), 'text-red-300');
                const aktifId = kameraAktifDeviceId();
                if (kameraPilih && aktifId) kameraPilih.value = aktifId;
              }
              loopDeteksiKameraLive(videoEl, setHasil, overlayEl); // mulai ulang loop ringan utk kamera baru
            });
            bisuStatusLoop = false;              // sesi kamera baru → status loop "bicara" lagi
            loopDeteksiKameraLive(videoEl, setHasil, overlayEl); // deteksi ringan berjalan langsung — status memberi tahu saat wajah terlihat
            setHasil('<i class="fa-solid fa-video mr-1"></i>Kamera aktif — atur posisi wajah. Indikator hijau muncul begitu wajah terdeteksi, lalu klik <b>Deteksi dari Kamera</b>.');
          } catch (e) {
            console.error(e);
            setHasil(fxEscape(e.message || e), 'text-red-300');
          }
        });

        if (btnTangkap) btnTangkap.addEventListener('click', async () => {
          if (!videoEl.srcObject) { setHasil('Nyalakan kamera dulu.', 'text-amber-300'); return; }
          setHasil('<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Memindai wajah…');
          let hasil = null;
          let pakaiLoop = false;   // true → hasil dari loop ringan (loop terus berjalan)
          try {
            // 1) Tunggu hasil SEGAR dari loop ringan (≤ 4 dtk). Loop kini deteksi-penuh
            //    tanpa FaceRecognitionNet → segar dalam 1–3 dtk bahkan di perangkat lambat.
            //    Descriptor dihitung SEKALI saat klik, MEREKAPLIKASI jalur internal
            //    `.withFaceDescriptor()`: landmarks.align → extractFaces → FaceRecognitionNet.
            const faWindow = window.faceapi;
            const batasTunggu = Date.now() + 4000;
            while (Date.now() < batasTunggu) {
              const segar = hasilDeteksiLive && (Date.now() - hasilDeteksiLive.waktu) < 3500;
              if (segar && faWindow && hasilDeteksiLive.landmarks) {
                try {
                  const aligned = hasilDeteksiLive.landmarks.align(null, { useDlibAlignment: true });
                  if (aligned) {
                    const crop = await faWindow.extractFaces(videoEl, [aligned]);
                    if (crop && crop.length) {
                      await pastikanNetRecok(); // net descriptor dimuat on-demand (bukan saat modal dibuka)
                      const d128 = await faWindow.nets.faceRecognitionNet.computeFaceDescriptor(crop[0]);
                      hasil = { descriptor: Array.from(d128), skor: hasilDeteksiLive.skor };
                      pakaiLoop = true;
                      break;
                    }
                  }
                } catch (e) {
                  console.warn('btnTangkap descriptor:', e); // box usang → jatuh ke one-shot
                }
              }
              await new Promise(r => setTimeout(r, 90));
            }
            // 2) Loop tak memberi hasil segar (mis. wajah baru muncul): hentikan loop dulu
            //    (anti tumpukan deteksi) lalu satu deteksi — kini inputSize 160 (setara
            //    loop, jauh lebih cepat dari 224) — dengan pengaman PANJANG (25 dtk)
            //    + status penghitung — perangkat lambat tidak lagi dicap "terlalu lama".
            if (!hasil) {
              if (!kameraBerjalan || !videoEl.srcObject) return; // modal/kamera sudah ditutup
              deteksiLoopToken++;                                // hentikan loop ringan sementara
              const mulai = Date.now();
              const progres = setInterval(() => {
                const dtk = Math.round((Date.now() - mulai) / 1000);
                setHasil('<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Memindai wajah… (' + dtk + ' dtk). Pastikan wajah lurus & tenang di area kamera.', 'text-slate-300');
              }, 3000);
              try {
                const d = await Promise.race([
                  deteksiSatuWajah(videoEl, { inputSize: 160, scoreThreshold: 0.2 }),
                  new Promise((_, rej) => setTimeout(() => rej(new Error('Pemindaian terlalu lama. Perangkat ini tampaknya lambat — hadapkan wajah lurus & tenang ke kamera, cukupi cahaya dari depan, lalu klik lagi.')), 25000))
                ]);
                if (d) hasil = { descriptor: Array.from(d.descriptor), skor: d.detection.score };
              } finally {
                clearInterval(progres);
              }
            }
          } catch (e) {
            console.warn('btnTangkap:', e);
            setHasil(fxEscape(e.message || e), 'text-amber-300');
            return;
          }
          if (!hasil) {
            setHasil('<i class="fa-solid fa-face-meh text-amber-300 mr-1"></i>Tidak ada wajah terdeteksi. Hadapkan wajah lurus ke kamera dengan cahaya cukup (posisi ±40–80 cm), lalu klik lagi.', 'text-amber-300');
            if (!pakaiLoop) loopDeteksiKameraLive(videoEl, setHasil, overlayEl); // hidupkan indikator otomatis lagi
            return;
          }
          if (hasil.skor < SKOR_MIN_FOTO) {
            setHasil('Wajah terdeteksi tapi kurang jelas (skor ' + hasil.skor.toFixed(2) + '). Mendekatlah sedikit / tambah cahaya, lalu klik lagi.', 'text-amber-300');
            if (!pakaiLoop) loopDeteksiKameraLive(videoEl, setHasil, overlayEl);
            return;
          }
          // Loop TETAP berjalan & hasilDeteksiLive sengaja tidak dikosongkan →
          // klik berikutnya kembali instan. Status loop dibungkam supaya tidak
          // menimpa pesan sukses di bawah.
          bisuStatusLoop = true;
          // Mode multi-sampel: setiap klik DETEKSI menambah sampel (maks 6).
          // Sampel yang TIDAK mirip dgn sampel lama (variasi pose) menaikkan akurasi.
          if (sampelWajah.length >= JUMLAH_SAMPEL_MAKS) {
            renderInfoSampel();
            setHasil('<i class="fa-solid fa-circle-exclamation text-amber-300 mr-1"></i>Sampel sudah maksimal (' + JUMLAH_SAMPEL_MAKS + '). Klik <b>Simpan Data Wajah</b>.', 'text-amber-300');
            return;
          }
          sampelWajah.push(Array.isArray(hasil.descriptor) ? Array.from(hasil.descriptor) : hasil.descriptor);
          skorSementara = hasil.skor;
          const canvas = document.createElement('canvas');
          canvas.width = videoEl.videoWidth || 640; canvas.height = videoEl.videoHeight || 480;
          canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
          const snap = cari('wajah-preview');
          if (snap) {
            if (snap.tagName !== 'IMG') snap.outerHTML = '<img id="wajah-preview" class="w-24 h-28 rounded-lg object-cover bg-slate-700 border border-white/10" alt="Foto siswa">';
            const imgSnap = cari('wajah-preview');
            if (imgSnap) imgSnap.src = canvas.toDataURL('image/jpeg', 0.85);
          }
          // Bila jalur one-shot (loop sempat dihentikan), nyalakan ulang supaya klik
          // berikutnya terlayani cepat oleh hasil loop (status loop tetap dibungkam).
          if (!pakaiLoop) loopDeteksiKameraLive(videoEl, setHasil, overlayEl);
          renderInfoSampel();
          // Beri tahu ADMIN kualitas sampel: jarak ke sampel terdekat (makin jauh
          // = pose makin bervariasi → makin menaikkan akurasi pencocokan).
          let pesanSampel = 'Wajah terdeteksi dari kamera (skor ' + hasil.skor.toFixed(2) + ') — sampel ke-' + sampelWajah.length + '.';
          if (sampelWajah.length >= 2) {
            const jarakMin = Math.min.apply(null, sampelWajah.slice(0, -1).map(s => jarakEuclidean(s, sampelWajah[sampelWajah.length - 1])));
            pesanSampel += ' Jarak ke sampel terdekat ' + jarakMin.toFixed(3) + ' (~' + persenKemiripan(jarakMin) + '% mirip).';
            if (jarakMin < 0.18) pesanSampel += ' <span class="text-amber-300">Pose terlalu mirip — ubah sedikit.</span>';
          }
          setHasil('<i class="fa-solid fa-check text-green-400 mr-1"></i>' + pesanSampel + ' <b>Simpan Data Wajah</b> atau klik Deteksi untuk pose berikutnya.', 'text-green-300');
          aktifkanSimpan();
        });

        if (btnSimpan) btnSimpan.addEventListener('click', async () => {
          if (!sampelWajah.length) return;
          btnSimpan.disabled = true;
          btnSimpan.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Menyimpan...';
          try {
            // Mode 'ganti': kirim SEMUA sampel sekali (array-of-arrays) → DB konsisten
            // tanpa panggilan berulang; RPC memvalidasi cap 6 di sisi server.
            await simpanWajahKeDb(nis, sampelWajah, 'aktif', 'ganti');
            if (petaWajahCache) petaWajahCache[String(nis)] = { descriptor: sampelWajah.slice(), status: 'aktif' };
            fxToast('success', 'Wajah ' + nama + ' tersimpan.');
            Swal.close();
            beriTahuWajahTersimpan(nis, 'aktif');
            refreshDaftarWajahTable();
          } catch (e) {
            console.error(e);
            setHasil(fxEscape(e.message || e), 'text-red-300');
            aktifkanSimpan();
          }
        });

        if (btnNonaktif) btnNonaktif.addEventListener('click', async () => {
          btnNonaktif.disabled = true;
          try {
            await simpanWajahKeDb(nis, null, 'nonaktif');
            if (petaWajahCache && petaWajahCache[String(nis)]) petaWajahCache[String(nis)].status = 'nonaktif';
            fxToast('success', 'Wajah ' + nama + ' dinonaktifkan.');
            Swal.close();
            beriTahuWajahTersimpan(nis, 'nonaktif');
            refreshDaftarWajahTable();
          } catch (e) {
            console.error(e);
            setHasil(fxEscape(e.message || e), 'text-red-300');
            btnNonaktif.disabled = false;
          }
        });
      },
      willClose: () => hentikanKamera()
    }).catch(() => {}).finally(hentikanKamera);
  }

  /** Hapus seluruh data wajah murid (konfirmasi dulu). Dipanggil dari tombol Hapus. */
  async function hapusDataWajah(nis, nama) {
    const conf = await Swal.fire({
      title: 'Hapus Data Wajah?',
      text: 'Semua data wajah ' + (nama || 'murid') + ' (NIS ' + nis + ') akan dihapus. Absensi wajah tidak akan mengenali lagi.',
      icon: 'warning', showCancelButton: true, confirmButtonText: 'Ya, Hapus', cancelButtonText: 'Batal',
      confirmButtonColor: '#dc2626', background: '#1e293b', color: '#fff'
    });
    if (!conf.isConfirmed) return;
    try {
      await simpanWajahKeDb(nis, null, '');
      if (petaWajahCache) delete petaWajahCache[String(nis)];
      fxToast('success', 'Data wajah dihapus.');
      beriTahuWajahTersimpan(nis, 'belum');
      refreshDaftarWajahTable();
    } catch (e) {
      console.error(e);
      fxToast('error', e.message || 'Gagal menghapus data wajah.');
    }
  }

  /** Segarkan tampilan wajah: panel lama (no-op setelah panel dihapus) + tabel Daftar Murid. */
  function refreshDaftarWajahTable() {
    renderRegistrasiWajah();
    if (typeof renderTabelMuridTerfilter === 'function') {
      try { renderTabelMuridTerfilter(); } catch (e) { console.error('refresh Daftar Murid:', e); }
    }
  }

  // ==================================================================
  // 8. PEMINDAIAN WAJAH LIVE DI MODAL ABSENSI
  // ==================================================================
  /** Hentikan pemindaian wajah (stream kamera + loop deteksi) bila aktif. */
  function berhentiPindaiWajah() {
    if (scanAktif) {
      scanAktif.hentikan = true;
      if (scanAktif.stream) scanAktif.stream.getTracks().forEach(t => t.stop());
      scanAktif = null;
    }
  }

  /**
   * Mulai pemindaian wajah live.
   * @param {Array} listMurid — daftar siswa modal absen ({ nis, nama, ... })
   * @param {Object} cfg     — { wrap: HTMLElement, onMatch: fn(nis) }
   *
   * URUTAN BARU (startup jauh lebih responsif):
   *   1) Janji model dimulai SEGERA (paralel) — dulu buka kamera MENUNGGU unduhan
   *      model ±6,4 MB selesai, itulah penyebab "mulai terasa macet".
   *   2) Kamera dibuka PARALEL dengan fetch data & unduhan model, memakai fallback
   *      berantai environment → user → default (perangkat tanpa kamera belakang
   *      dulu gagal total) + dropdown ganti kamera.
   *   3) Loop matching baru berjalan setelah model + data kelas siap, dengan
   *      indikator progres unduhan di bilah status.
   */
  async function mulaiPindaiWajahAbsen(listMurid, cfg) {
    berhentiPindaiWajah();
    const wrap = cfg && cfg.wrap;
    const onMatch = cfg && cfg.onMatch;
    if (!wrap) { fxToast('error', 'Wadah pemindaian tidak ditemukan.'); return; }

    // Janji model dimulai SEGERA — paralel dengan buka kamera & ambil data.
    const janjiModel = (async () => {
      try {
        await pastikanModels();
      } catch (e) {
        const ganti = perjelasErrorJaringan(e,
          'Gagal mengunduh model pengenalan wajah (koneksi/unduhan terputus). Muat ulang halaman lalu coba lagi — pastikan internet stabil dan folder "models" tersedia di server.');
        if (ganti) throw new Error(ganti);
        throw e;
      }
    })();

    // Wadah + video + dropdown kamera langsung tampil, bukan setelah model siap.
    wrap.innerHTML = `
      <div class="rounded-lg overflow-hidden border-2 border-cyan-500 bg-black mb-3">
        <div class="flex items-center gap-2 bg-slate-900/85 px-2 py-1">
          <span class="text-[9px] uppercase tracking-wider text-slate-400 shrink-0"><i class="fa-solid fa-camera-rotate mr-1"></i>Kamera</span>
          <select id="wajah-live-kamera" class="bg-slate-800 border border-white/10 text-white text-[10px] rounded px-1.5 py-1 flex-1 min-w-0 focus:outline-none focus:border-cyan-500" title="Pilih kamera"><option value="">Kamera bawaan</option></select>
        </div>
        <div class="relative">
          <video id="wajah-live-video" autoplay playsinline muted class="w-full h-56 object-cover"></video>
          <canvas id="wajah-live-overlay" class="absolute inset-0 w-full h-full pointer-events-none"></canvas>
          <div id="wajah-live-status" class="absolute top-2 left-2 right-2 text-center text-[11px] font-bold text-white drop-shadow-lg bg-black/40 rounded px-2 py-1">Menyiapkan kamera...</div>
          <button id="btn-wajah-live-stop" class="absolute bottom-2 right-2 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold px-2.5 py-1 rounded-lg shadow-lg">Berhenti</button>
        </div>
      </div>`;
    wrap.classList.remove('hidden');

    const video = document.getElementById('wajah-live-video');
    const overlay = document.getElementById('wajah-live-overlay');
    const statusEl = document.getElementById('wajah-live-status');
    const btnStop = document.getElementById('btn-wajah-live-stop');
    const selKamera = document.getElementById('wajah-live-kamera');

    const setStatus = (teks, warna) => {
      if (!statusEl || !statusEl.isConnected) return;
      statusEl.innerHTML = teks;
      statusEl.className = 'absolute top-2 left-2 right-2 text-center text-[11px] font-bold drop-shadow-lg bg-black/40 rounded px-2 py-1 ' + (warna || 'text-white');
    };

    // Ganti kamera live tanpa mengulang seluruh pemindaian.
    const gantiKameraPindai = async (deviceId) => {
      const streamLama = scanAktif && scanAktif.stream;
      const streamBaru = await bukaStreamKamera([{ deviceId: { exact: deviceId } }],
        { width: { ideal: 1280 }, height: { ideal: 720 } });
      if (!video || !video.isConnected) {
        streamBaru.getTracks().forEach(t => t.stop());
        return;
      }
      video.srcObject = streamBaru;
      await video.play();
      if (scanAktif) scanAktif.stream = streamBaru;
      if (streamLama) streamLama.getTracks().forEach(t => t.stop());
    };

    try {
      const nisList = [...new Set((listMurid || []).map(m => String(m.nis)).filter(Boolean))];
      // Ambil descriptor kelas (sudah multi-sampel) — paralel dengan kamera & model.
      const janjiData = (async () => {
        const mapKelas = {};
        if (!nisList.length) return mapKelas;
        try {
          const query = fxSupabase().from('akun').select('nis_nip, wajah_descriptor, wajah_status')
            .eq('tipe', 'murid').in('nis_nip', nisList).not('wajah_descriptor', 'is', null);
          const rows = await fxAmbilSemua(query);
          (rows || []).forEach(r => {
            if (r.wajah_status !== 'aktif') return;
            const list = normalisasiDescriptorWajah(r.wajah_descriptor);
            if (list && list.length) mapKelas[String(r.nis_nip)] = { descriptor: list };
          });
        } catch (e) {
          const ganti = perjelasErrorJaringan(e,
            'Gagal mengambil data wajah siswa dari server (koneksi ke database bermasalah). Periksa koneksi internet Anda, lalu coba lagi.');
          if (ganti) throw new Error(ganti);
          throw e;
        }
        return mapKelas;
      })();

      // Buka kamera: fallback berantai environment → user → tanpa facingMode.
      setStatus('<i class="fa-solid fa-video mr-1"></i>Menyiapkan kamera…');
      const stream = await bukaStreamKamera(['environment', 'user', {}],
        { width: { ideal: 1280 }, height: { ideal: 720 } });
      video.srcObject = stream;
      await video.play();
      scanAktif = { hentikan: false, stream };
      setStatus('<i class="fa-solid fa-video mr-1"></i>Kamera siap — memuat model pengenalan wajah… (bisa ±30 dtk di jaringan lambat)');

      // Dropdown kamera — label baru tersedia SETELAH izin diberikan.
      if (selKamera) {
        try {
          const trackUtama = stream.getVideoTracks && stream.getVideoTracks()[0];
          const aktifId = (trackUtama && typeof trackUtama.getSettings === 'function')
            ? (trackUtama.getSettings().deviceId || '') : '';
          await isiDaftarKamera(selKamera, async (deviceId) => {
            try {
              await gantiKameraPindai(deviceId);
              setStatus('<i class="fa-solid fa-video mr-1"></i>Kamera diganti.', 'text-cyan-100');
            } catch (e2) {
              console.error('ganti kamera pindai:', e2);
              setStatus('<i class="fa-solid fa-triangle-exclamation mr-1"></i>' + fxEscape(e2 && e2.message ? e2.message : e2), 'text-amber-200');
            }
          }, aktifId);
        } catch (e) {
          console.error('isi daftar kamera pindai:', e);
        }
      }

      // Tunggu data → matcher multi-sampel (min-distance).
      const peta = await janjiData;
      const matcher = buatMatcherDariPeta(peta);
      if (!matcher) {
        berhentiPindaiWajah();
        wrap.innerHTML = `<div class="rounded border border-amber-500/50 bg-amber-900/30 text-amber-200 text-xs p-3 mb-3 text-center"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Belum ada siswa di kelas ini yang terdaftar wajah.<br><span class="text-amber-100/70">Daftarkan lewat tombol <b>Registrasi</b> pada baris murid di menu <b>Data Akun Murid</b>.</span></div>`;
        return;
      }

      // Indikator progres unduhan model (layar tidak diam membisu).
      let progresModel = null;
      if (!modelsLoaded) {
        const t0 = Date.now();
        progresModel = setInterval(() => {
          setStatus('<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Menyiapkan model pengenalan wajah… (' + Math.round((Date.now() - t0) / 1000) + ' dtk).');
        }, 1500);
      }
      try {
        await janjiModel;
      } finally {
        if (progresModel) clearInterval(progresModel);
      }

      const cooldown = {}; // nis → last match timestamp
      const terdeteksi = new Set(); // nis yang susah cocok — beri tahu sekali
      if (btnStop) btnStop.addEventListener('click', () => berhentiPindaiWajah());

      setStatus('<i class="fa-solid fa-video mr-1"></i>Kamera menyala — hadapkan wajah ke kamera.');

      await loopDeteksiPindai({ wrap, video, overlay, matcher, peta, cooldown, terdeteksi, setStatus, onMatch, nisList });
    } catch (e) {
      console.error('mulaiPindaiWajahAbsen:', e);
      const pesanKamera = /notallowederror|permissiondenied|denied/i.test(String((e && e.message) || e))
        ? 'Izin kamera ditolak peramban. Buka izin kamera lalu klik Face Scan lagi.'
        : (e && e.message ? e.message : String(e));
      wrap.innerHTML = `<div class="rounded border border-red-500/50 bg-red-900/30 text-red-200 text-xs p-3 mb-3">${fxEscape(pesanKamera)}</div>`;
      berhentiPindaiWajah();
    }
  }

  /** Loop deteksi wajah pada video live sampai dihentikan / modal tertutup.
   *  inputSize 224 (bukan 320) + jeda DETECT_INTERVAL_MS (400 ms): beban inferensi
   *  per frame turun drastis → perangkat menengah tidak panas/lag dan deteksi tidak
   *  menumpuk. SEMUA sampel per NIS diikutkan via LabeledFaceDescriptors (min-distance).
   *  Catatan: `cooldown` dibaca dari `o.cooldown` (versi lama memakai nama `cooldown`
   *  yang tidak terdefinisi → ReferenceError begitu pertama kali cocok). */
  async function loopDeteksiPindai(o) {
    const fa = window.faceapi;
    const opts = new fa.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.2 });
    const cooldown = o.cooldown || {};        // nis → timestamp cocok terakhir
    let terakhir = 0;
    let hadirCount = 0;

    while (scanAktif && !scanAktif.hentikan && o.wrap.isConnected) {
      // Gambar tiap frame video atau canvas overlay agar bersih
      const overlay = o.overlay;
      const video = o.video;
      const cW = overlay.parentElement.clientWidth || video.clientWidth;
      const cH = overlay.parentElement.clientHeight || video.clientHeight;
      if (overlay.width !== cW) overlay.width = cW;
      if (overlay.height !== cH) overlay.height = cH;
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);

      // Batas kecepatan deteksi
      const now = Date.now();
      if (now - terakhir < DETECT_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, DETECT_INTERVAL_MS));
        continue;
      }
      terakhir = now;

      let deteksi = null;
      try {
        deteksi = await fa.detectSingleFace(video, opts).withFaceLandmarks(true).withFaceDescriptor();
      } catch (e) {
        if (scanAktif && !scanAktif.hentikan) o.setStatus('<i class="fa-solid fa-triangle-exclamation mr-1"></i>' + fxEscape(e && e.message ? e.message : 'Gagal memproses frame.'), 'text-amber-200');
        await new Promise(r => setTimeout(r, DETECT_INTERVAL_MS));
        continue;
      }

      if (!deteksi) {
        o.setStatus('<i class="fa-solid fa-face-smile mr-1"></i>Tidak ada wajah terdeteksi.');
        continue;
      }

      // Gambar bingkai deteksi pada overlay (koordinat video → layar)
      const disp = { width: cW, height: cH };
      const resized = fa.resizeResults(deteksi, disp);
      ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2;
      const b = resized.detection.box;
      ctx.strokeRect(b.x, b.y, b.width, b.height);

      let best = null;
      try { best = o.matcher.findBestMatch(deteksi.descriptor); } catch (e) { /* lanjut */ }

      if (best && best.label !== 'unknown' && best.distance <= JARAK_COCOK) {
        const nis = best.label;
        const dahulu = cooldown[nis] || 0;
        if (now - dahulu >= COOLDOWN_MS) {
          cooldown[nis] = now;
          let baruDitandai = true;
          if (typeof o.onMatch === 'function') {
            try { baruDitandai = o.onMatch(nis) !== false; } catch (e) { baruDitandai = true; }
          }
          if (baruDitandai) hadirCount += 1;
          ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 3;
          ctx.strokeRect(b.x, b.y, b.width, b.height);
          o.setStatus('<i class="fa-solid fa-circle-check mr-1" style="color:#4ade80"></i>Cocok! ' + fxEscape(nis) + ' — Hadir (' + hadirCount + '×) · kemiripan ~' + persenKemiripan(best.distance) + '%.', 'text-green-100');
        }
      } else {
        const namaCocok = best && best.label !== 'unknown'
          ? (best.label + ' jarak ' + best.distance.toFixed(2) + ' (~' + persenKemiripan(best.distance) + '% mirip)')
          : 'tidak dikenal (jarak ' + (best ? best.distance.toFixed(2) : '–') + ')';
        o.setStatus('<i class="fa-solid fa-arrows-up-down mr-1"></i>Wajah terdeteksi — ' + fxEscape(namaCocok) + '.', 'text-cyan-100');
      }
      await new Promise(r => setTimeout(r, DETECT_INTERVAL_MS));
    }
    berhentiPindaiWajah();
  }

  // ==================================================================
  // 8b. PEMINDAIAN WAJAH UNTUK ABSEN MANDIRI (verifikasi selfie)
  // ==================================================================
  /**
   * Verifikasi identitas murid pada Absen Mandiri: cocokkan wajah kamera depan
   * dengan descriptor milik NIS itu sendiri (single-label matcher, ambang
   * JARAK_COCOK = 0.5). Semua diproses di browser — gambar tidak dikirim.
   * Setelah cocok, kamera dihentikan & onHasil dipanggil.
   * @param {string} nis  — NIS murid yang sedang absen
   * @param {string} nama — nama murid (untuk pesan pada layar)
   * @param {Object} cfg  — { wrap: HTMLElement, onHasil: fn(nis) }
   */
  async function pindaiWajahMandiri(nis, nama, cfg) {
    berhentiPindaiWajah();
    const wrap = cfg && cfg.wrap;
    const onHasil = cfg && cfg.onHasil;
    if (!wrap) { fxToast('error', 'Wadah pemindaian tidak ditemukan.'); return false; }

    try {
      // Model dimulai SEGERA — kamera depan dinyalakan PARALEL (fallback user → default).
      const janjiModel = (async () => {
        try { await pastikanModels(); }
        catch (e) {
          const ganti = perjelasErrorJaringan(e,
            'Gagal mengunduh model pengenalan wajah (koneksi/unduhan terputus). Periksa koneksi & folder "models", lalu muat ulang halaman.');
          if (ganti) throw new Error(ganti);
          throw e;
        }
      })();

      const nisS = String(nis || '');
      if (!nisS) throw new Error('NIS pemanggil kosong.');

      // Ambil descriptor murid ini (mendukung MULTI-SAMPEL; data lama flat juga terbaca).
      const rows = await fxAmbilSemua(
        fxSupabase().from('akun').select('nis_nip, wajah_descriptor')
          .eq('tipe', 'murid').eq('nis_nip', nisS).eq('wajah_status', 'aktif').not('wajah_descriptor', 'is', null)
      );
      const row = (rows || [])[0];
      const daftarSampel = row ? normalisasiDescriptorWajah(row.wajah_descriptor) : null;
      if (!daftarSampel || !daftarSampel.length) {
        wrap.innerHTML = `<div class="rounded border border-amber-500/50 bg-amber-900/30 text-amber-200 text-[10px] p-2 mb-2 text-center">Wajah ${fxEscape(nama || nisS)} belum terdaftar/aktif.<br><span class="text-amber-100/70">Daftarkan di menu Manajemen Akun Murid → Registrasi Wajah.</span></div>`;
        return false;
      }

      const matcher = buatMatcherDariPeta({ [nisS]: { descriptor: daftarSampel } });
      if (!matcher) {
        wrap.innerHTML = `<div class="rounded border border-amber-500/50 bg-amber-900/30 text-amber-200 text-[10px] p-2 mb-2 text-center">Data wajah tidak valid.</div>`;
        return false;
      }

      wrap.innerHTML = `
        <div class="relative rounded-lg overflow-hidden border border-cyan-500 bg-black">
          <video id="wajah-mandiri-video" autoplay playsinline muted class="w-full h-40 object-cover" style="transform:scaleX(-1)"></video>
          <canvas id="wajah-mandiri-overlay" class="absolute inset-0 w-full h-full pointer-events-none" style="transform:scaleX(-1)"></canvas>
          <div id="wajah-mandiri-live-status" class="absolute top-1.5 left-1.5 right-1.5 text-center text-[10px] font-bold text-white drop-shadow-lg bg-black/40 rounded px-2 py-0.5">Menyiapkan kamera...</div>
          <button id="btn-wajah-mandiri-stop" class="absolute bottom-1.5 right-1.5 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold px-2 py-0.5 rounded shadow">Berhenti</button>
        </div>`;

      const video = document.getElementById('wajah-mandiri-video');
      const overlay = document.getElementById('wajah-mandiri-overlay');
      const statusEl = document.getElementById('wajah-mandiri-live-status');
      const btnStop = document.getElementById('btn-wajah-mandiri-stop');

      // Kamera: user → default (fallback berantai, tanpa 'environment').
      let stream;
      try {
        stream = await bukaStreamKamera(['user', {}], { width: { ideal: 640 }, height: { ideal: 480 } });
      } catch (e) {
        wrap.innerHTML = `<div class="rounded border border-red-500/50 bg-red-900/30 text-red-200 text-[10px] p-2 mb-2 text-center">Kamera tidak dapat diakses: ${fxEscape(e && e.message ? e.message : e)}</div>`;
        return false;
      }
      video.srcObject = stream;
      await video.play();
      scanAktif = { hentikan: false, stream };

      const setStatus = (teks, warna) => {
        statusEl.innerHTML = teks;
        statusEl.className = 'absolute top-1.5 left-1.5 right-1.5 text-center text-[10px] font-bold drop-shadow-lg bg-black/40 rounded px-2 py-0.5 ' + (warna || 'text-white');
      };
      setStatus('<i class="fa-solid fa-video mr-1"></i>Hadapkan wajah lurus ke kamera ±40–80 cm, cahaya dari depan, tanpa masker/kacamata gelap.');

      // Progres model (loop matching baru jalan setelah model siap — kamera tidak diam).
      let progresModel = null;
      if (!modelsLoaded) {
        const t0 = Date.now();
        progresModel = setInterval(() => {
          setStatus('<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Menyiapkan model wajah… (' + Math.round((Date.now() - t0) / 1000) + ' dtk).');
        }, 1500);
      }
      try {
        await janjiModel;
      } finally {
        if (progresModel) clearInterval(progresModel);
      }

      btnStop.addEventListener('click', () => berhentiPindaiWajah());

      await loopDeteksiPindai({
        wrap, video, overlay, matcher,
        peta: { [nisS]: { descriptor: daftarSampel } },
        cooldown: {}, terdeteksi: {}, setStatus, nisList: [nisS],
        onMatch: (nisCocok) => {
          if (String(nisCocok) !== nisS) return false; // hanya identitas sendiri
          if (typeof onHasil === 'function') {
            try { onHasil(nisCocok); } catch (e) { console.error('onHasil pindaiWajahMandiri:', e); }
          }
          berhentiPindaiWajah(); // cukup sekali cocok — hentikan kamera
          return false;
        }
      });
      return true;
    } catch (e) {
      console.error('pindaiWajahMandiri:', e);
      wrap.innerHTML = `<div class="rounded border border-red-500/50 bg-red-900/30 text-red-200 text-[10px] p-2 mb-2 text-center">${fxEscape(e && e.message ? e.message : e)}</div>`;
      berhentiPindaiWajah();
      return false;
    }
  }

  // ==================================================================
  // 8c. PRE-WARM MODEL — pindai & modal jadi instan
  // ==================================================================
  // Model (±6,4 MB) diunduh SAAT HALAMAN IDLE, bukan ketika admin menekan
  // Face Scan / membuka modal. Server aplikasi menyajikan folder models/ (di
  // jaringan lokal sekolah umumnya cepat & browser meng-cache), sehingga
  // pemindaian pertama tidak lagi menunggu unduhan besar. Gagal diam-diam:
  // jalur on-demand (pastikanModels) tetap bekerja seperti biasa.
  (function preWarmModelSaatIdle() {
    if (!window.faceapi || !window.faceapi.nets) return; // face-api belum dimuat — bukan urusan kita
    const mulai = () => { try { pastikanModels().catch(() => {}); } catch (e) { /* on-demand tetap ada */ } };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => {
        if (document.readyState === 'complete') mulai();
        else window.addEventListener('load', () => mulai(), { once: true });
      }, { timeout: 4000 });
    } else {
      if (document.readyState === 'complete') setTimeout(mulai, 600);
      else window.addEventListener('load', () => setTimeout(mulai, 600), { once: true });
    }
  })();

  // ==================================================================
  // 9. EKSPOR API PUBLIK
  // ==================================================================
  window.FaceWajah = {
    kelolaWajah,
    hapusDataWajah,
    muatPetaWajah,
    ambilStatusWajah,
    htmlBadgeWajah,
    ikonStatusWajah,
    renderRegistrasiWajah,
    muatUlangPetaWajah,
    mulaiPindaiWajahAbsen,
    berhentiPindaiWajah,
    pindaiWajahMandiri,
    urlFotoUntukCanvas
  };
})();