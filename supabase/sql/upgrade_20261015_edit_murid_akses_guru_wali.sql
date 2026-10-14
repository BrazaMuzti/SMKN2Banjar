-- ============================================================
-- UPGRADE: IZINKAN GURU (WALI/PEMBINA) EDIT AKUN MURID — 2026-12-10
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Menu "Data Akun Murid" memperlihatkan tombol Edit (pensil) untuk
--   admin & guru (wali kelas / pembina ekskul) — lihat bisaEditAkunMurid()
--   di web/js/app.js. Namun RPC buat_akun_murid SQL selama ini hanya
--   mengizinkan admin, sehingga guru yang menekan Simpan selalu ditolak
--   ("Hanya admin yang boleh mengelola akun murid").
--
--   Edge Function 'unggah-foto-murid' juga hanya mengizinkan admin atau
--   murid pemilik NIS — guru (wali/pembina) ditolak saat mengganti foto.
--
-- ISI UPGRADE:
--   1) Helper akun_guru_ampu_murid(p_guru_nis, p_murid_nis):
--      benar jika guru adalah WALI KELAS murid tsb ATAU PEMBINA ekskul murid.
--   2) buat_akun_murid diubah:
--        - admin  : boleh tambah & edit (termasuk password), seperti dulu.
--        - guru   : EDIT saja, hanya murid yang diampu, TANPA ubah password.
--        - murid  : ditolak (murid edit profil via RPC sendiri).
--   3) simpan_foto_murid diubah: izinkan juga guru wali/pembina bersangkutan.
--
-- Idempotent (create or replace) — aman dijalankan berulang.
-- ============================================================

-- ========== 1. HELPER: GURU MENGAMPU MURID? ==========
create or replace function akun_guru_ampu_murid(p_guru_nis text, p_murid_nis text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if trim(coalesce(p_guru_nis, '')) = '' or trim(coalesce(p_murid_nis, '')) = '' then
    return false;
  end if;
  return exists (
    select 1
    from akun g
    join akun m on m.nis_nip = p_murid_nis and m.tipe = 'murid'
    where g.nis_nip = p_guru_nis and g.tipe = 'guru'
      and (
        (lower(trim(coalesce(g.wali_kelas, ''))) <> ''
         and lower(trim(g.wali_kelas)) = lower(trim(coalesce(m.tingkat_kelas, ''))))
        or exists (
          select 1
          from unnest(string_to_array(g.ekstrakurikuler, ',')) ge
          cross join unnest(string_to_array(m.ekstrakurikuler, ',')) me
          where trim(ge) <> '' and lower(trim(ge)) = lower(trim(me))
        )
      )
  );
end $$;

-- ========== 2. RPC: TAMBAH/EDIT AKUN MURID (dengan izin guru) ==========
create or replace function buat_akun_murid(p_data jsonb)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pemanggil_tipe text := '';
  v_pemanggil_nis  text := '';
  v_ada            boolean := false;
  v_nis text;
  v_pass text;
  v_lahir date;
begin
  -- Identifikasi pemanggil lewat sesi Auth (admin & guru punya auth.uid()).
  select coalesce(tipe, ''), coalesce(nis_nip, '')
    into v_pemanggil_tipe, v_pemanggil_nis
    from akun where user_id = auth.uid() limit 1;

  v_nis := trim(coalesce(p_data->>'nis', ''));
  if v_nis = '' then
    return json_build_object('status', 'error', 'message', 'NIS wajib diisi.');
  end if;
  if coalesce(trim(coalesce(p_data->>'nama_lengkap', '')), '') = '' then
    return json_build_object('status', 'error', 'message', 'Nama lengkap wajib diisi.');
  end if;

  v_pass := trim(coalesce(p_data->>'password', ''));
  v_lahir := nullif(trim(coalesce(p_data->>'tgl_lahir', '')), '')::date;

  select exists (select 1 from akun where nis_nip = v_nis and tipe = 'murid') into v_ada;

  -- ========== OTORISASI ==========
  if v_pemanggil_tipe = 'admin' then
    null; -- boleh tambah & edit
  elsif v_pemanggil_tipe = 'guru' then
    -- Guru: EDIT saja pada murid yang diampu, tanpa ubah password.
    if not v_ada then
      return json_build_object('status', 'error', 'message', 'Guru hanya dapat mengedit murid yang sudah terdaftar (bukan menambah murid baru).');
    end if;
    if v_pass <> '' then
      return json_build_object('status', 'error', 'message', 'Guru tidak berhak mengubah password murid. Minta admin untuk reset password.');
    end if;
    if not akun_guru_ampu_murid(v_pemanggil_nis, v_nis) then
      return json_build_object('status', 'error', 'message', 'Anda hanya dapat mengedit murid yang Anda ampu (wali kelas atau pembina ekskul).');
    end if;
  else
    return json_build_object('status', 'error', 'message', 'Hanya admin atau guru (wali/pembina) yang boleh mengelola akun murid.');
  end if;

-- ========== PROSES ==========
  if v_ada then
    -- EDIT: perbarui profil; password hanya bila diisi (khusus admin)
    update akun set
      nama_lengkap     = coalesce(nullif(trim(p_data->>'nama_lengkap'), ''), nama_lengkap),
      nisn             = coalesce(nullif(trim(p_data->>'nisn'), ''), nisn),
      tahun_pelajaran  = coalesce(nullif(trim(p_data->>'tahun_pelajaran'), ''), tahun_pelajaran),
      semester         = coalesce(nullif(trim(p_data->>'semester'), ''), semester),
      tingkat_kelas    = coalesce(nullif(trim(p_data->>'tingkat_kelas'), ''), tingkat_kelas),
      jenis_kelamin    = coalesce(nullif(trim(p_data->>'jenis_kelamin'), ''), jenis_kelamin),
      tgl_lahir        = coalesce(v_lahir, tgl_lahir),
      agama            = coalesce(nullif(trim(p_data->>'agama'), ''), agama),
      golongan_darah   = coalesce(nullif(trim(p_data->>'golongan_darah'), ''), golongan_darah),
      jabatan          = coalesce(nullif(trim(p_data->>'jabatan'), ''), jabatan),
      email            = coalesce(nullif(trim(p_data->>'email'), ''), email),
      no_telepon       = coalesce(nullif(trim(p_data->>'no_telepon'), ''), no_telepon),
      ekstrakurikuler  = coalesce(nullif(trim(p_data->>'ekstrakurikuler'), ''), ekstrakurikuler),
      nama_ayah        = coalesce(nullif(trim(p_data->>'nama_ayah'), ''), nama_ayah),
      pekerjaan_ayah   = coalesce(nullif(trim(p_data->>'pekerjaan_ayah'), ''), pekerjaan_ayah),
      nama_ibu         = coalesce(nullif(trim(p_data->>'nama_ibu'), ''), nama_ibu),
      pekerjaan_ibu    = coalesce(nullif(trim(p_data->>'pekerjaan_ibu'), ''), pekerjaan_ibu),
      nama_wali        = coalesce(nullif(trim(p_data->>'nama_wali'), ''), nama_wali),
      alamat           = coalesce(nullif(trim(p_data->>'alamat'), ''), alamat),
      catatan_khusus   = coalesce(nullif(trim(p_data->>'catatan_khusus'), ''), catatan_khusus)
    where nis_nip = v_nis and tipe = 'murid';

    if v_pass <> '' then
      insert into akun_kredensial (nis_nip, password_hash)
      values (v_nis, crypt(v_pass, gen_salt('bf', 10)))
      on conflict (nis_nip) do update set password_hash = excluded.password_hash, updated_at = now();
    end if;
    return json_build_object('status', 'success', 'message', 'Data murid diperbarui.', 'aksi', 'update');
  else
    -- TAMBAH: password wajib (kosong → default 123456) — hanya admin yang sampai sini
    if v_pass = '' then v_pass := '123456'; end if;
    insert into akun (
      nama_lengkap, nis_nip, tipe, nisn, tahun_pelajaran, semester,
      jenis_kelamin, tgl_lahir, agama, golongan_darah,
      email, no_telepon, ekstrakurikuler, tingkat_kelas, jabatan,
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
      nullif(trim(coalesce(p_data->>'ekstrakurikuler', '')), ''),
      nullif(trim(coalesce(p_data->>'tingkat_kelas', '')), ''),
      nullif(trim(coalesce(p_data->>'jabatan', '')), ''),
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

-- ========== 3. RPC: SIMPAN FOTO MURID (juga izinkan guru wali/pembina) ==========
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

  if p_pemanggil_tipe = 'admin'
     or (p_pemanggil_tipe = 'murid' and p_pemanggil_nis = p_nis)
     or (p_pemanggil_tipe = 'guru' and akun_guru_ampu_murid(p_pemanggil_nis, p_nis)) then
    null; -- diizinkan
  else
    return json_build_object('status', 'error', 'message', 'Tidak berhak mengganti foto murid ini.');
  end if;

  update akun set url_foto = nullif(trim(coalesce(p_url, '')), '')
  where nis_nip = p_nis and tipe = 'murid';

  return json_build_object('status', 'success', 'message', 'Foto murid tersimpan.');
end $$;

-- ========== 4. IZIN EKSEKUSI + RELOAD CACHE ==========
grant execute on function buat_akun_murid(jsonb) to anon, authenticated;
grant execute on function simpan_foto_murid(text, text, text, text) to anon, authenticated;
grant execute on function akun_guru_ampu_murid(text, text) to anon, authenticated;

notify pgrst, 'reload schema';