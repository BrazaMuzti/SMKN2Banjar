-- ============================================================
-- UPGRADE: LEPAS NOT NULL KOLOM LEGACY TABEL jadwal_pelajaran — 2026-09-20
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Simpan "Jadwal Pelajaran" (menu Jadwal & Libur → Tambah Jadwal) gagal
--   dengan error: "null value in column "mata_pelajaran" of relation
--   "jadwal_pelajaran" violates not-null constraint".
--
--   Penyebab: tabel jadwal_pelajaran di database Anda adalah sisa setup
--   LAMA (dibuat manual di luar migrasi repo ini) yang punya kolom
--   snake_case sendiri (mis. mata_pelajaran, guru, kelas, hari, jam, dst.)
--   dengan constraint NOT NULL tanpa default. Migrasi repo hanya memakai
--   "add column if not exists" utk kolom yang DIPAKAI aplikasi ("Mapel",
--   "Tahun", dst.) — sehingga tidak pernah menyentuh/melonggarkan kolom
--   lama tsb. Karena aplikasi tidak pernah mengisi kolom lama itu, insert
--   ditolak Postgres.
--
--   Fix ini TIDAK menghapus kolom/data apa pun — hanya melepas constraint
--   NOT NULL pada kolom mana pun (selain "id") yang: (a) NOT NULL, (b)
--   tidak punya default, dan (c) BUKAN salah satu kolom yang dipakai
--   aplikasi. Dengan begitu kolom legacy apa pun (mata_pelajaran, guru,
--   kelas, hari, jam, dsb.) otomatis ikut diperbaiki tanpa perlu
--   menyebutkan nama-nama kolomnya satu per satu.
--
-- Aman dijalankan berulang (idempotent).
-- ============================================================

do $$
declare
  kolom record;
  kolom_dipakai_aplikasi text[] := array[
    'id', 'created_at',
    'ID Akun Guru', 'ID Jadwal Murid', 'Tahun', 'Semester', 'Waktu', 'Mapel', 'Tingkat/Kelas'
  ];
begin
  for kolom in
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'jadwal_pelajaran'
      and is_nullable = 'NO'
      and column_default is null
      and column_name <> all (kolom_dipakai_aplikasi)
  loop
    execute format('alter table jadwal_pelajaran alter column %I drop not null', kolom.column_name);
  end loop;
end $$;

notify pgrst, 'reload schema';
