#!/usr/bin/env node
// ============================================================
// SISIP BUILD GABUNGAN — perakit `supabase/sql/gabungan.sql`
// Menggabungkan SELURUH migrasi `supabase/sql/*.sql` (kecuali data
// uji `uji_*.sql`, diagnosa `diag_*.sql`, dan `gabungan.sql` itu
// sendiri) menjadi satu berkas siap-Run di Supabase SQL Editor.
//
// LATAR BELAKANG
//   `gabungan.sql` adalah berkas yang disalin pengguna saat memasang
//   project Supabase BARU. Berkas ini pernah tertinggal jauh dari
//   folder `supabase/sql` (35 dari 82 migrasi) sehingga project baru
//   kehilangan banyak kolom/RPC. Skrip ini menutup celah itu dan
//   MENOLAK jalan bila ada migrasi baru yang belum terdaftar.
//
// ATURAN URUTAN (penting!)
//   Urutan blok BUKAN hasil `sort` nama berkas — ini urutan eksekusi:
//     1) Blok 1..34 = urutan versi gabungan sebelumnya (dipertahankan
//        apa adanya agar diff tetap kecil & terbaca).
//     2) `upgrade_20260920_fix_kolom_jadwal_pelajaran.sql` dan
//        `upgrade_20260920b_lepas_notnull_legacy_jadwal_pelajaran.sql`
//        wajib BERADA SETELAH `upgrade_20260929_jadwal_pelajaran.sql`
//        karena keduanya menyentuh tabel yang baru dibuat blok itu
//        (fix_kolom punya `alter table jadwal_pelajaran` tanpa guard).
//     3) `upgrade_20261028b_rpc_akun.sql` wajib SEBELUM
//        `upgrade_20261028b2_token_rpc_murid.sql` (b2 = revisi b;
//        sort alfabet justru membalik keduanya).
//     4) Sisanya urut tanggal berkas; `upgrade_kartu_id_card.sql`
//        (tanpa tanggal) disisipkan di antara migrasi 2026-10-18.
//
// Cara menjalankan:
//   npm run build:sql            → tulis ulang supabase/sql/gabungan.sql
//   npm run check:sql            → periksa saja, tidak menulis (exit 1 bila ada masalah)
//   node scripts/build-gabungan.mjs --list
//   node scripts/build-gabungan.mjs --out /tmp/gabungan.sql
//
// Penjaga (semuanya fatal):
//   - ada `*.sql` di folder yang tidak terdaftar di URUTAN → migrasi hilang
//   - ada nama di URUTAN yang berkasnya tidak ada / terdaftar dua kali
//   - isi blok berkas lama BERUBAH dibanding versi gabungan sebelumnya
//   - jumlah `$$` (dollar-quote PL/pgSQL) ganjil → blok fungsi rusak
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const ambilOpsi = (nama, bawaan) => {
  const i = process.argv.indexOf(nama);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : bawaan;
};
const SQL_DIR = path.resolve(root, ambilOpsi('--sql-dir', 'supabase/sql'));
const OUT = path.resolve(root, ambilOpsi('--out', 'supabase/sql/gabungan.sql'));
const MODE_CHECK = process.argv.includes('--check');
const MODE_LIST = process.argv.includes('--list');

/** Berkas yang memang TIDAK ikut digabung. */
const TIDAK_IKUT = (nama) =>
  /^uji_/.test(nama) || /^diag_/.test(nama) || nama === 'gabungan.sql';

// ============================================================
// MANIFEST URUTAN — sumber kebenaran tunggal isi gabungan.sql.
// Menambah migrasi baru = tambahkan namanya di sini (skrip menolak
// jalan bila ada berkas baru yang belum terdaftar).
// ============================================================
const URUTAN = [
  // --- urutan versi gabungan sebelumnya (blok 1..34) ---
  'upgrade_20260903.sql',
  'fix_20260903_kredensial.sql',
  'fix_master_data_insert.sql',
  'upgrade_20260904_akun.sql',
  'upgrade_20260904_master_data_tambahan.sql',
  'upgrade_20260904_absensi.sql',
  'upgrade_20260904_absensi_d.sql',
  'upgrade_20260904_jurnal.sql',
  'upgrade_20260904_nilai.sql',
  'upgrade_20260904_ekskul.sql',
  'upgrade_20260905_ekskul_pengurus.sql',
  'upgrade_20260906_sikap_teman.sql',
  'upgrade_20260906_ekskul_surat.sql',
  'upgrade_20260906_ekskul_surat_v2.sql',
  'upgrade_20260908_kalender.sql',
  'upgrade_20260909_administrasi_guru.sql',
  'upgrade_20260910_penugasan_guru.sql',
  'upgrade_20260911_riwayat_siswa.sql',
  'upgrade_20260912_nisn_sync.sql',
  'upgrade_20260913_jabatan_ekskul.sql',
  'upgrade_20260914_akses_murid.sql',
  'upgrade_20260914_absensi_delete.sql',
  'upgrade_20260915_proses_kenaikan_rpc.sql',
  'upgrade_20260916_fase1.sql',
  'upgrade_20260917_fase2.sql',
  'upgrade_20260918_fase3.sql',
  'upgrade_20260919_fase4.sql',
  'upgrade_20260920_murid_rpc.sql',
  'upgrade_20260921_rls_policies.sql',
  'upgrade_20260922_nilai_murid_rpc.sql',
  'upgrade_20260926_ekskul_akses_guru.sql',
  'upgrade_20260927_sub_ekskul_anggota.sql',
  'upgrade_20260928_rpc_akun_murid.sql',
  'upgrade_20260929_jadwal_pelajaran.sql',
  // --- perbaikan tabel jadwal_pelajaran: WAJIB setelah blok di atas ---
  'upgrade_20260920_fix_kolom_jadwal_pelajaran.sql',
  'upgrade_20260920b_lepas_notnull_legacy_jadwal_pelajaran.sql',
  // --- 2026-09-30 s.d. 2026-10-28 (urut tanggal) ---
  'upgrade_20260930_pengurus_tambah_anggota.sql',
  'upgrade_20260930b_fix_akun_grant_anon.sql',
  'upgrade_20261001_kas_ekstrakurikuler.sql',
  'upgrade_20261002_kas_masterdata_v2.sql',
  'upgrade_20261003_kas_anggota_rentang.sql',
  'upgrade_20261005_kas_anggota_cicil.sql',
  'upgrade_20261006_import_murid_akses_guru.sql',
  'upgrade_20261006b_add_anggota_akses_admin_pembina.sql',
  'upgrade_20261006c_kunci_absen_ekskul_pengurus.sql',
  'upgrade_20261007_akun_hp_ortu.sql',
  'upgrade_20261007_jadwal_guru_custom.sql',
  'upgrade_20261007_kalender_tipe_custom.sql',
  'upgrade_20261008_ekskul_menu_lengkap.sql',
  'upgrade_20261010_jadwal_piket_ekskul.sql',
  'upgrade_20261011_akun_murid_foto_medsos.sql',
  'upgrade_20261013_akun_murid_keterangan_maps.sql',
  'upgrade_20261014_wajah.sql',
  'upgrade_20261014b_fix_nilai_grant.sql',
  'upgrade_20261014c_absen_mandiri_rpc.sql',
  'upgrade_20261014d_absen_mandiri_integrasi.sql',
  'upgrade_20261014e_wajah_multi.sql',
  'upgrade_20261015_edit_murid_akses_guru_wali.sql',
  'upgrade_20261016_wajah_akses_guru.sql',
  'upgrade_20261017_ubah_profil_guru.sql',
  'upgrade_20261018_fix_nilai_grant_lengkap.sql',
  // tanpa tanggal di nama berkas → dipin pada posisi aslinya (18 Okt, sebelum 20261018b)
  'upgrade_kartu_id_card.sql',
  'upgrade_20261018b_jurusan_lengkap.sql',
  'upgrade_20261018c_nip_kepala_sekolah.sql',
  'fix_20261019_ubah_anggota_ekskul_updated_at.sql',
  'upgrade_20261020_ekskul_riwayat_ta.sql',
  'upgrade_20261020b_piket_tabel_multi.sql',
  'upgrade_20261021_ekskul_riwayat_semester.sql',
  'upgrade_20261022_edupresensi.sql',
  'upgrade_20261023_absen_mandiri_metode.sql',
  'upgrade_20261023_wajah_motor_mediapipe.sql',
  'upgrade_20261024_absensi_gps.sql',
  'upgrade_20261025_absensi_gps_setting.sql',
  'fix_20261026_nilai_grant_authenticated.sql',
  'fix_20261026b_nilai_trigger_update.sql',
  'fix_20261026c_nilai_riwayat_trigger.sql',
  'upgrade_20261027_role_hybrid_opsiC.sql',
  'upgrade_20261028a_sesi_lokal_murid.sql',
  'upgrade_20261028b_rpc_akun.sql', // WAJIB sebelum b2 (b2 = revisi b)
  'upgrade_20261028b2_token_rpc_murid.sql',
  'upgrade_20261028c_rls_akun_ketat.sql',
  'fix_20261028d_sesi_wajib.sql'
];

// ============================================================
// HEADER gabungan.sql — dibuat otomatis (jumlah blok & rentang tanggal)
// ============================================================
function buatHeader(jml, awal, akhir) {
  return [
    '-- ============================================================================',
    '-- SIAKAD / SISIP — SKEMA DATABASE LENGKAP (VERSI SEKARANG)',
    '-- Gabungan seluruh upgrade skema: ' + awal + ' s.d. ' + akhir + ' (' + jml + ' berkas)',
    '--',
    '-- CARA PAKAI (project Supabase BARU):',
    '--   1) Buka Supabase Dashboard → SQL Editor → New query',
    '--   2) Salin SELURUH isi file ini (atau upload file-nya) → Run',
    '--   3) Verifikasi: Table Editor menampilkan semua tabel & kolom',
    '--',
    '-- Untuk project yang SUDAH berjalan dan hanya tertinggal beberapa upgrade,',
    '-- jangan jalankan gabungan ini — pakai file satu-persatu di folder yang sama',
    '-- (urut tanggal, jalankan hanya yang belum ada di database).',
    '--',
    '-- CATATAN:',
    '--   - Tanpa data uji (uji_*.sql) & tanpa skrip diagnosa (diag_*.sql).',
    '--   - Semua blok idempotent (IF NOT EXISTS / DROP IF EXISTS /',
    '--     CREATE OR REPLACE) — aman dijalankan berulang.',
    '--   - Urutan blok di bawah = urutan EKSEKUSI, bukan hasil sort nama berkas;',
    '--     jangan diacak. Dua blok jadwal_pelajaran (20260920_fix_kolom &',
    '--     20260920b_lepas_notnull) sengaja diletakkan SETELAH 20260929_jadwal_',
    '--     pelajaran.sql karena bergantung pada tabel yang dibuat blok itu.',
    '--   - Dua blok PALING AKHIR (20261028c RLS akun ketat & fix_20261028d sesi',
    '--     wajib) mengandaikan frontend versi terbaru. Jalankan berurutan:',
    '--     a → b → b2 → (deploy frontend) → c → d.',
    '--   - Dihasilkan ulang oleh: npm run build:sql',
    '--     (periksa tanpa menulis: npm run check:sql)',
    '-- ============================================================================',
    ''
  ].join('\n');
}

/** Ambil token tanggal 8 digit pertama yang muncul di nama berkas (mis. 20261028). */
function tanggalBerkas(nama) {
  const m = nama.match(/(20\d{6})/);
  return m ? m[1] : '';
}

/** Format token tanggal → "2026-10-28". */
function rapikanTanggal(t) {
  return t ? t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8) : '(tanpa tanggal)';
}

/** Baca satu berkas migrasi apa adanya (byte-for-byte, UTF-8). */
function bacaMigrasi(nama) {
  return fs.readFileSync(path.join(SQL_DIR, nama), 'utf8');
}

/** Pisahkan gabungan.sql yang ADA menjadi peta nama berkas → badan blok (mentah). */
function blokLama(isi) {
  const pola = /^-- \[\d+\/\d+\] (.+\.sql)$/gm;
  const hasil = new Map();
  const posisi = [];
  let m;
  while ((m = pola.exec(isi))) posisi.push({ nama: m[1], start: m.index });
  posisi.forEach((p, i) => {
    const akhir = i + 1 < posisi.length ? posisi[i + 1].start : isi.length;
    hasil.set(p.nama, isi.slice(p.start, akhir));
  });
  return hasil;
}

/** Baris "kebisingan" pemisah blok (garis `-- ===`, `-- [n/M] nama.sql`, kosong). */
const barisNoise = (b) => b.trim() === '' || /^-- =+$/.test(b) || /^-- \[\d+\/\d+\] /.test(b);

/** Normalisasi blok agar perbandingan "berkas asli vs isi gabungan" hanya
 *  membandingkan SQL-nya, bukan garis pemisah/penomoran blok. */
function normalisasi(teks) {
  const baris = teks.split('\n');
  while (baris.length && barisNoise(baris[0])) baris.shift();
  while (baris.length && barisNoise(baris[baris.length - 1])) baris.pop();
  return baris.join('\n');
}

const hitungBaris = (teks) => teks.split('\n').length;

// ============================================================
// 1. PENJAGA MANIFEST — gagal cepat sebelum menyentuh berkas apa pun
// ============================================================
const semuaSql = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
const diDisk = semuaSql.filter((f) => !TIDAK_IKUT(f));
const dikecualikan = semuaSql.filter((f) => TIDAK_IKUT(f));
const masalah = [];

const ganda = [...new Set(URUTAN.filter((n, i) => URUTAN.indexOf(n) !== i))];
if (ganda.length) masalah.push('Manifest URUTAN memuat nama GANDA: ' + ganda.join(', '));

const tidakAda = URUTAN.filter((n) => !semuaSql.includes(n));
if (tidakAda.length) masalah.push('Terdaftar di URUTAN tapi berkasnya TIDAK ADA (' + tidakAda.length + '): '
  + tidakAda.join(', '));

const belumTerdaftar = diDisk.filter((n) => !URUTAN.includes(n));
if (belumTerdaftar.length) masalah.push('Berkas migrasi BELUM TERDAFTAR di URUTAN (' + belumTerdaftar.length
  + '): ' + belumTerdaftar.join(', ') + '\n     → tambahkan namanya di const URUTAN (posisi = urutan eksekusi!)');

// ============================================================
// 2. SUSUN ISI GABUNGAN + penjaga kualitas blok
// ============================================================
const isiMigrasi = new Map();
for (const nama of URUTAN) isiMigrasi.set(nama, bacaMigrasi(nama));

// Dollar-quote ($$ … $$) harus genap, kalau tidak blok PL/pgSQL-nya rusak saat ditempel.
const dolarGanjil = URUTAN.filter((n) => (isiMigrasi.get(n).match(/\$\$/g) || []).length % 2 !== 0);
// Isi berkas tidak boleh memuat baris yang menyerupai marker gabungan (bikin blok salah terpotong).
const markerPalsu = URUTAN.filter((n) => /^-- \[\d+\/\d+\] .+\.sql$/m.test(isiMigrasi.get(n)));
if (dolarGanjil.length || markerPalsu.length) {
  console.log('\n' + '='.repeat(60));
  console.log('❌ GABUNGAN DIBATALKAN — blok sumber bermasalah:');
  if (dolarGanjil.length) console.log('   • $$ ganjil (' + dolarGanjil.length + '): ' + dolarGanjil.join(', '));
  if (markerPalsu.length) console.log('   • memuat baris mirip marker (' + markerPalsu.length + '): ' + markerPalsu.join(', '));
  process.exit(1);
}

const M = URUTAN.length;
const tanggalTerurut = URUTAN.map(tanggalBerkas).filter(Boolean).sort();
const bagian = [buatHeader(M, rapikanTanggal(tanggalTerurut[0]), rapikanTanggal(tanggalTerurut[tanggalTerurut.length - 1]))];
URUTAN.forEach((nama, i) => {
  const garis = '-- ' + '='.repeat(60) + '\n';
  const isi = isiMigrasi.get(nama);
  bagian.push(garis + '-- [' + (i + 1) + '/' + M + '] ' + nama + '\n' + garis
    + isi + (isi.endsWith('\n') ? '\n' : '\n\n'));
});
const isiBaru = bagian.join('');

// ============================================================
// 3. BANDINGKAN dengan gabungan.sql yang ada (deteksi drift & basi)
// ============================================================
const adaLama = fs.existsSync(OUT);
const isiLama = adaLama ? fs.readFileSync(OUT, 'utf8') : '';
const lama = adaLama ? blokLama(isiLama) : new Map();
const baru = blokLama(isiBaru);

// (a) blok lama vs berkas sumbernya: isi tidak boleh berubah diam-diam
const berubah = [];
for (const nama of lama.keys()) {
  if (!isiMigrasi.has(nama)) continue;
  if (normalisasi(lama.get(nama)) !== normalisasi(isiMigrasi.get(nama))) berubah.push(nama);
}
// (b) blok yang ada di versi lama tetapi tidak lagi diproduksi (mis. berkas dihapus)
const dibuang = [...lama.keys()].filter((n) => !baru.has(n));
// (c) blok yang baru masuk (berkas migrasi yang sebelumnya tertinggal)
const ditambah = [...baru.keys()].filter((n) => !lama.has(n));

// ============================================================
// 4. LAPORAN / TULIS
// ============================================================
if (MODE_LIST) {
  console.log('Manifest gabungan (' + M + ' blok):');
  URUTAN.forEach((n, i) => console.log('  ' + String(i + 1).padStart(3, ' ') + '. ' + n));
  process.exit(0);
}

const garis60 = '='.repeat(60);
console.log('\n[build-gabungan] SQL_DIR = ' + SQL_DIR);
console.log('  Blok gabungan    : ' + M + ' berkas | di folder: ' + semuaSql.length
  + ' | dikecualikan: ' + dikecualikan.length + ' (' + dikecualikan.join(', ') + ')');
console.log('  Rentang tanggal  : ' + rapikanTanggal(tanggalTerurut[0]) + ' s.d. '
  + rapikanTanggal(tanggalTerurut[tanggalTerurut.length - 1]));
console.log('  Penjaga          : $$ genap ✅ | marker palsu 0 ✅ | manifest ' + M + '/' + diDisk.length + ' terdaftar ✅');
console.log('  Blok vs sumber   : ' + (berubah.length ? '❌ BERUBAH (' + berubah.length + '): ' + berubah.join(', ')
  : '✅ ' + lama.size + ' blok lama identik dengan berkas aslinya'));
console.log('  Blok baru        : ' + ditambah.length + (ditambah.length ? ' → ' + ditambah.join(', ') : ''));
if (dibuang.length) console.log('  Blok dihapus     : ' + dibuang.length + ' → ' + dibuang.join(', '));

if (MODE_CHECK) {
  const basi = !adaLama || isiBaru !== isiLama;
  console.log('\n' + garis60);
  if (berubah.length || dibuang.length || basi) {
    console.log('❌ gabungan.sql TIDAK sinkron' + (basi ? ' (basi / perlu di-rakit ulang)' : '')
      + (berubah.length ? ' — blok lama yang isinya menyimpang dari berkas sumber: ' + berubah.length : '')
      + (dibuang.length ? ' — blok lama yang hilang dari manifest: ' + dibuang.length : ''));
    console.log('   Jalankan: npm run build:sql');
    process.exit(1);
  }
  console.log('✅ gabungan.sql sinkron dengan ' + M + ' berkas migrasi di ' + SQL_DIR);
  process.exit(0);
}

if (berubah.length) {
  console.log('\n⚠  PERHATIAN: blok lama berikut isinya menyimpang dari berkas sumbernya (ditulis ulang):');
  for (const n of berubah) console.log('   • ' + n);
}
fs.writeFileSync(OUT, isiBaru, 'utf8');
console.log('  Ditulis          : ' + path.relative(root, OUT) + ' ('
  + hitungBaris(isiLama) + ' → ' + hitungBaris(isiBaru) + ' baris)');
console.log(garis60);
console.log('✅ Gabungan ' + M + ' berkas migrasi siap dijalankan di Supabase SQL Editor.');
