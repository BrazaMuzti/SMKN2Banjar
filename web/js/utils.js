/**
 * utils.js — Adapter Supabase untuk SISIP
 */

// 1. Inisialisasi Supabase
const SUPABASE_URL_DEFAULT = 'https://lkhuyoihrrnzvrmhquln.supabase.co';
const SUPABASE_ANON_KEY_DEFAULT = 'sb_publishable_o_pUNncXPyOmV2yhhOevcw_58aUM3pB';
const SERVER_CONFIG_KEY = 'sisip_server_config';

function ambilKonfigurasiServer() {
  try {
    const cfg = JSON.parse(localStorage.getItem(SERVER_CONFIG_KEY) || 'null');
    if (cfg && cfg.url && cfg.key) return { url: String(cfg.url), key: String(cfg.key), gcalClientId: String(cfg.gcalClientId || '') };
  } catch (e) { /* config rusak → pakai default */ }
  return { url: SUPABASE_URL_DEFAULT, key: SUPABASE_ANON_KEY_DEFAULT, gcalClientId: '' };
}

function simpanKonfigurasiServer(url, key, gcalClientId) {
  let lama = {};
  try { lama = JSON.parse(localStorage.getItem(SERVER_CONFIG_KEY) || '{}') || {}; } catch (e) { /* abaikan */ }
  localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify({
    url,
    key,
    gcalClientId: (gcalClientId !== undefined) ? String(gcalClientId || '').trim() : String(lama.gcalClientId || '')
  }));
}

function hapusKonfigurasiServer() {
  localStorage.removeItem(SERVER_CONFIG_KEY);
}

// PERBAIKAN: Gunakan nama 'supaClient' agar tidak bentrok dengan library bawaan CDN
let SUPABASE_URL = SUPABASE_URL_DEFAULT;
let SUPABASE_ANON_KEY = SUPABASE_ANON_KEY_DEFAULT;
let supaClient = null;
function initSupaClient(url, key) {
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    throw new Error('Library Supabase (supabase-js) belum termuat. Periksa koneksi internet/CDN.');
  }
  SUPABASE_URL = url;
  SUPABASE_ANON_KEY = key;
  supaClient = window.supabase.createClient(url, key, {
    auth: {
      // Key storage unik per project agar tidak bentrok bila URL server berganti
      // dan mudah dibedakan dari data localStorage aplikasi sendiri (sisip_*).
      storageKey: 'sisip-supabase-auth-token',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // PERBAIKAN: GoTrue secara default memakai Navigator Web Locks API
      // (navigator.locks) untuk mengunci storageKey di atas antar-tab/instance.
      // Bila beberapa tab aplikasi ini terbuka bersamaan, lock itu sering GAGAL
      // seketika (NavigatorLockAcquireTimeoutError / "Acquiring an exclusive
      // Navigator LockManager lock ... immediately failed") sebagai unhandled
      // rejection yang tidak selalu bisa ditangkap andal lewat listener global.
      // Aplikasi ini TIDAK bergantung pada sesi Auth Supabase (dipakai hanya utk
      // akses anon/OAuth ringan) — login SISIP sendiri pakai sisip_token/sisip_user
      // di localStorage. Jadi aman melewati Web Locks API sepenuhnya dengan
      // lock kustom no-op agar error ini tidak pernah terjadi.
      lock: async (name, acquireTimeout, fn) => await fn()
    }
  });

  // Refresh token basi (kedaluwarsa/dicabut server) memicu AuthApiError saat
  // auto-refresh berjalan di background (mis. saat tab kembali fokus).
  // Bersihkan sesi Auth Supabase yang rusak itu agar tidak mengulang error terus-menerus.
  // Sesi login aplikasi sendiri (sisip_token/sisip_user) TIDAK terpengaruh oleh ini.
  supaClient.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT') return;
  });
}
(() => {
  const cfg = ambilKonfigurasiServer();
  try {
    initSupaClient(cfg.url, cfg.key);
  } catch (e) {
    console.error('Konfigurasi server tersimpan tidak valid, kembali ke default:', e);
    hapusKonfigurasiServer();
    try {
      initSupaClient(SUPABASE_URL_DEFAULT, SUPABASE_ANON_KEY_DEFAULT);
    } catch (e2) {
      console.error('Gagal menginisialisasi Supabase client bahkan dengan konfigurasi default:', e2);
      supaClient = null;
    }
  }

  // Tangkap error non-fatal global dari GoTrue (Supabase Auth) yang berjalan di
  // background dan TIDAK melalui alur await kode kita sendiri:
  //   - "Invalid Refresh Token" / "refresh token" → sesi Auth Supabase basi (kedaluwarsa/dicabut).
  //   - "Navigator LockManager lock ... immediately failed" → kontensi Web Locks API
  //     antar-tab/instance GoTrue (mis. tab lain masih terbuka, atau lock nyangkut dari
  //     reload sebelumnya). Ini tidak berbahaya untuk aplikasi ini karena sesi login
  //     SISIP sendiri (sisip_token/sisip_user) tidak memakai Supabase Auth session sama sekali.
  window.addEventListener('unhandledrejection', (ev) => {
    const msg = (ev && ev.reason && ev.reason.message) || '';
    if (/refresh token/i.test(msg) && supaClient) {
      ev.preventDefault();
      console.warn('Sesi Supabase Auth basi terdeteksi, membersihkan token lokal:', msg);
      try { localStorage.removeItem('sisip-supabase-auth-token'); } catch (e) { /* abaikan */ }
    } else if (/navigator lockmanager|acquiring an exclusive/i.test(msg)) {
      ev.preventDefault();
      console.warn('Kontensi lock Supabase Auth (biasanya karena tab lain terbuka), diabaikan:', msg);
    }
  });
})();



// Manajemen Sesi Lokal (Harus ada di utils.js)
function getToken() {
  return localStorage.getItem('sisip_token') || '';
}

function setSession(token, user) {
  localStorage.setItem('sisip_token', token);
  localStorage.setItem('sisip_user', JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem('sisip_token');
  localStorage.removeItem('sisip_user');
}

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('sisip_user') || 'null');
  } catch (e) {
    return null;
  }
}

// 3. Pengganti apiCall (Router Request Backend)

/** Bangun respons sesi dari profil tabel 'akun' + user Auth.
 *  Dipakai bersama oleh login password dan sesi OAuth (GitHub). */
function bangunResponsSesi(prof, emailFallback, token) {
  const tipe = (prof && prof.tipe) || 'murid';
  const nama = (prof && prof.nama_lengkap) || emailFallback || 'Pengguna';
  const mappedUser = {
    "Nama Lengkap": nama,
    "Nama Guru": nama,
    "Gelar Depan": (prof && prof.gelar_depan) || "",
    "Gelar Belakang": (prof && prof.gelar_belakang) || "",
    "NIS": tipe === 'murid' ? ((prof && prof.nis_nip) || "") : "",
    // Admin juga punya NIP/NIS sebagai identitas — wajib agar Edge Function
    // unggah-foto-murid bisa memverifikasi klaim admin (jalur non-JWT).
    "NIP": (tipe === 'guru' || tipe === 'admin') ? ((prof && prof.nis_nip) || "") : "",
    "ID Akun Guru": (tipe === 'guru' || tipe === 'admin') ? ((prof && prof.nis_nip) || "") : "",
    "Email": (prof && prof.email) || emailFallback || "",
    "Tingkat/Kelas": (prof && prof.tingkat_kelas) || "",
    "Jabatan": (prof && prof.jabatan) || "",
    "Jabatan Kelas": tipe === 'murid' ? ((prof && prof.jabatan) || "") : "",
    "Wali Kelas": (prof && prof.wali_kelas) || "",
    "Custom Teks Mata Pelajaran": tipe === 'guru' ? ((prof && prof.mapel) || "") : "",
    "Ekstrakurikuler": (prof && prof.ekstrakurikuler) || "",
    "Jabatan Ekstrakurikuler": (prof && prof.jabatan_ekskul) || "",
    "Jabatan Ekstrakurikuler Map": (prof && prof.jabatan_ekskul_map && typeof prof.jabatan_ekskul_map === 'object') ? prof.jabatan_ekskul_map : {},
    "Penugasan": (prof && prof.penugasan) || {},
    "ID Tahun Pelajaran": (prof && prof.tahun_pelajaran) || (typeof currentTahun !== 'undefined' ? currentTahun : "") || ""
  };
  return { status: 'success', role: tipe, user: mappedUser, token };
}

async function apiCall(action, data = {}) {
  if (!supaClient) {
    return { status: 'error', message: 'Gagal terhubung ke Supabase. Periksa Konfigurasi Server (ikon gerigi di kartu login) — URL/Anon Key mungkin tidak valid atau library Supabase gagal dimuat.' };
  }
  try {
    if (action === 'login') {
      const identifier = String(data.username || '').trim();
      const password = String(data.password || '');
      if (!identifier || !password) return { status: 'error', message: 'Isi NIS/NIP/Email dan Password.' };

      // Skema DB saat ini: tabel 'akun' (user_id → auth.users, tipe = role).
      // Password murid (akun lokal tanpa Google) di-hash di tabel akun_kredensial
      // (RLS tertutup) dan diverifikasi via RPC; guru/admin & akun Google via Supabase Auth.
      let emailAuth = identifier;
      if (!identifier.includes('@')) {
        // 1) Coba akun murid ber-password lokal (RPC bcrypt)
        const { data: rpcRes, error: rpcErr } = await supaClient.rpc('cek_login_murid', {
          p_nis: identifier,
          p_password: password
        });
        if (!rpcErr && rpcRes && rpcRes.status === 'success') {
          // Token sesi diterbitkan SERVER (tabel `sesi_lokal`) — upgrade_20261028a.
          // Bila DB belum dimigrasi, jatuh ke pola token lama agar login tetap jalan.
          const tokenSesi = rpcRes.sesi_token || ('lokal-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()));
          return bangunResponsSesi(rpcRes.akun, rpcRes.akun.email || '', tokenSesi);
        }
        // 2) Fallback: cari email akun terkait NIS/NIP → Supabase Auth (guru/admin/Google)
        //    Baca tabel `akun` kini lewat RPC (RLS ketat) — bukan `from('akun')`.
        const identitasNis = await akunIdentitasLogin(identifier);
        if (identitasNis.error) return { status: 'error', message: 'Gagal mencari akun: ' + identitasNis.error.message };
        const byNis = (identitasNis.akun || [])[0] || null;
        if (!byNis) {
          const pesanRpc = (!rpcErr && rpcRes && rpcRes.message) ? rpcRes.message : 'NIS/NIP tidak terdaftar.';
          return { status: 'error', message: pesanRpc };
        }
        // Guru/admin tanpa email nyata memakai pola email dummy `[nis_nip]@sekolah.local`
        // (lihat upgrade_20261027_role_hybrid_opsiC.sql). Bila kolom email kosong,
        // pakai pola dummy agar signInWithPassword tetap menemukan akun Auth.
        emailAuth = byNis.email || ((byNis.tipe === 'guru' || byNis.tipe === 'admin')
          ? (identifier.toLowerCase() + '@sekolah.local')
          : '');
        if (!emailAuth) {
          const pesanRpc = (!rpcErr && rpcRes && rpcRes.message) ? rpcRes.message : 'NIS/NIP tidak terdaftar.';
          return { status: 'error', message: pesanRpc };
        }
      } else {
        // Login via email: coba akun murid lokal (lookup NIS dari email) lalu Supabase Auth
        const identitasEmail = await akunIdentitasLogin(identifier);
        const nisDariEmail = ((identitasEmail.akun || [])[0] || {}).nis_nip || null;
        if (nisDariEmail) {
          const { data: rpcRes, error: rpcErr } = await supaClient.rpc('cek_login_murid', {
            p_nis: nisDariEmail,
            p_password: password
          });
          if (!rpcErr && rpcRes && rpcRes.status === 'success') {
            const tokenSesi = rpcRes.sesi_token || ('lokal-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()));
            return bangunResponsSesi(rpcRes.akun, rpcRes.akun.email || identifier, tokenSesi);
          }
        }
      }

      const { data: authRes, error: authErr } = await supaClient.auth.signInWithPassword({ email: emailAuth, password });
      if (authErr || !authRes || !authRes.session) {
        return { status: 'error', message: 'Email/NIS atau Password salah. Jika akun Anda terdaftar via Google, gunakan tombol "Masuk dengan Google".' };
      }

      // Profil dari tabel `akun` — kini lewat RPC `profil_sesi_auth` (RLS ketat).
      const profilAuth = await supaRpc('profil_sesi_auth', { p_email: authRes.user.email || '' });
      if (profilAuth.error) return { status: 'error', message: 'Gagal memuat profil: ' + profilAuth.error.message };
      const prof = (profilAuth.data && profilAuth.data.status === 'success') ? profilAuth.data.akun : null;

      // Baris belum tertaut user_id tetapi email cocok → tautkan (best-effort),
      // kini lewat RPC `taut_user_id_sesi` (verifikasi email dari JWT di server).
      if (profilAuth.data && profilAuth.data.perlu_taut) {
        const taut = await supaRpc('taut_user_id_sesi', { p_email: authRes.user.email || '' });
        if (taut.error) console.warn('Taut user_id gagal:', taut.error.message);
      }
      if (!prof) {
        await supaClient.auth.signOut();
        return { status: 'error', message: 'Akun Auth belum terhubung ke tabel akun. Hubungi admin.' };
      }

      return bangunResponsSesi(prof, authRes.user.email || "", authRes.session.access_token);
    }

    if (action === 'sesi_auth') {
      // Sesi OAuth (GitHub) — supabase-js otomatis menukar kode redirect saat load;
      // cukup baca sesi aktif lalu bangun sessionUser dari profil tabel 'akun'.
      const { data } = await supaClient.auth.getSession();
      const sesi = data && data.session;
      if (!sesi || !sesi.user) return { status: 'no_session' };

      const profilAuth = await supaRpc('profil_sesi_auth', { p_email: sesi.user.email || '' });
      const prof = (profilAuth.data && profilAuth.data.status === 'success') ? profilAuth.data.akun : null;

      // Baris belum tertaut user_id tetapi email cocok → tautkan (best-effort),
      // kini lewat RPC `taut_user_id_sesi` (verifikasi email dari JWT di server).
      if (profilAuth.data && profilAuth.data.perlu_taut) {
        const taut = await supaRpc('taut_user_id_sesi', { p_email: sesi.user.email || '' });
        if (taut.error) console.warn('Taut user_id gagal:', taut.error.message);
      }

      if (!prof) {
        await supaClient.auth.signOut();
        return { status: 'error', message: 'Akun Auth belum terhubung ke tabel akun. Hubungi admin.' };
      }
      return bangunResponsSesi(prof, sesi.user.email || '', sesi.access_token);
    }

    if (action === 'save_absen_masal') {
      // Simpan absensi masal — skema tabel absensi (unique: nis,tanggal,mapel)
      const rows = (data.absenList || []).map(absen => ({
        nis: String(absen.nis || ''),
        nama: absen.nama || '',
        tanggal: data.tanggal,
        status: absen.status,
        keterangan: (absen.keterangan || data.keterangan_kehadiran_masal || '').trim(),
        mapel: data.mapel || '',
        ekskul: data.ekskul || '',
        kelas: data.kelas || '',
        tahun: data.tahun || '',
        semester: data.semester || '',
        bulan: data.bulan || '',
        id_guru: data.id_guru || '',
        metode: data.metode || 'Manual / QR',
        // Kolom gps (upgrade_20261024_absensi_gps.sql): "lat, lng" perangkat perekam / GPS lama yang dipertahankan
        gps: String(absen.gps || '').trim()
      }));
      if (rows.length === 0) return { status: 'success', message: 'Tidak ada data absensi.' };

      const { error } = await supaClient.from('absensi').upsert(rows, { onConflict: 'nis,tanggal,mapel' });
      if (error) throw error;
      return { status: 'success' };
    }

    if (action === 'hapus_absen_masal') {
      // Hapus permanen baris absensi — scope identik dengan save_absen_masal (kunci unik: nis,tanggal,mapel)
      const nisList = (data.nisList || []).map(n => String(n));
      if (nisList.length === 0) return { status: 'success', terhapus: 0 };
      const { count, error } = await supaClient
        .from('absensi')
        .delete({ count: 'exact' })
        .eq('tanggal', data.tanggal)
        .eq('mapel', data.mapel || '')
        .in('nis', nisList);
      if (error) throw error;
      return { status: 'success', terhapus: count || 0 };
    }

    if (action === 'save_keterangan_siswa') {
      // Perbarui keterangan per nis + tanggal + mapel
      for (const u of (data.updates || [])) {
        const { error } = await supaClient
          .from('absensi')
          .update({ keterangan: u.keterangan || '' })
          .eq('nis', String(data.nis))
          .eq('tanggal', u.tanggal)
          .eq('mapel', data.mapel || '');
        if (error) throw error;
      }
      return { status: 'success' };
    }

    if (action === 'absen_mandiri') {
      // ==== JALUR UTAMA (baru): RPC `absen_mandiri` (security definer) ====
      // Tanggal & validasi captcha diverifikasi di server → tidak bergantung
      // state browser (currentTahun/currentBulan yang bisa basi) maupun hak
      // tulis anon pada tabel absensi. Bila RPC belum dibuat di DB (PGRST202)
      // → otomatis jatuh ke fallback lama di bawah.
      const tglKini = new Date();
      const tanggalIso = `${tglKini.getFullYear()}-${String(tglKini.getMonth() + 1).padStart(2, '0')}-${String(tglKini.getDate()).padStart(2, '0')}`;
      const payloadRpc = {
        p_nis: String(data.nis || ''),
        p_nama: data.nama || '',
        p_kelas: data.kelas || '',
        p_tahun: data.tahun || '',
        p_bulan: data.bulan || '',
        p_mapel: data.mapel || '',
        p_captcha: String(data.captcha || '').trim(),
        p_gps: data.gps || '',
        p_wajah_cocok: !!data.wajahCocok,
        p_tanggal: tanggalIso, // diabaikan server (tanggal selalu WIB) — dikirim demi kompatibilitas
        // p_jenis ('Mapel'/'Ekskul') menentukan BUCKET kelas yang ditulis server:
        // Mapel → kelas efektif TA (riwayat_kelas), Ekskul → 'Semua Kelas'.
        p_jenis: String(data.jenis || '').toUpperCase() === 'EKSKUL' ? 'Ekskul' : 'Mapel'
      };
      let rpcHasil;
      try {
        rpcHasil = await supaClient.rpc('absen_mandiri', payloadRpc);
      } catch (rpcErr) {
        rpcHasil = { error: rpcErr };
      }
      const rpcErr = rpcHasil && rpcHasil.error;
      if (rpcErr) {
        const kodeRpc = String((rpcErr && rpcErr.code) || '').toUpperCase();
        if (kodeRpc !== 'PGRST202') {
          // RPC terpasang tapi menolak absensi → jangan tiru "berhasil"
          return { status: 'error', message: (rpcErr && rpcErr.message) || 'Absen ditolak server.' };
        }
        console.warn('absen_mandiri: RPC belum ada di DB — memakai fallback klien.', rpcErr);
      } else {
        const hasilRpc = (rpcHasil && rpcHasil.data) || {};
        if (hasilRpc.status === 'success') return { status: 'success', data: hasilRpc };
        return { status: 'error', message: hasilRpc.message || 'Absen ditolak server.' };
      }

      // ---- Fallback lama (RPC `absen_mandiri` belum dibuat di database) ----
      // Validasi plichtig ook hier consistent met RPC v3:
      //   * Metode 1 (kode): kode MOET matchen met BUKA-guru die mapel diampu;
      //   * Metode 2 (wajah): kode leeg mag ALLEEN bila wajahCocok=true;
      //   * beide: sessie BUKA blijft verplicht (zonder open sessie geen hadir).
      // Validasi di SERVER lewat RPC `cek_sesi_absen` — kolom captcha/kunci_absen
      // guru tidak lagi dibaca langsung dari klien (tabel `akun` ber-RLS ketat).
      const cekSesi = await akunCekSesiAbsen(data.mapel, data.captcha);
      if (cekSesi.status !== 'success') return { status: 'error', message: cekSesi.message || 'Validasi sesi absen gagal.' };
      if (!cekSesi.sesi_buka) return { status: 'error', message: 'Sesi absen belum dibuka guru untuk ' + String(data.mapel || '') + '.' };
      const captchaTekst = String(data.captcha || '').trim();
      if (captchaTekst !== '') {
        if (!cekSesi.captcha_ok) return { status: 'error', message: 'Captcha salah atau sesi absen belum dibuka guru.' };
      } else if (!data.wajahCocok) {
        return { status: 'error', message: 'Kode captcha wajib diisi.' };
      }

      const { error } = await supaClient.from('absensi').upsert({
        nis: String(data.nis || ''),
        nama: data.nama || '',
        tanggal: tanggalIso, // tanggal REAL hari ini (bukan turunan bulan/tahun yang bisa basi)
        status: 'H',
        keterangan: '',
        mapel: data.mapel || '',
        ekskul: data.mapel || '',
        // Bucket kelas: Ekskul WAJIB 'Semua Kelas' (filter rekap guru ekskul memakai .eq('kelas','Semua Kelas'))
        kelas: (String(data.jenis || '').toUpperCase() === 'EKSKUL') ? 'Semua Kelas' : (data.kelas || ''),
        tahun: data.tahun || '',
        semester: data.semester || '',
        bulan: data.bulan || '',
        metode: data.wajahCocok ? 'Absen Mandiri (Wajah+GPS)' : 'Absen Mandiri (GPS)',
        gps: data.gps || ''
        // CATATAN: wajah_cocok sengaja TIDAK dikirim di jalur fallback —
        // kolom ini baru ada setelah migrasi upgrade_20261014c, dan fallback
        // justru dipakai saat RPC/migrasi belum ada (DB lama).
      }, { onConflict: 'nis,tanggal,mapel' });
      if (error) throw error;
      return { status: 'success' };
    }

    throw new Error(`Action '${action}' tidak dikenali oleh Supabase Adapter`);

  } catch (error) {
    console.error(`Error on apiCall [${action}]:`, error);
    return { status: 'error', message: error.message || "Terjadi kesalahan koneksi" };
  }
}

// 2. UI login & listener form ditangani app.js (menghindari submit ganda).

/** Kelola akun (buat/hapus user Auth + profil) via Edge Function 'buat-akun'.
 *  Token pemanggil diverifikasi di server — hanya admin yang diizinkan. */
async function kelolaAkunAuth(payload = {}) {
  try {
    const { data: sesi } = await supaClient.auth.getSession();
    const token = sesi && sesi.session && sesi.session.access_token;
    if (!token) return { status: 'error', message: 'Sesi habis. Silakan login ulang.' };

    const res = await fetch(`${SUPABASE_URL}/functions/v1/buat-akun`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    console.error('kelolaAkunAuth:', e);
    return { status: 'error', message: e.message || 'Gagal menghubungi server.' };
  }
}

// ==========================================================
// [FASE B] JEMBATAN RPC TABEL `akun`
// ----------------------------------------------------------
// Sejak `upgrade_20261028c_rls_akun_ketat.sql`, tabel `akun` ber-RLS ketat
// dan TIDAK punya jalur baca/tulis langsung dari browser lagi. Semua akses
// data akun kini lewat RPC SECURITY DEFINER
// (supabase/sql/upgrade_20261028b_rpc_akun.sql) yang memverifikasi sesi:
//   - guru/admin  → JWT Supabase Auth (fn_role)
//   - murid lokal → token sesi `sesi_lokal` (p_token, dari cek_login_murid)
// Selama fase B1/B2 server masih menerima `p_klaim_nis` (kompatibilitas);
// setelah `fix_20261028d_sesi_wajib.sql`, HANYA token yang diakui.
//
// ⚠ KONTRAK ARGUMEN — jangan tertukar (ini pernah mematahkan tombol
//   "Simpan Perubahan" di menu Data Akun Murid lewat error PGRST202):
//   a) RPC Fase B (upgrade_20261028b) — menerima `p_token` + `p_klaim_nis`
//      → pakai sesiRpc():
//      ambil_daftar_murid, ambil_akun_satu, ambil_peta_wajah,
//      cek_sesi_absen, simpan_riwayat_murid, simpan_ekskul_murid.
//   b) RPC Fase B2 (upgrade_20261028b2) — HANYA `p_token`, identitas diambil
//      server dari sesi → kirim `{ p_token: getToken() }` saja, JANGAN
//      pakai sesiRpc():
//      ubah_profil_murid, ubah_password_sendiri, simpan_wajah_murid,
//      ubah_anggota_ekskul, ganti_kunci_absen_ekskul.
//   Argumen yang tidak dideklarasikan fungsi membuat PostgREST menjawab
//   "Could not find the function … in the schema cache" (PGRST202).
// ==========================================================

/** [FASE B] Parameter sesi untuk RPC murid yang mendeklarasikan `p_klaim_nis`
 *  (token server + klaim NIS) — lihat kontrak argumen di atas.
 *  RPC Fase B2 (mis. `ubah_profil_murid`, `ubah_password_sendiri`) TIDAK
 *  menerima `p_klaim_nis`: kirim `{ p_token: getToken() }` saja. */
function sesiRpc() {
  try {
    const u = getCurrentUser() || {};
    const user = u.user || {};
    const nis = String(user["NIS"] || user["NIP"] || user["ID Akun Guru"] || user["nis_nip"] || '');
    return { p_token: getToken(), p_klaim_nis: nis };
  } catch (e) {
    return { p_token: getToken(), p_klaim_nis: '' };
  }
}

/** Panggil RPC apa pun dengan penanganan error seragam. */
async function supaRpc(nama, params = {}) {
  if (!supaClient) return { data: null, error: new Error('Supabase belum siap. Periksa Konfigurasi Server.') };
  try {
    return await supaClient.rpc(nama, params);
  } catch (e) {
    return { data: null, error: e };
  }
}

/** Daftar guru/admin per mode: 'guru_ringkas' | 'guru_wali' | 'guru_kanal_absen'
 *  | 'guru_pembina' | 'guru_penugasan' | 'guru_penugasan_ringkas'
 *  | 'guru_dashboard' | 'penuh'. */
async function akunDaftarGuru(mode, opsi = {}) {
  const { data, error } = await supaRpc('ambil_daftar_guru', {
    p_mode: mode,
    p_tipe: opsi.tipe === undefined ? 'guru' : String(opsi.tipe),
    p_hanya_buka: !!opsi.hanyaBuka
  });
  if (error) { console.warn('akunDaftarGuru(' + mode + '):', error.message); return []; }
  return Array.isArray(data) ? data : [];
}

/** Daftar murid per mode: 'list' | 'export' | 'cetak' | 'dashboard_murid' |
 *  'anggota_ekskul' (p_ekskul) | 'pemilih' | 'pemilih_ringkas' | 'ekskul_map'
 *  | 'nis' (p_nis_list). */
async function akunDaftarMurid(mode, opsi = {}) {
  const { data, error } = await supaRpc('ambil_daftar_murid', Object.assign({
    p_mode: mode,
    p_ekskul: opsi.ekskul || '',
    p_nis_list: Array.isArray(opsi.nisList) ? opsi.nisList : []
  }, sesiRpc()));
  if (error) { console.warn('akunDaftarMurid(' + mode + '):', error.message); return []; }
  return Array.isArray(data) ? data : [];
}

/** Satu baris akun per mode: 'profil_akun' | 'foto' | 'penuh' | 'cetak' |
 *  'ringkas_murid' | 'ekskul_map' | 'jabatan_map' | 'wajah' | 'nis'.
 *  Mengembalikan objek baris, atau null bila tidak ada / akses ditolak. */
async function akunSatu(opsi = {}) {
  const mode = opsi.mode || 'profil_akun';
  const { data, error } = await supaRpc('ambil_akun_satu', Object.assign({
    p_nis_nip: opsi.nis == null ? '' : String(opsi.nis),
    p_email: opsi.email == null ? '' : String(opsi.email),
    p_id: opsi.id == null ? '' : String(opsi.id),
    p_mode: mode
  }, sesiRpc()));
  if (error) { console.warn('akunSatu(' + mode + '):', error.message); return null; }
  if (data && data.status === 'success' && data.akun) return data.akun;
  if (data && data.message) console.warn('akunSatu(' + mode + '):', data.message);
  return null;
}

/** Peta descriptor wajah murid (kolom wajah_descriptor/wajah_status). */
async function akunPetaWajah(opsi = {}) {
  const { data, error } = await supaRpc('ambil_peta_wajah', Object.assign({
    p_nis_list: Array.isArray(opsi.nisList) ? opsi.nisList : [],
    p_aktif_saja: !!opsi.aktifSaja
  }, sesiRpc()));
  if (error) { console.warn('akunPetaWajah:', error.message); return []; }
  return Array.isArray(data) ? data : [];
}

/** Cari akun dari NIS/NIP atau email: { id, tipe, nis_nip, user_id, email, … }. */
async function akunIdentitasLogin(identifier) {
  const { data, error } = await supaRpc('identitas_login', { p_identifier: String(identifier || '') });
  if (error) return { error };
  return data || { status: 'success', jumlah: 0, akun: [] };
}

/** Hitungan akun (murid/guru/admin) untuk dashboard staf. */
async function akunHitung() {
  const { data, error } = await supaRpc('hitung_akun');
  if (error) { console.warn('akunHitung:', error.message); return { murid: 0, guru: 0, admin: 0 }; }
  return data || { murid: 0, guru: 0, admin: 0 };
}

/** Validasi sesi absen mandiri (kunci BUKA + captcha) — diverifikasi server. */
async function akunCekSesiAbsen(mapel, captcha) {
  const { data, error } = await supaRpc('cek_sesi_absen', Object.assign({
    p_mapel: String(mapel || ''),
    p_captcha: String(captcha || '')
  }, sesiRpc()));
  if (error) return { status: 'error', message: error.message };
  return data || { status: 'error', message: 'Validasi sesi absen gagal.' };
}

/** [FASE B] Daftar sesi absen yang SEDANG DIBUKA guru/admin (`kunci_absen`
 *  'BUKA') untuk panel murid **Absen Mandiri**. Kolom yang dikirim:
 *  `nis_nip`, `nama_lengkap`, `mapel`, `ekstrakurikuler` (captcha & kunci_absen
 *  sengaja tidak dikirim — lihat `fix_20261029_murid_kanal_absen.sql`).
 *  Murid TIDAK memakai `akunDaftarGuru('guru_kanal_absen')`: RPC
 *  `ambil_daftar_guru` digerbang `fn_is_admin()/fn_is_guru()`, jadi selalu
 *  membalas `[]` untuk sesi murid.
 *
 *  Kembalian = ARRAY sesi seperti sebelumnya (`.length`/`.map` tetap aman),
 *  DITAMBAH dua properti diagnosis agar panel murid dapat menjelaskan SEBAB
 *  daftarnya kosong tanpa membocorkan apa pun dari server:
 *    .sebab  'ok' | 'kosong' | 'token-basi' | 'rpc-tidak-ada' | 'gagal'
 *    .pesan  pesan mentah server (untuk log/diagnosis)
 *  Properti ditempel pada array (bukan objek baru) supaya build lama yang
 *  masih memanggil fungsi ini tetap menerima array biasa → aman ketika
 *  sebagian host masih menyajikan berkas versi lama (kasus drift build). */
async function akunSesiAbsenMurid() {
  // Payload ditulis lewat `Object.assign` (bukan langsung `sesiRpc()`) supaya
  // argumennya terbaca statis oleh penjaga `npm run test:rpc-args` — bentuk
  // langsung hanya memicu WARN "tak terbaca penuh". Isinya `{ p_token,
  // p_klaim_nis }`, persis dua parameter RPC-nya.
  const { data, error } = await supaRpc('ambil_sesi_absen_murid', Object.assign({}, sesiRpc()));
  const hasil = (!error && Array.isArray(data)) ? data : [];
  hasil.pesan = error ? String((error && error.message) || error) : '';
  if (error) {
    console.warn('akunSesiAbsenMurid:', hasil.pesan);
    // PGRST202/PGRST404 = RPC belum ada di server (DB/host belum dimigrasi).
    hasil.sebab = /PGRST202|PGRST404|Could not find the function/i.test(hasil.pesan) ? 'rpc-tidak-ada' : 'gagal';
    return hasil;
  }
  if (hasil.length > 0) { hasil.sebab = 'ok'; return hasil; }
  // Kosong: bedakan "belum ada guru ber-BUKA" dari "bukti identitas murid
  // tidak sah". Token gaya lama (`lokal-…`) atau token kosong tidak lagi
  // dikenali server (`fn_akses_murid` sejak `fix_20261028d` hanya menerima
  // token `sesi_lokal`) → pesannya harus "masuk ulang", bukan "minta guru
  // membuka sesi absen".
  const sesi = getCurrentUser() || {};
  const tok = String(getToken() || '');
  const tokenBasi = !tok || tok.indexOf('lokal-') === 0;
  hasil.sebab = (String(sesi.role || '') === 'murid' && tokenBasi) ? 'token-basi' : 'kosong';
  return hasil;
}

/** Simpan riwayat kelas &/atau riwayat ekskul murid (hanya field yang dikirim). */
async function akunSimpanRiwayat(p = {}) {
  const { data, error } = await supaRpc('simpan_riwayat_murid', Object.assign({
    p_nis: String(p.nis || ''),
    p_riwayat_kelas: p.riwayatKelas,
    p_tingkat_kelas: p.tingkatKelas === undefined ? '' : String(p.tingkatKelas),
    p_riwayat_ekskul: p.riwayatEkskul
  }, sesiRpc()));
  if (error) return { status: 'error', message: error.message };
  return data || { status: 'error', message: 'Simpan riwayat murid gagal.' };
}

/** Simpan keanggotaan &/atau jabatan ekskul murid (p_ekskul wajib agar
 *  pengurus ekskul ikut terverifikasi; admin/guru diizinkan tanpa p_ekskul). */
async function akunSimpanEkskul(p = {}) {
  const { data, error } = await supaRpc('simpan_ekskul_murid', Object.assign({
    p_nis: String(p.nis || ''),
    p_ekstrakurikuler: p.ekstrakurikuler === undefined ? '' : String(p.ekstrakurikuler),
    p_riwayat_ekskul: p.riwayatEkskul,
    p_jabatan_ekskul_map: p.jabatanEkskulMap,
    p_ekskul: p.ekskul || ''
  }, sesiRpc()));
  if (error) return { status: 'error', message: error.message };
  return data || { status: 'error', message: 'Simpan keanggotaan ekskul gagal.' };
}

/** Salin penugasan guru massal: rows = [{ id | nis_nip, penugasan }]. */
async function akunSimpanPenugasanGuru(rows) {
  const { data, error } = await supaRpc('simpan_penugasan_guru', { p_rows: Array.isArray(rows) ? rows : [] });
  if (error) return { status: 'error', message: error.message };
  return data || { status: 'error', message: 'Simpan penugasan guru gagal.' };
}

/** Kunci/captcha absen guru (admin: target apa pun; guru: barisnya sendiri). */
async function akunSimpanKunciAbsen(p = {}) {
  const { data, error } = await supaRpc('simpan_kunci_absen', {
    p_nis_nip: String(p.nisNip || ''),
    p_captcha: String(p.captcha || ''),
    p_kunci: String(p.kunci || '')
  });
  if (error) return { status: 'error', message: error.message };
  return data || { status: 'error', message: 'Simpan kunci absen gagal.' };
}

/** Perpanjang sesi lokal murid (sliding 12 jam). Aman dipanggil tanpa token.
 *  `kode` (mis. PGRST202) dipakai pemanggil untuk membedakan "RPC belum ada". */
async function sesiPerpanjang() {
  const token = getToken();
  if (!token) return { status: 'no_token' };
  const { data, error } = await supaRpc('perpanjang_sesi', { p_token: token });
  if (error) return { status: 'error', kode: (error && error.code) || '', message: error.message };
  return data || { status: 'error', message: 'Perpanjang sesi gagal.' };
}

/** Cabut sesi lokal murid di server (logout). Aman dipanggil tanpa token. */
async function sesiLogout() {
  const token = getToken();
  if (!token) return { status: 'no_token' };
  const { data, error } = await supaRpc('logout_sesi', { p_token: token });
  if (error) return { status: 'error', kode: (error && error.code) || '', message: error.message };
  return data || { status: 'success' };
}

/** Ambil SEMUA baris dari query Supabase dengan paginasi — PostgREST maks 1000 baris/request.
 *  Contoh: await supaAmbilSemua(supaClient.from('akun').select('...').eq('tipe','murid')) */
async function supaAmbilSemua(builder, ukuran = 1000) {
  const semua = [];
  let dari = 0;
  for (let i = 0; i < 1000; i++) { // guard anti loop tak terhingga
    const { data, error } = await builder.range(dari, dari + ukuran - 1);
    if (error) throw error;
    const rows = data || [];
    semua.push(...rows);
    if (rows.length < ukuran) break;
    dari += ukuran;
  }
  return semua;
}

// 4. Pengganti fetch global khusus untuk mengambil data (GET)
// Karena di app.js Anda banyak menggunakan `fetch(API_URL + '?action=get_master_data')`
async function supabaseFetch(action, payload = {}) {
    try {
    if (action === 'get_master_data') {
        // Kolom tabel memakai nama persis gaya Sheets ("Tahun Pelajaran", "Tingkat/Kelas", dst.)
        const { data, error } = await supaClient.from('master_data').select('*');
        if (error) throw error;
        return { status: 'success', data: data || [] };
    }

    if (action === 'get_dashboard_data') {
         const arrBulanDb = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
         const idxBulanDb = arrBulanDb.indexOf(payload.bulan);
         const partsTahunDb = String(payload.tahun || '').split('/');
         const tahunAktualDb = (idxBulanDb >= 6) ? partsTahunDb[0] : (partsTahunDb[1] || partsTahunDb[0]);
         const lastDayDb = (idxBulanDb >= 0) ? new Date(parseInt(tahunAktualDb, 10) || 2000, idxBulanDb + 1, 0).getDate() : 31;
         const mmDb = String(idxBulanDb + 1).padStart(2, '0');
         const tglAwalDb = `${tahunAktualDb}-${mmDb}-01`;
         const tglAkhirDb = `${tahunAktualDb}-${mmDb}-${String(lastDayDb).padStart(2, '0')}`;
         const isEkskulDb = payload.kelas === 'Semua Kelas';

         // 1) Murid: ambil SEMUA murid (kolom ringkas + riwayat_kelas) → filter kelas efektif & status per TA payload di bawah.
         //    Kelas efektif TA = riwayat_kelas[tahun].kelas (fallback tingkat_kelas statis); siswa non-Aktif disembunyikan.
         //    Paginasi: PostgREST maks 1000 baris/request — supaAmbilSemua menggabungkan semua halaman.
         // Baca tabel `akun` kini lewat RPC (RLS ketat) — kolom hasil identik.
         let muridSemua = await akunDaftarMurid('dashboard_murid');
         const tahunDbRw = String(payload.tahun || '');
         const murid = muridSemua.filter(m => {
            const rw = (m.riwayat_kelas || {})[tahunDbRw] || null;
            const kelasEfektif = rw ? String(rw.kelas || '') : String(m.tingkat_kelas || '');
            const statusSiswa = rw ? String(rw.status || 'Aktif') : 'Aktif';
            if (statusSiswa !== 'Aktif' || !kelasEfektif) return false;
            // Kecocokan anggota ekskul dipakai SEMUA fitur Ekskul lain lewat
            // ambilAnggotaEkskul() (app.js) yaitu `ilike('%ekskul%')` —
            // SUBSTRING & case-insensitive. Dahulu di sini dipakai pencocokan token
            // tepat (split(',') + include persis) sehingga murid yang terdaftar
            // sebagai anggota (mis. kapital/substring/format berbeda) TIDAK muncul di
            // Daftar Hadir Ekstrakurikuler. Samakan semantiknya agar roster konsisten
            // dengan daftar anggota di menu Kelola/Tambah Anggota.
            if (isEkskulDb) {
              const rwPenuh = (m.riwayat_ekskul && typeof m.riwayat_ekskul === 'object') ? m.riwayat_ekskul : null;
              const adaRiwayat = rwPenuh && Object.keys(rwPenuh).length > 0;
              let eksCek;
              if (adaRiwayat) {
                const rwE = rwPenuh[tahunDbRw];
                if (!rwE || typeof rwE !== 'object') return false; 
                const stRw = String(rwE.status || 'Aktif').trim();
                if (stRw.toLowerCase() !== 'aktif') return false;
                eksCek = String(rwE.ekskul || '').split(',').map(e => e.trim()).filter(Boolean);
              } else {
                eksCek = String(m.ekstrakurikuler || '').split(',').map(e => e.trim()).filter(Boolean);
              }
              return eksCek.some(e => String(e || '').toLowerCase().includes(String(payload.mapel || '').toLowerCase()));
            }
            return kelasEfektif === payload.kelas;
         });

         // 2) Absensi dalam rentang tanggal bulan+tahun terpilih (kelas = kelas; ekskul = "Semua Kelas")
         // Trim kolom: mapping hanya memakai nis/tanggal/status/keterangan (hemat ±70% payload)
         // Kolom `gps` (migrasi upgrade_20261024_absensi_gps.sql): coba dengan gps dulu;
         // bila kolom belum ada di DB (migrasi belum dijalankan) → ulangi tanpa gps.
         const bangunQAbsen = (kolom) => {
           const q = supaClient
              .from('absensi')
              .select(kolom)
              .eq('mapel', payload.mapel)
              .gte('tanggal', tglAwalDb)
              .lte('tanggal', tglAkhirDb);
           return isEkskulDb ? q.eq('kelas', 'Semua Kelas') : q.eq('kelas', payload.kelas);
         };
         let { data: absen, error: errAbsen } = await bangunQAbsen('nis, tanggal, status, keterangan, gps');
         if (errAbsen) ({ data: absen, error: errAbsen } = await bangunQAbsen('nis, tanggal, status, keterangan'));

          // 3) Daftar guru (status kunci, wali kelas, pilihan guru penguji) — via RPC.
          const guru = await akunDaftarGuru('guru_dashboard', { tipe: '' });

         if (errAbsen) throw new Error("Gagal mengambil data dashboard");

          return {
              status: 'success',
              murid: murid.map(m => {
                  const rw = (m.riwayat_kelas || {})[tahunDbRw] || null;
                  const kelasEfektif = rw ? String(rw.kelas || '') : String(m.tingkat_kelas || '');
                  const statusSiswa = rw ? String(rw.status || 'Aktif') : 'Aktif';
                  return {
                    "NIS": m.nis_nip,
                    "NISN": m.nisn || "",
                    "Nama Lengkap": m.nama_lengkap,
                    "Tingkat/Kelas": kelasEfektif,
                    "StatusSiswa": statusSiswa,
                    "Jenis Kelamin": m.jenis_kelamin || "",
                    "Agama": m.agama || "",
                    "Catatan Khusus": m.catatan_khusus || "",
                    "Ekstrakurikuler": m.ekstrakurikuler || "",
                    "Jabatan Kelas": m.jabatan || "",
                    "Jabatan Ekstrakurikuler Map": (m.jabatan_ekskul_map && typeof m.jabatan_ekskul_map === 'object') ? m.jabatan_ekskul_map : {},
                    "No HP/WA": m.no_telepon || "",
                    "ID Tahun Pelajaran": m.tahun_pelajaran || "",
                    "Semester": m.semester || ""
                  };
              }),
             absen: absen.map(a => ({ "NIS": a.nis, "Tanggal": a.tanggal, "Status": a.status, "Keterangan": a.keterangan, "GPS": a.gps || "" })),
              status_guru: (guru || []).map(g => ({
                  "ID Akun Guru": g.nis_nip,
                  "Nama Guru": g.nama_lengkap,
                  "Nama Guru Bergelar": [g.gelar_depan, g.nama_lengkap, g.gelar_belakang].filter(Boolean).join(' ').replace(' ,', ', '),
                  "Mapel": g.mapel || "",
                  "Custom Teks Mata Pelajaran": g.mapel || "",
                  "Ekskul": g.ekstrakurikuler || "",
                  "Ekstrakurikuler": g.ekstrakurikuler || "",
                  "Wali Kelas": g.wali_kelas || "",
                  "Penugasan": g.penugasan || {},
                  "Tingkat/Kelas": g.tingkat_kelas || "",
                  "No HP": g.no_telepon || "",
                  "Captcha": g.captcha || "1234",
                  "Kunci Absen": g.kunci_absen || "TUTUP"
              }))
         };
    }

    } catch (error) {
        console.error("Supabase Fetch Error:", error);
        return { status: 'error', data: [] };
    }
}

// Utilities pendukung bawaan Anda
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Saring URL untuk dipakai sebagai src gambar.
 *  Hanya mengizinkan skema http:, https: dan data: (foto/logo hasil upload lokal).
 *  Mengembalikan '' untuk skema lain (mis. file://), path absolut sistem (/home/...),
 *  atau nilai kosong — sehingga <img src=""> tidak memicu error keamanan browser
 *  ("tidak boleh memuat atau tersambung ke file:///") dan fallback (inisial/placeholder)
 *  yang sudah ada otomatis tampil. */
function urlGambarAman(url) {
  const u = String(url ?? '').trim();
  if (!u) return '';
  // Blokir skema selain http/https/data (file:, ftp:, javascript:, vbscript:, dsb.) — case-insensitive.
  if (/^(file|ftp|javascript|vbscript|about|chrome|data-):/i.test(u)) return '';
  // Blokir URL absolut yang mirip path filesistem (mis. /home/... atau C:\...).
  if (/^[a-z]:[\\/]/i.test(u)) return '';
  if (/^[/\\]/.test(u)) return '';
  // Izinkan http, https dan data:image.
  if (/^(https?:|data:image\/)/i.test(u)) return u;
  return '';
}
function showToast(icon = 'success', title = '') {
  if (typeof Swal === 'undefined') { console.log(`[${icon}] ${title}`); return; }
  Swal.fire({
    toast: true, position: 'top-end', icon, title,
    showConfirmButton: false, timer: 2500,
    background: '#1e293b', color: '#fff'
  });
}
