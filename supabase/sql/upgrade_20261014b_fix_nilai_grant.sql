-- ============================================================
-- FIX: GRANT PRIVILEGE TABEL MODUL NILAI (42501 — MENU INPUT NILAI) — 2026-10-14 (b)
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Semua kategori di menu **Input Nilai** (Pengetahuan/Keterampilan/
--   Sikap/Ekstrakurikuler) gagal dimuat dengan pesan:
--     "Gagal memuat data. Periksa koneksi internet Anda."
--   Di DevTools → Network, permintaan pertama yang gagal adalah:
--     GET /rest/v1/nilai_konfigurasi?select=config&kategori=eq....&mapel=eq....
--     HTTP 401 { "code":"42501", "message":"permission denied for table nilai_konfigurasi" }
--
--   Penyebab: tabel-tabel modul nilai di database project ini TIDAK
--   memiliki GRANT privilege untuk role API (anon/authenticated) —
--   hanya punya RLS policy. PostgREST butuh PRIVILEGE TINGKAT TABEL;
--   RLS policy saja TIDAK cukup (permintaan ditolak sebelum RLS).
--   Grant yang sama sudah pernah ditulis di upgrade_20260904_nilai.sql
--   dan upgrade_20260906_sikap_teman.sql — tapi tidak (lengkap)
--   ter-apply di database project ini.
--
-- ISI (idempotent — aman dijalankan berulang; menyelaraskan database
-- live dengan isi GRANT di file migrasi asli):
--   1) nilai_konfigurasi  → select/insert/update/delete utk authenticated
--   2) nilai_teman_sejawat → select/insert/update/delete utk authenticated
--   3) jurnal_sikap        → select/insert/update/delete utk authenticated
--   4) Reload cache skema PostgREST
-- ============================================================

revoke all on table nilai_konfigurasi from anon, authenticated;
grant select, insert, update, delete on nilai_konfigurasi to authenticated;

revoke all on table nilai_teman_sejawat from anon, authenticated;
grant select, insert, update, delete on nilai_teman_sejawat to authenticated;

revoke all on table jurnal_sikap from anon, authenticated;
grant select, insert, update, delete on jurnal_sikap to authenticated;

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';