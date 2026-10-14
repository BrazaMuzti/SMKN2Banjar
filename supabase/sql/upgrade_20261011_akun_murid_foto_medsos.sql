-- ============================================================
-- UPGRADE: FOTO MURID (GOOGLE DRIVE), MEDIA SOSIAL & ALAMAT MAPS — 2026-10-11
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Isi:
--   1) Kolom baru tabel akun:
--        url_foto     text   → URL foto siswa (Google Drive shared link / thumbnail)
--        alamat_maps  text   → Tautan Google Maps alamat tempat tinggal siswa
--        media_sosial jsonb  → [{ "label": "Instagram", "url": "https://..." }, ...]
--   2) RPC buat_akun_murid  dibuat ulang agar menyimpan ketiga kolom baru
--   3) RPC ubah_profil_murid dibuat ulang agar murid bisa mengisi sendiri
--      alamat_maps & media_sosial (whitelist — NIS/nama/kelas tetap terkunci).
--   4) RPC baru simpan_foto_murid: satu-satunya pintu penulisan akun.url_foto
--      (dipakai Edge Function 'unggah-foto-murid'; verifikasi: admin atau
--      murid pemilik NIS).
--
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. KOLOM BARU ==========
alter table akun
  add column if not exists url_foto text,
  add column if not exists alamat_maps text,
  add column if not exists media_sosial jsonb default '[]'::jsonb;

-- ========== 2. RPC: TAMBAH / EDIT AKUN MURID (url_foto, alamat_maps, media_sosial) ==========
create or replace function buat_akun_murid(p_data jsonb)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_nis text;
  v_pass text;
  v_lahir date;
  v_medsos jsonb;
begin
  if coalesce((select tipe from akun where user_id = auth.uid()), '') <> 'admin' then
    return json_build_object('status', 'error', 'message', 'Hanya admin yang boleh mengelola akun murid.');
  end if;

  v_nis := trim(coalesce(p_data->>'nis', ''));
  if v_nis = '' then
    return json_build_object('status', 'error', 'message', 'NIS wajib diisi.');
  end if;
  if coalesce(trim(coalesce(p_data->>'nama_lengkap', '')), '') = '' then
    return json_build_object('status', 'error', 'message', 'Nama lengkap wajib diisi.');
  end if;

  v_pass := trim(coalesce(p_data->>'password', ''));
  if v_pass <> '' and length(v_pass) < 6 then
    return json_build_object('status', 'error', 'message', 'Password minimal 6 karakter.');
  end if;

  v_lahir := nullif(trim(coalesce(p_data->>'tgl_lahir', '')), '')::date;

  -- Media sosial: hanya terima array json — nilai tak valid dianggap kosong.
  if jsonb_typeof(p_data->'media_sosial') = 'array' then
    v_medsos := p_data->'media_sosial';
  else
    v_medsos := '[]'::jsonb;
  end if;

  if exists (select 1 from akun where nis_nip = v_nis and tipe = 'murid') then
    -- EDIT: perbarui profil; kolom opsional kosong = dikosongkan; password hanya bila diisi
    update akun set
      nama_lengkap     = coalesce(nullif(trim(p_data->>'nama_lengkap'), ''), nama_lengkap),
      nisn             = nullif(trim(p_data->>'nisn'), ''),
      tahun_pelajaran  = nullif(trim(p_data->>'tahun_pelajaran'), ''),
      semester         = nullif(trim(p_data->>'semester'), ''),
      tingkat_kelas    = nullif(trim(p_data->>'tingkat_kelas'), ''),
      jenis_kelamin    = nullif(trim(p_data->>'jenis_kelamin'), ''),
      tgl_lahir        = v_lahir,
      agama            = nullif(trim(p_data->>'agama'), ''),
      golongan_darah   = nullif(trim(p_data->>'golongan_darah'), ''),
      jabatan          = nullif(trim(p_data->>'jabatan'), ''),
      jabatan_ekskul   = nullif(trim(p_data->>'jabatan_ekskul'), ''),
      email            = nullif(trim(p_data->>'email'), ''),
      no_telepon       = nullif(trim(p_data->>'no_telepon'), ''),
      no_telepon_ortu  = nullif(trim(p_data->>'no_telepon_ortu'), ''),
      ekstrakurikuler  = nullif(trim(p_data->>'ekstrakurikuler'), ''),
      nama_ayah        = nullif(trim(p_data->>'nama_ayah'), ''),
      pekerjaan_ayah   = nullif(trim(p_data->>'pekerjaan_ayah'), ''),
      nama_ibu         = nullif(trim(p_data->>'nama_ibu'), ''),
      pekerjaan_ibu    = nullif(trim(p_data->>'pekerjaan_ibu'), ''),
      nama_wali        = nullif(trim(p_data->>'nama_wali'), ''),
      alamat           = nullif(trim(p_data->>'alamat'), ''),
      catatan_khusus   = nullif(trim(p_data->>'catatan_khusus'), ''),
      url_foto         = case when p_data ? 'url_foto'
                              then nullif(trim(p_data->>'url_foto'), '')
                              else url_foto end,
      alamat_maps      = nullif(trim(p_data->>'alamat_maps'), ''),
      media_sosial     = v_medsos
    where nis_nip = v_nis and tipe = 'murid';

    if v_pass <> '' then
      insert into akun_kredensial (nis_nip, password_hash)
      values (v_nis, crypt(v_pass, gen_salt('bf', 10)))
      on conflict (nis_nip) do update set password_hash = excluded.password_hash, updated_at = now();
    end if;
    return json_build_object('status', 'success', 'message', 'Data murid diperbarui.', 'aksi', 'update');
  else
    -- TAMBAH: password wajib (kosong → default 123456)
    if v_pass = '' then v_pass := '123456'; end if;
    insert into akun (
      nama_lengkap, nis_nip, tipe, nisn, tahun_pelajaran, semester,
      jenis_kelamin, tgl_lahir, agama, golongan_darah,
      email, no_telepon, no_telepon_ortu, ekstrakurikuler, tingkat_kelas, jabatan, jabatan_ekskul,
      nama_ayah, pekerjaan_ayah, nama_ibu, pekerjaan_ibu, nama_wali,
      alamat, catatan_khusus, url_foto, alamat_maps, media_sosial
    ) values (
      trim(p_data->>'nama_lengkap'), v_nis, 'murid',
      nullif(trim(coalesce(p_data->>'nisn', '')), ''),
      nullif(trim(coalesce(p_data->>'tahun_pelajaran', '')), ''),
      nullif(trim(coalesce(p_data->>'semester', '')), ''),
      nullif(trim(coalesce(p_data->>'jenis_kelamin', '')), ''),
      v_lahir,
      nullif(trim(coalesce(p_data->>'agama', '')), ''),
      nullif(trim(coalesce(p_data->>'golongan_darah', '')), ''),
      nullif(trim(coalesce(p_data->>'email', '')), ''),
      nullif(trim(coalesce(p_data->>'no_telepon', '')), ''),
      nullif(trim(coalesce(p_data->>'no_telepon_ortu', '')), ''),
      nullif(trim(coalesce(p_data->>'ekstrakurikuler', '')), ''),
      nullif(trim(coalesce(p_data->>'tingkat_kelas', '')), ''),
      nullif(trim(coalesce(p_data->>'jabatan', '')), ''),
      nullif(trim(coalesce(p_data->>'jabatan_ekskul', '')), ''),
      nullif(trim(coalesce(p_data->>'nama_ayah', '')), ''),
      nullif(trim(coalesce(p_data->>'pekerjaan_ayah', '')), ''),
      nullif(trim(coalesce(p_data->>'nama_ibu', '')), ''),
      nullif(trim(coalesce(p_data->>'pekerjaan_ibu', '')), ''),
      nullif(trim(coalesce(p_data->>'nama_wali', '')), ''),
      nullif(trim(coalesce(p_data->>'alamat', '')), ''),
      nullif(trim(coalesce(p_data->>'catatan_khusus', '')), ''),
      nullif(trim(coalesce(p_data->>'url_foto', '')), ''),
      nullif(trim(coalesce(p_data->>'alamat_maps', '')), ''),
      v_medsos
    );
    insert into akun_kredensial (nis_nip, password_hash)
    values (v_nis, crypt(v_pass, gen_salt('bf', 10)))
    on conflict (nis_nip) do update set password_hash = excluded.password_hash, updated_at = now();
    return json_build_object('status', 'success', 'message', 'Murid baru tersimpan (password lokal aktif).', 'aksi', 'insert');
  end if;
end $$;

-- ========== 3. RPC: EDIT PROFIL SENDIRI (WHITELIST + MAPS & MEDSOS) ==========
-- Murid boleh mengubah kolom kontak, data pribadi, alamat_maps & media_sosial.
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

  v_lahir := nullif(trim(coalesce(p_data->>'tgl_lahir', '')), '')::date;
  if jsonb_typeof(p_data->'media_sosial') = 'array' then
    v_medsos := p_data->'media_sosial';
  else
    v_medsos := '[]'::jsonb;
  end if;

  update akun set
    email            = coalesce(p_data->>'email', email),
    no_telepon       = coalesce(p_data->>'no_telepon', no_telepon),
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
    golongan_darah   = coalesce(p_data->>'golongan_darah', golongan_darah)
  where nis_nip = p_nis and tipe = 'murid';

  return json_build_object('status', 'success', 'message', 'Profil berhasil diperbarui.');
end $$;

-- ========== 4. RPC: SIMPAN FOTO MURID (URL DRIVE) ==========
-- Satu-satunya penulis akun.url_foto — dipanggil oleh Edge Function
-- 'unggah-foto-murid' setelah file benar-benar ter-Upload ke Google Drive.
-- Otorisasi: pemanggil harus admin ATAU murid pemilik NIS.
create or replace function simpan_foto_murid(
  p_nis text,
  p_url text,
  p_pemanggil_nis text,
  p_pemanggil_tipe text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ada boolean;
begin
  p_nis := trim(coalesce(p_nis, ''));
  if p_nis = '' then
    return json_build_object('status', 'error', 'message', 'NIS wajib diisi.');
  end if;

  select exists (select 1 from akun where nis_nip = p_nis and tipe = 'murid') into v_ada;
  if not v_ada then
    return json_build_object('status', 'error', 'message', 'Data murid tidak ditemukan.');
  end if;

  if p_pemanggil_tipe <> 'admin'
     and not (p_pemanggil_tipe = 'murid' and p_pemanggil_nis = p_nis) then
    return json_build_object('status', 'error', 'message', 'Tidak berhak mengganti foto murid ini.');
  end if;

  -- p_url = '' berarti menghapus foto (diputuskan pemilik NIS atau admin)
  update akun set url_foto = nullif(trim(coalesce(p_url, '')), '')
  where nis_nip = p_nis and tipe = 'murid';

  return json_build_object('status', 'success', 'message', 'Foto murid tersimpan.');
end $$;

-- ========== 5. IZIN EKSEKUSI + RELOAD CACHE ==========
grant execute on function buat_akun_murid(jsonb) to anon, authenticated;
grant execute on function ubah_profil_murid(text, jsonb) to anon, authenticated;
grant execute on function simpan_foto_murid(text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';