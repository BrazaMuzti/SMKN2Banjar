/* =====================================================================
 * face.js — Pengenalan Wajah SISIP (DUA MOTOR)
 * ---------------------------------------------------------------------
 * Motor wajah dihilihan per-browser (localStorage `sbg_wajah_motor`):
 *   'faceapi'   → vladmandic/face-api (TFJS, descriptor 128) — BAKU.
 *   'mediapipe' → MediaPipe Face Landmarker (wasm lokal) + MobileFaceNet
 *                 via ONNX Runtime Web (descriptor 512, models/mobilefacenet.onnx).
 * Semua motor sorun identiek interface: teteki serangkai FaceWajah
 * (pindai, registrasi, status) — de keuze blijft binnen deze file.
 * Library & model dimuat dari folder lokal (vendor/ + models/),
 * bukan CDN — ramah jaringan sekolah (offline setelah cache pertama).
 * ===================================================================== */

(() => {
  'use strict';

  // Animasi overlay pose registrasi (panah & label arah) — didefinisikan SEKALI di
  // <head> agar keyframes posePulse tersedia kapan pun modal kelolaWajah dibuka.
  (function sisipkanCssOverlayPose() {
    try {
      if (document.getElementById('sbg-pose-pulse-css')) return;
      const st = document.createElement('style');
      st.id = 'sbg-pose-pulse-css';
      st.textContent =
        '@keyframes posePulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.18);opacity:0.75}}';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) { console.warn('sisipkanCssOverlayPose:', e); }
  })();

  // ------------------------------------------------------------------
  // 0. Konstanta
  // ------------------------------------------------------------------
  const MODELS_DIR = (function () {
    // Hitung dari URL skrip face.js sendiri (path relatif `js/face.js` di index.html
    // selalu di-resolve browser ke lokasi asli `web/js/face.js`). Dari situ naik satu
    // level ke `models/`. Jauh lebih andal daripada document.baseURI/location.href yang
    // bisa memuat path filesistem (mis. server dev) → URL models 404.
    try {
      const s = (typeof document !== 'undefined' && document.currentScript) ||
                (typeof document !== 'undefined' && document.querySelector('script[src*="face.js"]'));
      if (s && s.src) return s.src.replace(/[^/]*$/, '') + '../models/';
    } catch (e) { /* lanjut ke fallback */ }
    return (document.baseURI || location.href).replace(/[^/]*$/, '') + 'models/';
  })();
  const JARAK_COCOK = 0.5;          // ambang jarak Euclidean utk "Hadir" (FaceMatcher default 0.6)
  const JARAK_KENAL = 0.6;          // ambang utk membuat matcher (di luar ini dianggap tak dikenal)
  const COOLDOWN_MS = 2500;         // jeda antar-matching orang yang sama
  const DETECT_INTERVAL_MS = 400;   // jeda antar-frame analisis saat pindai live (dulu 180 ms — terlalu berat utk ponsel kelas menengah)
  const JUMLAH_SAMPEL_MAKS = 6;     // jumlah maksimal sampel descriptor per murid (array-of-arrays, adopsi multi-pose repo referensi)
  const HENTIAN_AUTO_MS = 8000;     // jeda masa tenggang utk siswa terlambat setelah SEMUA terdaftar terdeteksi → kamera henti otomatis

  // ------------------------------------------------------------------
  // 0a. MOTOR WAJAH: DUA ENGINE (face-api baku ATAU MediaPipe + MobileFaceNet)
  // ------------------------------------------------------------------
  // Motor dihilihan per-browser via localStorage `sbg_wajah_motor`:
  //   'faceapi'   (BAKU) → vladmandic/face-api + TFJS (models/ face-api) —
  //                        descriptor 128; data wajah yang LAMA tetap cocok.
  //   'mediapipe' → MediaPipe Face Landmarker (deteksi + landmarks, wasm lokal
  //                 vendor/mediapipe/) + MobileFaceNet via ONNX Runtime Web
  //                 (descriptor 512, vendor/onnx/ + models/mobilefacenet.onnx).
  //                 SEMUA diproses lokal — gambar tidak dikirim (privasi).
  //                 Feature space MobileFaceNet != facenet → data wajah LAMA
  //                 (128) tetap disimpan maar TIDAK cocok: murid perlu
  //                 didaftaran ULANG (mode ganti) na pemilihan motor.
  // Test koneksi: supabase Dashboard → SQL Editor — jalankan migrasi
  // upgrade_20261023_wajah_motor_mediapipe.sql (RPC menerima 128/512).
  const DIM_WAJAH_LEGACY = 128;     // vektor face-api (schema RPC asal)
  const DIM_WAJAH_MEDIAPIPE = 512;  // vektor MobileFaceNet (ONNX) — RPC na migrasi
  const JARAK_COCOK_MP = 0.80;      // ambang "Hadir" motor mediapipe (jarak L2, deskriptor dinormalisasi)
  const JARAK_KENAL_MP = 0.95;      // ambang matcher motor mediapipe (di luar ini = tak dikenal)

  function motorWajah() {
    try {
      return localStorage.getItem('sbg_wajah_motor') === 'mediapipe' ? 'mediapipe' : 'faceapi';
    } catch (e) { return 'faceapi'; }
  }

  // State muat motor mediapipe (lazy, sekali pakai — naast modelsLoaded face-api).
  let mpLandmarkerLive = null;      // FaceLandmarker runningMode VIDEO (loop live)
  let mpLandmarkerStil = null;      // FaceLandmarker runningMode IMAGE (foto)
  let mpOrtSession = null;          // ort.InferenceSession (MobileFaceNet)
  let mpDimensiWajah = 0;           // dim descriptor (512) — dihitung saat model muat
  let mpModelsPromise = null;       // promise muat landmarker
  let mpOrtPromise = null;          // promise muat ONNX session

  function dimWajahMotor() {
    if (motorWajah() === 'mediapipe') return mpDimensiWajah || DIM_WAJAH_MEDIAPIPE;
    return DIM_WAJAH_LEGACY;
  }

  let modelsLoaded = false;
  let modelsPromise = null;
  let modelsRinganPromise = null;   // promise muat model RINGAN (modal kelolaWajah): detektor + landmarks saja
  let petaWajahCache = null;        // { nis: { descriptor:[128], status } } — cache status wajah
  let petaWajahCacheMotor = null;    // motor waarop petaWajahCache gebouwd (cache reset bij motor-switch)
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
  /** Pastikan library motor wajah sudah tersedia (throw bila belum dimuat). */
  function wajahApiAda() {
    if (motorWajah() === 'mediapipe') {
      if (typeof window.vision === 'undefined' || typeof window.ort === 'undefined') {
        throw new Error('Library pengenalan wajah (MediaPipe vision_bundle.js / ONNX Runtime Web) belum dimuat. Periksa file vendor/mediapipe/ + vendor/onnx/.');
      }
      return window.vision;
    }
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
    if (motorWajah() === 'mediapipe') return pastikanModelsMediapipe();
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
   * Muat model RINGAN untuk modal kelolaWajah: hanya tiny face detector +
   * landmark 68 titik (±550 KB). Cukup untuk loop indikator & kotak scan kamera.
   * FaceRecognitionNet (±6,4 MB) sengaja TIDAK dimuat di sini — dipanggil
   * on-demand lewat pastikanNetRecok() tepat sebelum descriptor dihitung, sehingga
   * tombol "Gunakan Kamera" aktif jauh lebih cepat, terutama di jaringan sekolah.
   * Tidak mengubah modelsLoaded (jalur lengkap tetap dimuat saat absensi).
   */
  function pastikanModelsRingan() {
    if (motorWajah() === 'mediapipe') return pastikanModelsMediapipe();
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

  /** Pastikan net descriptor (FaceRecognitionNet ATAU MobileFaceNet-ONNX) sudah dimuat. */
  async function pastikanNetRecok() {
    if (motorWajah() === 'mediapipe') { await pastikanOrtEmbedder(); return; }
    const fa = wajahApiAda();
    if (fa.nets.faceRecognitionNet.isLoaded) return;
    await fa.nets.faceRecognitionNet.loadFromUri(MODELS_DIR);
  }

  // ------------------------------------------------------------------
  // 2b. MOTOR MEDIAPIPE — FEMUAT MODEL (Face Landmarker + MobileFaceNet ONNX)
  // ------------------------------------------------------------------
  /** Muat MediaPipe Fileset (wasm lokal vendor/mediapipe/wasm/) + 2 FaceLandmarker. */
  async function pastikanModelsMediapipe() {
    if (modelsLoaded) return true;
    wajahApiAda();
    if (mpModelsPromise) return mpModelsPromise;
    mpModelsPromise = (async () => {
      const vis = window.vision;
      // Path relatif skrip (sama trick als MODELS_DIR) → base web/  (vendor + models).
      const dirMedia = MODELS_DIR.replace(/models\/?$/, '') + 'vendor/mediapipe/';
      const fileset = await vis.FilesetResolver.forVisionTasks(dirMedia + 'wasm/');
      const jalanModel = MODELS_DIR + 'face_landmarker.task';
      const lanciarLandmarker = async (modus) => {
        try {
          return await vis.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: jalanModel, delegate: 'CPU' },
            runningMode: modus, numFaces: 1,
            minFaceDetectionConfidence: 0.25,
            minFacePresenceConfidence: 0.25,
            minTrackingConfidence: 0.25
          });
        } catch (e) {
          // Fallback: parametra baku (createFromModelPath) — tetap satu instance werkbar.
          if (typeof vis.FaceLandmarker.createFromModelPath === 'function') {
            return await vis.FaceLandmarker.createFromModelPath(fileset, jalanModel);
          }
          throw e;
        }
      };
      const runModus = (live) => {
        const R = (typeof vis.RunningMode !== 'undefined') ? vis.RunningMode : null;
        if (R) return live ? R.VIDEO : R.IMAGE;
        return live ? 'VIDEO' : 'IMAGE';
      };
      mpLandmarkerLive = await lanciarLandmarker(runModus(true));
      mpLandmarkerStil = await lanciarLandmarker(runModus(false));
      modelsLoaded = true;
    })();
    try {
      await mpModelsPromise;
    } catch (e) {
      mpModelsPromise = null;
      throw new Error('Gagal memuat model wajah (MediaPipe): ' + ((e && e.message) || e));
    }
    return true;
  }

  /** Muat MobileFaceNet via ONNX Runtime Web + hitung dim descriptor (512). */
  async function pastikanOrtEmbedder() {
    if (mpOrtSession) return;
    wajahApiAda();
    if (mpOrtPromise) return mpOrtPromise;
    mpOrtPromise = (async () => {
      const dirOrt = MODELS_DIR.replace(/models\/?$/, '') + 'vendor/onnx/';
      const jalanOnnx = MODELS_DIR + 'mobilefacenet.onnx';
      const resp = await fetch(jalanOnnx, { mode: 'cors' });
      if (!resp.ok) {
        throw new Error('Model descriptor wajah tidak dapat diunduh (HTTP ' + resp.status + '). Periksa file models/mobilefacenet.onnx.');
      }
      const bytes = await resp.arrayBuffer();
      // wasmPaths (object): gebruik het RINGERE paar ort-wasm-simd-threaded.{mjs,wasm}
      // uit vendor/onnx/ (14MB) in plaats van het 28MB jsep-paar dat het script-tag
      // default zou zoeken. Fallback naar default gebeurt automatisch bij fout.
      mpOrtSession = await window.ort.InferenceSession.create(bytes, {
        executionProviders: ['WebAssembly'],
        numThreads: 1,
        wasmPaths: {
          mjs: dirOrt + 'ort-wasm-simd-threaded.mjs',
          wasm: dirOrt + 'ort-wasm-simd-threaded.wasm'
        }
      });
      // Dim dihitung via dummy forward — robust terhadap slamet model (128/512).
      const dummy = new window.ort.Tensor('float32', new Float32Array(3 * 112 * 112), [1, 3, 112, 112]);
      const naam = (typeof mpOrtSession.inputNames === 'object' && mpOrtSession.inputNames && mpOrtSession.inputNames.length)
        ? mpOrtSession.inputNames[0] : 'input';
      try {
        const out = await mpOrtSession.run({ [naam]: dummy });
        const key = Object.keys(out || {})[0];
        const sh = key && out[key] && out[key].shape ? out[key].shape : null;
        if (sh && sh.length && sh[1]) mpDimensiWajah = sh[1];
      } catch (e) { /* diplos hanya wanring — dim baku blijft 512 */ }
      if (!mpDimensiWajah) mpDimensiWajah = DIM_WAJAH_MEDIAPIPE;
    })();
    try {
      await mpOrtPromise;
    } catch (e) {
      mpOrtPromise = null;
      throw new Error('Gagal memuat model descriptor wajah (ONNX): ' + ((e && e.message) || e));
    }
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
    if (motorWajah() === 'mediapipe') {
      await pastikanModelsMediapipe();
      return await detektiWajahMediapipe(el, { descriptor: true });
    }
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
   * vektor angka (128 utk face-api / 512 utk MobileFaceNet-mediapipe). Data lama
   * (flat vektor) otomatis dibungkus → [[...]], sehingga pembacaan tetap
   * kompatibel voor en na migrasi multi-sampel.
   * @param dim - dimensi vektor waiterin; baku per motor aktief (dimWajahMotor()).
   * Mengembalikan `null` bila geen vektor valid.
   */
  function normalisasiDescriptorWajah(d, dim) {
    const dimW = dim || dimWajahMotor();
    if (!d || !Array.isArray(d) || !d.length) return null;
    if (typeof d[0] === 'number') {
      return (d.length === dimW && d.every(x => typeof x === 'number')) ? [Array.from(d)] : null;
    }
    if (Array.isArray(d[0])) {
      const list = d
        .filter(x => Array.isArray(x) && x.length === dimW && x.every(n => typeof n === 'number'))
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

  /** Bangun matcher dari daftar { nis, descriptor } (dari DB wajah_descriptor jsonb).
   *  Setiap NIS memakai SEMUA sampel descriptor-nya — matcher mengambil jarak
   *  MINIMUM ke semua sampel (min-distance matching). Satu pose tampak berbeda bagi
   *  model, makin banyak sampel makin tahan perubahan sudut/pencahayaan.
   *  Motor mediapipe → versi eigen (buatMatcherMediapipe) met dim 512; face-api
   *  → FaceMatcher (128). Ambang JARAK_KENAL / JARAK_KENAL_MP per motor. */
  function buatMatcherDariPeta(peta) {
    if (motorWajah() === 'mediapipe') return buatMatcherMediapipe(peta);
    const fa = window.faceapi;
    const labeled = [];
    Object.keys(peta || {}).forEach(nis => {
      const list = normalisasiDescriptorWajah(peta[nis] && peta[nis].descriptor);
      if (list && list.length) {
        // Wajib Float32Array — build face-api tertentu (mis. yang ter-bundle di
        // file vendor untuk ponsel) menolak Array biasa di konstruktor
        // LabeledFaceDescriptors ("expected descriptors to be an array of Float32Array").
        const floatList = list.map(v => (v instanceof Float32Array) ? v : new Float32Array(v));
        labeled.push(new fa.LabeledFaceDescriptors(String(nis), floatList));
      }
    });
    if (!labeled.length) return null;
    return new fa.FaceMatcher(labeled, JARAK_KENAL);
  }

  /** Matcher mediapipe: min-distance Euclidean vektori (512) dinormalisasi (alle sampel). */
  function buatMatcherMediapipe(peta) {
    const dim = dimWajahMotor();
    const daftar = [];
    Object.keys(peta || {}).forEach(nis => {
      const list = normalisasiDescriptorWajah(peta[nis] && peta[nis].descriptor, dim);
      if (list && list.length) {
        daftar.push({
          label: String(nis),
          samples: list.map(v => (v instanceof Float32Array) ? v : new Float32Array(v))
        });
      }
    });
    if (!daftar.length) return null;
    return {
      findBestMatch(desc) {
        const d0 = (desc instanceof Float32Array) ? desc : new Float32Array(desc);
        let best = null;
        for (let i = 0; i < daftar.length; i++) {
          const smp = daftar[i].samples;
          for (let j = 0; j < smp.length; j++) {
            const jar = jarakEuclidean(d0, smp[j]);
            if (!best || jar < best.distance) best = { label: daftar[i].label, distance: jar };
          }
        }
        if (!best || best.distance > JARAK_KENAL_MP) {
          return { label: 'unknown', distance: best ? best.distance : JARAK_KENAL_MP };
        }
        return { label: best.label, distance: best.distance, match: true };
      }
    };
  }

  // ------------------------------------------------------------------
  // 4b. DETEKSI + DESCRIPTOR — MOTOR MEDIAPIPE (Face Landmarker + MobileFaceNet)
  // ------------------------------------------------------------------
  // Face Landmarker (tasks-vision) draait BlazeFace + landmarks 478-punt dalam
  // wasm lokale (vendor/mediapipe/wasm/). Box wajah dihitung uit landmarks
  // (min/max + padding) zodat kontrak semantik met de bestaande overlay-code
  // identiek blijft: { detection: { box: {x,y,width,height} /* pixel frame */,
  // score }, landmarks: { positions: [{x,y} /* pixel */] } }.
  // Descriptor 512 via MobileFaceNet (ONNX Runtime Web), L2-dinormalisasi.
  let mpCanvasKe = null; // canvas offscreen pool utk baca pixel wajah

  /** Box wajah (pixel frame) dari landmarks 478 (normalized 0..1). */
  function mpBoksDariLandmarks(pts, w, h) {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i].x, py = pts[i].y;
      if (px < minX) minX = px; if (py < minY) minY = py;
      if (px > maxX) maxX = px; if (py > maxY) maxY = py;
    }
    const bw = Math.max(0.05, (maxX - minX) * 1.15); // 15% padding
    const bh = Math.max(0.05, (maxY - minY) * 1.15);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const x = Math.max(0, (cx - bw / 2) * w), y = Math.max(0, (cy - bh / 2) * h);
    return { x, y, width: Math.min(w, bw * w), height: Math.min(h, bh * h) };
  }

  /** Detect wajah sekali (motor mediapipe) — kembalikan hasil compat / null. */
  async function detektiWajahMediapipe(el, opts) {
    const o = opts || {};
    await pastikanModelsMediapipe();
    const w = el.videoWidth || el.naturalWidth || el.width || 0;
    const h = el.videoHeight || el.naturalHeight || el.height || 0;
    if (!w || !h) return null;
    let res = null;
    try {
      if (el.tagName === 'VIDEO') {
        res = mpLandmarkerLive.detectForVideo(el, o.timestampMs || Date.now());
      } else {
        res = mpLandmarkerStil.detect(el, Date.now());
      }
    } catch (e) {
      return null; // frame belum siap — caller geeft retry
    }
    const pts = res && res.faceLandmarks && res.faceLandmarks[0];
    if (!pts || !pts.length) return null;
    const positions = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) positions[i] = { x: pts[i].x * w, y: pts[i].y * h };
    const boks = mpBoksDariLandmarks(pts, w, h);
    let descriptor = null;
    if (o.descriptor) descriptor = await descriptorDariMediapipe(el, boks, w, h);
    return {
      detection: { box: boks, score: 0.85 }, // landmarks aanwezig ⇒ hoge confidence
      landmarks: { positions },
      descriptor,
      _frame: { w, h, at: Date.now() }
    };
  }

  /** Crop wajah dari frame → 112×112 → MobileFaceNet → descriptor (L2-normal). */
  async function descriptorDariMediapipe(el, box, w, h) {
    await pastikanOrtEmbedder();
    const srcW = w || el.videoWidth || el.naturalWidth || el.width || 0;
    const srcH = h || el.videoHeight || el.naturalHeight || el.height || 0;
    if (!srcW || !srcH) throw new Error('Frame wajah niet siap — coba lagi.');
    const b = box || { x: 0, y: 0, width: srcW, height: srcH };
    const cw = Math.max(8, Math.min(b.width, srcW - b.x));
    const ch = Math.max(8, Math.min(b.height, srcH - b.y));
    if (cw < 8 || ch < 8) throw new Error('Wajah terlalu kecil voor diproceso.');
    const cv = mpCanvasKe || (mpCanvasKe = document.createElement('canvas'));
    cv.width = 112; cv.height = 112;
    const ctx = cv.getContext('2d');
    ctx.drawImage(el, 0, 0, 112, 112, b.x, b.y, cw, ch);
    const px = ctx.getImageData(0, 0, 112, 112).data; // RGBA
    return await mpEmbedPixels(px);
  }

  /** Reken descriptor dari pixel RGBA 112×112 (konvension RGB — zelfde pipelin
   *  als validasi offline: (x−127.5)/127.5, CHW, L2-normalisasi). */
  async function mpEmbedPixels(px) {
    await pastikanOrtEmbedder();
    const n = 112 * 112;
    const inp = new Float32Array(3 * n);
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      const r = px[i * 4], g = px[i * 4 + 1], bl = px[i * 4 + 2];
      inp[o] = (r - 127.5) / 127.5;
      inp[o + 1] = (g - 127.5) / 127.5;
      inp[o + 2] = (bl - 127.5) / 127.5;
    }
    const t = new window.ort.Tensor('float32', inp, [1, 3, 112, 112]);
    const naam = (typeof mpOrtSession.inputNames === 'object' && mpOrtSession.inputNames && mpOrtSession.inputNames.length)
      ? mpOrtSession.inputNames[0] : 'input';
    const out = await mpOrtSession.run({ [naam]: t });
    const key = Object.keys(out || {})[0];
    const raw = (key && out[key] && out[key].data) ? out[key].data : null;
    if (!raw) throw new Error('Model descriptor gagal berekenen (output leeg).');
    const v = (raw instanceof Float32Array) ? raw : new Float32Array(raw);
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    const d = new Float32Array(v.length);
    if (norm > 1e-8) for (let i = 0; i < v.length; i++) d[i] = v[i] / norm;
    if (!mpDimensiWajah) mpDimensiWajah = d.length;
    return d;
  }

  /** Snapshot crop wajah (ImageData 128×128) op het moment van detectie in de
   *  ringan-loop — descriptor wordt DETERMINISTISCH uit deze zelfde frame berekend
   *  (landmarks MediaPipe zijn frame-gebonden; re-crop uit de huidige frame kan
   *  mismatch geven als leerling beweegt tussen detectie en klik). */
  function mpSnapshotFace(el, box) {
    try {
      const w = el.videoWidth || el.naturalWidth || el.width || 0;
      const h = el.videoHeight || el.naturalHeight || el.height || 0;
      if (!w || !h || !box) return null;
      const S = 128;
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const ctx = cv.getContext('2d');
      const cw = Math.max(8, Math.min(box.width, w - box.x));
      const ch = Math.max(8, Math.min(box.height, h - box.y));
      ctx.drawImage(el, 0, 0, S, S, box.x, box.y, cw, ch);
      return ctx.getImageData(0, 0, S, S);
    } catch (e) {
      console.warn('mpSnapshotFace:', e);
      return null;
    }
  }

  /** Descriptor dari snapshot ImageData (zie mpSnapshotFace): schalen naar 112² → embed. */
  async function descriptorDariImageDataKe(snap) {
    if (!snap) return null;
    try {
      await pastikanOrtEmbedder();
      const tmp = document.createElement('canvas');
      tmp.width = snap.width; tmp.height = snap.height;
      tmp.getContext('2d').putImageData(snap, 0, 0);
      const cv = document.createElement('canvas');
      cv.width = 112; cv.height = 112;
      const ctx = cv.getContext('2d');
      ctx.drawImage(tmp, 0, 0, 112, 112, 0, 0, snap.width, snap.height);
      const px = ctx.getImageData(0, 0, 112, 112).data;
      return await mpEmbedPixels(px);
    } catch (e) {
      console.warn('descriptorDariImageDataKe:', e);
      return null;
    }
  }

  // ------------------------------------------------------------------
  // 5. Akses data wajah di database
  // ------------------------------------------------------------------
  function pemanggilKini() {
    const cur = (typeof currentUser !== 'undefined') ? currentUser : null;
    if (!cur) return { nis: '', tipe: 'admin' };
    const u = cur.user || {};
    // Murid → NIS; guru → NIP / "ID Akun Guru"; fallback ke username.
    const idPemanggil = String(
      u['NIS'] || u.NIS || u['NIP'] || u.NIP || u['ID Akun Guru'] || u.nipGuru ||
      cur.nis || cur.nipGuru || cur.username || ''
    );
    return {
      nis: idPemanggil,
      tipe: String(cur.role || u['Jabatan'] || '')
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
      p_mode: mode || 'ganti',
      // [FASE B] Token sesi server (murid lokal) — diverifikasi RPC
      // `simpan_wajah_murid` (upgrade_20261028b2_token_rpc_murid.sql).
      p_token: (typeof getToken === 'function') ? getToken() : ''
    };
    const { data, error } = await fa.rpc('simpan_wajah_murid', payload);
    if (error) throw new Error(error.message || 'RPC simpan_wajah_murid gagal.');
    const hasil = (data && (data.status === 'success' || data.message)) ? data : { status: 'success' };
    if (hasil.status !== 'success') throw new Error(hasil.message || 'Server menolak penyimpanan.');
    return hasil;
  }

  /** Muat peta wajah semua murid terdaftar ({ nis_nip: {descriptor, status} }).
   *  Cache is MOTOR-specifiek (dimensi descriptor 128/512) — na motor-switch
   *  wordt de peta vers gebouwd zodat oude (128) rijen niet door de normalisasi
   *  van de andere motor als 'aktif' blijven meetellen. */
  async function muatPetaWajah() {
    if (petaWajahCache && petaWajahCacheMotor === motorWajah()) return petaWajahCache;
    const fa = fxSupabase();
    // [FASE B] Peta wajah dibaca lewat RPC `ambil_peta_wajah` (tabel akun RLS ketat).
    const rows = await akunPetaWajah();
    const peta = {};
    (rows || []).forEach(r => {
      if (!r.wajah_descriptor) return;
      peta[String(r.nis_nip)] = {
        descriptor: normalisasiDescriptorWajah(r.wajah_descriptor),
        status: r.wajah_status || 'aktif'
      };
    });
    petaWajahCache = peta;
    petaWajahCacheMotor = motorWajah();
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

  /** Badge status wajah penuh (dipakai `htmlBadgeWajah` & header modal `kelolaWajah`). */
  const BADGE_STATUS = {
    aktif:  '<span class="px-2 py-0.5 rounded-full bg-green-500/20 text-green-300 border border-green-500/40 text-[9px] font-bold uppercase tracking-wider"><i class="fa-solid fa-check mr-1"></i>Aktif</span>',
    nonaktif: '<span class="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[9px] font-bold uppercase tracking-wider"><i class="fa-solid fa-pause mr-1"></i>Nonaktif</span>',
    belum:  '<span class="px-2 py-0.5 rounded-full bg-slate-600/30 text-slate-400 border border-white/10 text-[9px] font-bold uppercase tracking-wider"><i class="fa-solid fa-user-plus mr-1"></i>Belum</span>'
  };

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
  // 6. KELOLA WAJAH per murid (form registrasi)
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
  const AUTO_POLL_MS = 900;         // jeda poll loop auto-mindai registrasi (hasilDeteksiLive segar ~2×/dtk)
  const AUTO_JEDA_MS = 1500;        // jeda minimal antar percobaan/ambilan sampel auto
  const POSO_MIN_JARAK = 0.25;      // sampel baru harus ≥ jarak Euclidean ini dari sampel terdekat (pose bervariasi)
  const POSO_MIN_JARAK_FALLBACK = 0.12; // pose stagnan >4 dtk (semua percobaan mirip) → sampel tetap ditambah (anti-macet)
  let kameraBerjalan = null; // { stream, video } aktif saat ini

  /** Label arah setiap pose registrasi (indeks sama dengan TIPS_POSE) utk overlay animasi wajah. */
  const POSE_ARAH = ['LURUS', 'KIRI', 'KANAN', 'BAWAH', 'ATAS', 'DEKAT'];
  /** Ikon FontAwesome utk tiap pose (indeks sama dengan TIPS_POSE). */
  const POSE_IKON = [
    '<i class="fa-solid fa-arrows-up-down text-white/90"></i>',
    '<i class="fa-solid fa-arrow-rotate-left text-white/90"></i>',
    '<i class="fa-solid fa-arrow-rotate-right text-white/90"></i>',
    '<i class="fa-solid fa-arrow-down text-white/90"></i>',
    '<i class="fa-solid fa-arrow-up text-white/90"></i>',
    '<i class="fa-solid fa-arrows-left-right-to-line text-white/90"></i>'
  ];

  /** Bicarakan teks memakai SpeechSynthesis (mantap: batalkan ucapan lama, bahasa Indonesia). */
  function ucapkanTTS(teks) {
    try {
      if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(teks);
      u.lang = 'id-ID';
      u.rate = 0.95;
      u.pitch = 1.05;
      window.speechSynthesis.speak(u);
    } catch (e) {
      console.warn('ucapkanTTS:', e); // TTS gagal diam-diam — bukan kegagalan fatal
    }
  }

  /** Perbarui elemen overlay pose (panah + label arah) milik modal kelolaWajah.
   *  Overlay hanyalah lapisan transparan di atas kamera — animasi wajah SVG/panah
   *  digambar via CSS gif + teks arah, dipanggil tiap pose berganti. */
  function updateOverlayPose(overlayEl, idx) {
    if (!overlayEl || overlayEl.dataset.matikan === '1') return;
    const ikon = POSE_IKON[(idx || 0) % POSE_IKON.length];
    const arah = POSE_ARAH[(idx || 0) % POSE_ARAH.length];
    overlayEl.innerHTML =
      '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;background:rgba(0,0,0,0.10);border:1.5px dashed rgba(255,255,255,0.32);border-radius:12px">' +
        '<div style="font-size:30px;line-height:1;text-shadow:0 2px 6px rgba(0,0,0,0.6);animation:posePulse 1.6s ease-in-out infinite">' + ikon + '</div>' +
        '<div style="margin-top:6px;font-size:10px;font-weight:900;letter-spacing:2px;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,0.8)">' + arah + '</div>' +
      '</div>';
  }

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

  async function mulaiKameraKe(videoEl, deviceId, potret) {
    hentikanKamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Kamera tidak tersedia di peramban ini (butuh HTTPS atau localhost).');
    }
    // Registrasi wajah minta ORIENTASI POTRET (720×1280) — sensor kamera depan modern
    // memberikan native atas-bawah; kamera 4:3 lama tetap berfungsi (`ideal` bukan
    // `exact`: driver kembali ukuran terbaik). Crop 9:16 dikomputasi di snapshot sebagai fallback.
    const ukuran = potret
      ? { width: { ideal: 720 }, height: { ideal: 1280 } }
      : { width: { ideal: 640 }, height: { ideal: 480 } };
    const videoCfg = deviceId
      ? Object.assign({ deviceId: { exact: deviceId } }, ukuran)
      : Object.assign({ facingMode: 'user' }, ukuran);
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
    // Melepas srcObject penuh → kamera totalmente dilepas di browser (stream yang
    // tetap di video bisa diblokir modal setelahnya: "Kamera sedang dipakai…").
    if (kameraBerjalan && kameraBerjalan.video) {
      try { kameraBerjalan.video.srcObject = null; } catch (e) { /* opsional */ }
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
      ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.strokeRect(offX + b.x * s, offY + b.y * s, b.width * s, b.height * s);
    }
    if (pts && pts.length) {
      ctx.fillStyle = 'rgba(34,197,94,0.30)';
      ctx.strokeStyle = 'rgba(34,197,94,0.50)';
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
   * Loop deteksi RINGAN untuk kamera depan (modal kelolaWajah).
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
        const vpReg = overlayEl.parentElement; // viewport ukuran tetap — tak terpengaruh transform zoom
        oW = (vpReg && vpReg.clientWidth) || videoEl.clientWidth || 0;
        oH = (vpReg && vpReg.clientHeight) || videoEl.clientHeight || 0;
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
        // Motor face-api: loop TIDAK menghitung descriptor (FaceRecognitionNet =
        // bagian terberat); cukup deteksi + landmarks → indikator hijau 1–3 dtk.
        // Motor mediapipe: Face Landmarker ook ringan (wasm lokal, zonder ONNX);
        // snapshot crop wajah bewaard voor DETERMINISTISCHE descriptor bij klik.
        const d = (motorWajah() === 'mediapipe')
          ? await detektiWajahMediapipe(videoEl, {})
          : await fa.detectSingleFace(videoEl, opts).withFaceLandmarks(true);
        if (token !== deteksiLoopToken) break;
        if (d) {
          gagalStreak = 0;
          pesanGagalDitampilkan = false;
          if (ctxOverlay) gambarScanKamera(ctxOverlay, d, oW, oH, videoEl);
          const boksD = (d.detection && d.detection.box) || null;
          hasilDeteksiLive = {
            deteksi: d.detection, landmarks: d.landmarks, skor: d.detection.score, waktu: Date.now(),
            _snap: (motorWajah() === 'mediapipe' && boksD) ? mpSnapshotFace(videoEl, boksD) : null,
            _frame: { w: videoEl.videoWidth || 0, h: videoEl.videoHeight || 0 }
          };
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
      // Relabel ramah + urutkan kamera depan dulu: label baku OS (mis. "Facing front: 1-...")
      // tidak intuitif bagi siswa/guru — tampilkan "Depan"/"Belakang".
      const hitungNama = {};
      const urutan = videoDevices
        .map((d, i) => {
          const l = String(d.label || '').trim();
          const lr = l.toLowerCase();
          let prio = 2, nama = l || ('Kamera ' + (i + 1));
          if (/front|user|selfie|depan/i.test(lr)) { prio = 0; nama = 'Depan'; }
          else if (/back|rear|environment|belakang|world/i.test(lr)) { prio = 1; nama = 'Belakang'; }
          else {
            const bersih = l.split(':')[0].split('(')[0].split('@')[0].trim();
            if (bersih) nama = bersih;
          }
          const n = (hitungNama[nama] = (hitungNama[nama] || 0) + 1);
          return { d, i, prio, nama: n > 1 ? nama + ' ' + n : nama };
        })
        .sort((a, b) => a.prio - b.prio || a.i - b.i);
      selectEl.innerHTML = '';
      urutan.forEach(({ d, nama }) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = nama;
        if (aktifId && d.deviceId === aktifId) opt.selected = true;
        selectEl.appendChild(opt);
      });
      if (!aktifId) selectEl.value = pilihanLama || (urutan[0] ? urutan[0].d.deviceId : '');
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

  /** Buang opsi perangkat berlabel duplikat "Depan"/"Belakang" dari dropdown pindai.
   *  isiDaftarKamera direlabel kamera depan/belakang dengan nama yang SAMA dengan opsi
   *  sentinel __depan__/__belakang__ → dropdown menimbuh 4 pilihan ganda, dan opsi
   *  perangkat milik kamera yang sedang aktif just mati (guard ganti kamera
   *  `id !== kameraAktifDeviceId()` menolak ganti) → perzenan "opsi kamera tidak
   *  berfungsi". Sentinel yang tersahab selalu berfungsi (ganti facingMode saja). */
  function singkirkanOpsiKameraDuplikat(selectEl) {
    if (!selectEl) return;
    Array.from(selectEl.querySelectorAll('option')).forEach((opt) => {
      const t = String(opt.textContent || '').trim();
      if ((t === 'Depan' || t === 'Belakang') && opt.value !== '__depan__' && opt.value !== '__belakang__') {
        opt.remove();
      }
    });
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

  /** Rekam descriptor dari hasil loop ringan (hasilDeteksiLive) — jalur SAMA dengan klik
   *  "Deteksi dari Kamera": landmarks.align → extractFaces → FaceRecognitionNet (net
   *  descriptor dimuat on-demand). → { descriptor, skor } ATAU null bila hasil usang/gagal. */
  async function descriptorDariHasilLive(videoEl, hasil) {
    if (!hasil) return null;
    if (motorWajah() === 'mediapipe') {
      // Deskriptor deterministisch uit de snapshot die bij DETECTIE bewaard is
      // (zelfde frame als de landmarks) — geen risico mismatch bij beweging.
      try {
        const d = hasil._snap
          ? await descriptorDariImageDataKe(hasil._snap)
          : (hasil.deteksi && hasil.deteksi.box
              ? await descriptorDariMediapipe(videoEl, hasil.deteksi.box, hasil._frame && hasil._frame.w, hasil._frame && hasil._frame.h)
              : null);
        if (!d) return null;
        return { descriptor: Array.from(d), skor: hasil.skor || (hasil.deteksi && hasil.deteksi.score) || 0.85 };
      } catch (e) {
        console.warn('descriptorDariHasilLive (mediapipe):', e);
        return null;
      }
    }
    if (!hasil || !hasil.landmarks) return null;
    try {
      const faWindow = window.faceapi;
      const aligned = hasil.landmarks.align(null, { useDlibAlignment: true });
      if (!aligned) return null;
      const crop = await faWindow.extractFaces(videoEl, [aligned]);
      if (!crop || !crop.length) return null;
      await pastikanNetRecok(); // net descriptor dimuat on-demand (bukan saat modal dibuka)
      const d128 = await faWindow.nets.faceRecognitionNet.computeFaceDescriptor(crop[0]);
      return { descriptor: Array.from(d128), skor: hasil.skor };
    } catch (e) {
      console.warn('descriptorDariHasilLive:', e); // box usang → jatuh ke one-shot / percobaan berikut
      return null;
    }
  }

  async function kelolaWajah(nis) {
    let murid = (typeof cacheAkunMurid !== 'undefined' && cacheAkunMurid.find)
      ? cacheAkunMurid.find(m => String(m.nis_nip) === String(nis))
      : null;
    if (!murid) {
      // Self-service (menu siswa "Data Akun Murid"): cache admin (cacheAkunMurid) tidak ada di sesi ini,
      // ambil row murid langsung — RLS mengizinkan baris sendiri utk siswa, semua baris utk admin.
      // [FASE B] Baca 1 baris murid lewat RPC (tabel `akun` RLS ketat).
      try {
        const data = await akunSatu({ nis: String(nis), mode: 'wajah' });
        if (data) murid = data;
      } catch (e) { console.error('[FaceWajah] ambil murid fallback:', e); }
    }
    if (!murid) { fxToast('error', 'Data murid tidak ditemukan.'); return; }

    // Modal dibuka SEKETIKA (tanpa await di depan) — klik tombol tabel selalu diberi respons.
    // Model face-api dimuat di dalam modal (didOpen) supaya tombol "Gunakan Foto"/"Gunakan Kamera"
    // siap dipakai begitu model siap, tanpa menahan pembukaan modal.
    let sampelWajah = [];             // daftar descriptor (maks JUMLAH_SAMPEL_MAKS) — data multi-pose
    let skorSementara = 0;
    let autoGambarAktif = true;       // Auto 6 pose: ON baku — sampel terekam otomatis bila wajah segar & pose bervariasi
    let autoGambarToken = 0;          // membatalkan loop auto (modal ditutup / auto dibungkam)
    let autoGambarLoper = false;      // loop auto sedang berjalan (mulai sekali; berhenti via flag/token)
    let laatstAutoGambar = 0;         // timestamp sampel auto terakhir — jeda antar-shot
    // Status: petaWajahCache sudah terisi penuh di sesi admin → dipakai dulu; di sesi siswa
    // cache kosong → status dihitung dari kolom wajah row yang diambil (fallback) di atas.
    const st = (petaWajahCache && petaWajahCache[String(nis)])
      ? statusMurid(petaWajahCache, nis)
      : (murid.wajah_descriptor ? (murid.wajah_status === 'nonaktif' ? 'nonaktif' : 'aktif') : 'belum');
    const nama = murid.nama_lengkap || '';
    const kelas = murid.tingkat_kelas || '';
    // [B4] Navegasi prev/next antar murid di modal registrasi wajah (sesi admin/guru).
    // Prioritas: mrdNavNis = urutan NIS hasil filter tabel aktif (diisi app.js renderTabelMuridTerfilter)
    // → navigasi mengikuti filter yang sedang dipilih (tahun/kelas/ekskul/status/cari/pencarian).
    // Fallback: seluruh cache admin bila mrdNavNis kosong/tak ada (mis. sesi self-service).
    let daftarNav = [];
    let idxNav = -1;
    if (typeof mrdNavNis !== 'undefined' && Array.isArray(mrdNavNis) && mrdNavNis.length > 1) {
      daftarNav = mrdNavNis.slice();
      idxNav = daftarNav.indexOf(String(nis));
    } else if (typeof cacheAkunMurid !== 'undefined' && Array.isArray(cacheAkunMurid) && cacheAkunMurid.length > 1) {
      daftarNav = cacheAkunMurid
        .filter(m => String(m.tipe || '') === 'murid' || (m.nis_nip || m.NIS || m.nis))
        .map(m => String(m.nis_nip || m.NIS || m.nis));
      idxNav = daftarNav.indexOf(String(nis));
    }

    Swal.fire({
      title: `<div class="flex items-center gap-2 mt-1">${daftarNav.length > 1 ? `<button id="nav-wajah-prev" class="w-6 h-6 rounded bg-slate-700 hover:bg-slate-600 text-white flex items-center justify-center transition" title="Murid sebelumnya"><i class="fa-solid fa-chevron-left text-[10px]"></i></button>` : ''}<div class="text-sm font-bold"><i class="fa-solid fa-face-viewfinder text-cyan-400 mr-2"></i>Foto Siswa</div>${daftarNav.length > 1 ? `<button id="nav-wajah-next" class="w-6 h-6 rounded bg-slate-700 hover:bg-slate-600 text-white flex items-center justify-center transition" title="Murid berikutnya"><i class="fa-solid fa-chevron-right text-[10px]"></i></button>` : ''}</div>`,
      html: `
        <div class="flex items-start gap-3 justify-between mb-2">
          <div class="text-left flex-1">
            <p class="text-xs font-bold text-white">${fxEscape(nama)}</p>
            <p class="text-[10px] text-slate-400 font-mono">NIS ${nis} · ${fxEscape(kelas)}</p>
            <p class="mt-1">${BADGE_STATUS[st] || BADGE_STATUS.belum}</p>
          </div>
          <img id="wajah-preview" class="w-24 h-42 rounded-lg object-cover bg-slate-700 border border-white/10" src="" alt="Foto siswa">
        </div>
        <div class="flex justify-center items-center gap-1.5 bg-black/60 p-1 rounded-lg mb-2">
          <button id="btn-wajah-foto" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded px-2 py-1.5 text-[10px] font-bold transition" title="Gunakan foto siswa yang tersimpan di akun"><i class="fa-solid fa-image mr-1"></i>Gunakan Foto</button>
          <button id="btn-wajah-kamera" class="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white rounded px-2 py-1.5 text-[10px] font-bold transition" title="Pindai langsung dari kamera"><i class="fa-solid fa-camera mr-1"></i>Gunakan Kamera</button>
        </div>
        <div id="wajah-camera-area" class="hidden relative rounded-lg overflow-hidden border border-cyan-500 bg-black mb-2" style="display:none">
          <div class="flex items-center gap-2 bg-slate-900/80 px-2 py-1.5">
            <span class="text-[9px] uppercase tracking-wider text-slate-400 shrink-0"><i class="fa-solid fa-camera-rotate mr-1"></i>Kamera</span>
            <select id="camera-select" class="bg-slate-800 border border-white/10 text-white text-[10px] rounded px-1.5 py-1 flex-1 min-w-0 focus:outline-none focus:border-cyan-500" title="Pilih kamera"><option value="">Kamera bawaan</option></select>
            <button type="button" id="btn-wajah-reg-zoom-out" class="shrink-0 bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-bold leading-none px-1.5 py-1 rounded transition" title="Perkecil (zoom keluar)">−</button>
            <button type="button" id="btn-wajah-reg-zoom-in" class="shrink-0 bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-bold leading-none px-1.5 py-1 rounded transition" title="Perbesar (zoom masuk)">+</button>
            <span id="wajah-reg-zoom-label" class="shrink-0 text-[8px] text-slate-400 tabular-nums w-7 text-center">100%</span>
          </div>
          <div class="relative h-36 overflow-hidden">
            <video id="wajah-video" autoplay playsinline muted class="w-full h-full object-cover" style="transform:scaleX(-1); transform-origin:center"></video>
            <canvas id="wajah-overlay" class="absolute inset-0 w-full h-full pointer-events-none" style="transform:scaleX(-1); transform-origin:center"></canvas>
            <div id="wajah-pose-box" class="absolute inset-0 w-full h-full pointer-events-none" style="transform:none; transform-origin:center"></div>
          </div>
          <div id="wajah-panduan" class="px-2 py-1.5 bg-slate-900/70 border-t border-white/10 text-[10px] leading-relaxed text-slate-300">
            <b class="text-cyan-300">Posisi &amp; perintah:</b> hadapkan wajah lurus ke kamera · cahaya cukup dari depan · jarak 40–80 cm · tanpa masker/kacamata gelap. Ganti pose saat indikator hijau — mode <b>Auto 6 pose</b> menambah sampel sendiri (6/6 lalu <b>Simpan Data Wajah</b>); klik <b>Deteksi dari Kamera</b> utk sampel manual.
          </div>
          <div class="flex gap-2 items-stretch">
              <button id="btn-wajah-tangkap" class="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white px-3 py-2 rounded-lg text-[11px] font-bold transition" title="Deteksi wajah dari frame kamera (manual — setiap klik menambah sampel)"><i class="fa-solid fa-camera mr-1"></i>Deteksi dari Kamera</button>
              <button type="button" id="btn-wajah-auto" class="shrink-0 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold px-2 py-2 rounded-lg transition" title="Mindai 6 pose otomatis — sampel ditambah sendiri bila pose bervariasi (klik utk ON/OFF)"><i class="fa-solid fa-wand-magic mr-1"></i><span id="wajah-auto-label">Auto 6 pose: ON</span></button>
            </div>
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
        const poseBoxEl = cari('wajah-pose-box');
        const sampelInfoEl = cari('wajah-sampel-info');
        // Guard: elemen modal yang hilang TIDAK boleh terjadi senyap.
        ['wajah-preview','wajah-hasil','btn-wajah-foto','btn-wajah-kamera',
         'wajah-camera-area','wajah-video','btn-wajah-tangkap','btn-wajah-simpan',
         'wajah-overlay','wajah-pose-box','wajah-sampel-info','btn-wajah-auto','wajah-auto-label'].forEach((id) => {
          if (!cari(id)) console.error('[FaceWajah] Elemen #' + id + ' tidak ditemukan di dalam modal.');
        });

        const setHasil = (teks, warna) => {
          if (!hasilEl) return;
          hasilEl.innerHTML = teks;
          hasilEl.className = 'text-center text-[11px] min-h-[16px] mb-2 ' + (warna || 'text-slate-300');
        };
        // [B4] Navigasi prev/next antar murid — tutup modal ini & buka murid tetangga.
        if (daftarNav.length > 1) {
          const nav = (step) => {
            const nx = idxNav + step;
            if (nx < 0 || nx >= daftarNav.length) return;
            const nisTujuan = daftarNav[nx];
            if (!nisTujuan || String(nisTujuan) === String(nis)) return;
            Swal.close();
            kelolaWajah(String(nisTujuan));
          };
          const btnPrev = popup.querySelector('#nav-wajah-prev');
          const btnNext = popup.querySelector('#nav-wajah-next');
          if (btnPrev) btnPrev.addEventListener('click', () => nav(-1));
          if (btnNext) btnNext.addEventListener('click', () => nav(1));
        }
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
            laatstAutoGambar = 0;
            // [B3] Hapus semua → mulai /langkah 0 dari awal: kamera auto-mindai dihidupkan
            // kembali, pose pertama diucapkan ulang & overlay panah di-reset (progres di awal).
            autoGambarAktif = true;
            setLavelAuto();
            const pdBox = popup.querySelector('#wajah-pose-box');
            if (pdBox) updateOverlayPose(pdBox, 0);
            ucapkanTTS('Mulai. ' + TIPS_POSE[0] + '.');
            renderInfoSampel();
            aktifkanSimpan();
            setHasil('<i class="fa-solid fa-broom text-amber-300 mr-1"></i>Sampel dibersihkan. Deteksi dari kamera lagi atau gunakan foto.', 'text-amber-200');
            // Hidupkan ulang loop auto bila kamera masih menyala (mode ON baku).
            if (videoEl && videoEl.srcObject) mulaiAutoGambar();
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
            await mulaiKameraKe(videoEl, null, true); // potret 9:16 — crop rasio potret di snapshot
            areaKam.classList.remove('hidden');
            areaKam.style.display = 'block';
            btnKam.disabled = true;
            // [UPGRADE] Zoom kamera depan (mirror selfie) registrasi wajah.
            const lblZR = cari('wajah-reg-zoom-label');
            const btnZIR = cari('btn-wajah-reg-zoom-in');
            const btnZOR = cari('btn-wajah-reg-zoom-out');
            let zoomReg = 1;
            const setTransformReg = () => {
              zoomReg = Math.min(3, Math.max(0.75, zoomReg));
              const t = 'scaleX(-1) scale(' + zoomReg + ')';
              if (videoEl) { videoEl.style.transform = t; videoEl.style.transformOrigin = 'center'; }
              if (overlayEl) { overlayEl.style.transform = t; overlayEl.style.transformOrigin = 'center'; }
              if (lblZR) lblZR.textContent = Math.round(zoomReg * 100) + '%';
            };
            if (btnZIR) btnZIR.addEventListener('click', () => { zoomReg = Math.min(3, zoomReg + 0.25); setTransformReg(); });
            if (btnZOR) btnZOR.addEventListener('click', () => { zoomReg = Math.max(0.75, zoomReg - 0.25); setTransformReg(); });
            setTransformReg();
            // Isi daftar kamera setelah izin diberikan (label baru muncul saat itu),
            // lalu pasang listener ganti kamera → mulai ulang stream dengan device baru.
            await isiDaftarKamera(kameraPilih, async (deviceId) => {
              try {
                await mulaiKameraKe(videoEl, deviceId, true); // potret juga utk kamera diganti
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
            // [TTS + Overlay Pose] Ucapkan pose PERTAMA (lurus) & tampilkan panah arah
            // sejak kamera dinyalakan — siswa langsung tahu pose mana yang diminta.
            ucapkanTTS('Mulai. ' + TIPS_POSE[0] + '.');
            updateOverlayPose(poseBoxEl, 0);
            mulaiAutoGambar(); // auto-mindai 6 pose berjalan langsung (flag ON baku; klik tombol Auto utk beralih manual)
            setHasil('<i class="fa-solid fa-video mr-1"></i>Kamera aktif — atur posisi wajah. Mode <b>Auto 6 pose</b> menambah sampel sendiri saat pose bervariasi (klik <b>Deteksi dari Kamera</b> utk manual).');
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
            const batasTunggu = Date.now() + 4000;
            while (Date.now() < batasTunggu) {
              const segar = hasilDeteksiLive && (Date.now() - hasilDeteksiLive.waktu) < 3500;
              if (segar) {
                // Jalur descriptor SAMA (landmarks.align → extractFaces → FaceRecognitionNet)
                // dibagi ke helper — di-reuse oleh auto-mindai 6 pose.
                const h = await descriptorDariHasilLive(videoEl, hasilDeteksiLive);
                if (h) { hasil = h; pakaiLoop = true; break; }
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
            ucapkanTTS('Selesai. Tekan Simpan Data Wajah.');
            return;
          }
          sampelWajah.push(Array.isArray(hasil.descriptor) ? Array.from(hasil.descriptor) : hasil.descriptor);
          skorSementara = hasil.skor;
          // Snapshot PROPORASI POTRET 9:16 — frame kamera (mis. 640×480 4:3) dicrop tengah
          // ke rasio potret penuh dan di-output 900×1600 (format ID foto). Pratinjau
          // wajah-preview memakai rasio sama → WYSIWYG; data JS yang dikirim pun potret.
          const vwSnap = videoEl.videoWidth || 640;
          const vhSnap = videoEl.videoHeight || 480;
          const RASIO_POTRET = 9 / 16;
          let swSnap = vwSnap, shSnap = vhSnap, sxSnap = 0, sySnap = 0;
          if (vwSnap / vhSnap > RASIO_POTRET) { swSnap = Math.round(vhSnap * RASIO_POTRET); sxSnap = Math.round((vwSnap - swSnap) / 2); }
          else { shSnap = Math.round(vwSnap / RASIO_POTRET); sySnap = Math.round((vhSnap - shSnap) / 2); }
          const OUT_W_SNAP = 900, OUT_H_SNAP = 1600;
          const canvas = document.createElement('canvas');
          canvas.width = OUT_W_SNAP; canvas.height = OUT_H_SNAP;
          canvas.getContext('2d').drawImage(videoEl, sxSnap, sySnap, swSnap, shSnap, 0, 0, OUT_W_SNAP, OUT_H_SNAP);
          const snap = cari('wajah-preview');
          if (snap) {
            if (snap.tagName !== 'IMG') snap.outerHTML = '<img id="wajah-preview" class="w-24 h-42 rounded-lg object-cover bg-slate-700 border border-white/10" alt="Foto siswa">';
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

        // ===== AUTO-MINDAI 6 pose — hasil loop ringan (hasilDeteksiLive) dipakai tanpa klik =====
        const btnAuto = cari('btn-wajah-auto');
        const lavelAuto = cari('wajah-auto-label');
        const setLavelAuto = () => { if (lavelAuto) lavelAuto.textContent = 'Auto 6 pose: ' + (autoGambarAktif ? 'ON' : 'OFF'); };
        setLavelAuto();
        const mulaiAutoGambar = async () => {
          if (autoGambarLoper || !areaKam || !areaKam.isConnected || !videoEl.srcObject) return;
          autoGambarLoper = true;
          const token = autoGambarToken;
          let tSjanse = 0; // sejak percobaan sampel diTOLAK (pose masih mirip) — utk fallback stagnan >4 dtk
          while (autoGambarAktif && token === autoGambarToken && areaKam.isConnected
              && sampelWajah.length < JUMLAH_SAMPEL_MAKS) {
            const t = Date.now();
            const segar = hasilDeteksiLive && (t - hasilDeteksiLive.waktu) < 1200;
            if (segar && t - laatstAutoGambar >= AUTO_JEDA_MS) {
              const h = await descriptorDariHasilLive(videoEl, hasilDeteksiLive);
              if (h) {
                const jarakMin = sampelWajah.length === 0
                  ? 999
                  : Math.min.apply(null, sampelWajah.map(s => jarakEuclidean(s, h.descriptor)));
                const stagnan = tSjanse && (t - tSjanse) >= 4000;
                const tambah = jarakMin >= POSO_MIN_JARAK || (stagnan && jarakMin >= POSO_MIN_JARAK_FALLBACK);
                if (tambah) {
                  sampelWajah.push(Array.isArray(h.descriptor) ? Array.from(h.descriptor) : h.descriptor);
                  skorSementara = h.skor;
                  laatstAutoGambar = t;
                  tSjanse = 0;
                  renderInfoSampel();
                  aktifkanSimpan();
                  if (sampelWajah.length >= JUMLAH_SAMPEL_MAKS) {
                    autoGambarAktif = false;
                    setLavelAuto();
                    setHasil('<i class="fa-solid fa-circle-check text-green-400 mr-1"></i><b>' + JUMLAH_SAMPEL_MAKS + '/' + JUMLAH_SAMPEL_MAKS + ' sampel terekam (auto)</b> — klik <b>Simpan Data Wajah</b>.', 'text-green-300');
                    // [B2] Beri tahu lewat suara bahwa pendataan selesai & tinggal simpan.
                    updateOverlayPose(poseBoxEl, 0);
                    ucapkanTTS('Selesai. Tekan Simpan Data Wajah.');
                  } else {
                    setHasil('<i class="fa-solid fa-camera text-cyan-300 mr-1"></i>Auto-mindai: sampel <b>' + sampelWajah.length + '/' + JUMLAH_SAMPEL_MAKS + '</b> — pose berikut: <i class="text-cyan-200">' + TIPS_POSE[sampelWajah.length % TIPS_POSE.length] + '</i>.', 'text-green-300');
                  }
                  // [TTS + Overlay Pose] Bicarakan pose berikutnya & perbarui panah arah.
                  // Setiap sampel berhasil → ucapan pose berikutnya otomatis diputar;
                  // overlay kamera menampilkan ikon arah + label (LURUS/KIRI/KANAN/...).
                  const posIdx = sampelWajah.length % TIPS_POSE.length;
                  ucapkanTTS('Pose berikut: ' + TIPS_POSE[posIdx] + '.');
                  updateOverlayPose(poseBoxEl, posIdx);
                } else {
                  tSjanse = t; // pose terlalu mirip — siswa ganti pose; bila stagnan >4 dtk → fallback
                }
              }
            }
            await new Promise(r => setTimeout(r, AUTO_POLL_MS));
          }
          autoGambarLoper = false;
        };
        if (btnAuto) btnAuto.addEventListener('click', () => {
          if (autoGambarAktif) {
            autoGambarAktif = false;
            setLavelAuto();
            setHasil('<i class="fa-solid fa-hand mr-1"></i>Auto-mindai DINONAKTIFKAN — klik <b>Deteksi dari Kamera</b> utk sampel manual.', 'text-amber-200');
            return;
          }
          if (!videoEl.srcObject) {
            setHasil('Nyalakan kamera dulu (<b>Gunakan Kamera</b>) — auto-mindai butuh stream aktif.', 'text-amber-300');
            return;
          }
          autoGambarAktif = true;
          setLavelAuto();
          setHasil('<i class="fa-solid fa-wand-magic text-cyan-300 mr-1"></i>Auto-mindai AKTIF — ganti pose pelan saat indikator hijau; sampel terekam sendiri.', 'text-green-300');
          mulaiAutoGambar();
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
      willClose: () => {
        autoGambarAktif = false;
        autoGambarToken++; // membatalkan loop auto bila modal ditutup
        hentikanKamera();
      }
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

  /** Segarkan kolom Status Wajah pada tabel Daftar Murid (setelah simpan/nonaktif/hapus). */
  function refreshDaftarWajahTable() {
    if (typeof renderTabelMuridTerfilter === 'function') {
      try { renderTabelMuridTerfilter(); } catch (e) { console.error('refresh Daftar Murid:', e); }
    }
  }

  // ==================================================================
  // 7. PEMINDAIAN WAJAH LIVE DI MODAL ABSENSI
  // ==================================================================
  /** Hentikan pemindaian wajah (stream kamera + loop deteksi) bila aktif. */
  function berhentiPindaiWajah() {
    if (scanAktif) {
      scanAktif.hentikan = true;
      if (scanAktif.stream) scanAktif.stream.getTracks().forEach(t => t.stop());
      if (scanAktif.video) { try { scanAktif.video.srcObject = null; } catch (e) { /* opsional */ } }
      scanAktif = null;
    }
  }
  /** [B2] Kamera/scan wajah sedang berjalan? Dipakai utk toggle stop + henti ui. */
  function isWajahMandiriAktif() {
    return !!(scanAktif && scanAktif.stream);
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
          <select id="wajah-live-kamera" class="bg-slate-800 border border-white/10 text-white text-[10px] rounded px-1.5 py-1 flex-1 min-w-0 focus:outline-none focus:border-cyan-500" title="Pilih kamera: Depan / Belakang / perangkat lain"><option value="__depan__">Depan</option><option value="__belakang__">Belakang</option></select>
          <span style="width:1px" class="h-3.5 bg-white/15 shrink-0"></span>
          <button type="button" id="btn-wajah-live-zoom-out" class="shrink-0 bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-bold leading-none px-1.5 py-1 rounded transition" title="Perkecil (zoom keluar)">−</button>
          <button type="button" id="btn-wajah-live-zoom-in" class="shrink-0 bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-bold leading-none px-1.5 py-1 rounded transition" title="Perbesar (zoom masuk)">+</button>
          <span id="wajah-live-zoom-label" class="shrink-0 text-[8px] text-slate-400 tabular-nums w-7 text-center">100%</span>
        </div>
        <div class="relative h-56 overflow-hidden">
          <video id="wajah-live-video" autoplay playsinline muted class="w-full h-full object-contain" style="transform-origin:center"></video>
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

    // [UPGRADE] Zoom & mirror (kamera depan → selfie terpantul seperti cermin).
    // Transform CSS diterapkan ke video DAN overlay bersamaan → kotak deteksi
    // tetap menempel di wajah saat diperbesarkan/dibalik.
    const btnZiP = document.getElementById('btn-wajah-live-zoom-in');
    const btnZoP = document.getElementById('btn-wajah-live-zoom-out');
    const lblZP = document.getElementById('wajah-live-zoom-label');
    let zoomPindai = 1;
    let mukaDepanPindai = false;
    const terapkanTfPindai = () => {
      // Zoom min 0.5 (dulu 0.75) + object-contain: frame kamera potrait tampil utuh
      // (tepi atas–bawah tidak ter-crop) dan wajah bisa diperbesaran pakai tombol +.
      zoomPindai = Math.min(3, Math.max(0.5, zoomPindai));
      // Transform diterapkan ke VIDEO saja. Overlay digambar di koordinat layar final
      // (loopDeteksiPindai memetakan object-contain + zoom + mirror), sehingga kotak
      // deteksi menempel persis di wajah di SEMUA level zoom / kamera depan-belakang.
      const t = (mukaDepanPindai ? 'scaleX(-1) ' : '') + 'scale(' + zoomPindai + ')';
      if (video) { video.style.transform = t; video.style.transformOrigin = 'center'; }
      if (overlay) { overlay.style.transform = 'none'; overlay.style.transformOrigin = 'center'; }
      if (scanAktif) { scanAktif.zoom = zoomPindai; scanAktif.mirror = mukaDepanPindai; }
      if (lblZP) lblZP.textContent = Math.round(zoomPindai * 100) + '%';
    };
    const ubahZoomPindai = (naik) => {
      zoomPindai = Math.min(3, Math.max(0.5, Math.round((zoomPindai + (naik ? 0.25 : -0.25)) * 100) / 100));
      terapkanTfPindai();
    };
    if (btnZiP) btnZiP.addEventListener('click', () => ubahZoomPindai(true));
    if (btnZoP) btnZoP.addEventListener('click', () => ubahZoomPindai(false));

    const setStatus = (teks, warna) => {
      if (!statusEl || !statusEl.isConnected) return;
      statusEl.innerHTML = teks;
      statusEl.className = 'absolute top-2 left-2 right-2 text-center text-[11px] font-bold drop-shadow-lg bg-black/40 rounded px-2 py-1 ' + (warna || 'text-white');
    };

    // Tunggu video element siap membaca frame (readyState ≥ HAVE_CURRENT_DATA / 2).
    // Tanpa ini, face-api memanggil video yang baru diganti stream-nya pada
    // readyState 0–1 → error/eksepsi & loop deteksi mati diam-diam (kamera
    // "tidak memproses" setelah diganti depan/belakang).
    const tungguVideoSiap = (el, batasMs) => {
      return new Promise(resolve => {
        if (!el) return resolve();
        if (el.readyState >= 2) return resolve();
        const batas = Date.now() + (batasMs || 4000);
        const cek = () => {
          if (el.readyState >= 2) return resolve();
          if (Date.now() >= batas) return resolve(); // timeout — loop siap coba-coba
          setTimeout(cek, 60);
        };
        el.addEventListener('loadeddata', () => resolve(), { once: true });
        cek();
      });
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
      await tungguVideoSiap(video);
      if (scanAktif) { scanAktif.stream = streamBaru; scanAktif.video = video; }
      if (streamLama) streamLama.getTracks().forEach(t => t.stop());
      mukaDepanPindai = (() => {
        const tr = streamBaru.getVideoTracks && streamBaru.getVideoTracks()[0];
        const st = tr && typeof tr.getSettings === 'function' ? tr.getSettings() : null;
        return !!(st && st.facingMode === 'user');
      })();
      terapkanTfPindai();
    };
    // Ganti depan/belakang lewat dropdown (opsi sentinel __depan__/__belakang__).
    let facingMuka = 'environment';
    // Sinkronkan pilihan dropdown dengan facingMode stream yang sedang aktif.
    const sinkronkanPilihanKamera = () => {
      if (!selKamera) return;
      const val = mukaDepanPindai ? '__depan__' : '__belakang__';
      if (selKamera.querySelector('option[value="' + val + '"]')) selKamera.value = val;
    };
    const gantiMukaKamera = async (facing) => {
      try {
        const streamLama = scanAktif && scanAktif.stream;
        const streamBaru = await bukaStreamKamera([facing, {}],
          { width: { ideal: 1280 }, height: { ideal: 720 } });
        if (!video || !video.isConnected) { streamBaru.getTracks().forEach(t => t.stop()); return; }
        video.srcObject = streamBaru;
        await video.play();
        await tungguVideoSiap(video);
        if (scanAktif) { scanAktif.stream = streamBaru; scanAktif.video = video; }
        if (streamLama) streamLama.getTracks().forEach(t => t.stop());
        facingMuka = facing;
        mukaDepanPindai = facing === 'user';
        terapkanTfPindai();
        sinkronkanPilihanKamera();
        setStatus('<i class="fa-solid fa-video mr-1"></i>Kamera ' + (facing === 'user' ? 'depan' : 'belakang') + ' aktif — hadapkan wajah ke kamera.', 'text-cyan-100');
      } catch (e2) {
        console.error('ganti muka kamera:', e2);
        setStatus('<i class="fa-solid fa-triangle-exclamation mr-1"></i>' + fxEscape(e2 && e2.message ? e2.message : e2), 'text-amber-200');
      }
    };

    try {
      const nisList = [...new Set((listMurid || []).map(m => String(m.nis)).filter(Boolean))];
      // Ambil descriptor kelas (sudah multi-sampel) — paralel dengan kamera & model.
      const janjiData = (async () => {
        const mapKelas = {};
        if (!nisList.length) return mapKelas;
        try {
          // [FASE B] Peta wajah NIS terpilih lewat RPC (tabel `akun` RLS ketat).
          const rows = await akunPetaWajah({ nisList });
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
      mukaDepanPindai = (() => {
        const tr = stream.getVideoTracks && stream.getVideoTracks()[0];
        const st = tr && typeof tr.getSettings === 'function' ? tr.getSettings() : null;
        return !!(st && st.facingMode === 'user');
      })();
      terapkanTfPindai();
      sinkronkanPilihanKamera();
      scanAktif = { hentikan: false, stream, video, zoom: zoomPindai, mirror: mukaDepanPindai };
      setStatus('<i class="fa-solid fa-video mr-1"></i>Kamera siap — memuat model pengenalan wajah… (bisa ±30 dtk di jaringan lambat)');

      // Dropdown kamera — label baru tersedia SETELAH izin diberikan.
      if (selKamera) {
        try {
          const trackUtama = stream.getVideoTracks && stream.getVideoTracks()[0];
          const aktifId = (trackUtama && typeof trackUtama.getSettings === 'function')
            ? (trackUtama.getSettings().deviceId || '') : '';
          await isiDaftarKamera(selKamera, async (deviceId) => {
            try {
              if (deviceId === '__depan__') await gantiMukaKamera('user');
              else if (deviceId === '__belakang__') await gantiMukaKamera('environment');
              else {
                await gantiKameraPindai(deviceId);
                setStatus('<i class="fa-solid fa-video mr-1"></i>Kamera diganti.', 'text-cyan-100');
              }
            } catch (e2) {
              console.error('ganti kamera pindai:', e2);
              setStatus('<i class="fa-solid fa-triangle-exclamation mr-1"></i>' + fxEscape(e2 && e2.message ? e2.message : e2), 'text-amber-200');
            }
          }, aktifId);
          // Opsi sentinel Depan/Belakang selalu tersedia di atas daftar perangkat
          // (isiDaftarKamera menghapus isi select — pasang ulang bila terhapus).
          if (!selKamera.querySelector('option[value="__depan__"]')) {
            selKamera.insertAdjacentHTML('afterbegin',
              '<option value="__depan__">Depan</option><option value="__belakang__">Belakang</option>');
          }
          // Buang opsi perangkat duplikat (mis. dua "Depan") — sentinel yang tersisa
          // selalu berfungsi, dropdown tidak menimbuh pilihan mati (kamera aktif).
          singkirkanOpsiKameraDuplikat(selKamera);
          sinkronkanPilihanKamera();
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
      if (btnStop) btnStop.addEventListener('click', () => berhentiPindaiWajah());

      setStatus('<i class="fa-solid fa-video mr-1"></i>Kamera menyala — hadapkan wajah ke kamera.');

      await loopDeteksiPindai({ wrap, video, overlay, matcher, peta, cooldown, setStatus, onMatch, nisList });
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
   *  AUTO-HENTIAN: bila SEMUA siswa terdaftar (targhe = jumlah label peta, min 2 — mode
   *  mandiri single-label tidak terpengaruh) sudah cocok, countdown masa tenggang HENTIAN_AUTO_MS;
   *  siswa terlambat masih bisa cocok & reset countdown → loop berhenti otomatis
   *  (o.onSemuaCocok = hook opsional utk caller, dipanggil saat break).
   *  Catatan: `cooldown` dibaca dari `o.cooldown` (versi lama memakai nama `cooldown`
   *  yang tidak terdefinisi → ReferenceError begitu pertama kali cocok). */
  async function loopDeteksiPindai(o) {
    // `fa`/opts alleen voor de face-api-tak; mediapipe tak gebruikt zijn eigen
    // landmarker (geen afhankelijkheid van window.faceapi zodat die ook mag falen).
    const opts = (motorWajah() === 'mediapipe')
      ? null
      : new window.faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.2 });
    const cooldown = o.cooldown || {};        // nis → timestamp cocok terakhir
    const targheCocok = (o.peta && typeof o.peta === 'object') ? Object.keys(o.peta).length : 0;
    const telahCocok = new Set();             // nis unik yang sudah cocok — utk deteksi "semua terdaftar ✓"
    let semuaSelamate = false;                // semua terdaftar cocok → countdown masa tenggang siswa terlambat
    let sejakSemua = 0;
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
      // AUTO-HENTIAN: countdown masa tenggang lewat → loop berhenti otomatis (break; hook opsional
      // o.onSemuaCocok utk caller). Check dijalankan tiap iterasi, sebelum rate-limit.
      if (semuaSelamate && scanAktif && !scanAktif.hentikan && o.wrap.isConnected
          && now - sejakSemua >= HENTIAN_AUTO_MS) {
        if (typeof o.onSemuaCocok === 'function') {
          try { o.onSemuaCocok(); } catch (e) { console.error('onSemuaCocok:', e); }
        }
        break;
      }
      if (now - terakhir < DETECT_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, DETECT_INTERVAL_MS));
        continue;
      }
      terakhir = now;

      // Jeda bila video belum siap (baru diganti kamera / pertama dibuka).
      // readyState < 2 (HAVE_CURRENT_DATA) → frame belum bisa dibaca face-api;
      // men-detectSingleFace terlalu dini bikin error/\"video tidak siap\" dan
      // loop mati diam-diam sehingga pemindaian berhenti setelah ganti kamera.
      if (video.readyState < 2) {
        o.setStatus('<i class="fa-solid fa-video mr-1"></i>Menyiapkan frame kamera…', 'text-amber-200');
        await new Promise(r => setTimeout(r, 250));
        continue;
      }

      let deteksi = null;
      try {
        deteksi = (motorWajah() === 'mediapipe')
          ? await detektiWajahMediapipe(video, { descriptor: true })
          : await window.faceapi.detectSingleFace(video, opts).withFaceLandmarks(true).withFaceDescriptor();
      } catch (e) {
        if (scanAktif && !scanAktif.hentikan) o.setStatus('<i class="fa-solid fa-triangle-exclamation mr-1"></i>' + fxEscape(e && e.message ? e.message : 'Gagal memproses frame.'), 'text-amber-200');
        await new Promise(r => setTimeout(r, DETECT_INTERVAL_MS));
        continue;
      }

      if (!deteksi) {
        o.setStatus('<i class="fa-solid fa-face-smile mr-1"></i>Tidak ada wajah terdeteksi.');
        continue;
      }

      // Gambar bingkai deteksi pada overlay — mapping object-contain + zoom + mirror
      // (sama geometri CSS video, transform-origin:center) → kotak menempel persis
      // di wajah di SEMUA level zoom & saat kamera depan/belakang diganti.
      const vw = video.videoWidth || 640;
      const vh = video.videoHeight || 480;
      const zoomK = (scanAktif && scanAktif.zoom) || 1;
      const mirrorK = !!(scanAktif && scanAktif.mirror);
      const s0 = Math.min(cW / vw, cH / vh);
      const s = s0 * zoomK;
      const offKX = (cW - vw * s) / 2;
      const offKY = (cH - vh * s) / 2;
      const b = deteksi.detection.box;
      const bx = mirrorK ? (cW - (offKX + (b.x + b.width) * s)) : (offKX + b.x * s);
      const by = offKY + b.y * s;
      // Kotak deteksi: hijau (dash) → kotak cocok: hijau solid & lebih tebal.
      ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.strokeRect(bx, by, b.width * s, b.height * s);

      let best = null;
      try { best = o.matcher.findBestMatch(deteksi.descriptor); } catch (e) { /* lanjut */ }

      const cocokDi = (motorWajah() === 'mediapipe') ? JARAK_COCOK_MP : JARAK_COCOK;
      if (best && best.label !== 'unknown' && best.distance <= cocokDi) {
        const nis = best.label;
        const dahulu = cooldown[nis] || 0;
        if (now - dahulu >= COOLDOWN_MS) {
          cooldown[nis] = now;
          let baruDitandai = true;
          if (typeof o.onMatch === 'function') {
            try { baruDitandai = o.onMatch(nis) !== false; } catch (e) { baruDitandai = true; }
          }
          telahCocok.add(nis);
          if (baruDitandai) hadirCount += 1;
          // Semua siswa terdaftar sudah cocok (min 2 label — 1 label = mode mandiri, hentian
          // manual cukup) → countdown tenggang; match berikutnya (siswa terlambat) reset countdown.
          if (targheCocok >= 2 && telahCocok.size >= targheCocok) {
            if (!semuaSelamate) {
              semuaSelamate = true;
              sejakSemua = now; // mulai countdown tenggang — siswa terlambat bisa reset
              o.setStatus('<i class="fa-solid fa-circle-check mr-1" style="color:#4ade80"></i>Semua ' + targheCocok + ' siswa terdaftar terdeteksi ✓ — kamera henti otomatis bila tak ada siswa lain (±' + Math.round(HENTIAN_AUTO_MS / 1000) + ' dtk)…', 'text-green-100');
            } else {
              sejakSemua = now; // siswa terlambat masuk → reset countdown
            }
          }
          ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 3; ctx.setLineDash([]);
          ctx.strokeRect(bx, by, b.width * s, b.height * s);
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
  // 7b. PEMINDAIAN WAJAH UNTUK ABSEN MANDIRI (verifikasi selfie)
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
      // [FASE B] Descriptor murid ini lewat RPC (hanya status 'aktif').
      const rows = await akunPetaWajah({ nisList: [nisS], aktifSaja: true });
      const row = (rows || [])[0];
      const daftarSampel = row ? normalisasiDescriptorWajah(row.wajah_descriptor) : null;
      if (!daftarSampel || !daftarSampel.length) {
        wrap.innerHTML = `<div class="rounded border border-amber-500/50 bg-amber-900/30 text-amber-200 text-[10px] p-2 mb-2 text-center">Wajah ${fxEscape(nama || nisS)} belum terdaftar/aktif.<br><span class="text-amber-100/70">Daftarkan lewat Manajemen Akun Murid — klik ikon wajah pada baris siswa.</span></div>`;
        return false;
      }

      const matcher = buatMatcherDariPeta({ [nisS]: { descriptor: daftarSampel } });
      if (!matcher) {
        wrap.innerHTML = `<div class="rounded border border-amber-500/50 bg-amber-900/30 text-amber-200 text-[10px] p-2 mb-2 text-center">Data wajah tidak valid.</div>`;
        return false;
      }

      wrap.innerHTML = `
        <div class="rounded-lg overflow-hidden border border-cyan-500 bg-black">
          <div class="flex items-center gap-2 bg-slate-900/85 px-2 py-1">
            <span class="text-[9px] uppercase tracking-wider text-slate-400 shrink-0"><i class="fa-solid fa-camera-rotate mr-1"></i>Kamera</span>
            <button type="button" id="btn-mandiri-cam-user" class="shrink-0 bg-cyan-700 hover:bg-cyan-600 text-white text-[9px] font-bold px-2 py-1 rounded transition" title="Kamera depan (selfie)">Depan</button>
            <button type="button" id="btn-mandiri-cam-env" class="shrink-0 bg-slate-700 hover:bg-slate-600 text-white text-[9px] font-bold px-2 py-1 rounded transition" title="Kamera belakang">Belakang</button>
            <span style="width:1px" class="h-3 bg-white/15 shrink-0"></span>
            <button type="button" id="btn-mandiri-zoom-out" class="shrink-0 bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-bold leading-none px-1.5 py-0.5 rounded transition" title="Perkecil (zoom keluar)">−</button>
            <button type="button" id="btn-mandiri-zoom-in" class="shrink-0 bg-slate-700 hover:bg-slate-600 text-white text-[11px] font-bold leading-none px-1.5 py-0.5 rounded transition" title="Perbesar (zoom masuk)">+</button>
            <span id="wajah-mandiri-zoom-label" class="shrink-0 text-[8px] text-slate-400 tabular-nums w-7 text-center">100%</span>
          </div>
          <div class="relative h-56 overflow-hidden">
            <video id="wajah-mandiri-video" autoplay playsinline muted class="w-full h-full object-contain"></video>
            <canvas id="wajah-mandiri-overlay" class="absolute inset-0 w-full h-full pointer-events-none"></canvas>
            <div id="wajah-mandiri-live-status" class="absolute top-1.5 left-1.5 right-1.5 text-center text-[10px] font-bold text-white drop-shadow-lg bg-black/40 rounded px-2 py-0.5">Menyiapkan kamera...</div>
            <button id="btn-wajah-mandiri-stop" class="absolute bottom-1.5 right-1.5 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold px-2 py-0.5 rounded shadow">Berhenti</button>
          </div>
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
      scanAktif = { hentikan: false, stream, video, zoom: 1, mirror: true };

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

      // ---- Kamera depan/belakang (facingMode) untuk Absen Mandiri ----
      let facingMandiri = 'user';
      let zoomMandiri = 1;
      const lblZM = document.getElementById('wajah-mandiri-zoom-label');
      const btnZInM = document.getElementById('btn-mandiri-zoom-in');
      const btnZOutM = document.getElementById('btn-mandiri-zoom-out');
      const setTransformMandiri = () => {
        // Zoom min 0.5 + object-contain: gambar kamera utuh (tepi atas/bawah tidak ter-crop).
        zoomMandiri = Math.min(3, Math.max(0.5, zoomMandiri));
        const t = (facingMandiri === 'user' ? 'scaleX(-1) ' : '') + 'scale(' + zoomMandiri + ')';
        if (video) { video.style.transform = t; video.style.transformOrigin = 'center'; }
        if (overlay) { overlay.style.transform = 'none'; overlay.style.transformOrigin = 'center'; }
        if (scanAktif) { scanAktif.zoom = zoomMandiri; scanAktif.mirror = facingMandiri === 'user'; }
        if (lblZM) lblZM.textContent = Math.round(zoomMandiri * 100) + '%';
      };
      if (btnZInM) btnZInM.addEventListener('click', () => { zoomMandiri = Math.min(3, Math.round((zoomMandiri + 0.25) * 100) / 100); setTransformMandiri(); });
      if (btnZOutM) btnZOutM.addEventListener('click', () => { zoomMandiri = Math.max(0.5, Math.round((zoomMandiri - 0.25) * 100) / 100); setTransformMandiri(); });
      setTransformMandiri();
      const tandaiMukaMandiri = () => {
        const u = document.getElementById('btn-mandiri-cam-user');
        const e = document.getElementById('btn-mandiri-cam-env');
        [u, e].forEach(el => { if (el) { el.classList.remove('ring-2'); el.classList.remove('ring-yellow-400'); } });
        const t = facingMandiri === 'user' ? u : e;
        if (t) { t.classList.add('ring-2'); t.classList.add('ring-yellow-400'); }
      };
      const tungguSiapMandiri = (el) => {
        return new Promise(resolve => {
          if (!el || el.readyState >= 2) return resolve();
          const cek = () => {
            if (el.readyState >= 2) return resolve();
            if (Date.now() >= Date.now() + 4000) return resolve();
            setTimeout(cek, 60);
          };
          el.addEventListener('loadeddata', () => resolve(), { once: true });
          cek();
        });
      };
      const gantiMukaMandiri = async (facing) => {
        try {
          const lama = scanAktif && scanAktif.stream;
          const baru = await bukaStreamKamera([facing, {}], { width: { ideal: 640 }, height: { ideal: 480 } });
          if (!video || !video.isConnected) { baru.getTracks().forEach(t => t.stop()); return; }
          video.srcObject = baru;
          await video.play();
          await tungguSiapMandiri(video);
          if (scanAktif) { scanAktif.stream = baru; scanAktif.video = video; }
          if (lama) lama.getTracks().forEach(t => t.stop());
          // [B3] Jangan percaya permintaan "facing" — baca facingMode ASLI dari kamera
          // yang benar-benar terbuka (perangkat kamera-tunggal bisa fallback ke depan
          // walau diminta 'environment'). Ini menjaga mirror & label tetap benar.
          facingMandiri = (() => {
            const tr = baru.getVideoTracks && baru.getVideoTracks()[0];
            const st = tr && typeof tr.getSettings === 'function' ? tr.getSettings() : null;
            return (st && (st.facingMode === 'user' || st.facingMode === 'environment')) ? st.facingMode : facing;
          })();
          setTransformMandiri();
          tandaiMukaMandiri();
          setStatus('<i class="fa-solid fa-video mr-1"></i>Kamera ' + (facingMandiri === 'user' ? 'depan' : 'belakang') + ' aktif — hadapkan wajah lurus ke kamera ±40–80 cm.', 'text-cyan-100');
        } catch (e2) {
          console.error('gantiMukaMandiri:', e2);
          setStatus('<i class="fa-solid fa-triangle-exclamation mr-1"></i>' + fxEscape(e2 && e2.message ? e2.message : e2), 'text-amber-200');
        }
      };
      const btnCamUserM = document.getElementById('btn-mandiri-cam-user');
      const btnCamEnvM = document.getElementById('btn-mandiri-cam-env');
      if (btnCamUserM) btnCamUserM.addEventListener('click', () => gantiMukaMandiri('user'));
      if (btnCamEnvM) btnCamEnvM.addEventListener('click', () => gantiMukaMandiri('environment'));
      tandaiMukaMandiri();

      await loopDeteksiPindai({
        wrap, video, overlay, matcher,
        peta: { [nisS]: { descriptor: daftarSampel } },
        cooldown: {}, setStatus, nisList: [nisS],
        onMatch: (nisCocok) => {
          if (String(nisCocok) !== nisS) return false; // hanya identitas sendiri
          // Notif popup + TTS (sama seperti QR Scan) — nama siswa dibacakan.
          try {
            fxToast('success', 'Hadir — ' + (nama || nisS));
            if ('speechSynthesis' in window) {
              const uc = new SpeechSynthesisUtterance('Absen mandiri berhasil. Selamat datang, ' + (nama || 'siswa'));
              uc.lang = 'id-ID'; uc.rate = 1.35; uc.pitch = 1;
              window.speechSynthesis.speak(uc);
            }
          } catch (e) { /* TTS/toast opsional */ }
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
  // 7c. PRE-WARM MODEL — pindai & modal jadi instan
  // ==================================================================
  // Model (±6,4 MB) diunduh SAAT HALAMAN IDLE, bukan ketika admin menekan
  // Face Scan / membuka modal. Server aplikasi menyajikan folder models/ (di
  // jaringan lokal sekolah umumnya cepat & browser meng-cache), sehingga
  // pemindaian pertama tidak lagi menunggu unduhan besar. Gagal diam-diam:
  // jalur on-demand (pastikanModels) tetap bekerja seperti biasa.
  (function preWarmModelSaatIdle() {
    const mulai = () => {
      try {
        if (motorWajah() === 'mediapipe') {
          pastikanModelsMediapipe().then(() => { try { pastikanOrtEmbedder().catch(() => {}); } catch (e2) { /* on-demand */ } }).catch(() => {});
        } else {
          pastikanModels().catch(() => {});
        }
      } catch (e) { /* on-demand tetap ada */ }
    };
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

  // Kamera dilepas otomatis saat peramban/tab disembunjikan — browser bisa terus menahan
  // stream di modal yang tidak lagi terlihat & diblokir modal lain ("Kamera sedang
  // dipakai… NotReadable"). User makan kembali → klik Face Scan ulang.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      berhentiPindaiWajah();
      hentikanKamera();
    }
  });

  // [B6] Registrasi wajah otomatis dari foto profil yang sudah tersimpan (url_foto).
  // Dipakai menu "Data Akun Murid": satu klik menyisipkan 1 sampel descriptor dari
  // foto Drive murid tanpa buka modal kamera. Mengembalikan { ok, skor, pesan? }.
  async function registrasiOtomatisDariFoto(nis, urlFoto, nama) {
    const nisS = String(nis || '');
    if (!urlFoto) return { ok: false, pesan: 'Murid belum punya foto profil. Gunakan kamera.' };
    try {
      await pastikanModelsRinganTepatWaktu();
      const img = await muatGambarDariUrl(urlFoto);
      const hasil = await hasilDeteksiKuat(img, 'foto');
      const d = Array.from(hasil.descriptor);
      await simpanWajahKeDb(nisS, [d], 'aktif', 'ganti');
      if (petaWajahCache) petaWajahCache[nisS] = { descriptor: [d], status: 'aktif' };
      try { beriTahuWajahTersimpan(nisS, 'aktif'); } catch (e) {}
      if (typeof refreshDaftarWajahTable === 'function') { try { refreshDaftarWajahTable(); } catch (e) {} }
      return { ok: true, skor: hasil.skor, nama: nama || '' };
    } catch (e) {
      console.error('registrasiOtomatisDariFoto:', e);
      return { ok: false, pesan: (e && e.message) ? e.message : String(e) };
    }
  }

  /* [8] EKSPOR API PUBLIK — jangan sampai terkomentari */
  window.FaceWajah = {
    kelolaWajah,
    hapusDataWajah,
    muatPetaWajah,
    ambilStatusWajah,
    htmlBadgeWajah,
    ikonStatusWajah,
    mulaiPindaiWajahAbsen,
    berhentiPindaiWajah,
    isWajahMandiriAktif,
    pindaiWajahMandiri,
    registrasiOtomatisDariFoto,
    urlFotoUntukCanvas
  };
})();