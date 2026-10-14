-- ============================================================
-- UPGRADE: PENGURUS EKSKUL GANTI KUNCI ABSEN (CAPTCHA) — 2026-10-06 (c)
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Panel "Kunci Absen Siswa (Captcha)" pada modal absensi hanya dirender
--   untuk sesi admin/guru (web/js/app.js showModalEditAbsen). Murid yang
--   menjabat sebagai pengurus ekskul tidak melihat panel sama sekali.
--   Selain itu, data kunci/captcha disimpan di BARIS PEMBINA
--   (updateKunciServer: .eq('nis_nip', nipGuru)); murid tidak punya
--   privilese UPDATE baris pembina (grant anon hanya kolom ekstrakurikuler
--   & jabatan_ekskul_map).
--
-- ISI:
--   RPC security definer ganti_kunci_absen_ekskul(p_pemanggil, p_ekskul,
--   p_captcha, p_kunci):
--     - Verifikasi pemanggil adalah MURID yang menjabat (jabatan_ekskul_map
--       memuat p_ekskul, tidak kosong).
--     - Update kolom captcha & kunci_absen pada SEMUA baris guru/admin yang
--       membina p_ekskul (kecocokan kolom ekstrakurikuler, atau mapel) —
--       sama dengan basis validasi absen_mandiri di utils.js, sehingga
--       "absen mandiri" dengan captcha baru langsung berlaku.
--     - Kunci dinormalisasi: selain 'BUKA' → 'TUTUP'; captcha di-upper-case
--       (validasi absen_mandiri case-insensitive).
--   Penulisan tetap satu-satunya untuk pengurus murid (tanpa grant UPDATE
--   lebar ke tabel akun).
--
-- Idempotent (create or replace) — aman dijalankan berulang.
-- ============================================================

create or replace function ganti_kunci_absen_ekskul(p_pemanggil text, p_ekskul text, p_captcha text, p_kunci text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_jabatan_map jsonb;
  v_total int;
begin
  -- 1) Pemanggil harus murid yang menjabat (pengurus) pada p_ekskul.
  select jabatan_ekskul_map into v_jabatan_map
  from akun
  where nis_nip = p_pemanggil and tipe = 'murid';

  if not found then
    return json_build_object('status', 'error', 'message', 'Hanya murid pengurus ekskul yang dapat mengganti kunci absen.');
  end if;

  if v_jabatan_map is null or coalesce(trim(coalesce(v_jabatan_map->>p_ekskul, '')), '') = '' then
    return json_build_object('status', 'error', 'message', 'Anda bukan pengurus (menjabat) pada ' || p_ekskul || '.');
  end if;

  -- 2) Perbarui kunci/captcha pada baris PEMBINA (guru/admin) ekskul ini.
  --    Kecocokan identik dengan validasi absen_mandiri: ekstrakurikuler
  --    berisi p_ekskul, atau mapel mengandung p_ekskul.
  update akun
  set captcha = upper(trim(coalesce(p_captcha, ''))),
      kunci_absen = case when p_kunci = 'BUKA' then 'BUKA' else 'TUTUP' end,
      updated_at = now()
  where tipe in ('guru', 'admin')
    and (
      lower(trim(p_ekskul)) = any (
        select lower(trim(x)) from unnest(string_to_array(ekstrakurikuler, ',')) as x where trim(x) <> ''
      )
      or mapel ilike '%' || p_ekskul || '%'
    );

  get diagnostics v_total = row_count;

  if v_total = 0 then
    return json_build_object('status', 'error', 'message', 'Pembina ' || p_ekskul || ' tidak ditemukan — kunci absen tidak diubah.');
  end if;

  return json_build_object('status', 'success', 'total', v_total, 'message', 'Kunci absen ' || p_ekskul || ' diperbarui.');
end $$;

-- ========== IZIN EKSEKUSI + RELOAD CACHE ==========
grant execute on function ganti_kunci_absen_ekskul(text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';