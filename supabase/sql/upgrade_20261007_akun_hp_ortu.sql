-- ============================================================
-- UPGRADE: NO HP ORANG TUA (AKUN MURID) — 2026-10-07
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Isi:
--   1) kolom no_telepon_ortu tabel akun (No HP Orang Tua, murid)
--   2) RPC buat_akun_murid dibuat ulang agar menyimpan no_telepon_ortu
--      (pola sama dengan kolom opsional lain: kosong = dikosongkan saat EDIT).
--
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. KOLOM NO HP ORANG TUA ==========
alter table akun
  add column if not exists no_telepon_ortu text;

-- ========== 2. RPC: TAMBAH / EDIT AKUN MURID (dengan no_telepon_ortu) ==========
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
      catatan_khusus   = nullif(trim(p_data->>'catatan_khusus'), '')
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
      alamat, catatan_khusus
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
      nullif(trim(coalesce(p_data->>'catatan_khusus', '')), '')
    );
    insert into akun_kredensial (nis_nip, password_hash)
    values (v_nis, crypt(v_pass, gen_salt('bf', 10)))
    on conflict (nis_nip) do update set password_hash = excluded.password_hash, updated_at = now();
    return json_build_object('status', 'success', 'message', 'Murid baru tersimpan (password lokal aktif).', 'aksi', 'insert');
  end if;
end $$;

-- ========== 3. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';
