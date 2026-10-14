-- ============================================================
-- UPGRADE: AKSES ADMIN & PEMBINA TAMBAH ANGGOTA EKSKUL — 2026-10-06 (b)
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Modal "Tambah Anggota" / "Hapus Anggota" Ekstrakurikuler memakai
--   terapkanKeanggotaanEkskul() (web/js/app.js) yang melakukan SELECT +
--   UPDATE langsung ke tabel akun. Admin & guru/pembina masuk lewat
--   Supabase Auth (sesi `authenticated`) sedangkan kolom `ekstrakurikuler`
--   hanya di-grant untuk SELECT/UPDATE ke `anon` — sehingga sesi
--   `authenticated` justru gagal dengan:
--     "permission denied for table akun"
--
-- ISI:
--   RPC security definer ubah_anggota_ekskul(p_pemanggil, p_ekskul,
--   p_nis_list, p_tambah):
--     - Verifikasi pemanggil: ADMIN selalu boleh; GURU (pembina) bila
--       kolom akun.ekstrakurikuler memuat p_ekskul; MURID bila
--       jabatan_ekskul_map->>p_ekskul terisi (pengurus).
--     - Setiap NIS pada p_nis_list: gabung/buang nama ekskul pada kolom
--       ekstrakurikuler murid (anti-duplikat, sama persis dengan logika
--       gabungEkskulSiswa/buangEkskulSiswa di app.js).
--     - Dijalankan security definer, jadi sesi anon (murid lokal) maupun
--       authenticated (admin/pembina) mendapat hak yang sama.
--   Frontend memanggil RPC ini lebih dulu; bila RPC belum ada (PGRST202)
--   otomatis fallback ke jalur lama SELECT+UPDATE.
--
-- Idempotent (create or replace) — aman dijalankan berulang.
-- ============================================================

create or replace function ubah_anggota_ekskul(p_pemanggil text, p_ekskul text, p_nis_list text[], p_tambah boolean)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tipe text;
  v_ekstra_guru text;
  v_jabatan_map jsonb;
  v_nis text;
  v_ekstra_siswa text;
  v_baru text;
  v_total int := 0;
begin
  -- 1) Identitas pemanggil
  select tipe, ekstrakurikuler, jabatan_ekskul_map
  into v_tipe, v_ekstra_guru, v_jabatan_map
  from akun
  where nis_nip = p_pemanggil;

  if not found then
    return json_build_object('status', 'error', 'message', 'Akun pemanggil tidak ditemukan.');
  end if;

  -- 2) Verifikasi hak akses per tipe
  if v_tipe = 'admin' then
    -- admin selalu boleh
    null;
  elsif v_tipe = 'guru' then
    -- pembina: namanya tercantum di kolom ekstrakurikuler
    perform 1
    from unnest(string_to_array(v_ekstra_guru, ',')) as x
    where trim(x) <> '' and lower(trim(x)) = lower(trim(p_ekskul));
    if not found then
      return json_build_object('status', 'error', 'message', 'Anda bukan pembina ' || p_ekskul || '.');
    end if;
  elsif v_tipe = 'murid' then
    -- pengurus: punya jabatan (tidak kosong) pada ekskul ini
    if v_jabatan_map is null or coalesce(trim(coalesce(v_jabatan_map->>p_ekskul, '')), '') = '' then
      return json_build_object('status', 'error', 'message', 'Hanya pengurus (menjabat) ' || p_ekskul || ' yang dapat mengubah anggota.');
    end if;
  else
    return json_build_object('status', 'error', 'message', 'Tipe akun pemanggil tidak dikenal.');
  end if;

  -- 3) Terapkan per NIS (gabung/buang nama ekskul, anti-duplikat)
  if p_nis_list is null then
    p_nis_list := array[]::text[];
  end if;

  foreach v_nis in array p_nis_list loop
    if trim(coalesce(v_nis, '')) = '' then continue; end if;

    select ekstrakurikuler into v_ekstra_siswa
    from akun
    where nis_nip = v_nis and tipe = 'murid'
    for update;

    if not found then continue; end if;

    if p_tambah then
      if lower(trim(p_ekskul)) = any (
        select lower(trim(x)) from unnest(string_to_array(v_ekstra_siswa, ',')) as x where trim(x) <> ''
      ) then
        v_baru := v_ekstra_siswa; -- sudah jadi anggota → tidak ada perubahan
      else
        v_baru := case
          when coalesce(trim(v_ekstra_siswa), '') = '' then trim(p_ekskul)
          else trim(v_ekstra_siswa) || ',' || trim(p_ekskul)
        end;
      end if;
    else
      select string_agg(x, ',') into v_baru
      from (
        select trim(x) as x
        from unnest(string_to_array(v_ekstra_siswa, ',')) as t(x)
        where trim(x) <> '' and lower(trim(x)) <> lower(trim(p_ekskul))
      ) s;
      v_baru := coalesce(v_baru, '');
    end if;

    if coalesce(v_baru, '') = coalesce(v_ekstra_siswa, '') then continue; end if;

    update akun
    set ekstrakurikuler = v_baru, updated_at = now()
    where nis_nip = v_nis;

    v_total := v_total + 1;
  end loop;

  return json_build_object('status', 'success', 'total', v_total);
end $$;

-- ========== IZIN EKSEKUSI + RELOAD CACHE ==========
grant execute on function ubah_anggota_ekskul(text, text, text[], boolean) to anon, authenticated;

notify pgrst, 'reload schema';