-- ============================================================
-- UPGRADE: DATA AKUN MURID — NO HP ORTU & KETERANGAN + PRATINJAU GOOGLE MAPS — 2026-10-13
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Isi:
--   1) RPC ubah_profil_murid dibuat ulang:
--      a) whitelist bertambah: no_telepon_ortu (No HP/WA Orang Tua/Wali)
--         & catatan_khusus (Keterangan) — kedua kolom ini SUDAH ada di tabel akun,
--         jadi TIDAK ada kolom baru (tanpa migrasi struktur).
--      b) + verifikasi kepemilikan (kebijakan keamanan): hanya admin ATAU murid
--         pemilik NIS yang boleh mengubah profil murid. RPC lama hanya mengecek
--         NIS itu ada padahal di-grant ke anon/authenticated — celah ditutup.
--
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. RPC: EDIT PROFIL SENDIRI (WHITELIST + PEMILIK) ==========
-- Murid boleh mengubah kolom kontak, data pribadi, alamat_maps, media_sosial,
-- no_telepon_ortu & catatan_khusus.
-- NIS, NISN, nama, kelas, ekstrakurikuler, jabatan, url_foto TIDAK bisa diubah di sini.
create or replace function ubah_profil_murid(p_nis text, p_data jsonb)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_lahir date;
  v_medsos jsonb;
begin
  if not exists (select 1 from akun where nis_nip = p_nis and tipe = 'murid') then
    return json_build_object('status', 'error', 'message', 'Akun murid tidak ditemukan.');
  end if;

  -- Kebijakan kepemilikan: hanya admin, atau murid pemilik NIS ini.
  if coalesce((select tipe from akun where user_id = auth.uid()), '') <> 'admin'
     and not exists (
       select 1 from akun
       where user_id = auth.uid() and nis_nip = p_nis and tipe = 'murid'
     ) then
    return json_build_object('status', 'error', 'message', 'Tidak berhak mengubah profil murid ini.');
  end if;

  v_lahir := nullif(trim(coalesce(p_data->>'tgl_lahir', '')), '')::date;
  if jsonb_typeof(p_data->'media_sosial') = 'array' then
    v_medsos := p_data->'media_sosial';
  else
    v_medsos := '[]'::jsonb;
  end if;

  update akun set
    email            = coalesce(p_data->>'email', email),
    no_telepon       = coalesce(p_data->>'no_telepon', no_telepon),
    no_telepon_ortu  = coalesce(p_data->>'no_telepon_ortu', no_telepon_ortu),
    alamat           = coalesce(p_data->>'alamat', alamat),
    alamat_maps      = coalesce(p_data->>'alamat_maps', alamat_maps),
    media_sosial     = case when p_data ? 'media_sosial' then v_medsos else media_sosial end,
    nama_ayah        = coalesce(p_data->>'nama_ayah', nama_ayah),
    pekerjaan_ayah   = coalesce(p_data->>'pekerjaan_ayah', pekerjaan_ayah),
    nama_ibu         = coalesce(p_data->>'nama_ibu', nama_ibu),
    pekerjaan_ibu    = coalesce(p_data->>'pekerjaan_ibu', pekerjaan_ibu),
    nama_wali        = coalesce(p_data->>'nama_wali', nama_wali),
    tgl_lahir        = coalesce(v_lahir, tgl_lahir),
    jenis_kelamin    = coalesce(p_data->>'jenis_kelamin', jenis_kelamin),
    agama            = coalesce(p_data->>'agama', agama),
    golongan_darah   = coalesce(p_data->>'golongan_darah', golongan_darah),
    catatan_khusus   = coalesce(p_data->>'catatan_khusus', catatan_khusus)
  where nis_nip = p_nis and tipe = 'murid';

  return json_build_object('status', 'success', 'message', 'Profil berhasil diperbarui.');
end $$;

-- ========== 2. IZIN EKSEKUSI + RELOAD CACHE ==========
grant execute on function ubah_profil_murid(text, jsonb) to anon, authenticated;
notify pgrst, 'reload schema';