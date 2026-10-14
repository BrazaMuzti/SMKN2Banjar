-- ============================================================
-- UPGRADE: AKSES IMPORT DATA MURID UNTUK GURU (WALI KELAS/PEMBINA) — 2026-10-06
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Menu "Data Akun Murid" → "Import" sebelumnya hanya boleh dipakai admin
--   (RPC import_akun_murid menolak selain tipe = 'admin'). Sekarang guru
--   yang berperan sebagai wali kelas ATAU pembina ekstrakurikuler (kolom
--   flat akun.wali_kelas / akun.ekstrakurikuler terisi) juga diizinkan
--   import data murid, selaras dengan akses menu "Data Akun Murid" yang
--   memang sudah terbuka untuk admin & guru.
--
-- Isi (idempotent — aman dijalankan berulang):
--   1) RPC import_akun_murid dibuat ulang dengan pemeriksaan akses baru:
--        - tipe = 'admin'                              -> boleh
--        - tipe = 'guru' DAN (wali_kelas terisi ATAU
--          ekstrakurikuler terisi)                      -> boleh
--        - selain itu                                   -> ditolak
--      Logika upsert baris data TIDAK berubah.
--   2) Grant execute + reload cache skema PostgREST
-- ============================================================

create or replace function import_akun_murid(p_rows jsonb, p_default_password text default '123456')
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  el jsonb;
  v_nis text;
  v_pass text;
  v_lahir date;
  v_tipe text;
  v_wali text;
  v_ekskul text;
  v_ok int := 0; v_upd int := 0; v_fail int := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  select tipe, coalesce(wali_kelas, ''), coalesce(ekstrakurikuler, '')
    into v_tipe, v_wali, v_ekskul
  from akun where user_id = auth.uid();

  if coalesce(v_tipe, '') = 'admin' then
    -- admin: akses penuh
    null;
  elsif coalesce(v_tipe, '') = 'guru' and (v_wali <> '' or v_ekskul <> '') then
    -- guru wali kelas atau pembina ekskul: boleh import
    null;
  else
    return json_build_object('status', 'error', 'message', 'Hanya admin atau guru (wali kelas/pembina ekskul) yang boleh import data murid.');
  end if;

  for el in select * from jsonb_array_elements(p_rows) loop
    v_nis := trim(coalesce(el->>'nis', ''));
    if v_nis = '' then
      v_fail := v_fail + 1;
      v_errors := v_errors || jsonb_build_array('Baris tanpa NIS dilewati.');
      continue;
    end if;
    v_pass := trim(coalesce(el->>'password', ''));
    if v_pass = '' then v_pass := coalesce(trim(p_default_password), '123456'); end if;
    if length(v_pass) < 6 then v_pass := '123456'; end if;

    begin
      v_lahir := nullif(trim(coalesce(el->>'tgl_lahir', '')), '')::date;
      if exists (select 1 from akun where nis_nip = v_nis and tipe = 'murid') then
        update akun set
          nama_lengkap     = coalesce(nullif(trim(el->>'nama_lengkap'), ''), nama_lengkap),
          nisn             = coalesce(nullif(trim(el->>'nisn'), ''), nisn),
          tahun_pelajaran  = coalesce(nullif(trim(el->>'tahun_pelajaran'), ''), tahun_pelajaran),
          semester         = coalesce(nullif(trim(el->>'semester'), ''), semester),
          jenis_kelamin    = coalesce(nullif(trim(el->>'jenis_kelamin'), ''), jenis_kelamin),
          tgl_lahir        = coalesce(v_lahir, tgl_lahir),
          agama            = coalesce(nullif(trim(el->>'agama'), ''), agama),
          golongan_darah   = coalesce(nullif(trim(el->>'golongan_darah'), ''), golongan_darah),
          tingkat_kelas    = coalesce(nullif(trim(el->>'tingkat_kelas'), ''), tingkat_kelas),
          jabatan          = coalesce(nullif(trim(el->>'jabatan'), ''), jabatan),
          email            = coalesce(nullif(trim(el->>'email'), ''), email),
          no_telepon       = coalesce(nullif(trim(el->>'no_telepon'), ''), no_telepon),
          ekstrakurikuler  = coalesce(nullif(trim(el->>'ekstrakurikuler'), ''), ekstrakurikuler),
          nama_ayah        = coalesce(nullif(trim(el->>'nama_ayah'), ''), nama_ayah),
          pekerjaan_ayah   = coalesce(nullif(trim(el->>'pekerjaan_ayah'), ''), pekerjaan_ayah),
          nama_ibu         = coalesce(nullif(trim(el->>'nama_ibu'), ''), nama_ibu),
          pekerjaan_ibu    = coalesce(nullif(trim(el->>'pekerjaan_ibu'), ''), pekerjaan_ibu),
          nama_wali        = coalesce(nullif(trim(el->>'nama_wali'), ''), nama_wali),
          alamat           = coalesce(nullif(trim(el->>'alamat'), ''), alamat),
          catatan_khusus   = coalesce(nullif(trim(el->>'catatan_khusus'), ''), catatan_khusus)
        where nis_nip = v_nis and tipe = 'murid';
        v_upd := v_upd + 1;
      else
        insert into akun (
          nama_lengkap, nis_nip, tipe, nisn, tahun_pelajaran, semester,
          jenis_kelamin, tgl_lahir, agama, golongan_darah,
          email, tingkat_kelas, jabatan, no_telepon, ekstrakurikuler,
          nama_ayah, pekerjaan_ayah, nama_ibu, pekerjaan_ibu, nama_wali,
          alamat, catatan_khusus
        ) values (
          coalesce(nullif(trim(el->>'nama_lengkap'), ''), 'Tanpa Nama'),
          v_nis, 'murid',
          nullif(trim(coalesce(el->>'nisn', '')), ''),
          nullif(trim(coalesce(el->>'tahun_pelajaran', '')), ''),
          nullif(trim(coalesce(el->>'semester', '')), ''),
          nullif(trim(coalesce(el->>'jenis_kelamin', '')), ''),
          v_lahir,
          nullif(trim(coalesce(el->>'agama', '')), ''),
          nullif(trim(coalesce(el->>'golongan_darah', '')), ''),
          nullif(trim(coalesce(el->>'email', '')), ''),
          nullif(trim(coalesce(el->>'tingkat_kelas', '')), ''),
          nullif(trim(coalesce(el->>'jabatan', '')), ''),
          nullif(trim(coalesce(el->>'no_telepon', '')), ''),
          nullif(trim(coalesce(el->>'ekstrakurikuler', '')), ''),
          nullif(trim(coalesce(el->>'nama_ayah', '')), ''),
          nullif(trim(coalesce(el->>'pekerjaan_ayah', '')), ''),
          nullif(trim(coalesce(el->>'nama_ibu', '')), ''),
          nullif(trim(coalesce(el->>'pekerjaan_ibu', '')), ''),
          nullif(trim(coalesce(el->>'nama_wali', '')), ''),
          nullif(trim(coalesce(el->>'alamat', '')), ''),
          nullif(trim(coalesce(el->>'catatan_khusus', '')), '')
        );
        v_ok := v_ok + 1;
      end if;
      insert into akun_kredensial (nis_nip, password_hash)
      values (v_nis, crypt(v_pass, gen_salt('bf', 10)))
      on conflict (nis_nip) do update set password_hash = excluded.password_hash, updated_at = now();
    exception when others then
      v_fail := v_fail + 1;
      v_errors := v_errors || jsonb_build_array('NIS ' || v_nis || ': ' || SQLERRM);
    end;
  end loop;

  return json_build_object(
    'status', 'success',
    'ditambahkan', v_ok,
    'diperbarui', v_upd,
    'gagal', v_fail,
    'detail_gagal', v_errors
  );
end $$;

-- ========== IZIN EKSEKUSI + RELOAD CACHE ==========
grant execute on function import_akun_murid(jsonb, text) to authenticated;

notify pgrst, 'reload schema';
