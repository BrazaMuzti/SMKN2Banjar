-- ============================================================
-- UPGRADE: KALENDER PENDIDIKAN — NAMA KATEGORI CUSTOM — 2026-10-07
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi: kolom tipe_custom di kalender_pendidikan, dipakai saat tipe = 'custom'
--      untuk menyimpan nama kategori bebas yang diketik admin (menggantikan
--      label baku "Kegiatan (Custom)" di tabel data & legenda kalender).
-- Idempotent — aman dijalankan berulang.
-- ============================================================

alter table kalender_pendidikan
  add column if not exists tipe_custom text default '';

notify pgrst, 'reload schema';
