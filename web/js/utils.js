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
  supaClient = window.supabase.createClient(url, key);
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

// INI FUNGSI YANG ERROR KARENA HILANG:
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
    "NIP": tipe === 'guru' ? ((prof && prof.nis_nip) || "") : "",
    "ID Akun Guru": tipe === 'guru' ? ((prof && prof.nis_nip) || "") : "",
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
    "ID Tahun Pelajaran": ""
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
          return bangunResponsSesi(rpcRes.akun, rpcRes.akun.email || '', 'lokal-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()));
        }
        // 2) Fallback: cari email akun terkait NIS/NIP → Supabase Auth (guru/admin/Google)
        const { data: byNis, error: errNis } = await supaClient
          .from('akun')
          .select('email')
          .eq('nis_nip', identifier)
          .maybeSingle();
        if (errNis) return { status: 'error', message: 'Gagal mencari akun: ' + errNis.message };
        if (!byNis || !byNis.email) {
          const pesanRpc = (!rpcErr && rpcRes && rpcRes.message) ? rpcRes.message : 'NIS/NIP tidak terdaftar.';
          return { status: 'error', message: pesanRpc };
        }
        emailAuth = byNis.email;
      } else {
        // Login via email: coba akun murid lokal (lookup NIS dari email) lalu Supabase Auth
        const { data: listByEmail, error: errEmail } = await supaClient
          .from('akun')
          .select('nis_nip')
          .eq('email', identifier)
          .limit(1);
        const nisDariEmail = (!errEmail && listByEmail && listByEmail[0]) ? listByEmail[0].nis_nip : null;
        if (nisDariEmail) {
          const { data: rpcRes, error: rpcErr } = await supaClient.rpc('cek_login_murid', {
            p_nis: nisDariEmail,
            p_password: password
          });
          if (!rpcErr && rpcRes && rpcRes.status === 'success') {
            return bangunResponsSesi(rpcRes.akun, rpcRes.akun.email || identifier, 'lokal-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()));
          }
        }
      }

      const { data: authRes, error: authErr } = await supaClient.auth.signInWithPassword({ email: emailAuth, password });
      if (authErr || !authRes || !authRes.session) {
        return { status: 'error', message: 'Email/NIS atau Password salah. Jika akun Anda terdaftar via Google, gunakan tombol "Masuk dengan Google".' };
      }

      let { data: prof, error: profErr } = await supaClient
        .from('akun')
        .select('*')
        .eq('user_id', authRes.user.id)
        .maybeSingle();

      // Profil belum tertaut user_id → cocokkan lewat email lalu tautkan (best-effort).
      // Berguna untuk akun yang dibuat manual lewat Supabase Dashboard (mis. admin).
      if (!profErr && !prof && authRes.user.email) {
        const { data: byEmail } = await supaClient
          .from('akun')
          .select('*')
          .eq('email', authRes.user.email)
          .maybeSingle();
        if (byEmail) {
          prof = byEmail;
          supaClient.from('akun').update({ user_id: authRes.user.id }).eq('id', byEmail.id)
            .then(r => { if (r.error) console.warn('Taut user_id gagal:', r.error.message); })
            .catch(() => {});
        }
      }
      if (profErr) return { status: 'error', message: 'Gagal memuat profil: ' + profErr.message };
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

      let { data: prof } = await supaClient
        .from('akun')
        .select('*')
        .eq('user_id', sesi.user.id)
        .maybeSingle();

      if (!prof && sesi.user.email) {
        // Profil belum tertaut user_id → coba cocokkan lewat email, lalu tautkan (best-effort)
        const { data: byEmail } = await supaClient
          .from('akun')
          .select('*')
          .eq('email', sesi.user.email)
          .maybeSingle();
        if (byEmail) {
          prof = byEmail;
          supaClient.from('akun').update({ user_id: sesi.user.id }).eq('id', byEmail.id)
            .then(r => { if (r.error) console.warn('Taut user_id gagal:', r.error.message); })
            .catch(() => {});
        }
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
        metode: data.metode || 'Manual / QR'
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
      // Validasi captcha terhadap sesi yang dibuka guru pengampu (mapel/ekskul)
      const arrBulanAm = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
      const idxAm = arrBulanAm.indexOf(data.bulan);
      const partsAm = String(data.tahun || '').split('/');
      const tahunAm = (idxAm >= 6) ? partsAm[0] : (partsAm[1] || partsAm[0]);
      const tglAm = `${tahunAm}-${String(idxAm + 1).padStart(2, '0')}-${String(data.tanggal).padStart(2, '0')}`;

      const { data: guruRows, error: gErr } = await supaClient
        .from('akun')
        .select('captcha, kunci_absen')
        .in('tipe', ['guru', 'admin'])
        .or(`mapel.ilike.%${data.mapel}%,ekstrakurikuler.ilike.%${data.mapel}%`);
      if (gErr) throw gErr;
      const sesiOk = (guruRows || []).some(g => g.kunci_absen === 'BUKA' && String(g.captcha || '').toUpperCase() === String(data.captcha || '').toUpperCase());
      if (!sesiOk) return { status: 'error', message: 'Captcha salah atau sesi absen belum dibuka guru.' };

      const { error } = await supaClient.from('absensi').upsert({
        nis: String(data.nis || ''),
        nama: data.nama || '',
        tanggal: tglAm,
        status: 'H',
        keterangan: '',
        mapel: data.mapel || '',
        ekskul: data.mapel || '',
        kelas: data.kelas || '',
        tahun: data.tahun || '',
        semester: data.semester || '',
        bulan: data.bulan || '',
        metode: 'Absen Mandiri (GPS)',
        gps: data.gps || ''
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
         let muridSemua;
         try {
           muridSemua = await supaAmbilSemua(
             supaClient
              .from('akun')
              .select('nis_nip, nisn, nama_lengkap, tingkat_kelas, riwayat_kelas, jenis_kelamin, agama, catatan_khusus, ekstrakurikuler, jabatan, jabatan_ekskul_map, tahun_pelajaran, semester, no_telepon')
              .eq('tipe', 'murid')
           );
         } catch (eKolom) {
           // Kolom jabatan_ekskul_map belum ada (migrasi 20260926 belum dijalankan) → ulangi tanpa kolom itu
           muridSemua = await supaAmbilSemua(
             supaClient
              .from('akun')
              .select('nis_nip, nisn, nama_lengkap, tingkat_kelas, riwayat_kelas, jenis_kelamin, agama, catatan_khusus, ekstrakurikuler, jabatan, tahun_pelajaran, semester, no_telepon')
              .eq('tipe', 'murid')
           );
         }
         const tahunDbRw = String(payload.tahun || '');
         const murid = muridSemua.filter(m => {
            const rw = (m.riwayat_kelas || {})[tahunDbRw] || null;
            const kelasEfektif = rw ? String(rw.kelas || '') : String(m.tingkat_kelas || '');
            const statusSiswa = rw ? String(rw.status || 'Aktif') : 'Aktif';
            if (statusSiswa !== 'Aktif' || !kelasEfektif) return false;
            if (isEkskulDb) return String(m.ekstrakurikuler || '').split(',').map(e => e.trim()).includes(payload.mapel);
            return kelasEfektif === payload.kelas;
         });

         // 2) Absensi dalam rentang tanggal bulan+tahun terpilih (kelas = kelas; ekskul = "Semua Kelas")
         // Trim kolom: mapping hanya memakai nis/tanggal/status/keterangan (hemat ±70% payload)
         let qAbsen = supaClient
            .from('absensi')
            .select('nis, tanggal, status, keterangan')
            .eq('mapel', payload.mapel)
            .gte('tanggal', tglAwalDb)
            .lte('tanggal', tglAkhirDb);
         qAbsen = isEkskulDb ? qAbsen.eq('kelas', 'Semua Kelas') : qAbsen.eq('kelas', payload.kelas);
         const { data: absen, error: errAbsen } = await qAbsen;

          // 3) Daftar guru (status kunci, wali kelas, pilihan guru penguji)
          const { data: guru, error: errGuru } = await supaClient
             .from('akun')
             .select('nis_nip, nama_lengkap, mapel, ekstrakurikuler, wali_kelas, penugasan, tingkat_kelas, captcha, kunci_absen, no_telepon, gelar_depan, gelar_belakang')
             .in('tipe', ['guru', 'admin']);

         if (errAbsen || errGuru) throw new Error("Gagal mengambil data dashboard");

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
             absen: absen.map(a => ({ "NIS": a.nis, "Tanggal": a.tanggal, "Status": a.status, "Keterangan": a.keterangan })),
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
function showToast(icon = 'success', title = '') {
  if (typeof Swal === 'undefined') { console.log(`[${icon}] ${title}`); return; }
  Swal.fire({
    toast: true, position: 'top-end', icon, title,
    showConfirmButton: false, timer: 2500,
    background: '#1e293b', color: '#fff'
  });
}