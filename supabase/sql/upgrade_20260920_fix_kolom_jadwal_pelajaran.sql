-- ============================================================
-- UPGRADE: PERBAIKAN NAMA KOLOM TABEL jadwal_pelajaran — 2026-09-20
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Simpan "Jadwal Pelajaran" (menu Jadwal & Libur → Tambah Jadwal) gagal
--   dengan error PGRST204: "Could not find the 'Mapel' column of
--   'jadwal_pelajaran' in the schema cache".
--
--   Penyebab: migrasi sebelumnya (upgrade_20260929_jadwal_pelajaran.sql)
--   membuat kolom Tahun, Semester, Waktu, Mapel TANPA tanda kutip ganda,
--   sehingga Postgres melipat nama kolom tsb menjadi huruf kecil semua
--   (tahun, semester, waktu, mapel). Aplikasi (web/js/app.js) mengirim
--   payload dengan key berhuruf kapital di awal ("Tahun", "Semester",
--   "Waktu", "Mapel") — PostgREST mencocokkan nama kolom secara case-
--   sensitive, sehingga kolom "Mapel" (dsb.) dianggap tidak ada.
--
-- Isi (idempotent — aman dijalankan berulang, tidak menghapus data):
--   1) Jika kolom lower-case lama (tahun/semester/waktu/mapel) ada dan
--      kolom ber-kapital ("Tahun"/dst.) belum ada → RENAME (data aman).
--   2) add column if not exists "Tahun"/"Semester"/"Waktu"/"Mapel" —
--      fallback untuk instalasi baru yang belum punya kolom sama sekali.
--   3) Reload cache skema PostgREST.
-- ============================================================

do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'jadwal_pelajaran' and column_name = 'tahun')
     and not exists (select 1 from information_schema.columns where table_name = 'jadwal_pelajaran' and column_name = 'Tahun') then
    alter table jadwal_pelajaran rename column tahun to "Tahun";
  end if;

  if exists (select 1 from information_schema.columns where table_name = 'jadwal_pelajaran' and column_name = 'semester')
     and not exists (select 1 from information_schema.columns where table_name = 'jadwal_pelajaran' and column_name = 'Semester') then
    alter table jadwal_pelajaran rename column semester to "Semester";
  end if;

  if exists (select 1 from information_schema.columns where table_name = 'jadwal_pelajaran' and column_name = 'waktu')
     and not exists (select 1 from information_schema.columns where table_name = 'jadwal_pelajaran' and column_name = 'Waktu') then
    alter table jadwal_pelajaran rename column waktu to "Waktu";
  end if;

  if exists (select 1 from information_schema.columns where table_name = 'jadwal_pelajaran' and column_name = 'mapel')
     and not exists (select 1 from information_schema.columns where table_name = 'jadwal_pelajaran' and column_name = 'Mapel') then
    alter table jadwal_pelajaran rename column mapel to "Mapel";
  end if;
end $$;

alter table jadwal_pelajaran
  add column if not exists "Tahun" text default '',
  add column if not exists "Semester" text default '',
  add column if not exists "Waktu" text default '',
  add column if not exists "Mapel" text default '';

notify pgrst, 'reload schema';
