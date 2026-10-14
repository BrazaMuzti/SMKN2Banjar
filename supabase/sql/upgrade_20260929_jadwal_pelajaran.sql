-- ============================================================
-- UPGRADE: TABEL JADWAL PELAJARAN (PERBAIKAN SIMPAN JADWAL) — 2026-09-29
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Simpan "Jadwal Pelajaran" (menu Jadwal & Libur) gagal dengan error
--   semacam "Could not find the ... column of 'jadwal_pelajaran' in the
--   schema cache" (PGRST204).
--   Penyebab: tabel jadwal_pelajaran TIDAK PERNAH dibuat oleh migrasi repo
--   (ada sebagai sisa setup lama) — kolom yang ditulis aplikasi
--   ("ID Jadwal Murid", "Semester", dst.) belum tentu lengkap.
--
-- Isi (semua idempotent — aman dijalankan berulang):
--   1) create table if not exists jadwal_pelajaran (kolom persis yang
--      ditulis aplikasi) + add column if not exists per kolom
--      (memperbaiki tabel lama yang kolomnya kurang)
--   2) Index filter (Tahun, Tingkat/Kelas) & (ID Akun Guru, Tahun)
--   3) RLS + privilege: authenticated penuh (kelola jadwal),
--      anon select (absen mandiri murid & filter tanggal mingguan)
--   4) Reload cache skema PostgREST
-- ============================================================

-- ========== 1. TABEL + SELF-HEALING KOLOM ==========
create table if not exists jadwal_pelajaran (
  id uuid primary key default gen_random_uuid(),
  "ID Akun Guru" text default '',
  "ID Jadwal Murid" text default '',
  "Tahun" text default '',
  "Semester" text default '',
  "Waktu" text default '',
  "Mapel" text default '',
  "Tingkat/Kelas" text default '',
  created_at timestamptz not null default now()
);

alter table jadwal_pelajaran
  add column if not exists "ID Akun Guru" text default '',
  add column if not exists "ID Jadwal Murid" text default '',
  add column if not exists "Tahun" text default '',
  add column if not exists "Semester" text default '',
  add column if not exists "Waktu" text default '',
  add column if not exists "Mapel" text default '',
  add column if not exists "Tingkat/Kelas" text default '',
  add column if not exists created_at timestamptz default now();

create index if not exists idx_jadwal_filter on jadwal_pelajaran (Tahun, "Tingkat/Kelas");
create index if not exists idx_jadwal_guru on jadwal_pelajaran ("ID Akun Guru", Tahun);

-- ========== 2. RLS & PRIVILEGE ==========
alter table jadwal_pelajaran enable row level security;

drop policy if exists "jadwal_baca_auth" on jadwal_pelajaran;
create policy "jadwal_baca_auth" on jadwal_pelajaran
  for select to authenticated using (true);
drop policy if exists "jadwal_tulis_auth" on jadwal_pelajaran;
create policy "jadwal_tulis_auth" on jadwal_pelajaran
  for insert to authenticated with check (true);
drop policy if exists "jadwal_ubah_auth" on jadwal_pelajaran;
create policy "jadwal_ubah_auth" on jadwal_pelajaran
  for update to authenticated using (true) with check (true);
drop policy if exists "jadwal_hapus_auth" on jadwal_pelajaran;
create policy "jadwal_hapus_auth" on jadwal_pelajaran
  for delete to authenticated using (true);

-- Anon (murid password lokal) membaca jadwal utk absen mandiri & filter "Minggu Ini"
drop policy if exists "jadwal_baca_anon" on jadwal_pelajaran;
create policy "jadwal_baca_anon" on jadwal_pelajaran
  for select to anon using (true);

revoke all on table jadwal_pelajaran from anon, authenticated;
grant select, insert, update, delete on jadwal_pelajaran to authenticated;
grant select on jadwal_pelajaran to anon;

-- ========== 3. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';
