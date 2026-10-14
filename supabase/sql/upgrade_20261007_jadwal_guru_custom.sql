-- ============================================================
-- UPGRADE: JADWAL PELAJARAN — GURU TANPA AKUN (CUSTOM) — 2026-10-07
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi: kolom "Guru Custom" di jadwal_pelajaran, dipakai saat slot jadwal
--      diajar oleh guru yang belum punya akun di tabel akun — admin bisa
--      mengetik nama guru secara manual (dipakai jg di legenda per Jurusan
--      pada tampilan "Lihat Jadwal → Per Kelas (Jurusan)").
-- Idempotent — aman dijalankan berulang.
-- ============================================================

alter table jadwal_pelajaran
  add column if not exists "Guru Custom" text default '';

notify pgrst, 'reload schema';
