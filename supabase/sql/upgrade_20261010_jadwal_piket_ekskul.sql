-- ============================================================
-- UPGRADE 2026-10-10: JADWAL PIKET EKSTRAKURIKULER
-- Jalankan SELURUH file ini di Supabase Dashboard -> SQL Editor -> Run
--
-- LATAR BELAKANG:
--   Tab "Jurnal & Program Kerja" di Menu Ekstrakurikuler diberi sub-tab
--   baru "Jadwal Piket". Jadwal disusun oleh admin/guru/pengurus:
--   pilih hari aktif (custom hari), generate otomatis (anggota dibagi
--   merata, 1 kali piket per minggu), lalu susun ulang via drag & drop
--   pada tabel (kolom = hari, baris = slot Piket 1..n). Hasil jadwal
--   tampil read-only di Info Ekskul (di atas kartu Pengurus).
--
--   Akses ditegakkan di client (web/js/app.js -> hakAksesEkskulUntuk),
--   pola sama dengan modul ekskul lain: admin/guru/pengurus = tulis+edit,
--   anggota = baca. RLS di DB longgar (anon = sesi murid password lokal).
--
-- Isi file ini (idempotent — aman dijalankan berulang):
--   1) Tabel jadwal_piket_ekskul — 1 baris per ekskul:
--      - ekskul : nama ekskul (unique)
--      - hari   : jsonb array hari aktif, cth ["Senin","Rabu","Jumat"]
--      - piket  : jsonb objek hari -> array [{nis, nama}, ...]
--   2) Grant + RLS (anon & authenticated = penuh, sama pola modul ekskul lain)
-- ============================================================

-- ========== 1. TABEL JADWAL PIKET ==========
create table if not exists jadwal_piket_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null unique,
  hari jsonb not null default '["Senin","Selasa","Rabu","Kamis","Jumat","Sabtu"]'::jsonb,
  piket jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- hari : ["Senin", ...] (urut DAFTAR_HARI_PIKET di app.js)
-- piket: { "Senin": [{ "nis": "...", "nama": "..." }, ...], ... }

-- ========== 2. GRANT + RLS (anon = sesi murid password lokal, pola proyek ini) ==========
alter table jadwal_piket_ekskul enable row level security;

do $$
begin
  drop policy if exists jadwal_piket_ekskul_select_all on jadwal_piket_ekskul;
  create policy jadwal_piket_ekskul_select_all on jadwal_piket_ekskul for select using (true);
  drop policy if exists jadwal_piket_ekskul_insert_all on jadwal_piket_ekskul;
  create policy jadwal_piket_ekskul_insert_all on jadwal_piket_ekskul for insert with check (true);
  drop policy if exists jadwal_piket_ekskul_update_all on jadwal_piket_ekskul;
  create policy jadwal_piket_ekskul_update_all on jadwal_piket_ekskul for update using (true);
  drop policy if exists jadwal_piket_ekskul_delete_all on jadwal_piket_ekskul;
  create policy jadwal_piket_ekskul_delete_all on jadwal_piket_ekskul for delete using (true);
  execute 'grant select, insert, update, delete on jadwal_piket_ekskul to anon, authenticated';
end $$;

-- Reload cache skema PostgREST
notify pgrst, 'reload schema';