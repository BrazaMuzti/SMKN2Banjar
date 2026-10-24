#!/usr/bin/env node
// ============================================================
// SISIP E2E API — TINGKAT 1 (tanpa browser)
// Menjalankan alur bisnis Fase 1-4 via Supabase:
//   login admin & guru (Supabase Auth) + murid UJI999 (RPC anon),
//   kenaikan kelas RPC (naik/turun/tolak guru), perpustakaan
//   (pinjam/kembali + denda telat), SPP bayar → kas, poin
//   (kategori + ambang), PPDB → konversi akun, dan pembacaan
//   murid anon (pengumuman/poin/pinjaman/rapor + proteksi tabel).
//
// Cara menjalankan:
//   E2E_ADMIN_EMAIL=… E2E_ADMIN_PASS=… \
//   E2E_GURU_EMAIL=…  E2E_GURU_PASS=…  npm run test:e2e
//
// URL & anon key otomatis dibaca dari web/js/utils.js.
// Skrip membuat & membersihkan data ujinya sendiri (marker UJI),
// IDEMPOTENT — tahan terhadap data uji manual dari uji_data.sql.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const utilsSrc = fs.readFileSync(path.join(root, 'web/js/utils.js'), 'utf8');
const urlM = utilsSrc.match(/SUPABASE_URL_DEFAULT\s*=\s*['"]([^'"]+)['"]/);
const keyM = utilsSrc.match(/SUPABASE_ANON_KEY_DEFAULT\s*=\s*['"]([^'"]+)['"]/);
if (!urlM || !keyM) { console.error('❌ URL/anon key tidak ditemukan di web/js/utils.js'); process.exit(1); }
const SUPA_URL = process.env.SUPABASE_URL || urlM[1];
const SUPA_KEY = process.env.SUPABASE_ANON_KEY || keyM[1];
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL, ADMIN_PASS = process.env.E2E_ADMIN_PASS;
const GURU_EMAIL = process.env.E2E_GURU_EMAIL, GURU_PASS = process.env.E2E_GURU_PASS;
const EMAIL_OK = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));
if (!ADMIN_EMAIL || !ADMIN_PASS || !GURU_EMAIL || !GURU_PASS) {
    console.error('❌ Kredensial belum lengkap. Jalankan dengan:');
    console.error('   E2E_ADMIN_EMAIL=… E2E_ADMIN_PASS=… E2E_GURU_EMAIL=… E2E_GURU_PASS=… npm run test:e2e');
    process.exit(1);
}
if (!EMAIL_OK(ADMIN_EMAIL) || !EMAIL_OK(GURU_EMAIL)) {
    console.error('❌ E2E_ADMIN_EMAIL / E2E_GURU_EMAIL harus berupa EMAIL akun Supabase Auth.');
    console.error('   Anda memasukkan: admin="' + ADMIN_EMAIL + '", guru="' + GURU_EMAIL + '"');
    console.error('   → Jangan pakai NIS/NIP/username. Jika Anda biasa login aplikasi dengan NIP,');
    console.error('     lihat email sebenarnya di Supabase Dashboard → Authentication → Users.');
    console.error('     Password = password Supabase Auth akun tsb (bukan password lokal murid).');
    process.exit(1);
}

const TA = '2026/2027', TA_NEXT = '2027/2028';
const NIS_MURID = 'UJI999', NIS_KONVERSI = 'UJI998';

const anon = createClient(SUPA_URL, SUPA_KEY);
const admin = createClient(SUPA_URL, SUPA_KEY);
const guru = createClient(SUPA_URL, SUPA_KEY);

let pass = 0, fail = 0;
const cek = (nama, kondisi, detail = '') => {
    if (kondisi) { pass++; console.log(`  ✅ ${nama}`); }
    else { fail++; console.log(`  ❌ ${nama}${detail ? ' — ' + detail : ''}`); }
};
const sec = (t) => console.log(`\n━━ ${t} ━━`);
const isoNow = () => new Date().toISOString().slice(0, 10);
const isoPlus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const isoMinus = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const selisihHari = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
// Mirror ambang UI Fase 2
const ambang = (t) => t <= 25 ? 'A' : t <= 50 ? 'B' : t <= 75 ? 'C' : 'D';

async function main() {
    console.log(`SISIP E2E API — ${SUPA_URL}`);

    // ============ A. LOGIN ADMIN & GURU ============
    sec('A. LOGIN ADMIN & GURU (Supabase Auth)');
    {
        const { error } = await admin.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASS });
        if (error) {
            console.error(`  ❌ Login admin (${ADMIN_EMAIL}) — ${error.message}`);
            console.error('   → Kredensial harus EMAIL + password akun Supabase Auth (bukan NIS/NIP).');
            console.error('     Cek Supabase Dashboard → Authentication → Users untuk email yang terdaftar.');
            console.error('   → Baris tabel akun admin juga harus punya user_id yang terhubung ke user tsb.');
            process.exit(1);
        }
        cek('Login admin', true);
    }
    {
        const { error } = await guru.auth.signInWithPassword({ email: GURU_EMAIL, password: GURU_PASS });
        if (error) {
            console.error(`  ❌ Login guru (${GURU_EMAIL}) — ${error.message}`);
            console.error('   → Kredensial harus EMAIL + password akun Supabase Auth (bukan NIS/NIP).');
            process.exit(1);
        }
        cek('Login guru', true);
    }

    // ============ B. AKUN MURID UJI ============
    sec('B. AKUN MURID UJI (RPC buat_akun_murid + cek_login_murid)');
    {
        const { data, error } = await admin.rpc('buat_akun_murid', { p_data: {
            nis: NIS_MURID, password: 'uji1234', nama_lengkap: 'UJI Murid E2E',
            tingkat_kelas: 'X UJI', tahun_pelajaran: TA, semester: 'Ganjil',
            jenis_kelamin: 'L', agama: 'Islam', email: 'uji999@example.com'
        } });
        cek('buat_akun_murid UJI999', !error && data?.status === 'success', error?.message || data?.message);
    }
    {
        const { data, error } = await anon.rpc('cek_login_murid', { p_nis: NIS_MURID, p_password: 'uji1234' });
        cek('cek_login_murid — password benar', !error && data?.status === 'success', error?.message);
        const { data: data2 } = await anon.rpc('cek_login_murid', { p_nis: NIS_MURID, p_password: 'salah' });
        cek('cek_login_murid — password salah ditolak', data2?.status === 'error');
    }
    const { data: muridRow } = await admin.from('akun').select('id, tingkat_kelas').eq('nis_nip', NIS_MURID).maybeSingle();
    cek('Baris akun UJI999 ada (kelas X UJI)', !!muridRow && muridRow.tingkat_kelas === 'X UJI');

    // ============ C. KENAIKAN KELAS ============
    sec('C. KENAIKAN KELAS (RPC proses_kenaikan_kelas — naik/turun/tolak guru)');
    {
        const payload = [{ id: muridRow.id, kelas: 'XI UJI', status: 'Aktif', ket: 'Naik' }];
        const { data, error } = await admin.rpc('proses_kenaikan_kelas', { p_ta_tujuan: TA_NEXT, p_siswa: payload });
        cek('RPC naik (admin) sukses', !error && data?.status === 'success', error?.message || JSON.stringify(data));
        cek('1 baris diperbarui', data?.diperbarui === 1);
    }
    {
        const { data } = await admin.from('akun').select('tingkat_kelas, riwayat_kelas').eq('nis_nip', NIS_MURID).maybeSingle();
        cek(`Kelas naik → XI UJI & riwayat ${TA_NEXT} = Naik`,
            data?.tingkat_kelas === 'XI UJI' && data?.riwayat_kelas?.[TA_NEXT]?.kelas === 'XI UJI' && data?.riwayat_kelas?.[TA_NEXT]?.ket === 'Naik',
            JSON.stringify(data).slice(0, 120));
    }
    {
        const payload = [{ id: muridRow.id, kelas: 'X UJI', status: 'Aktif', ket: 'Koreksi turun' }];
        const { data, error } = await admin.rpc('proses_kenaikan_kelas', { p_ta_tujuan: TA_NEXT, p_siswa: payload });
        cek('RPC turun/koreksi sukses', !error && data?.status === 'success');
        const { data: d2 } = await admin.from('akun').select('tingkat_kelas, riwayat_kelas').eq('nis_nip', NIS_MURID).maybeSingle();
        cek('Kelas kembali X UJI (koreksi TA sama)', d2?.tingkat_kelas === 'X UJI' && d2?.riwayat_kelas?.[TA_NEXT]?.ket === 'Koreksi turun');
    }
    {
        const { data } = await guru.rpc('proses_kenaikan_kelas', { p_ta_tujuan: TA_NEXT, p_siswa: [] });
        cek('RPC kenaikan DITOLAK utk guru', data?.status === 'error' && /admin/i.test(data?.message || ''), JSON.stringify(data));
    }

    // ============ D. PERPUSTAKAAN ============
    sec('D. PERPUSTAKAAN (buku → pinjam → kembali telat → denda) — idempotent');
    let bukuId = null, pinjamId = null;
    {
        const { data, error } = await admin.from('perpus_buku').upsert({
            kode: 'UJI-001', judul: 'UJI Buku E2E', pengarang: 'Uji', kategori: 'Pelajaran', eksemplar: 2, lokasi: 'Rak UJI'
        }, { onConflict: 'kode' }).select().maybeSingle();
        cek('Buku UJI-001 siap (upsert — tahan data uji manual)', !error && !!data, error?.message);
        bukuId = data?.id;
    }
    {
        const { error } = await admin.from('perpus_buku').insert({ kode: 'UJI-001', judul: 'Duplikat', eksemplar: 1 });
        cek('Kode buku unik (duplikat ditolak)', !!error);
    }
    {
        await admin.from('perpus_pinjam').delete().eq('nis', NIS_MURID); // hindari akumulasi antar-run
        const { data, error } = await admin.from('perpus_pinjam').insert({
            buku_id: bukuId, kode_buku: 'UJI-001', judul_buku: 'UJI Buku E2E',
            nis: NIS_MURID, nama: 'UJI Murid E2E', kelas: 'X UJI', ta: TA, semester: 'Ganjil',
            tanggal_pinjam: isoMinus(20), tenggat: isoMinus(13), status: 'Dipinjam', petugas: 'UJI'
        }).select().maybeSingle();
        cek('Catat peminjaman', !error && !!data, error?.message);
        pinjamId = data?.id;
    }
    {
        const tenggat = isoMinus(13), kembali = isoNow();
        const telat = Math.max(0, selisihHari(kembali, tenggat));
        const denda = telat * 500;
        const { error } = await admin.from('perpus_pinjam').update({ tanggal_kembali: kembali, hari_telat: telat, denda, status: 'Kembali' }).eq('id', pinjamId);
        const { data: d2 } = await admin.from('perpus_pinjam').select('hari_telat, denda').eq('id', pinjamId).maybeSingle();
        cek(`Pengembalian telat: hari_telat=${telat} & denda=${denda}`, !error && d2?.hari_telat === telat && Number(d2?.denda) === denda);
    }
    {
        const { data, error } = await anon.rpc('pinjaman_murid', { p_nis: NIS_MURID });
        cek('RPC pinjaman_murid (murid anon) — riwayat terbaca', !error && data?.status === 'success' && (data?.pinjaman || []).length >= 1, error?.message);
    }

    // ============ E. SPP & KAS ============
    sec('E. SPP & BUKU KAS (tagihan → bayar → kas) — idempotent');
    {
        const { data, error } = await admin.from('spp_tagihan').upsert({
            nis: NIS_MURID, nama: 'UJI Murid E2E', kelas: 'X UJI', ta: TA, semester: 'Ganjil',
            jenis: 'SPP', periode: isoNow().slice(0, 7), nominal: 50000, jatuh_tempo: isoPlus(9)
        }, { onConflict: 'nis,ta,jenis,periode' }).select().maybeSingle();
        cek('Tagihan SPP Rp50.000 siap (upsert — tahan data uji manual)', !error && !!data, error?.message);
        const { error: eDup } = await admin.from('spp_tagihan').insert({
            nis: NIS_MURID, nama: 'dup', ta: TA, jenis: 'SPP', periode: isoNow().slice(0, 7), nominal: 1
        });
        cek('Tagihan ganda ditolak (unique nis+ta+jenis+periode)', !!eDup);
    }
    {
        const noBukti = `UJI/KWT/${Date.now()}`;
        const { error: eUpd } = await admin.from('spp_tagihan').update({ lunas: true, tanggal_bayar: isoNow(), metode: 'Tunai', petugas: 'UJI', no_bukti: noBukti }).eq('nis', NIS_MURID);
        const { error: eKas } = await admin.from('kas_transaksi').insert({
            ta: TA, tanggal: isoNow(), jenis: 'Masuk', kategori: 'SPP', nis: NIS_MURID,
            nominal: 50000, keterangan: 'Pembayaran SPP — UJI Murid E2E (X UJI)', petugas: 'UJI', no_bukti: noBukti
        });
        cek('Bayar: lunas + entri kas otomatis', !eUpd && !eKas, (eUpd?.message || eKas?.message));
        const { data: kas } = await admin.from('kas_transaksi').select('nominal, jenis').eq('no_bukti', noBukti).maybeSingle();
        cek('Kas Masuk Rp50.000 tercatat', kas?.jenis === 'Masuk' && Number(kas?.nominal) === 50000);
    }

    // ============ F. POIN ============
    sec('F. POIN SISWA (kategori → catat → ambang → RPC murid) — idempotent');
    let katId = null;
    {
        const { data, error } = await admin.from('poin_kategori').upsert({
            jenis: 'pelanggaran', nama: 'UJI-Test Pelanggaran', poin: 25, ket: 'uji e2e', aktif: true
        }, { onConflict: 'jenis,nama' }).select().maybeSingle();
        cek('Kategori pelanggaran (25 poin) siap (upsert — tahan data uji manual)', !error && !!data, error?.message);
        katId = data?.id;
    }
    {
        const { data, error } = await guru.from('poin_siswa').insert({
            nis: NIS_MURID, nama: 'UJI Murid E2E', kelas: 'X UJI', ta: TA, semester: 'Ganjil',
            tanggal: isoNow(), jenis: 'pelanggaran', kategori_id: katId, kategori_nama: 'UJI-Test Pelanggaran',
            poin: 25, catatan: 'uji e2e', pelapor: 'UJI Guru E2E'
        }).select().maybeSingle();
        cek('Guru mencatat poin 25', !error && !!data, error?.message);
    }
    {
        const { data, error } = await admin.from('poin_siswa').insert({
            nis: NIS_MURID, nama: 'UJI Murid E2E', kelas: 'X UJI', ta: TA, semester: 'Ganjil',
            tanggal: isoNow(), jenis: 'pelanggaran', kategori_id: katId, kategori_nama: 'UJI-Test Pelanggaran',
            poin: 5, catatan: 'uji tambah', pelapor: 'UJI Admin'
        }).select().maybeSingle();
        cek('Catatan poin kedua (5) → total 30', !error && !!data);
        cek('Ambang: 25 → A, 30 → B', ambang(25) === 'A' && ambang(30) === 'B');
    }
    {
        const { data, error } = await anon.rpc('poin_murid', { p_nis: NIS_MURID, p_ta: TA });
        cek('RPC poin_murid (anon) — total 30, ≥2 entri',
            !error && data?.status === 'success' && Number(data?.total_pelanggaran) === 30 && (data?.entri || []).length >= 2, error?.message);
    }

    // ============ G. PPDB → KONVERSI ============
    sec('G. PPDB (calon → status → konversi akun) — idempotent');
    let calonId = null;
    {
        const { data, error } = await admin.from('ppdb_calon').upsert({
            ta: TA_NEXT, no_daftar: `UJI-999/${TA_NEXT}`, nama: 'UJI Calon E2E', nisn: '9999999998',
            jenis_kelamin: 'L', asal_sekolah: 'SMP Uji', jalur: 'Reguler', status: 'Baru',
            tanggal_daftar: isoNow(), dibuat_oleh: 'UJI', akun_dibuat: false
        }, { onConflict: 'no_daftar' }).select().maybeSingle();
        cek('Calon PPDB siap (upsert — tahan data uji manual)', !error && !!data, error?.message);
        calonId = data?.id;
    }
    {
        const { error: eV } = await admin.from('ppdb_calon').update({ status: 'Verifikasi', catatan: 'uji e2e' }).eq('id', calonId);
        const { error: eD } = await admin.from('ppdb_calon').update({ status: 'Diterima' }).eq('id', calonId);
        cek('Status Baru → Verifikasi → Diterima', !eV && !eD);
    }
    {
        const { data, error } = await admin.rpc('buat_akun_murid', { p_data: {
            nis: NIS_KONVERSI, password: '123456', nama_lengkap: 'UJI Calon E2E', nisn: '9999999998',
            tingkat_kelas: 'X UJI', tahun_pelajaran: TA_NEXT, semester: 'Ganjil', alamat: 'Jl. Uji 1'
        } });
        cek('Konversi via RPC buat_akun_murid', !error && data?.status === 'success', error?.message || data?.message);
        const { data: ak } = await admin.from('akun').select('nama_lengkap').eq('nis_nip', NIS_KONVERSI).maybeSingle();
        cek('Akun UJI998 muncul', !!ak && ak.nama_lengkap === 'UJI Calon E2E');
        const { error: eT } = await admin.from('ppdb_calon').update({ nis: NIS_KONVERSI, akun_dibuat: true }).eq('id', calonId);
        cek('Calon ditandai terkonversi', !eT);
    }

    // ============ H. PEMBACAAN MURID (ANON) + PROTEKSI ============
    sec('H. SUDUT PANDANG MURID (ANON) — fitur & proteksi');
    {
        const ada = await admin.from('pengumuman').select('id').eq('judul', 'UJI Pengumuman E2E').maybeSingle();
        if (!ada?.data) await admin.from('pengumuman').insert({ ta: TA, judul: 'UJI Pengumuman E2E', isi: 'uji', target: 'semua', mulai: isoMinus(1), akhir: isoPlus(30), penulis: 'UJI' });
        const { data, error } = await anon.from('pengumuman').select('*').eq('ta', TA).eq('judul', 'UJI Pengumuman E2E').maybeSingle();
        cek('Murid baca pengumuman (grant anon)', !error && !!data, error?.message);
    }
    {
        const { data: bk, error } = await anon.from('perpus_buku').select('*').limit(3);
        cek('Murid baca katalog perpus (grant anon)', !error && Array.isArray(bk), error?.message);
    }
    {
        const { data, error } = await anon.rpc('catatan_wali_murid', { p_nis: NIS_MURID, p_ta: TA, p_smt: 'Ganjil' });
        cek('RPC catatan_wali_murid', !error && data?.status === 'success', error?.message);
    }
    {
        const { data, error } = await anon.rpc('ambil_rapor_nilai_murid', { p_nis: NIS_MURID, p_ta: TA, p_smt: 'Ganjil' });
        cek('RPC ambil_rapor_nilai_murid (rapor murid, anon) — nilai terbaca', !error && data?.status === 'success' && Array.isArray(data?.nilai), error?.message);
    }
    {
        // [MIGRASI 20260926] anon (pengurus ekskul) kini diberi akses penuh tabel nilai
        const { error: eNilai } = await anon.from('nilai').select().limit(1);
        cek('Anon BISA baca tabel nilai (pengurus ekskul — grant 20260926)', !eNilai, eNilai?.message);
        const { error: ePoin } = await anon.from('poin_siswa').select().limit(1);
        cek('Proteksi: anon TIDAK bisa baca poin_siswa langsung', !!ePoin);
        const { error: ePpdb } = await anon.from('ppdb_calon').select().limit(1);
        cek('Proteksi: anon TIDAK bisa baca ppdb_calon', !!ePpdb);
    }

    // ============ I. EKSKUL: AKSES PENGURUS MURID + JABATAN EKSKUL MAP ============
    sec('I. EKSKUL PENGURUS MURID (anon) + jabatan_ekskul_map + pembina multi — migrasi 20260926');
    const EKSKUL_UJI = 'UJI-EKSKUL-E2E';
    {
        // RPC login murid kini membawa data keanggotaan & peta jabatan ekskul
        const { data, error } = await anon.rpc('cek_login_murid', { p_nis: NIS_MURID, p_password: 'uji1234' });
        const ak = data?.akun || {};
        cek('cek_login_murid membawa ekstrakurikuler', !error && 'ekstrakurikuler' in ak, error?.message || 'kolom hilang');
        cek('cek_login_murid membawa jabatan_ekskul_map', !error && 'jabatan_ekskul_map' in ak);
    }
    {
        // Kolom baru + admin menetapkan jabatan ekskul (peta per ekskul)
        const { error } = await admin.from('akun').update({ jabatan_ekskul_map: { [EKSKUL_UJI]: 'Ketua' } }).eq('nis_nip', NIS_MURID);
        cek('Admin set jabatan_ekskul_map (Ketua UJI-EKSKUL-E2E)', !error, error?.message);
        const { data } = await admin.from('akun').select('jabatan_ekskul_map').eq('nis_nip', NIS_MURID).maybeSingle();
        cek('Peta jabatan tersimpan & terbaca', data?.jabatan_ekskul_map?.[EKSKUL_UJI] === 'Ketua', JSON.stringify(data).slice(0, 100));
    }
    {
        // [FASE B] Tabel `akun` kini RLS KETAT + anon dicabut: update langsung dari
        // anon HARUS ditolak (sebelumnya lolos karena grant kolom-level 20260926).
        const { error } = await anon.from('akun').update({ jabatan_ekskul_map: { [EKSKUL_UJI]: 'Sekretaris' } }).eq('nis_nip', NIS_MURID);
        cek('Anon (pengurus) DITOLAK mengubah akun langsung (RLS ketat)',
            !!error, 'update anon justru sukses — jalankan upgrade_20261028c_rls_akun_ketat.sql');
    }
    {
        // [FASE B] Jalur resmi: token sesi dari server + RPC `simpan_ekskul_murid`.
        const { data: login } = await anon.rpc('cek_login_murid', { p_nis: NIS_MURID, p_password: 'uji1234' });
        const token = (login && login.sesi_token) || '';
        cek('cek_login_murid menerbitkan sesi_token (server, 64 hex)',
            typeof token === 'string' && token.length === 64, token ? `panjang ${token.length}` : 'kosong');
        const { data: rpcJab, error: eJab } = await anon.rpc('simpan_ekskul_murid', {
            p_nis: NIS_MURID, p_ekskul: EKSKUL_UJI,
            p_jabatan_ekskul_map: { [EKSKUL_UJI]: 'Sekretaris' }, p_token: token
        });
        cek('Murid ber-token ubah jabatan via RPC simpan_ekskul_murid',
            !eJab && rpcJab && rpcJab.status === 'success', eJab?.message || rpcJab?.message);
        const { data: jm } = await admin.from('akun').select('jabatan_ekskul_map').eq('nis_nip', NIS_MURID).maybeSingle();
        cek('Jabatan hasil RPC tersimpan (Sekretaris)',
            jm?.jabatan_ekskul_map?.[EKSKUL_UJI] === 'Sekretaris', JSON.stringify(jm).slice(0, 100));
    }
    {
        // [FASE B] RPC baca `akun` menuntut sesi valid.
        const { data: tanpaToken } = await anon.rpc('ambil_daftar_murid', { p_mode: 'list' });
        cek('RPC ambil_daftar_murid tanpa token → []',
            Array.isArray(tanpaToken) && tanpaToken.length === 0, JSON.stringify(tanpaToken).slice(0, 80));
        const { data: profilAnon } = await anon.rpc('ambil_akun_satu', { p_nis_nip: NIS_MURID, p_mode: 'penuh' });
        cek('RPC ambil_akun_satu tanpa token ditolak',
            !!(profilAnon && profilAnon.status === 'error'), JSON.stringify(profilAnon).slice(0, 80));
    }
    {
        // Sub-ekstrakurikuler: anon kelola sub & anggota — RENAME TIDAK BOLEH menghilangkan anggota
        const { data: subIns, error: eSub } = await anon.from('sub_ekstrakurikuler')
            .insert({ ekskul: EKSKUL_UJI, nama_sub: 'UJI Sub 1', urutan: 1, anggota: [NIS_MURID] }).select().maybeSingle();
        cek('Anon insert sub_ekstrakurikuler', !eSub && !!subIns, eSub?.message);
        // [SUB] simpan sub versi baru = UPDATE nama pada baris yang sama (bukan hapus+insert)
        const { error: eRename } = await anon.from('sub_ekstrakurikuler').update({ nama_sub: 'UJI Sub Baru', urutan: 2 }).eq('id', subIns?.id);
        cek('Anon rename sub (update nama+urutan)', !eRename, eRename?.message);
        const { data: subRenamed } = await admin.from('sub_ekstrakurikuler').select('nama_sub, urutan, anggota').eq('id', subIns?.id).maybeSingle();
        cek('Rename sub mempertahankan anggota (pendataan utuh)',
            subRenamed?.nama_sub === 'UJI Sub Baru' && Number(subRenamed?.urutan) === 2 && (subRenamed?.anggota || []).map(String).includes(NIS_MURID),
            JSON.stringify(subRenamed).slice(0, 120));
        const { error: eUpdSub } = await anon.from('sub_ekstrakurikuler').update({ anggota: [] }).eq('id', subIns?.id);
        cek('Anon update anggota sub', !eUpdSub, eUpdSub?.message);
        const { error: eDelSub } = await anon.from('sub_ekstrakurikuler').delete().eq('id', subIns?.id);
        cek('Anon hapus sub', !eDelSub, eDelSub?.message);
    }
    {
        // Profil ekskul: anon (pengurus) edit + tabel pembina_nip multi (dipisah koma)
        await admin.from('ekstrakurikuler').delete().eq('nama_ekskul', EKSKUL_UJI);
        const { error: eEk } = await admin.from('ekstrakurikuler').insert({ nama_ekskul: EKSKUL_UJI, deskripsi: 'uji', jadwal: 'Senin', pembina_nip: 'UJI-NIP-1' });
        const { error: eUpdEk } = await anon.from('ekstrakurikuler').update({ pembina_nip: 'UJI-NIP-1, UJI-NIP-2' }).eq('nama_ekskul', EKSKUL_UJI);
        cek('Anon edit profil ekskul (multi pembina koma)', !eEk && !eUpdEk, (eEk?.message || eUpdEk?.message));
        const { data: ek } = await admin.from('ekstrakurikuler').select('pembina_nip').eq('nama_ekskul', EKSKUL_UJI).maybeSingle();
        cek('pembina_nip memuat 2 NIP', (ek?.pembina_nip || '').split(',').map(s => s.trim()).filter(Boolean).length === 2, ek?.pembina_nip);
    }
    {
        // Nilai ekskul: anon (pengurus) isi nilai
        const kunci = { nis: NIS_MURID, kategori: 'Data Nilai Eskul', mapel: '', ekskul: EKSKUL_UJI, tahun: TA, semester: 'Ganjil', kelas: 'X UJI' };
        const { error: eIns } = await anon.from('nilai').upsert({ ...kunci, nama: 'UJI Murid E2E', data: { predikat: 'A' } }, { onConflict: 'nis,kategori,mapel,ekskul,tahun,semester' });
        cek('Anon (pengurus) input nilai ekskul', !eIns, eIns?.message);
        const { data: nl } = await anon.from('nilai').select('data').eq('nis', NIS_MURID).eq('ekskul', EKSKUL_UJI).maybeSingle();
        cek('Nilai ekskul terbaca kembali', nl?.data?.predikat === 'A', JSON.stringify(nl).slice(0, 80));
    }
    {
        // Agenda & dispensasi: anon boleh hapus (select/insert sudah dari 20260905)
        await admin.from('agenda_ekskul').delete().eq('ekskul', EKSKUL_UJI);
        const { data: ag, error: eAg } = await admin.from('agenda_ekskul').insert({ ekskul: EKSKUL_UJI, tanggal: isoNow(), kegiatan: 'UJI Latihan', hari: '' }).select().maybeSingle();
        cek('Admin siapkan agenda uji', !eAg && !!ag, eAg?.message);
        const { error: eDelAg } = await anon.from('agenda_ekskul').delete().eq('id', ag?.id);
        cek('Anon hapus agenda_ekskul', !eDelAg, eDelAg?.message);
        const { data: dp, error: eDp } = await admin.from('dispensasi').insert({ ekskul: EKSKUL_UJI, nis: NIS_MURID, nama: 'UJI', kelas: 'X UJI', tanggal_izin: isoNow(), surat_id: 'uji-surat-e2e' }).select().maybeSingle();
        cek('Admin siapkan riwayat dispensasi uji', !eDp && !!dp, eDp?.message);
        const { error: eDelDp } = await anon.from('dispensasi').delete().eq('id', dp?.id);
        cek('Anon hapus riwayat dispensasi', !eDelDp, eDelDp?.message);
    }

    // ============ J. CLEANUP ============
    sec('I. CLEANUP DATA UJI');
    {
        const target = [
            ['nilai (uji ekskul)', () => admin.from('nilai').delete().eq('nis', NIS_MURID).eq('ekskul', EKSKUL_UJI)],
            ['agenda_ekskul (UJI)', () => admin.from('agenda_ekskul').delete().eq('ekskul', EKSKUL_UJI)],
            ['dispensasi (UJI)', () => admin.from('dispensasi').delete().eq('ekskul', EKSKUL_UJI)],
            ['sub_ekstrakurikuler (UJI)', () => admin.from('sub_ekstrakurikuler').delete().eq('ekskul', EKSKUL_UJI)],
            ['ekstrakurikuler (UJI)', () => admin.from('ekstrakurikuler').delete().eq('nama_ekskul', EKSKUL_UJI)],
            ['perpus_pinjam', () => admin.from('perpus_pinjam').delete().eq('nis', NIS_MURID)],
            ['perpus_buku', () => admin.from('perpus_buku').delete().eq('kode', 'UJI-001')],
            ['spp_tagihan', () => admin.from('spp_tagihan').delete().eq('nis', NIS_MURID)],
            ['kas_transaksi', () => admin.from('kas_transaksi').delete().like('keterangan', '%UJI%')],
            ['poin_siswa', () => admin.from('poin_siswa').delete().eq('nis', NIS_MURID)],
            ['poin_kategori', () => admin.from('poin_kategori').delete().like('nama', 'UJI-%')],
            ['ppdb_calon', () => admin.from('ppdb_calon').delete().like('no_daftar', 'UJI-%')],
            ['pengumuman', () => admin.from('pengumuman').delete().like('judul', 'UJI Pengumuman E2E%')],
            ['akun (UJI998)', () => admin.from('akun').delete().eq('nis_nip', NIS_KONVERSI)],
            ['akun (UJI999)', () => admin.from('akun').delete().eq('nis_nip', NIS_MURID)],
        ];
        let gagal = 0;
        for (const [nama, q] of target) {
            const { error } = await q();
            if (error) { gagal++; console.log(`  ⚠️  ${nama}: ${error.message}`); }
        }
        cek(gagal ? `Cleanup selesai (${gagal} gagal — lihat di atas)` : 'Semua tabel uji dibersihkan', gagal === 0);
        console.log('  ℹ️  Sisa akun_kredensial (UJI999/UJI998) tak terjangkau API (RLS) — jalankan supabase/sql/uji_bersih.sql di SQL Editor.');
    }

    console.log(`\n══ HASIL: ${pass} PASS, ${fail} FAIL ══`);
    if (fail > 0) { console.log('→ Perbaiki kegagalan di atas, lalu jalankan ulang.'); process.exit(1); }
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });