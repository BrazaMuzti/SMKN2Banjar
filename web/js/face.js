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
  const DETECT_INTERVAL_MS = 180;   // jeda antar-frame analisis saat pindai live

  let modelsLoaded = false;
  let modelsPromise = null;
  let petaWajahCache = null;        // { nis: { descriptor:[128], status } } — cache tab registrasi
  let scanAktif = null;             // state pindai live (dihentikan total sebelum mulai ulang)

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
  async function pastikanModels() {
    if (modelsLoaded) return true;
    if (!window.faceapi || typeof window.faceapi.nets === 'undefined') {
      throw new Error('Library pengenalan wajah belum dimuat. Periksa file vendor/face-api.min.js.');
    }
    if (modelsPromise) return modelsPromise;
    const fa = window.faceapi;
    const muatSekali = async () => {
      await fa.nets.tinyFaceDetector.loadFromUri(MODELS_DIR);
      await fa.nets.faceLandmark68Net.loadFromUri(MODELS_DIR);
      await fa.nets.faceRecognitionNet.loadFromUri(MODELS_DIR);
    };
    modelsPromise = (async () => {
      try {
        await muatSekali();
      } catch (ePertama) {
        // Unduhan .bin besar (terutama face_recognition_model.bin ±6,4 MB) mudah
        // terputus di jaringan lambat/bergoyang → jeda sejenak lalu coba sekali
        // lagi sebelum benar-benar menyerah.
        console.warn('Muat model wajah gagal pertama kali, mencoba ulang:', (ePertama && ePertama.message) || ePertama);
        await new Promise(r => setTimeout(r, 900));
        await muatSekali();
      }
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

  // ------------------------------------------------------------------
  // 3. Foto siswa dari Google Drive — konversi CORS-safe
  // ------------------------------------------------------------------
  // drive.google.com/file/d/{ID}/view → lh3.googleusercontent.com/d/{ID}=w1200
  // (lh3 mengirim header Access-Control-Allow-Origin: * sehingga fetch lintas
  //  origin + canvas tidak "dikotori" — syarat membaca pixel wajah.)
  function urlFotoUntukCanvas(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    let m = u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) m = u.match(/drive\.google\.com\/(?:uc|open)\?(?:.*?)(?:&|^)id=([a-zA-Z0-9_-]+)/);
    if (m) return 'https://lh3.googleusercontent.com/d/' + m[1] + '=w1200';
    if (/lh3\.googleusercontent\.com|\.googleusercontent\.com/.test(u)) return u;
    return u; // domain lain diizinkan; fetch bisa gagal tanpa CORS → pesan jelas
  }

  /** Muat URL foto menjadi HTMLImageElement siap deteksi (blob via fetch → objectURL). */
  async function muatGambarDariUrl(url) {
    const target = urlFotoUntukCanvas(url);
    if (!target) throw new Error('Murid belum punya foto. Gunakan kamera.');
    let resp;
    try {
      resp = await fetch(target, { mode: 'cors', referrerPolicy: 'no-referrer' });
    } catch (e) {
      console.warn('muatGambarDariUrl fetch:', e);
      throw new Error('Foto tidak dapat diunduh — koneksi/izin jaringan terganggu. Pastikan internet stabil, atau gunakan tombol Kamera.');
    }
    if (!resp.ok) throw new Error('Foto tidak dapat diunduh (HTTP ' + resp.status + ').');
    const blob = await resp.blob();
    if (!blob || !blob.size) throw new Error('File foto kosong.');
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('File foto tidak valid.')); });
    return img;
  }

  // ------------------------------------------------------------------
  // 4. Deteksi + descriptor (sumber: Image / video / canvas)
  // ------------------------------------------------------------------
  async function deteksiSatuWajah(el, opts) {
    const fa = window.faceapi;
    const o = opts || {};
    const conf = o.scoreThreshold || 0.35;
    const inputSize = o.inputSize || 320;
    const deteksi = await fa.detectSingleFace(el, new fa.TinyFaceDetectorOptions({ inputSize, scoreThreshold: conf }))
      .withFaceLandmarks(true)
      .withFaceDescriptor();
    return deteksi; // null bila tidak ada wajah
  }

  /** Bangun FaceMatcher dari daftar { nis, descriptor } (dari DB wajah_descriptor jsonb). */
  function buatMatcherDariPeta(peta) {
    const fa = window.faceapi;
    const labeled = [];
    Object.keys(peta || {}).forEach(nis => {
      const d = peta[nis] && peta[nis].descriptor;
      if (Array.isArray(d) && d.length === 128) {
        labeled.push(new fa.LabeledFaceDescriptors(String(nis), [Array.from(d)]));
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

  /** Simpan/hapus data wajah lewat RPC (security definer). */
  async function simpanWajahKeDb(nis, descriptorArray, status) {
    const fa = fxSupabase();
    const pgl = pemanggilKini();
    const payload = {
      p_nis: String(nis),
      p_descriptor: descriptorArray ? descriptorArray : null,
      p_status: status || 'aktif',
      p_pemanggil_nis: pgl.nis,
      p_pemanggil_tipe: pgl.tipe
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
        descriptor: Array.isArray(r.wajah_descriptor) ? r.wajah_descriptor : null,
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
  let kameraBerjalan = null; // { stream, video } aktif saat ini

  async function mulaiKameraKe(videoEl, deviceId) {
    hentikanKamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Kamera tidak tersedia di peramban ini (butuh HTTPS atau localhost).');
    }
    const videoCfg = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
      : { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } };
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoCfg, audio: false });
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

    kameraBerjalan = null;
  }

  /** deviceId kamera yang sedang benar-benar dipakai (dari track stream aktif). */
  function kameraAktifDeviceId() {
    if (kameraBerjalan && kameraBerjalan.stream) {
      const track = kameraBerjalan.stream.getVideoTracks()[0];
      if (track && typeof track.getSettings === 'function') return track.getSettings().deviceId || '';
    }
    return '';
  }

  /** Isi dropdown pilihan kamera & pasang listener ganti kamera (sekali per modal). */
  async function isiDaftarKamera(selectEl, onGanti) {
    if (!selectEl || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    if (selectEl.dataset.terisi === '1') return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = (devices || []).filter(d => d.kind === 'videoinput');
      if (!videoDevices.length) return;
      const aktifId = kameraAktifDeviceId();
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
    if (d.score < SKOR_MIN_FOTO) {
      throw new Error('Wajah terdeteksi tapi kurang jelas (skor ' + d.score.toFixed(2) + '). Gunakan foto lebih terang/tajam.');
    }
    return { descriptor: Array.from(d.descriptor), skor: d.score };
  }

  /** Muat model face-api dengan batas waktu — modal tetap terbuka meski model lambat/gagal. */
  function pastikanModelsTepatWaktu(ms = 12000) {
    const pesanTimeout = 'Memuat model wajah terlalu lama (lebih dari ' + Math.round(ms / 1000) + ' detik). Periksa koneksi dan pastikan folder "models" tersaji oleh server, lalu muat ulang halaman dan coba lagi.';
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(pesanTimeout)), ms));
    return Promise.race([pastikanModels(), timeout]);
  }

  async function kelolaWajah(nis) {
    const murid = (typeof cacheAkunMurid !== 'undefined' && cacheAkunMurid.find)
      ? cacheAkunMurid.find(m => String(m.nis_nip) === String(nis))
      : null;
    if (!murid) { fxToast('error', 'Data murid tidak ditemukan.'); return; }

    // Modal dibuka SEKETIKA (tanpa await di depan) — klik tombol tabel selalu diberi respons.
    // Model face-api dimuat di dalam modal (didOpen) supaya tombol "Gunakan Foto"/"Gunakan Kamera"
    // siap dipakai begitu model siap, tanpa menahan pembukaan modal.
    let descriptorSementara = null;      // hasil deteksi terakhir (array 128)
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
          <video id="wajah-video" autoplay playsinline muted class="w-full h-52 object-cover"></video>
          <button id="btn-wajah-tangkap" class="w-full bg-cyan-600 hover:bg-cyan-700 text-white px-3 py-2.5 rounded-lg text-[11px] font-bold transition" title="Deteksi wajah dari frame kamera"><i class="fa-solid fa-camera mr-1"></i>Deteksi dari Kamera</button>
        </div>
        <div id="wajah-hasil" class="text-center text-[11px] min-h-[16px] mb-2 text-slate-300">${st === 'aktif' ? '<i class="fa-solid fa-circle-check text-green-400 mr-1"></i>Sudah terdaftar — menyimpan ulang akan menimpa wajah lama.' : 'Pilih sumber wajah (foto siswa atau kamera).'}</div>
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
        // Guard: elemen modal yang hilang TIDAK boleh terjadi senyap.
        ['wajah-preview','wajah-hasil','btn-wajah-foto','btn-wajah-kamera',
         'wajah-camera-area','wajah-video','btn-wajah-tangkap','btn-wajah-simpan'].forEach((id) => {
          if (!cari(id)) console.error('[FaceWajah] Elemen #' + id + ' tidak ditemukan di dalam modal.');
        });

        const setHasil = (teks, warna) => {
          if (!hasilEl) return;
          hasilEl.innerHTML = teks;
          hasilEl.className = 'text-center text-[11px] min-h-[16px] mb-2 ' + (warna || 'text-slate-300');
        };
        const aktifkanSimpan = () => {
          if (!btnSimpan) return;
          btnSimpan.disabled = !descriptorSementara;
          btnSimpan.innerHTML = descriptorSementara
            ? '<i class="fa-solid fa-floppy-disk mr-1"></i>Simpan Wajah (skor ' + skorSementara.toFixed(2) + ')'
            : '<i class="fa-solid fa-floppy-disk mr-1"></i>Simpan Data Wajah';
        };

        // Foto siswa: tampilkan fallback "Tanpa foto" bila akun tidak punya url_foto.
        if (pratinjau) {
          if (!murid.url_foto) {
            pratinjau.outerHTML = '<span id="wajah-preview" class="w-24 h-28 rounded-lg bg-slate-800 border border-white/10 flex items-center justify-center text-slate-500 text-xs"><i class="fa-solid fa-user-slash text-xl mb-1"></i><br>Tanpa foto</span>';
          } else {
            pratinjau.src = urlFotoUntukCanvas(murid.url_foto);
          }
        }

        // ===== Muat model DI DALAM modal — tidak lagi memblokir pembukaannya. =====
        if (btnFoto) btnFoto.disabled = true;
        if (btnKam) btnKam.disabled = true;
        setHasil('<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Menyiapkan model wajah…');
        try {
          await pastikanModelsTepatWaktu(12000);
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
            descriptorSementara = hasil.descriptor; skorSementara = hasil.skor;
            setHasil('<i class="fa-solid fa-check text-green-400 mr-1"></i>Wajah terdeteksi (skor ' + hasil.skor.toFixed(2) + '). Klik <b>Simpan Data Wajah</b>.', 'text-green-300');
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
            });
            setHasil('<i class="fa-solid fa-video mr-1"></i>Kamera aktif — pilih kamera lain di menu bila perlu, atur posisi wajah lalu klik <b>Deteksi dari Kamera</b>.');
          } catch (e) {
            console.error(e);
            setHasil(fxEscape(e.message || e), 'text-red-300');
          }
        });

        if (btnTangkap) btnTangkap.addEventListener('click', async () => {
          if (!videoEl.srcObject) { setHasil('Nyalakan kamera dulu.', 'text-amber-300'); return; }
          setHasil('<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Mendeteksi wajah dari kamera...');
          try {
            const hasil = await hasilDeteksiKuat(videoEl, 'kamera');
            descriptorSementara = hasil.descriptor; skorSementara = hasil.skor;
            const canvas = document.createElement('canvas');
            canvas.width = videoEl.videoWidth || 640; canvas.height = videoEl.videoHeight || 480;
            canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            const snap = cari('wajah-preview');
            if (snap) {
              if (snap.tagName !== 'IMG') snap.outerHTML = '<img id="wajah-preview" class="w-24 h-28 rounded-lg object-cover bg-slate-700 border border-white/10" alt="Foto siswa">';
              const imgSnap = cari('wajah-preview');
              if (imgSnap) imgSnap.src = canvas.toDataURL('image/jpeg', 0.85);
            }
            setHasil('<i class="fa-solid fa-check text-green-400 mr-1"></i>Wajah terdeteksi dari kamera (skor ' + hasil.skor.toFixed(2) + '). Klik <b>Simpan Data Wajah</b>.', 'text-green-300');
            aktifkanSimpan();
          } catch (e) {
            console.error(e);
            setHasil(fxEscape(e.message || e), 'text-red-300');
          }
        });

        if (btnSimpan) btnSimpan.addEventListener('click', async () => {
          if (!descriptorSementara) return;
          btnSimpan.disabled = true;
          btnSimpan.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Menyimpan...';
          try {
            await simpanWajahKeDb(nis, descriptorSementara, 'aktif');
            if (petaWajahCache) petaWajahCache[String(nis)] = { descriptor: descriptorSementara, status: 'aktif' };
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
   */
  async function mulaiPindaiWajahAbsen(listMurid, cfg) {
    berhentiPindaiWajah();
    const wrap = cfg && cfg.wrap;
    const onMatch = cfg && cfg.onMatch;
    if (!wrap) { fxToast('error', 'Wadah pemindaian tidak ditemukan.'); return; }

    try {
      // Tahap 1 — model pengenalan wajah (unduh models/*.bin dari server aplikasi).
      try {
        await pastikanModels();
      } catch (e) {
        const ganti = perjelasErrorJaringan(e,
          'Gagal mengunduh model pengenalan wajah (koneksi/unduhan terputus). Muat ulang halaman lalu coba lagi — pastikan internet stabil dan folder "models" tersedia di server.');
        if (ganti) throw new Error(ganti);
        throw e;
      }

      const fa = window.faceapi;
      const nisList = [...new Set((listMurid || []).map(m => String(m.nis)).filter(Boolean))];

      // Tahap 2 — ambil descriptor wajah siswa dari database (REST ke Supabase).
      let peta = {};
      if (nisList.length) {
        try {
          const query = fxSupabase().from('akun').select('nis_nip, wajah_descriptor, wajah_status')
            .eq('tipe', 'murid').in('nis_nip', nisList).not('wajah_descriptor', 'is', null);
          const rows = await fxAmbilSemua(query);
          (rows || []).forEach(r => {
            if (r.wajah_status === 'aktif' && Array.isArray(r.wajah_descriptor) && r.wajah_descriptor.length === 128) {
              peta[String(r.nis_nip)] = { descriptor: r.wajah_descriptor };
            }
          });
        } catch (e) {
          const ganti = perjelasErrorJaringan(e,
            'Gagal mengambil data wajah siswa dari server (koneksi ke database bermasalah). Periksa koneksi internet Anda, lalu coba lagi.');
          if (ganti) throw new Error(ganti);
          throw e;
        }
      }

      const matcher = buatMatcherDariPeta(peta);
      if (!matcher) {
        wrap.innerHTML = `<div class="rounded border border-amber-500/50 bg-amber-900/30 text-amber-200 text-xs p-3 mb-3 text-center"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Belum ada siswa di kelas ini yang terdaftar wajah.<br><span class="text-amber-100/70">Daftarkan lewat tombol <b>Registrasi</b> pada baris murid di menu <b>Data Akun Murid</b>.</span></div>`;
        return;
      }

      wrap.innerHTML = `
        <div class="relative rounded-lg overflow-hidden border-2 border-cyan-500 bg-black mb-3">
          <video id="wajah-live-video" autoplay playsinline muted class="w-full h-56 object-cover"></video>
          <canvas id="wajah-live-overlay" class="absolute inset-0 w-full h-full pointer-events-none"></canvas>
          <div id="wajah-live-status" class="absolute top-2 left-2 right-2 text-center text-[11px] font-bold text-white drop-shadow-lg bg-black/40 rounded px-2 py-1">Menyiapkan kamera...</div>
          <button id="btn-wajah-live-stop" class="absolute bottom-2 right-2 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold px-2.5 py-1 rounded-lg shadow-lg">Berhenti</button>
        </div>`;
      wrap.classList.remove('hidden');

      const video = document.getElementById('wajah-live-video');
      const overlay = document.getElementById('wajah-live-overlay');
      const statusEl = document.getElementById('wajah-live-status');
      const btnStop = document.getElementById('btn-wajah-live-stop');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();

      const cooldown = {}; // nis → last match timestamp
      const terdeteksi = new Set(); // nis yang susah cocok — beri tahu sekali
      scanAktif = { hentikan: false, stream };

      const setStatus = (teks, warna) => {
        statusEl.innerHTML = teks;
        statusEl.className = 'absolute top-2 left-2 right-2 text-center text-[11px] font-bold drop-shadow-lg bg-black/40 rounded px-2 py-1 ' + (warna || 'text-white');
      };

      btnStop.addEventListener('click', () => berhentiPindaiWajah());

      setStatus('<i class="fa-solid fa-video mr-1"></i>Kamera menyala — hadapkan wajah ke kamera.');

      await loopDeteksiPindai({ wrap, video, overlay, matcher, peta, cooldown, terdeteksi, setStatus, onMatch, nisList });
    } catch (e) {
      console.error('mulaiPindaiWajahAbsen:', e);
      wrap.innerHTML = `<div class="rounded border border-red-500/50 bg-red-900/30 text-red-200 text-xs p-3 mb-3">${fxEscape(e && e.message ? e.message : e)}</div>`;
      berhentiPindaiWajah();
    }
  }

  /** Loop deteksi wajah pada video live sampai dihentikan / modal tertutup. */
  async function loopDeteksiPindai(o) {
    const fa = window.faceapi;
    const opts = new fa.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.25 });
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
          o.setStatus('<i class="fa-solid fa-circle-check mr-1" style="color:#4ade80"></i>Cocok! ' + fxEscape(nis) + ' — Hadir (' + hadirCount + '×).', 'text-green-100');
        }
      } else {
        const namaCocok = best && best.label !== 'unknown'
          ? (best.label + ' jarak ' + best.distance.toFixed(2))
          : 'Wajah tidak dikenal';
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
      await pastikanModels();
      const fa = window.faceapi;
      const nisS = String(nis || '');
      if (!nisS) throw new Error('NIS pemanggil kosong.');

      // Ambil descriptor milik murid ini sendiri (wajah_status aktif)
      const rows = await fxAmbilSemua(
        fxSupabase().from('akun').select('nis_nip, wajah_descriptor')
          .eq('tipe', 'murid').eq('nis_nip', nisS).eq('wajah_status', 'aktif').not('wajah_descriptor', 'is', null)
      );
      const row = (rows || [])[0];
      if (!row || !Array.isArray(row.wajah_descriptor) || row.wajah_descriptor.length !== 128) {
        wrap.innerHTML = `<div class="rounded border border-amber-500/50 bg-amber-900/30 text-amber-200 text-[10px] p-2 mb-2 text-center">Wajah ${fxEscape(nama || nisS)} belum terdaftar/aktif.<br><span class="text-amber-100/70">Daftarkan di menu Manajemen Akun Murid → Registrasi Wajah.</span></div>`;
        return false;
      }

      const matcher = buatMatcherDariPeta({ [nisS]: { descriptor: row.wajah_descriptor } });
      if (!matcher) {
        wrap.innerHTML = `<div class="rounded border border-amber-500/50 bg-amber-900/30 text-amber-200 text-[10px] p-2 mb-2 text-center">Data wajah tidak valid.</div>`;
        return false;
      }

      wrap.innerHTML = `
        <div class="relative rounded-lg overflow-hidden border border-cyan-500 bg-black">
          <video id="wajah-mandiri-video" autoplay playsinline muted class="w-full h-40 object-cover"></video>
          <canvas id="wajah-mandiri-overlay" class="absolute inset-0 w-full h-full pointer-events-none"></canvas>
          <div id="wajah-mandiri-live-status" class="absolute top-1.5 left-1.5 right-1.5 text-center text-[10px] font-bold text-white drop-shadow-lg bg-black/40 rounded px-2 py-0.5">Menyiapkan kamera...</div>
          <button id="btn-wajah-mandiri-stop" class="absolute bottom-1.5 right-1.5 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold px-2 py-0.5 rounded shadow">Berhenti</button>
        </div>`;

      const video = document.getElementById('wajah-mandiri-video');
      const overlay = document.getElementById('wajah-mandiri-overlay');
      const statusEl = document.getElementById('wajah-mandiri-live-status');
      const btnStop = document.getElementById('btn-wajah-mandiri-stop');

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false
        });
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
      setStatus('<i class="fa-solid fa-video mr-1"></i>Hadapkan wajah ke kamera.');

      btnStop.addEventListener('click', () => berhentiPindaiWajah());

      await loopDeteksiPindai({
        wrap, video, overlay, matcher,
        peta: { [nisS]: { descriptor: row.wajah_descriptor } },
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