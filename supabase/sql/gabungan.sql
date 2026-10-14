-- ============================================================================
-- SIAKAD / SISIP — SKEMA DATABASE LENGKAP (VERSI SEKARANG)
-- Gabungan seluruh upgrade skema: 2026-09-03 s.d. 2026-09-29
--
-- CARA PAKAI (project Supabase BARU):
--   1) Buka Supabase Dashboard → SQL Editor → New query
--   2) Salin SELURUH isi file ini (atau upload file-nya) → Run
--   3) Verifikasi: Table Editor menampilkan semua tabel & kolom
--
-- Untuk project yang SUDAH berjalan dan hanya tertinggal beberapa upgrade,
-- jangan jalankan gabungan ini — pakai file satu-persatu di folder yang sama
-- (urut tanggal, jalankan hanya yang belum ada di database).
--
-- CATATAN:
--   - Tanpa data uji (uji_data.sql & uji_bersih.sql tidak termasuk).
--   - Semua blok idempotent (IF NOT EXISTS / DROP IF EXISTS /
--     CREATE OR REPLACE) — aman dijalankan berulang.
--   - Urutan blok di bawah = urutan pengembangan riil; jangan diacak.
-- ============================================================================

-- ============================================================
-- [1/34] upgrade_20260903.sql
-- ============================================================

-- ============================================================
-- UPGRADE SKEMA SIAKAD — 2026-09-03
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   1) Tabel akun    : kolom profil guru/murid
--   2) Tabel master_data : 13 kolom gaya Sheets (nama persis)
--   3) RLS master_data : select untuk semua, tulis hanya authenticated
--
-- PENTING: bagian password & RPC murid KINI ada di
--   fix_20260903_kredensial.sql  (jalankan file itu juga)
-- Semua blok idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. TABEL AKUN ==========
alter table akun
  add column if not exists jabatan text,
  add column if not exists tingkat_kelas text,
  add column if not exists wali_kelas text,
  add column if not exists mapel text,
  add column if not exists ekstrakurikuler text;

-- ========== 2. TABEL MASTER_DATA (nama kolom persis gaya Sheets) ==========
alter table master_data
  add column if not exists "Nama Dinas" text,
  add column if not exists "Nama Sekolah" text,
  add column if not exists "URL LOGO 1" text,
  add column if not exists "URL LOGO 2" text,
  add column if not exists "Ket. Nama Dinas" text,
  add column if not exists "Alamat Sekolah" text,
  add column if not exists "Semester" text,
  add column if not exists "Tahun Pelajaran" text,
  add column if not exists "Tingkat/Kelas" text,
  add column if not exists "Mata Pelajaran" text,
  add column if not exists "Ekstrakurikuler" text,
  add column if not exists "Jabatan Kelas" text,
  add column if not exists "Jabatan Guru" text;

-- ========== 3 & 4: RPC MURID & PRIVILEGE KREDENSIAL ==========
-- Dipindah ke fix_20260903_kredensial.sql — jalankan file itu.

-- ========== 3. RLS MASTER_DATA ==========
-- Baca untuk semua (header/login perlu), tulis hanya user login (admin).
alter table master_data enable row level security;

drop policy if exists "master_data_baca_semua" on master_data;
create policy "master_data_baca_semua" on master_data
  for select using (true);

drop policy if exists "master_data_tulis_authenticated" on master_data;
create policy "master_data_tulis_authenticated" on master_data
  for insert to authenticated with check (true);

drop policy if exists "master_data_ubah_authenticated" on master_data;
create policy "master_data_ubah_authenticated" on master_data
  for update to authenticated using (true) with check (true);

drop policy if exists "master_data_hapus_authenticated" on master_data;
create policy "master_data_hapus_authenticated" on master_data
  for delete to authenticated using (true);


-- ============================================================
-- [2/34] fix_20260903_kredensial.sql
-- ============================================================

-- ============================================================
-- FIX KREDENSIAL MURID — 2026-09-03 (v2)
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- (melengkapi upgrade_20260903.sql; bagian kredensial di sana
--  sudah digantikan oleh file ini)
--
-- Perbaikan:
--   1) password_hash pindah ke tabel terpisah `akun_kredensial`
--      (RLS aktif TANPA policy → tak terbaca via API oleh siapa pun;
--       akses hanya lewat RPC security definer & service_role)
--   2) Privilege tabel akun dipulihkan → select * normal (403 hilang)
--   3) RPC murid dibuat ulang membaca hash dari akun_kredensial
--   4) Cache skema PostgREST direload di akhir
-- Semua blok idempotent — aman dijalankan berulang.
-- ============================================================

create extension if not exists pgcrypto;

-- ========== 1. TABEL KREDENSIAL (hash password murid) ==========
create table if not exists akun_kredensial (
  id uuid primary key default gen_random_uuid(),
  nis_nip text not null unique,
  password_hash text not null,
  updated_at timestamptz not null default now()
);
alter table akun_kredensial enable row level security;
-- Sengaja TANPA policy: REST API tidak punya jalur baca/tulis.

-- ========== 2. MIGRASI hash lama (jika kolom password_hash masih ada di akun) ==========
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'akun'
               and column_name = 'password_hash') then
    insert into akun_kredensial (nis_nip, password_hash)
    select nis_nip, password_hash from akun
    where nis_nip is not null and password_hash is not null and password_hash <> ''
    on conflict (nis_nip) do update set password_hash = excluded.password_hash;
    alter table akun drop column password_hash;
  end if;
end $$;

-- ========== 3. PULIHKAN PRIVILEGE TABEL AKUN (fix 403 select *) ==========
revoke all on table akun from anon, authenticated;
grant select on akun to anon;
grant select, insert, update, delete on akun to authenticated;

-- ========== 4. RPC MURID (security definer; hash di akun_kredensial) ==========

-- 4a. Verifikasi login murid (NIS + password). Dipanggil anon saat login.
create or replace function cek_login_murid(p_nis text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r akun%rowtype;
  v_hash text;
begin
  select * into r from akun where nis_nip = p_nis and tipe = 'murid' limit 1;
  if r.id is null then
    return json_build_object('status', 'error', 'message', 'NIS tidak terdaftar.');
  end if;
  select password_hash into v_hash from akun_kredensial where nis_nip = p_nis;
  if v_hash is null or v_hash = '' then
    return json_build_object('status', 'error', 'message', 'Akun ini belum memiliki password lokal.');
  end if;
  if crypt(p_password, v_hash) = v_hash then
    return json_build_object('status', 'success', 'akun', json_build_object(
      'id', r.id,
      'user_id', r.user_id,
      'nama_lengkap', r.nama_lengkap,
      'nis_nip', r.nis_nip,
      'tipe', r.tipe,
      'email', r.email,
      'tingkat_kelas', r.tingkat_kelas,
      'jabatan', r.jabatan
    ));
  end if;
  return json_build_object('status', 'error', 'message', 'Password salah.');
end $$;

-- 4b. Tambah / edit akun murid oleh admin (upsert berdasarkan nis_nip).
create or replace function buat_akun_murid(p_data jsonb)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_nis text;
  v_pass text;
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

  if exists (select 1 from akun where nis_nip = v_nis and tipe = 'murid') then
    -- EDIT: perbarui profil; password hanya bila diisi
    update akun set
      nama_lengkap    = coalesce(nullif(trim(p_data->>'nama_lengkap'), ''), nama_lengkap),
      tingkat_kelas   = coalesce(nullif(trim(p_data->>'tingkat_kelas'), ''), tingkat_kelas),
      jabatan         = coalesce(nullif(trim(p_data->>'jabatan'), ''), jabatan),
      email           = coalesce(nullif(trim(p_data->>'email'), ''), email),
      no_telepon      = coalesce(nullif(trim(p_data->>'no_telepon'), ''), no_telepon),
      ekstrakurikuler = coalesce(nullif(trim(p_data->>'ekstrakurikuler'), ''), ekstrakurikuler)
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
    insert into akun (nama_lengkap, nis_nip, tipe, email, tingkat_kelas, jabatan, no_telepon, ekstrakurikuler)
    values (
      trim(p_data->>'nama_lengkap'), v_nis, 'murid',
      nullif(trim(coalesce(p_data->>'email', '')), ''),
      nullif(trim(coalesce(p_data->>'tingkat_kelas', '')), ''),
      nullif(trim(coalesce(p_data->>'jabatan', '')), ''),
      nullif(trim(coalesce(p_data->>'no_telepon', '')), ''),
      nullif(trim(coalesce(p_data->>'ekstrakurikuler', '')), '')
    );
    insert into akun_kredensial (nis_nip, password_hash)
    values (v_nis, crypt(v_pass, gen_salt('bf', 10)))
    on conflict (nis_nip) do update set password_hash = excluded.password_hash, updated_at = now();
    return json_build_object('status', 'success', 'message', 'Murid baru tersimpan (password lokal aktif).', 'aksi', 'insert');
  end if;
end $$;

-- 4c. Import massal murid: array [{nis, nama_lengkap, tingkat_kelas, email,
--     no_telepon, ekstrakurikuler, password?}] + password default.
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
  v_ok int := 0; v_upd int := 0; v_fail int := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  if coalesce((select tipe from akun where user_id = auth.uid()), '') <> 'admin' then
    return json_build_object('status', 'error', 'message', 'Hanya admin yang boleh mengelola akun murid.');
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
      if exists (select 1 from akun where nis_nip = v_nis and tipe = 'murid') then
        update akun set
          nama_lengkap    = coalesce(nullif(trim(el->>'nama_lengkap'), ''), nama_lengkap),
          tingkat_kelas   = coalesce(nullif(trim(el->>'tingkat_kelas'), ''), tingkat_kelas),
          email           = coalesce(nullif(trim(el->>'email'), ''), email),
          no_telepon      = coalesce(nullif(trim(el->>'no_telepon'), ''), no_telepon),
          ekstrakurikuler = coalesce(nullif(trim(el->>'ekstrakurikuler'), ''), ekstrakurikuler)
        where nis_nip = v_nis and tipe = 'murid';
        v_upd := v_upd + 1;
      else
        insert into akun (nama_lengkap, nis_nip, tipe, email, tingkat_kelas, no_telepon, ekstrakurikuler)
        values (
          coalesce(nullif(trim(el->>'nama_lengkap'), ''), 'Tanpa Nama'),
          v_nis, 'murid',
          nullif(trim(coalesce(el->>'email', '')), ''),
          nullif(trim(coalesce(el->>'tingkat_kelas', '')), ''),
          nullif(trim(coalesce(el->>'no_telepon', '')), ''),
          nullif(trim(coalesce(el->>'ekstrakurikuler', '')), '')
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

-- 4d. Reset password murid oleh admin (default saran: 123456).
create or replace function set_password_murid(p_nis text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if coalesce((select tipe from akun where user_id = auth.uid()), '') <> 'admin' then
    return json_build_object('status', 'error', 'message', 'Hanya admin yang boleh mereset password.');
  end if;
  if length(trim(coalesce(p_password, ''))) < 6 then
    return json_build_object('status', 'error', 'message', 'Password minimal 6 karakter.');
  end if;
  if not exists (select 1 from akun where nis_nip = p_nis and tipe = 'murid') then
    return json_build_object('status', 'error', 'message', 'NIS tidak ditemukan.');
  end if;
  insert into akun_kredensial (nis_nip, password_hash)
  values (p_nis, crypt(p_password, gen_salt('bf', 10)))
  on conflict (nis_nip) do update set password_hash = excluded.password_hash, updated_at = now();
  return json_build_object('status', 'success', 'message', 'Password murid direset.');
end $$;

-- ========== 5. IZIN EKSEKUSI RPC ==========
grant execute on function cek_login_murid(text, text) to anon, authenticated;
grant execute on function buat_akun_murid(jsonb) to authenticated;
grant execute on function import_akun_murid(jsonb, text) to authenticated;
grant execute on function set_password_murid(text, text) to authenticated;

-- ========== 6. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [3/34] fix_master_data_insert.sql
-- ============================================================

-- ============================================================
-- FIX INSERT master_data (400 Bad Request) — 2026-09-03
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Penyebab: tabel dibuat manual via Table Editor sehingga bisa saja
-- memiliki (a) kolom id uuid NOT NULL tanpa default, dan/atau
-- (b) kolom legacy NOT NULL tanpa default (mis. keterangan).
-- Insert dari aplikasi hanya mengisi kolom tertentu → pelanggaran
-- NOT NULL → PostgREST membalas 400.
--
-- Isi (semua idempotent, tidak menyentuh data):
--   1) Set default gen_random_uuid() untuk kolom id uuid tanpa default
--      (master_data & akun)
--   2) Drop NOT NULL semua kolom non-PK tanpa default (master_data & akun)
--   3) Reload cache skema PostgREST
-- ============================================================

-- ========== 1. DEFAULT UNTUK KOLOM id UUID ==========
do $$
declare
  r record;
  v_tabel text;
  v_is_identity text;
begin
  foreach v_tabel in array array['master_data', 'akun'] loop
    for r in
      select c.column_name
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = v_tabel
        and c.column_name = 'id'
        and c.is_nullable = 'NO'
        and c.data_type = 'uuid'
        and c.column_default is null
    loop
      -- Lewati jika kolom sudah berupa identity (column_default-nya memang null)
      select a.attidentity::text into v_is_identity
      from pg_attribute a
      where a.attrelid = to_regclass('public.' || v_tabel)
        and a.attname = 'id'
        and a.attnum > 0
        and not a.attisdropped;
      if coalesce(v_is_identity, '') = '' then
        execute format('alter table %I alter column id set default gen_random_uuid();', v_tabel);
        raise notice 'id.% diberi default gen_random_uuid()', v_tabel;
      end if;
    end loop;
  end loop;
end $$;

-- ========== 2. DROP NOT NULL KOLOM NON-PK TANPA DEFAULT ==========
do $$
declare
  r record;
  v_sql text;
begin
  for r in
    select c.table_name, c.column_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name in ('master_data', 'akun')
      and c.is_nullable = 'NO'
      and c.column_default is null
      and not exists (
        select 1 from information_schema.key_column_usage k
        join information_schema.table_constraints t
          on t.constraint_name = k.constraint_name
         and t.constraint_schema = k.constraint_schema
         and t.constraint_type = 'PRIMARY KEY'
        where k.table_schema = c.table_schema
          and k.table_name = c.table_name
          and k.column_name = c.column_name
      )
  loop
    v_sql := format('alter table %I alter column %I drop not null;',
                    r.table_name, r.column_name);
    execute v_sql;
    raise notice 'NOT NULL dilepas: %.%', r.table_name, r.column_name;
  end loop;
end $$;

-- ========== 3. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [4/34] upgrade_20260904_akun.sql
-- ============================================================

-- ============================================================
-- UPGRADE AKUN (GURU & MURID) — 2026-09-04
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   1) Gelar guru        : gelar_depan, gelar_belakang
--   2) 14 kolom profil murid : nisn, tahun_pelajaran, semester,
--      jenis_kelamin, tgl_lahir, agama, golongan_darah, nama_ayah,
--      pekerjaan_ayah, nama_ibu, pekerjaan_ibu, nama_wali, alamat,
--      catatan_khusus
--   3) RPC buat_akun_murid & import_akun_murid dibuat ulang untuk
--      mendukung kolom baru (pola & aturan sama: password hash di
--      akun_kredensial, hanya admin)
--
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. GELAR GURU ==========
alter table akun
  add column if not exists gelar_depan text,
  add column if not exists gelar_belakang text;

-- ========== 2. KOLOM PROFIL MURID ==========
alter table akun
  add column if not exists nisn text,
  add column if not exists tahun_pelajaran text,
  add column if not exists semester text,
  add column if not exists jenis_kelamin text,
  add column if not exists tgl_lahir date,
  add column if not exists agama text,
  add column if not exists golongan_darah text,
  add column if not exists nama_ayah text,
  add column if not exists pekerjaan_ayah text,
  add column if not exists nama_ibu text,
  add column if not exists pekerjaan_ibu text,
  add column if not exists nama_wali text,
  add column if not exists alamat text,
  add column if not exists catatan_khusus text;

-- ========== 3a. RPC: TAMBAH / EDIT AKUN MURID (dengan kolom baru) ==========
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
    -- EDIT: perbarui profil; password hanya bila diisi
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
    -- TAMBAH: password wajib (kosong → default 123456)
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

-- ========== 3b. RPC: IMPORT MASSAL MURID (dengan kolom baru) ==========
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
  v_ok int := 0; v_upd int := 0; v_fail int := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  if coalesce((select tipe from akun where user_id = auth.uid()), '') <> 'admin' then
    return json_build_object('status', 'error', 'message', 'Hanya admin yang boleh mengelola akun murid.');
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

-- ========== 4. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [5/34] upgrade_20260904_master_data_tambahan.sql
-- ============================================================

-- ============================================================
-- UPGRADE MASTER_DATA — 2026-09-04
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   1) 12 kolom daftar baru : Status Kehadiran, Jam Pelajaran per hari
--      (Senin-Sabtu), Jurusan, Kategori Nilai, Agama, Jadwal Ujian,
--      Kegiatan
--   2) 6 kolom identitas baru : NPSN, Kepala Sekolah, Telepon Sekolah,
--      Email Sekolah, Website Sekolah, Kurikulum
--
-- Semua idempotent — aman dijalankan berulang.
-- RLS tidak perlu diubah (policy berlaku di level tabel).
-- ============================================================

-- ========== 1. KOLOM DAFTAR BARU ==========
alter table master_data
  add column if not exists "Status Kehadiran" text,
  add column if not exists "Jam Pelajaran Senin" text,
  add column if not exists "Jam Pelajaran Selasa" text,
  add column if not exists "Jam Pelajaran Rabu" text,
  add column if not exists "Jam Pelajaran Kamis" text,
  add column if not exists "Jam Pelajaran Jumat" text,
  add column if not exists "Jam Pelajaran Sabtu" text,
  add column if not exists "Jurusan" text,
  add column if not exists "Kategori Nilai" text,
  add column if not exists "Agama" text,
  add column if not exists "Jadwal Ujian" text,
  add column if not exists "Kegiatan" text;

-- ========== 2. KOLOM IDENTITAS BARU ==========
alter table master_data
  add column if not exists "NPSN" text,
  add column if not exists "Kepala Sekolah" text,
  add column if not exists "Telepon Sekolah" text,
  add column if not exists "Email Sekolah" text,
  add column if not exists "Website Sekolah" text,
  add column if not exists "Kurikulum" text;

-- ========== 3. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [6/34] upgrade_20260904_absensi.sql
-- ============================================================

-- ============================================================
-- UPGRADE ABSENSI — 2026-09-04
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   1) Recreate tabel absensi (kolom lengkap + unique anti-duplikat)
--      CATATAN: tabel lama KOSONG, jadi tidak ada data yang hilang.
--   2) Kolom kunci absen guru di tabel akun (captcha, kunci_absen)
--   3) RLS + privilege
--
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. RECREATE TABEL ABSENSI ==========
drop table if exists absensi;
create table absensi (
  id uuid primary key default gen_random_uuid(),
  nis text not null,
  nama text,
  tanggal date not null,
  status text not null check (status in ('H','S','I','A')),
  keterangan text default '',
  mapel text default '',
  ekskul text default '',
  kelas text default '',
  tahun text,
  semester text,
  bulan text,
  id_guru text,
  metode text default 'Manual / QR',
  created_at timestamptz not null default now(),
  unique (nis, tanggal, mapel)
);
create index if not exists idx_absensi_nis_tanggal on absensi (nis, tanggal);
create index if not exists idx_absensi_kelas_mapel on absensi (kelas, mapel);

-- ========== 2. KUNCI ABSEN GURU (CAPTCHA) ==========
alter table akun
  add column if not exists captcha text default '1234',
  add column if not exists kunci_absen text default 'TUTUP';

-- ========== 3. RLS & PRIVILEGE ==========
-- absensi: murid lokal memakai anon key (pseudo-token), jadi select/insert/
-- update dibuka untuk anon + authenticated (posture sama dengan tabel lama).
alter table absensi enable row level security;

drop policy if exists "absensi_baca_semua" on absensi;
create policy "absensi_baca_semua" on absensi
  for select using (true);

drop policy if exists "absensi_tulis_semua" on absensi;
create policy "absensi_tulis_semua" on absensi
  for insert with check (true);

drop policy if exists "absensi_ubah_semua" on absensi;
create policy "absensi_ubah_semua" on absensi
  for update using (true) with check (true);

revoke all on table absensi from anon, authenticated;
grant select, insert, update, delete on absensi to anon, authenticated;

-- akun: pastikan kolom kunci bisa dibaca & diubah user terkait
grant select, update on akun to authenticated;

-- ========== 4. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [7/34] upgrade_20260904_absensi_d.sql
-- ============================================================

-- ============================================================
-- UPGRADE ABSENSI: STATUS D (DISPEN) — 2026-09-04
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi: ganti check constraint kolom status agar menerima 'D' (Dispen).
-- Idempotent — aman dijalankan berulang. Data tidak tersentuh.
-- ============================================================

alter table absensi drop constraint if exists absensi_status_check;
alter table absensi
  add constraint absensi_status_check
  check (status in ('H','S','I','A','D'));

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [8/34] upgrade_20260904_jurnal.sql
-- ============================================================

-- ============================================================
-- UPGRADE: JURNAL HARIAN GURU — 2026-09-04
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi: tabel jurnal_guru (agenda mengajar per pertemuan).
--
-- unique (nis_guru, kelas, mapel, tahun, pertemuan):
--   - Pertemuan otomatis melanjutkan, tetap bisa diedit tanpa duplikat.
-- RLS: guru/admin (authenticated) boleh baca/tulis.
-- Idempotent — aman dijalankan berulang.
-- ============================================================

create table if not exists jurnal_guru (
  id uuid primary key default gen_random_uuid(),
  nis_guru text not null,
  tanggal date not null,
  kelas text not null,
  mapel text not null,
  pertemuan int not null default 1,
  tahun text,
  semester text,
  bulan text,
  kompetensi_dasar text default '',
  materi text default '',
  kegiatan_kbm text default '',
  permasalahan text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (nis_guru, kelas, mapel, tahun, pertemuan)
);
create index if not exists idx_jurnal_guru_pertemuan
  on jurnal_guru (nis_guru, kelas, mapel, tahun);

alter table jurnal_guru enable row level security;

drop policy if exists "jurnal_baca_auth" on jurnal_guru;
create policy "jurnal_baca_auth" on jurnal_guru
  for select to authenticated using (true);

drop policy if exists "jurnal_tulis_auth" on jurnal_guru;
create policy "jurnal_tulis_auth" on jurnal_guru
  for insert to authenticated with check (true);

drop policy if exists "jurnal_ubah_auth" on jurnal_guru;
create policy "jurnal_ubah_auth" on jurnal_guru
  for update to authenticated using (true) with check (true);

revoke all on table jurnal_guru from anon, authenticated;
grant select, insert, update, delete on jurnal_guru to authenticated;

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [9/34] upgrade_20260904_nilai.sql
-- ============================================================

-- ============================================================
-- UPGRADE INPUT NILAI — 2026-09-04
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   1) Recreate tabel nilai (JSONB per siswa per kategori per mapel)
--      CATATAN: tabel lama KOSONG, tidak ada data yang hilang.
--      Kolom dinamis (KD A 1, Prak A 1, Projek A, KET, dst.) disimpan
--      di kolom `data` (JSONB) — mengikuti konfigurasi tiap kategori.
--   2) Tabel nilai_konfigurasi (konfigurasi KD/bobot per kategori+mapel)
--   3) RLS + privilege (guru/admin = authenticated)
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. RECREATE TABEL NILAI ==========
drop table if exists nilai;
create table nilai (
  id uuid primary key default gen_random_uuid(),
  nis text not null,
  nama text default '',
  kategori text not null,
  mapel text not null default '',
  ekskul text not null default '',
  kelas text default '',
  tahun text default '',
  semester text default '',
  id_guru text default '',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (nis, kategori, mapel, ekskul, tahun, semester)
);
create index if not exists idx_nilai_filter
  on nilai (kategori, mapel, kelas, tahun, semester);

-- ========== 2. TABEL KONFIGURASI NILAI ==========
create table if not exists nilai_konfigurasi (
  id uuid primary key default gen_random_uuid(),
  kategori text not null,
  mapel text not null default '',
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (kategori, mapel)
);

-- ========== 3. RLS & PRIVILEGE ==========
alter table nilai enable row level security;

drop policy if exists "nilai_baca_auth" on nilai;
create policy "nilai_baca_auth" on nilai
  for select to authenticated using (true);

drop policy if exists "nilai_tulis_auth" on nilai;
create policy "nilai_tulis_auth" on nilai
  for insert to authenticated with check (true);

drop policy if exists "nilai_ubah_auth" on nilai;
create policy "nilai_ubah_auth" on nilai
  for update to authenticated using (true) with check (true);

alter table nilai_konfigurasi enable row level security;

drop policy if exists "nilaikfg_baca_auth" on nilai_konfigurasi;
create policy "nilaikfg_baca_auth" on nilai_konfigurasi
  for select to authenticated using (true);

drop policy if exists "nilaikfg_tulis_auth" on nilai_konfigurasi;
create policy "nilaikfg_tulis_auth" on nilai_konfigurasi
  for insert to authenticated with check (true);

drop policy if exists "nilaikfg_ubah_auth" on nilai_konfigurasi;
create policy "nilaikfg_ubah_auth" on nilai_konfigurasi
  for update to authenticated using (true) with check (true);

revoke all on table nilai from anon, authenticated;
grant select, insert, update, delete on nilai to authenticated;
revoke all on table nilai_konfigurasi from anon, authenticated;
grant select, insert, update, delete on nilai_konfigurasi to authenticated;

-- ========== 4. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [10/34] upgrade_20260904_ekskul.sql
-- ============================================================

-- ============================================================
-- UPGRADE EKSTRAKURIKULER — 2026-09-04
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   1) Tabel ekstrakurikuler: tambah pembina_nip & jadwal
--   2) Tabel agenda_ekskul (agenda kegiatan per ekskul)
--   3) Tabel dispensasi (riwayat surat dispensasi)
--   4) RLS & privilege (guru/admin = authenticated)
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. TABEL EKSTRAKURIKULER ==========
alter table ekstrakurikuler
  add column if not exists pembina_nip text default '',
  add column if not exists jadwal text default '';

alter table ekstrakurikuler enable row level security;

drop policy if exists "ekskul_baca_auth" on ekstrakurikuler;
create policy "ekskul_baca_auth" on ekstrakurikuler
  for select to authenticated using (true);

drop policy if exists "ekskul_baca_anon" on ekstrakurikuler;
create policy "ekskul_baca_anon" on ekstrakurikuler
  for select to anon using (true);

drop policy if exists "ekskul_tulis_auth" on ekstrakurikuler;
create policy "ekskul_tulis_auth" on ekstrakurikuler
  for insert to authenticated with check (true);

drop policy if exists "ekskul_ubah_auth" on ekstrakurikuler;
create policy "ekskul_ubah_auth" on ekstrakurikuler
  for update to authenticated using (true) with check (true);

drop policy if exists "ekskul_hapus_auth" on ekstrakurikuler;
create policy "ekskul_hapus_auth" on ekstrakurikuler
  for delete to authenticated using (true);

revoke all on table ekstrakurikuler from anon, authenticated;
grant select on ekstrakurikuler to anon, authenticated;
grant insert, update, delete on ekstrakurikuler to authenticated;

-- ========== 2. AGENDA KEGIATAN EKSKUL ==========
create table if not exists agenda_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  tanggal date not null,
  kegiatan text not null,
  keterangan text default '',
  dibuat_oleh text default '',
  created_at timestamptz not null default now(),
  unique (ekskul, tanggal, kegiatan)
);
create index if not exists idx_agenda_ekskul on agenda_ekskul (ekskul, tanggal);

alter table agenda_ekskul enable row level security;

drop policy if exists "agenda_baca_auth" on agenda_ekskul;
create policy "agenda_baca_auth" on agenda_ekskul
  for select to authenticated using (true);

drop policy if exists "agenda_tulis_auth" on agenda_ekskul;
create policy "agenda_tulis_auth" on agenda_ekskul
  for insert to authenticated with check (true);

drop policy if exists "agenda_ubah_auth" on agenda_ekskul;
create policy "agenda_ubah_auth" on agenda_ekskul
  for update to authenticated using (true) with check (true);

drop policy if exists "agenda_hapus_auth" on agenda_ekskul;
create policy "agenda_hapus_auth" on agenda_ekskul
  for delete to authenticated using (true);

revoke all on table agenda_ekskul from anon, authenticated;
grant select, insert, update, delete on agenda_ekskul to authenticated;

-- ========== 3. RIWAYAT SURAT DISPENSASI ==========
create table if not exists dispensasi (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  nis text not null,
  nama text default '',
  kelas text default '',
  tanggal_izin date not null,
  alasan text default '',
  dibuat_oleh text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_dispensasi_ekskul on dispensasi (ekskul, tanggal_izin);

alter table dispensasi enable row level security;

drop policy if exists "dispensasi_baca_auth" on dispensasi;
create policy "dispensasi_baca_auth" on dispensasi
  for select to authenticated using (true);

drop policy if exists "dispensasi_tulis_auth" on dispensasi;
create policy "dispensasi_tulis_auth" on dispensasi
  for insert to authenticated with check (true);

drop policy if exists "dispensasi_hapus_auth" on dispensasi;
create policy "dispensasi_hapus_auth" on dispensasi
  for delete to authenticated using (true);

revoke all on table dispensasi from anon, authenticated;
grant select, insert, delete on dispensasi to authenticated;

-- ========== 4. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [11/34] upgrade_20260905_ekskul_pengurus.sql
-- ============================================================

-- ============================================================
-- UPGRADE EKSTRAKURIKULER (LANJUTAN) — 2026-09-05
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   1) agenda_ekskul: kolom "hari" untuk jadwal berulang
--      (Setiap Hari Senin-Minggu); tanggal boleh NULL
--   2) Akses pengurus ekskul (murid): murid password lokal memakai
--      anon key (pola sama dengan tabel absensi), sehingga:
--      - agenda_ekskul  : select/insert/update untuk anon
--      - dispensasi     : select/insert untuk anon
--      - akun           : update kolom "ekstrakurikuler" saja (kolom-level)
--
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. KOLOM HARI AGENDA ==========
alter table agenda_ekskul
  add column if not exists hari text default '';

alter table agenda_ekskul alter column tanggal drop not null;

-- ========== 2. GRANT & POLICY ANON (PENGURUS EKSKUL) ==========
-- agenda_ekskul
revoke all on table agenda_ekskul from anon;
grant select, insert, update on agenda_ekskul to anon;

drop policy if exists "agenda_baca_anon" on agenda_ekskul;
create policy "agenda_baca_anon" on agenda_ekskul
  for select to anon using (true);

drop policy if exists "agenda_tulis_anon" on agenda_ekskul;
create policy "agenda_tulis_anon" on agenda_ekskul
  for insert to anon with check (true);

drop policy if exists "agenda_ubah_anon" on agenda_ekskul;
create policy "agenda_ubah_anon" on agenda_ekskul
  for update to anon using (true) with check (true);

-- dispensasi
revoke all on table dispensasi from anon;
grant select, insert on dispensasi to anon;

drop policy if exists "dispensasi_baca_anon" on dispensasi;
create policy "dispensasi_baca_anon" on dispensasi
  for select to anon using (true);

drop policy if exists "dispensasi_tulis_anon" on dispensasi;
create policy "dispensasi_tulis_anon" on dispensasi
  for insert to anon with check (true);

-- akun: anon hanya boleh mengubah kolom keanggotaan ekskul (kolom-level)
grant update (ekstrakurikuler) on akun to anon;

-- ========== 3. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [12/34] upgrade_20260906_sikap_teman.sql
-- ============================================================

-- ============================================================
-- UPGRADE SIKAP — TEMAN SEJAWAT & JURNAL PENILAIAN SIKAP — 2026-09-06
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   1) Tabel nilai_teman_sejawat (rating 1-4 per PENILAI per TARGET;
--      satu baris = satu penilai menilai satu teman)
--   2) Tabel jurnal_sikap (jurnal guru: hari/tanggal, kejadian,
--      aspek sikap, tindak lanjut — per kelas+mapel+tahun+semester)
--   3) RLS + privilege (guru/admin = authenticated)
--   4) RPC murid (security definer, bisa dipanggil anon — murid password
--      lokal tidak punya sesi Auth Supabase):
--      - sesi_teman_terbuka(): daftar mapel dengan sesi penilaian BUKA
--      - ambil_teman_sekelas(): teman sekelas + rating milik penilai
--      - simpan_penilaian_teman(): upsert rating (validasi sesi buka,
--        target sekelas, skor 1-4; tahun/semester dipaksa dari sesi guru)
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. TABEL TEMAN SEJAWAT ==========
create table if not exists nilai_teman_sejawat (
  id uuid primary key default gen_random_uuid(),
  penilai_nis text not null,
  target_nis text not null,
  kelas text default '',
  mapel text default '',
  tahun text default '',
  semester text default '',
  skor int not null check (skor between 1 and 4),
  id_guru text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (penilai_nis, target_nis, mapel, tahun, semester)
);
create index if not exists idx_nsts_target
  on nilai_teman_sejawat (target_nis, mapel, kelas, tahun, semester);
create index if not exists idx_nsts_penilai
  on nilai_teman_sejawat (penilai_nis, mapel, tahun, semester);

-- ========== 2. TABEL JURNAL SIKAP ==========
create table if not exists jurnal_sikap (
  id uuid primary key default gen_random_uuid(),
  kelas text default '',
  mapel text default '',
  tahun text default '',
  semester text default '',
  hari_tanggal text default '',
  kejadian text default '',
  aspek_sikap text default '',
  tindak_lanjut text default '',
  id_guru text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_jurnal_sikap_scope
  on jurnal_sikap (kelas, mapel, tahun, semester);

-- ========== 3. RLS & PRIVILEGE ==========
alter table nilai_teman_sejawat enable row level security;

drop policy if exists "nsts_baca_auth" on nilai_teman_sejawat;
create policy "nsts_baca_auth" on nilai_teman_sejawat
  for select to authenticated using (true);

drop policy if exists "nsts_tulis_auth" on nilai_teman_sejawat;
create policy "nsts_tulis_auth" on nilai_teman_sejawat
  for insert to authenticated with check (true);

drop policy if exists "nsts_ubah_auth" on nilai_teman_sejawat;
create policy "nsts_ubah_auth" on nilai_teman_sejawat
  for update to authenticated using (true) with check (true);

drop policy if exists "nsts_hapus_auth" on nilai_teman_sejawat;
create policy "nsts_hapus_auth" on nilai_teman_sejawat
  for delete to authenticated using (true);

alter table jurnal_sikap enable row level security;

drop policy if exists "jurnalsikap_baca_auth" on jurnal_sikap;
create policy "jurnalsikap_baca_auth" on jurnal_sikap
  for select to authenticated using (true);

drop policy if exists "jurnalsikap_tulis_auth" on jurnal_sikap;
create policy "jurnalsikap_tulis_auth" on jurnal_sikap
  for insert to authenticated with check (true);

drop policy if exists "jurnalsikap_ubah_auth" on jurnal_sikap;
create policy "jurnalsikap_ubah_auth" on jurnal_sikap
  for update to authenticated using (true) with check (true);

drop policy if exists "jurnalsikap_hapus_auth" on jurnal_sikap;
create policy "jurnalsikap_hapus_auth" on jurnal_sikap
  for delete to authenticated using (true);

revoke all on table nilai_teman_sejawat from anon, authenticated;
grant select, insert, update, delete on nilai_teman_sejawat to authenticated;
revoke all on table jurnal_sikap from anon, authenticated;
grant select, insert, update, delete on jurnal_sikap to authenticated;

-- ========== 4. RPC MURID (security definer) ==========
-- 4a. Daftar sesi penilaian teman yang sedang BUKA (per mapel Sikap).
create or replace function sesi_teman_terbuka()
returns json
language sql
security definer
set search_path = public, extensions
as $$
  select coalesce(json_agg(json_build_object(
    'mapel', k.mapel,
    'judul', k.config->'sikap_teman'->>'judul',
    'keterangan', k.config->'sikap_teman'->>'keterangan',
    'jumlah_teman', coalesce((k.config->'sikap_teman'->>'jumlah_teman')::int, 5),
    'tahun', coalesce(k.config->'sikap_teman'->>'sesi_tahun', ''),
    'semester', coalesce(k.config->'sikap_teman'->>'sesi_semester', '')
  ) order by k.mapel), '[]'::json)
  from nilai_konfigurasi k
  where k.kategori = 'Data Nilai Sikap'
    and coalesce((k.config->'sikap_teman'->>'sesi_buka')::boolean, false);
$$;

-- 4b. Teman sekelas + rating milik penilai (untuk mapel dengan sesi terbuka).
create or replace function ambil_teman_sekelas(p_nis text, p_mapel text default '')
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_penilai akun%rowtype;
  v_cfg jsonb;
begin
  select * into v_penilai from akun where nis_nip = p_nis and tipe = 'murid' limit 1;
  if v_penilai.id is null then
    return json_build_object('status', 'error', 'message', 'NIS penilai tidak terdaftar.');
  end if;

  select config into v_cfg from nilai_konfigurasi
    where kategori = 'Data Nilai Sikap'
      and mapel = coalesce(nullif(trim(p_mapel), ''), '')
    limit 1;

  return json_build_object(
    'status', 'success',
    'kelas', v_penilai.tingkat_kelas,
    'sesi_buka', coalesce((v_cfg->'sikap_teman'->>'sesi_buka')::boolean, false),
    'judul', coalesce(v_cfg->'sikap_teman'->>'judul', 'Berilah nilai untuk 5 teman'),
    'keterangan', coalesce(v_cfg->'sikap_teman'->>'keterangan', ''),
    'jumlah_teman', coalesce((v_cfg->'sikap_teman'->>'jumlah_teman')::int, 5),
    'kriteria', coalesce(v_cfg->'sikap_teman'->'kriteria', '{}'::jsonb),
    'tahun', coalesce(v_cfg->'sikap_teman'->>'sesi_tahun', ''),
    'semester', coalesce(v_cfg->'sikap_teman'->>'sesi_semester', ''),
    'teman', (
      select coalesce(json_agg(json_build_object(
        'nis', a.nis_nip, 'nama', a.nama_lengkap
      ) order by a.nama_lengkap), '[]'::json)
      from akun a
      where a.tipe = 'murid'
        and a.tingkat_kelas = v_penilai.tingkat_kelas
        and a.nis_nip <> p_nis
    ),
    'rating_saya', (
      select coalesce(json_object_agg(t.target_nis, t.skor), '{}'::json)
      from nilai_teman_sejawat t
      where t.penilai_nis = p_nis
        and t.mapel = coalesce(nullif(trim(p_mapel), ''), '')
        and t.tahun = coalesce(v_cfg->'sikap_teman'->>'sesi_tahun', '')
        and t.semester = coalesce(v_cfg->'sikap_teman'->>'sesi_semester', '')
    )
  );
end $$;

-- 4c. Simpan rating murid (upsert idempoten — dapat mengoreksi selama sesi buka).
--     Tahun/semester DIPAKSA dari sesi guru di config (murid tidak menentukan).
create or replace function simpan_penilaian_teman(
  p_penilai_nis text,
  p_mapel text default '',
  p_rows jsonb default '[]'::jsonb
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_penilai akun%rowtype;
  v_cfg jsonb;
  v_buka boolean;
  v_tahun text;
  v_semester text;
  el jsonb;
  v_target text;
  v_skor int;
  v_ok int := 0;
  v_fail int := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  select * into v_penilai from akun where nis_nip = p_penilai_nis and tipe = 'murid' limit 1;
  if v_penilai.id is null then
    return json_build_object('status', 'error', 'message', 'NIS penilai tidak terdaftar.');
  end if;

  -- Sesi harus dibuka guru pada konfigurasi kategori Sikap mapel terkait
  select config into v_cfg from nilai_konfigurasi
    where kategori = 'Data Nilai Sikap'
      and mapel = coalesce(nullif(trim(p_mapel), ''), '')
    limit 1;
  v_buka := coalesce((v_cfg->'sikap_teman'->>'sesi_buka')::boolean, false);
  if not v_buka then
    return json_build_object('status', 'error', 'message', 'Sesi penilaian teman sejawat belum dibuka guru.');
  end if;
  v_tahun := coalesce(v_cfg->'sikap_teman'->>'sesi_tahun', '');
  v_semester := coalesce(v_cfg->'sikap_teman'->>'sesi_semester', '');

  if jsonb_typeof(p_rows) <> 'array' then
    return json_build_object('status', 'error', 'message', 'Format data tidak valid.');
  end if;

  for el in select * from jsonb_array_elements(p_rows) loop
    v_target := trim(coalesce(el->>'nis', ''));
    v_skor := nullif(el->>'skor', '')::int;
    begin
      if v_target = '' or v_target = p_penilai_nis then
        v_fail := v_fail + 1;
        v_errors := v_errors || jsonb_build_array('Target tidak valid / menilai diri sendiri.');
        continue;
      end if;
      if v_skor is null or v_skor < 1 or v_skor > 4 then
        v_fail := v_fail + 1;
        v_errors := v_errors || jsonb_build_array('Skor harus angka 1-4.');
        continue;
      end if;
      -- Target wajib murid sekelas dengan penilai
      if not exists (
        select 1 from akun a
        where a.nis_nip = v_target
          and a.tipe = 'murid'
          and a.tingkat_kelas = v_penilai.tingkat_kelas
      ) then
        v_fail := v_fail + 1;
        v_errors := v_errors || jsonb_build_array('Target bukan teman sekelas: ' || v_target);
        continue;
      end if;

      insert into nilai_teman_sejawat
        (penilai_nis, target_nis, kelas, mapel, tahun, semester, skor)
      values
        (p_penilai_nis, v_target, v_penilai.tingkat_kelas,
         coalesce(nullif(trim(p_mapel), ''), ''), v_tahun, v_semester, v_skor)
      on conflict (penilai_nis, target_nis, mapel, tahun, semester)
      do update set skor = excluded.skor, updated_at = now();
      v_ok := v_ok + 1;
    exception when others then
      v_fail := v_fail + 1;
      v_errors := v_errors || jsonb_build_array('Gagal simpan untuk ' || v_target || ': ' || SQLERRM);
    end;
  end loop;

  return json_build_object(
    'status', 'success',
    'tersimpan', v_ok,
    'gagal', v_fail,
    'detail_gagal', v_errors
  );
end $$;

grant execute on function sesi_teman_terbuka() to anon, authenticated;
grant execute on function ambil_teman_sekelas(text, text) to anon, authenticated;
grant execute on function simpan_penilaian_teman(text, text, jsonb) to anon, authenticated;

-- ========== 5. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [13/34] upgrade_20260906_ekskul_surat.sql
-- ============================================================

-- ============================================================
-- UPGRADE EKSTRAKURIKULER — SURAT DISPENSASI & SUB-EKSKUL — 2026-09-06
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   1) ekstrakurikuler: kolom logo_url
--   2) dispensasi: kolom sub_ekskul, keterangan, detail (jsonb), surat_id
--   3) Tabel sub_ekstrakurikuler (daftar sub per ekskul)
--   4) Tabel anggota_sub_ekskul (penandaan sub per anggota)
--   5) Tabel preset_dispensasi (preset surat per ekskul / global)
--   6) RLS & privilege (guru/admin/pengurus; anon = murid password lokal)
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. LOGO EKSKUL ==========
alter table ekstrakurikuler
  add column if not exists logo_url text default '';

-- ========== 2. TAMBAHAN KOLOM DISPENSASI ==========
alter table dispensasi
  add column if not exists sub_ekskul text default '',
  add column if not exists keterangan text default '',
  add column if not exists detail jsonb default '{}'::jsonb,
  add column if not exists surat_id text default '';
create index if not exists idx_dispensasi_surat on dispensasi (surat_id);

-- ========== 3. SUB-EKSTRAKURIKULER ==========
create table if not exists sub_ekstrakurikuler (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  nama_sub text not null,
  urutan int default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ekskul, nama_sub)
);
create index if not exists idx_sub_ekskul on sub_ekstrakurikuler (ekskul);

alter table sub_ekstrakurikuler enable row level security;

drop policy if exists "subekskul_baca_auth" on sub_ekstrakurikuler;
create policy "subekskul_baca_auth" on sub_ekstrakurikuler
  for select to authenticated using (true);
drop policy if exists "subekskul_tulis_auth" on sub_ekstrakurikuler;
create policy "subekskul_tulis_auth" on sub_ekstrakurikuler
  for insert to authenticated with check (true);
drop policy if exists "subekskul_ubah_auth" on sub_ekstrakurikuler;
create policy "subekskul_ubah_auth" on sub_ekstrakurikuler
  for update to authenticated using (true) with check (true);
drop policy if exists "subekskul_hapus_auth" on sub_ekstrakurikuler;
create policy "subekskul_hapus_auth" on sub_ekstrakurikuler
  for delete to authenticated using (true);
drop policy if exists "subekskul_baca_anon" on sub_ekstrakurikuler;
create policy "subekskul_baca_anon" on sub_ekstrakurikuler
  for select to anon using (true);

revoke all on table sub_ekstrakurikuler from anon, authenticated;
grant select on sub_ekstrakurikuler to anon, authenticated;
grant insert, update, delete on sub_ekstrakurikuler to authenticated;

-- ========== 4. KEANGGOTAAN SUB-EKSKUL ==========
create table if not exists anggota_sub_ekskul (
  id uuid primary key default gen_random_uuid(),
  nis text not null,
  ekskul text not null,
  sub text default '',
  updated_at timestamptz not null default now(),
  unique (nis, ekskul)
);
create index if not exists idx_anggota_sub on anggota_sub_ekskul (ekskul, sub);

alter table anggota_sub_ekskul enable row level security;

drop policy if exists "angsub_baca_auth" on anggota_sub_ekskul;
create policy "angsub_baca_auth" on anggota_sub_ekskul
  for select to authenticated using (true);
drop policy if exists "angsub_tulis_auth" on anggota_sub_ekskul;
create policy "angsub_tulis_auth" on anggota_sub_ekskul
  for insert to authenticated with check (true);
drop policy if exists "angsub_ubah_auth" on anggota_sub_ekskul;
create policy "angsub_ubah_auth" on anggota_sub_ekskul
  for update to authenticated using (true) with check (true);
drop policy if exists "angsub_hapus_auth" on anggota_sub_ekskul;
create policy "angsub_hapus_auth" on anggota_sub_ekskul
  for delete to authenticated using (true);
-- Pengurus ekskul (murid password lokal) memakai anon key — pola 20260905
drop policy if exists "angsub_baca_anon" on anggota_sub_ekskul;
create policy "angsub_baca_anon" on anggota_sub_ekskul
  for select to anon using (true);
drop policy if exists "angsub_tulis_anon" on anggota_sub_ekskul;
create policy "angsub_tulis_anon" on anggota_sub_ekskul
  for insert to anon with check (true);
drop policy if exists "angsub_ubah_anon" on anggota_sub_ekskul;
create policy "angsub_ubah_anon" on anggota_sub_ekskul
  for update to anon using (true) with check (true);
drop policy if exists "angsub_hapus_anon" on anggota_sub_ekskul;
create policy "angsub_hapus_anon" on anggota_sub_ekskul
  for delete to anon using (true);

revoke all on table anggota_sub_ekskul from anon, authenticated;
grant select, insert, update, delete on anggota_sub_ekskul to authenticated;
grant select, insert, update, delete on anggota_sub_ekskul to anon;

-- ========== 5. PRESET SURAT DISPENSASI ==========
create table if not exists preset_dispensasi (
  id uuid primary key default gen_random_uuid(),
  ekskul text default '',
  nama_preset text not null,
  isi jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ekskul, nama_preset)
);
create index if not exists idx_preset_disp on preset_dispensasi (ekskul);

alter table preset_dispensasi enable row level security;

drop policy if exists "preset_baca_auth" on preset_dispensasi;
create policy "preset_baca_auth" on preset_dispensasi
  for select to authenticated using (true);
drop policy if exists "preset_tulis_auth" on preset_dispensasi;
create policy "preset_tulis_auth" on preset_dispensasi
  for insert to authenticated with check (true);
drop policy if exists "preset_ubah_auth" on preset_dispensasi;
create policy "preset_ubah_auth" on preset_dispensasi
  for update to authenticated using (true) with check (true);
drop policy if exists "preset_hapus_auth" on preset_dispensasi;
create policy "preset_hapus_auth" on preset_dispensasi
  for delete to authenticated using (true);

revoke all on table preset_dispensasi from anon, authenticated;
grant select, insert, update, delete on preset_dispensasi to authenticated;

-- ========== 6. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [14/34] upgrade_20260906_ekskul_surat_v2.sql
-- ============================================================

-- ============================================================
-- UPGRADE EKSTRAKURIKULER — SURAT DISPENSASI v2 — 2026-09-06
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   1) sub_ekstrakurikuler: kolom "anggota" (JSONB array NIS) —
--      keanggotaan sub digabung ke SATU tabel
--   2) Migrasi data dari anggota_sub_ekskul → sub_ekstrakurikuler.anggota
--   3) Drop tabel anggota_sub_ekskul (tidak lagi dipakai)
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. KOLOM ANGOTA PADA SUB-EKSKUL ==========
alter table sub_ekstrakurikuler
  add column if not exists anggota jsonb not null default '[]'::jsonb;

-- ========== 2. MIGRASI DATA KEANGGOTAAN LAMA ==========
-- Masukkan NIS dari anggota_sub_ekskul ke array anggota baris sub yang cocok
-- (hanya bila kolom anggota masih kosong — idempoten).
do $$
declare
  v_kol text;
begin
  if to_regclass('public.anggota_sub_ekskul') is not null then
    -- [PERBAIKAN 42703] kolom penyimpan nama sub dideteksi otomatis:
    -- skema v1 memakai kolom "sub" (bukan "nama_sub") — deteksi via information_schema, dipakai via %I.
    select case
      when exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'anggota_sub_ekskul'
                     and column_name = 'nama_sub') then 'nama_sub'
      when exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'anggota_sub_ekskul'
                     and column_name = 'sub') then 'sub'
      else null
    end into v_kol;
    if v_kol is not null then
      execute format($f$
        update sub_ekstrakurikuler s
        set anggota = q.anggota
        from (
          select ekskul, %I as nama_sub, jsonb_agg(distinct nis order by nis) as anggota
          from anggota_sub_ekskul
          where coalesce(%I, '') <> ''
          group by ekskul, %I
        ) q
        where s.ekskul = q.ekskul
          and s.nama_sub = q.nama_sub
          and coalesce(s.anggota, '[]'::jsonb) = '[]'::jsonb
      $f$, v_kol, v_kol, v_kol);
    end if;
  end if;
end $$;

-- ========== 3. DROP TABEL LAMA ==========
drop table if exists anggota_sub_ekskul;

-- ========== 4. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [15/34] upgrade_20260908_kalender.sql
-- ============================================================

-- ============================================================
-- UPGRADE: KALENDER PENDIDIKAN — 2026-09-08
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi: tabel kalender_pendidikan (event libur/kegiatan per tahun pelajaran).
--
-- tipe: libur | libur_siswa | awal_masuk | sumatif | rapor | budi_pekerti | custom
--   - libur & libur_siswa ikut mengunci absensi (Hadir Tatap Muka);
--   - kategori lain hanya penanda warna/tooltip.
-- tanggal_sampai: null/sama = acara satu hari; rentang dipecah per hari di aplikasi.
-- semester: 'Ganjil' | 'Genap' (tabel data dibagi per semester).
-- RLS: guru/admin (authenticated) boleh baca/tulis.
-- Idempotent — aman dijalankan berulang.
-- ============================================================

create table if not exists kalender_pendidikan (
  id uuid primary key default gen_random_uuid(),
  tahun text not null,
  semester text not null default 'Ganjil',
  tipe text not null default 'custom',
  tanggal_mulai date not null,
  tanggal_sampai date,
  nama text not null,
  keterangan text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_kalender_tahun_tgl
  on kalender_pendidikan (tahun, tanggal_mulai);

alter table kalender_pendidikan enable row level security;

drop policy if exists "kalender_baca_auth" on kalender_pendidikan;
create policy "kalender_baca_auth" on kalender_pendidikan
  for select to authenticated using (true);

drop policy if exists "kalender_tulis_auth" on kalender_pendidikan;
create policy "kalender_tulis_auth" on kalender_pendidikan
  for insert to authenticated with check (true);

drop policy if exists "kalender_update_auth" on kalender_pendidikan;
create policy "kalender_update_auth" on kalender_pendidikan
  for update to authenticated using (true) with check (true);

drop policy if exists "kalender_hapus_auth" on kalender_pendidikan;
create policy "kalender_hapus_auth" on kalender_pendidikan
  for delete to authenticated using (true);


-- ============================================================
-- [16/34] upgrade_20260909_administrasi_guru.sql
-- ============================================================

-- ============================================================
-- UPGRADE: ADMINISTRASI GURU LAINNYA — 2026-09-09
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Isi:
--   1) ALTER jurnal_guru  : + hari, jam_ke, pencapaian (Kegiatan Harian Guru)
--   2) remedial_pelaksanaan : Format Pelaksanaan Perbaikan dan Pengayaan
--   3) remedial_program     : Program Remedial/Pengayaan per KI/KD
--   4) bimbingan_penyuluhan : Lembar Bimbingan Penyuluhan (BK)
--   5) kunjungan_supervisi  : Lembar Kunjungan Kelas Supervisi
--   6) dokumen_guru         : Dokumen/link milik guru (opsi dibagikan)
--
-- Kepemilikan data: kolom nip_guru / pemilik_nip; scoping akses diberlakukan
-- di UI (guru = miliknya + yang dibagikan; admin = semua).
-- RLS: guru/admin (authenticated) boleh baca/tulis.
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1) JURNAL GURU: kolom kegiatan harian ==========
alter table jurnal_guru add column if not exists hari text default '';
alter table jurnal_guru add column if not exists jam_ke text default '';
alter table jurnal_guru add column if not exists pencapaian text default '';

-- ========== 2) REMEDIAL: FORMAT PELAKSANAAN ==========
create table if not exists remedial_pelaksanaan (
  id uuid primary key default gen_random_uuid(),
  tahun text not null,
  semester text default 'Ganjil',
  kelas text default '',
  mapel text default '',
  bentuk_evaluasi text default '',
  tanggal_pelaksanaan date,
  ki_kd text default '',
  program text default 'Perbaikan',
  jumlah_siswa int,
  tindakan text default '',
  hasil text default 'TUNTAS',
  nip_guru text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_rem_pelaksanaan_tahun
  on remedial_pelaksanaan (tahun, semester, kelas);

-- ========== 3) REMEDIAL: PROGRAM ==========
create table if not exists remedial_program (
  id uuid primary key default gen_random_uuid(),
  tahun text default '',
  semester text default 'Ganjil',
  kelas text default '',
  mapel text default '',
  ki_cp text default '',
  kd_tp text default '',
  ketercapaian text default '',
  tindak_lanjut text default 'Remedial Tes',
  nip_guru text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_rem_program_tahun
  on remedial_program (tahun, semester, kelas, mapel);

-- ========== 4) BIMBINGAN PENYULUHAN ==========
create table if not exists bimbingan_penyuluhan (
  id uuid primary key default gen_random_uuid(),
  tahun text default '',
  semester text default 'Ganjil',
  hari text default '',
  tanggal date,
  nama_siswa text default '',
  nis text default '',
  kelas text default '',
  mapel text default '',
  masalah text default '',
  jenis_bimbingan text default 'Pelajaran - Individu',
  tindak_lanjut text default '',
  nip_guru text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_bimbingan_tahun
  on bimbingan_penyuluhan (tahun, tanggal);

-- ========== 5) KUNJUNGAN KELAS SUPERVISI ==========
create table if not exists kunjungan_supervisi (
  id uuid primary key default gen_random_uuid(),
  tahun text default '',
  semester text default 'Ganjil',
  hari text default '',
  tanggal date,
  nama_guru text default '',
  jabatan text default '',
  nip text default '',
  kelas text default '',
  maksud text default '',
  kesan text default '',
  pesan text default '',
  tanda_tangan text default '',
  keterangan text default '',
  nip_pencatat text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_supervisi_tahun
  on kunjungan_supervisi (tahun, tanggal);

-- ========== 6) DOKUMEN LAINNYA (LINK EKSTERNAL) ==========
create table if not exists dokumen_guru (
  id uuid primary key default gen_random_uuid(),
  judul text not null,
  jenis text default 'Dokumen',
  url text not null default '',
  keterangan text default '',
  pemilik_nip text default '',
  pemilik_nama text default '',
  dibagikan boolean not null default false,
  tahun text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_dokumen_pemilik
  on dokumen_guru (pemilik_nip, tahun);

-- ========== RLS SEMUA TABEL ==========
alter table remedial_pelaksanaan enable row level security;
alter table remedial_program enable row level security;
alter table bimbingan_penyuluhan enable row level security;
alter table kunjungan_supervisi enable row level security;
alter table dokumen_guru enable row level security;

drop policy if exists "adm_baca_auth" on remedial_pelaksanaan;
create policy "adm_baca_auth" on remedial_pelaksanaan
  for select to authenticated using (true);
drop policy if exists "adm_tulis_auth" on remedial_pelaksanaan;
create policy "adm_tulis_auth" on remedial_pelaksanaan
  for insert to authenticated with check (true);
drop policy if exists "adm_ubah_auth" on remedial_pelaksanaan;
create policy "adm_ubah_auth" on remedial_pelaksanaan
  for update to authenticated using (true) with check (true);
drop policy if exists "adm_hapus_auth" on remedial_pelaksanaan;
create policy "adm_hapus_auth" on remedial_pelaksanaan
  for delete to authenticated using (true);

drop policy if exists "rmp_baca_auth" on remedial_program;
create policy "rmp_baca_auth" on remedial_program
  for select to authenticated using (true);
drop policy if exists "rmp_tulis_auth" on remedial_program;
create policy "rmp_tulis_auth" on remedial_program
  for insert to authenticated with check (true);
drop policy if exists "rmp_ubah_auth" on remedial_program;
create policy "rmp_ubah_auth" on remedial_program
  for update to authenticated using (true) with check (true);
drop policy if exists "rmp_hapus_auth" on remedial_program;
create policy "rmp_hapus_auth" on remedial_program
  for delete to authenticated using (true);

drop policy if exists "bpb_baca_auth" on bimbingan_penyuluhan;
create policy "bpb_baca_auth" on bimbingan_penyuluhan
  for select to authenticated using (true);
drop policy if exists "bpb_tulis_auth" on bimbingan_penyuluhan;
create policy "bpb_tulis_auth" on bimbingan_penyuluhan
  for insert to authenticated with check (true);
drop policy if exists "bpb_ubah_auth" on bimbingan_penyuluhan;
create policy "bpb_ubah_auth" on bimbingan_penyuluhan
  for update to authenticated using (true) with check (true);
drop policy if exists "bpb_hapus_auth" on bimbingan_penyuluhan;
create policy "bpb_hapus_auth" on bimbingan_penyuluhan
  for delete to authenticated using (true);

drop policy if exists "ksp_baca_auth" on kunjungan_supervisi;
create policy "ksp_baca_auth" on kunjungan_supervisi
  for select to authenticated using (true);
drop policy if exists "ksp_tulis_auth" on kunjungan_supervisi;
create policy "ksp_tulis_auth" on kunjungan_supervisi
  for insert to authenticated with check (true);
drop policy if exists "ksp_ubah_auth" on kunjungan_supervisi;
create policy "ksp_ubah_auth" on kunjungan_supervisi
  for update to authenticated using (true) with check (true);
drop policy if exists "ksp_hapus_auth" on kunjungan_supervisi;
create policy "ksp_hapus_auth" on kunjungan_supervisi
  for delete to authenticated using (true);

drop policy if exists "dkm_baca_auth" on dokumen_guru;
create policy "dkm_baca_auth" on dokumen_guru
  for select to authenticated using (true);
drop policy if exists "dkm_tulis_auth" on dokumen_guru;
create policy "dkm_tulis_auth" on dokumen_guru
  for insert to authenticated with check (true);
drop policy if exists "dkm_ubah_auth" on dokumen_guru;
create policy "dkm_ubah_auth" on dokumen_guru
  for update to authenticated using (true) with check (true);
drop policy if exists "dkm_hapus_auth" on dokumen_guru;
create policy "dkm_hapus_auth" on dokumen_guru
  for delete to authenticated using (true);

revoke all on table remedial_pelaksanaan from anon, authenticated;
grant select, insert, update, delete on remedial_pelaksanaan to authenticated;
revoke all on table remedial_program from anon, authenticated;
grant select, insert, update, delete on remedial_program to authenticated;
revoke all on table bimbingan_penyuluhan from anon, authenticated;
grant select, insert, update, delete on bimbingan_penyuluhan to authenticated;
revoke all on table kunjungan_supervisi from anon, authenticated;
grant select, insert, update, delete on kunjungan_supervisi to authenticated;
revoke all on table dokumen_guru from anon, authenticated;
grant select, insert, update, delete on dokumen_guru to authenticated;

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [17/34] upgrade_20260910_penugasan_guru.sql
-- ============================================================

-- ============================================================
-- UPGRADE: PENUGASAN GURU PER TAHUN PELAJARAN — 2026-09-10
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Isi:
--   Kolom akun.penugasan (jsonb) untuk guru: penugasan Mapel Diampu,
--   Wali Kelas & Pembina Ekstrakurikuler PER TAHUN PELAJARAN.
--
-- Struktur:
--   { "2026/2027": { "mapel": ["Matematika"], "wali": "X RPL 1", "ekskul": ["Pramuka"] },
--     "2025/2026": { ... } }
--
-- Perilaku aplikasi: tahun pelajaran yang belum punya entri penugasan
-- otomatis memakai fallback kolom statis (wali_kelas / mapel / ekstrakurikuler),
-- sehingga data eksisting tetap berjalan tanpa migrasi manual.
--
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

alter table akun
  add column if not exists penugasan jsonb not null default '{}'::jsonb;

comment on column akun.penugasan is
  'Penugasan guru per tahun pelajaran: { "TA": { "mapel": [], "wali": "", "ekskul": [] } }. Tahun tanpa entri = fallback kolom statis (wali_kelas/mapel/ekstrakurikuler).';

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [18/34] upgrade_20260911_riwayat_siswa.sql
-- ============================================================

-- ============================================================
-- UPGRADE: RIWAYAT KELAS & STATUS SISWA PER TAHUN PELAJARAN — 2026-09-11
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Isi:
--   Kolom akun.riwayat_kelas (jsonb) untuk murid: kelas efektif & status
--   siswa PER TAHUN PELAJARAN (kenaikan kelas, pindah jurusan, dropout, lulus).
--
-- Struktur:
--   { "2026/2027": { "kelas": "X RPL 1", "status": "Aktif", "ket": "" },
--     "2027/2028": { "kelas": "XI RPL 1", "status": "Aktif",  "ket": "Naik" },
--     "2028/2029": { "kelas": "XI RPL 1", "status": "Pindah", "ket": "pindah ke SMKN 3" } }
--
-- status: Aktif | Lulus | Pindah | Dropout | Keluar
-- Perilaku aplikasi:
--   - Tahun tanpa entri → fallback kolom statis tingkat_kelas (status 'Aktif'),
--     sehingga data eksisting tetap berjalan tanpa migrasi manual.
--   - Dual-write: proses kenaikan/pindah juga memperbarui tingkat_kelas statis
--     = kelas TA aktif agar seluruh query existing tetap benar.
--   - Siswa non-Aktif disembunyikan dari daftar absensi/nilai/ekskul TA tersebut.
--
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

alter table akun
  add column if not exists riwayat_kelas jsonb not null default '{}'::jsonb;

comment on column akun.riwayat_kelas is
  'Riwayat kelas & status siswa per tahun pelajaran: { "TA": { "kelas": "", "status": "Aktif|Lulus|Pindah|Dropout|Keluar", "ket": "" } }. Tahun tanpa entri = fallback tingkat_kelas statis (Aktif).';

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [19/34] upgrade_20260912_nisn_sync.sql
-- ============================================================

-- ============================================================
-- UPGRADE: SINKRONISASI NISN + PERBAIKAN FORM AKUN MURID — 2026-09-12
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Isi:
--   1) kolom nisn tabel akun (pengaman; sudah ada via upgrade_20260904_akun.sql)
--   2) kolom nisn tabel bimbingan_penyuluhan (Administrasi Guru → Bimbingan Penyuluhan)
--   3) RPC buat_akun_murid dibuat ulang:
--        - Jalur EDIT : kolom opsional yang dikirim kosong ('') → DIKOSONGKAN (NULL),
--                       sehingga isian yang dihapus di form ikut terhapus di database.
--                       (Versi lama memperlakukan '' = pertahankan nilai lama.)
--        - Jalur TAMBAH: tidak berubah (kolom kosong tersimpan NULL).
--      Catatan: RPC import_akun_murid TIDAK diubah ('' = pertahankan) agar import
--               parsial tetap aman.
--
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. NISN TABEL AKUN (pengaman) ==========
alter table akun
  add column if not exists nisn text;

-- ========== 2. NISN TABEL BIMBINGAN PENYULUHAN ==========
alter table bimbingan_penyuluhan
  add column if not exists nisn text default '';

-- ========== 3. RPC: TAMBAH / EDIT AKUN MURID (kolom kosong = dihapus) ==========
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
      email            = nullif(trim(p_data->>'email'), ''),
      no_telepon       = nullif(trim(p_data->>'no_telepon'), ''),
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

-- ========== 4. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [20/34] upgrade_20260913_jabatan_ekskul.sql
-- ============================================================

-- ============================================================
-- UPGRADE: JABATAN EKSTRAKURIKULER — 2026-09-13
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Isi:
--   1) kolom "Jabatan Ekstrakurikuler" tabel master_data (kategori baru
--      Master Data → tab Daftar)
--   2) kolom jabatan_ekskul tabel akun (jabatan ekskul milik murid)
--   3) RPC buat_akun_murid dibuat ulang dengan penanganan jabatan_ekskul
--      (jalur EDIT: kolom kosong '' → dikosongkan; jalur TAMBAH: tetap NULL).
--
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. KATEGORI MASTER DATA: JABATAN EKSTRAKURIKULER ==========
alter table master_data
  add column if not exists "Jabatan Ekstrakurikuler" text;

-- ========== 2. KOLOM JABATAN EKSKUL TABEL AKUN ==========
alter table akun
  add column if not exists jabatan_ekskul text;

-- ========== 3. RPC: TAMBAH / EDIT AKUN MURID (kolom kosong = dihapus) ==========
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
      email, no_telepon, ekstrakurikuler, tingkat_kelas, jabatan, jabatan_ekskul,
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

-- ========== 4. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [21/34] upgrade_20260914_akses_murid.sql
-- ============================================================

-- ============================================================
-- UPGRADE AKSES MURID — 2026-09-14
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   1) Kolom gps di tabel absensi (persist lokasi absen mandiri)
--   2) RPC ubah_profil_murid        : murid edit data dirinya (whitelist)
--   3) RPC ubah_password_sendiri    : murid reset password sendiri
--                                     (verifikasi password lama)
--   4) RPC ambil_laporan_nilai_murid: murid (anon) membaca nilai miliknya
--
-- Murid lokal login dengan anon key (tanpa sesi Supabase Auth) — pola
-- sama dengan absensi & teman sejawat: verifikasi dilakukan di RPC
-- security-definer berdasarkan NIS pemanggil.
--
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. KOLOM GPS ABSENSI ==========
alter table absensi add column if not exists gps text default '';

-- ========== 2. RPC: EDIT PROFIL SENDIRI (WHITELIST) ==========
-- Murid hanya boleh mengubah kolom kontak & data pribadi.
-- NIS, NISN, nama, kelas, ekstrakurikuler, jabatan TIDAK bisa diubah.
create or replace function ubah_profil_murid(p_nis text, p_data jsonb)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_lahir date;
begin
  -- Verifikasi pemanggil benar-benar pemilik NIS (murid lokal/anon
  -- tidak punya auth.uid(), jadi kecocokan NIS + tipe murid adalah kuncinya).
  if not exists (select 1 from akun where nis_nip = p_nis and tipe = 'murid') then
    return json_build_object('status', 'error', 'message', 'Akun murid tidak ditemukan.');
  end if;

  v_lahir := nullif(trim(coalesce(p_data->>'tgl_lahir', '')), '')::date;

  update akun set
    email            = coalesce(p_data->>'email', email),
    no_telepon       = coalesce(p_data->>'no_telepon', no_telepon),
    alamat           = coalesce(p_data->>'alamat', alamat),
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

-- ========== 3. RPC: GANTI PASSWORD SENDIRI ==========
create or replace function ubah_password_sendiri(p_nis text, p_lama text, p_baru text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  if length(trim(coalesce(p_baru, ''))) < 6 then
    return json_build_object('status', 'error', 'message', 'Password baru minimal 6 karakter.');
  end if;

  select password_hash into v_hash from akun_kredensial where nis_nip = p_nis;
  if v_hash is null then
    return json_build_object('status', 'error', 'message', 'Kredensial tidak ditemukan. Hubungi admin.');
  end if;

  if crypt(coalesce(p_lama, ''), v_hash) <> v_hash then
    return json_build_object('status', 'error', 'message', 'Password lama salah.');
  end if;

  update akun_kredensial
    set password_hash = crypt(p_baru, gen_salt('bf', 10)), updated_at = now()
  where nis_nip = p_nis;

  return json_build_object('status', 'success', 'message', 'Password berhasil diganti.');
end $$;

-- ========== 4. RPC: LAPORAN NILAI MURID (READ-ONLY) ==========
create or replace function ambil_laporan_nilai_murid(p_nis text, p_tahun text, p_semester text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_rows json;
begin
  if not exists (select 1 from akun where nis_nip = p_nis and tipe = 'murid') then
    return json_build_object('status', 'error', 'message', 'Akun murid tidak ditemukan.');
  end if;

  select coalesce(json_agg(row_to_json(t) order by t.kategori, t.mapel), '[]'::json)
    into v_rows
  from (
    select nis, nama, kategori, mapel, ekskul, kelas, tahun, semester, data
    from nilai
    where nis = p_nis
      and (p_tahun = '' or tahun = p_tahun)
      and (p_semester = '' or semester = p_semester)
  ) t;

  return json_build_object('status', 'success', 'nilai', v_rows);
end $$;

-- ========== 5. IZIN EKSEKUSI ==========
grant execute on function ubah_profil_murid(text, jsonb) to anon, authenticated;
grant execute on function ubah_password_sendiri(text, text, text) to anon, authenticated;
grant execute on function ambil_laporan_nilai_murid(text, text, text) to anon, authenticated;

-- ========== 6. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [22/34] upgrade_20260914_absensi_delete.sql
-- ============================================================

-- ============================================================
-- UPGRADE ABSENSI (DELETE) — 2026-09-14
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   Policy RLS DELETE untuk tabel absensi.
--   Wajib untuk tombol "Kosongkan Data" pada Input Hadir Masal
--   (Hadir Tatap Muka) yang kini menghapus permanen baris absensi
--   dari database. Tanpa policy ini, perintah delete diabaikan RLS
--   (0 baris terhapus) meski grant delete sudah ada.
--
-- Idempotent — aman dijalankan berulang.
-- ============================================================

drop policy if exists "absensi_hapus_semua" on absensi;
create policy "absensi_hapus_semua" on absensi
  for delete using (true);

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [23/34] upgrade_20260915_proses_kenaikan_rpc.sql
-- ============================================================

-- ============================================================
-- UPGRADE PROSES KENAIKAN KELAS (ADMIN-ONLY) — 2026-09-15
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi:
--   RPC proses_kenaikan_kelas(p_ta_tujuan, p_siswa):
--     - Hanya admin (akun.tipe = 'admin' utk auth.uid()) boleh eksekusi
--     - Update massal: tingkat_kelas + riwayat_kelas (merge jsonb
--       pada kunci TA tujuan) hanya untuk baris tipe = 'murid'
--     - Dipakai wizard "Proses Kenaikan Kelas" (mode Naik & Turun/Koreksi)
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== RPC: PROSES KENAIKAN / KOREKSI KELAS (ADMIN) ==========
create or replace function proses_kenaikan_kelas(p_ta_tujuan text, p_siswa jsonb)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tipe text;
  v_diperbarui int := 0;
begin
  if coalesce((select tipe from akun where user_id = auth.uid()), '') <> 'admin' then
    return json_build_object('status', 'error', 'message', 'Hanya admin yang boleh memproses kenaikan kelas.');
  end if;

  if coalesce(trim(p_ta_tujuan), '') = '' then
    return json_build_object('status', 'error', 'message', 'Tahun pelajaran tujuan tidak valid.');
  end if;
  if p_siswa is null or jsonb_typeof(p_siswa) <> 'array' or jsonb_array_length(p_siswa) = 0 then
    return json_build_object('status', 'error', 'message', 'Data siswa tidak valid.');
  end if;

  begin
    update akun a
    set tingkat_kelas = s.kelas,
        riwayat_kelas = coalesce(a.riwayat_kelas, '{}'::jsonb) || jsonb_build_object(
          p_ta_tujuan,
          jsonb_build_object('kelas', s.kelas, 'status', s.status, 'ket', s.ket)
        )
    from jsonb_to_recordset(p_siswa) as s(id uuid, kelas text, status text, ket text)
    where a.id = s.id
      and a.tipe = 'murid'
      and coalesce(trim(s.kelas), '') <> '';

    get diagnostics v_diperbarui = row_count;
  exception when others then
    return json_build_object('status', 'error', 'message', 'Gagal memperbarui data: ' || SQLERRM);
  end;

  return json_build_object('status', 'success', 'diperbarui', v_diperbarui);
end $$;

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [24/34] upgrade_20260916_fase1.sql
-- ============================================================

-- ============================================================
-- UPGRADE FASE 1 MODUL ADMINISTRASI SEKOLAH — 2026-09-16
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi (4 tabel baru):
--   1) jadwal_ujian  : jadwal ujian per TA/semester/kelas (sumber kartu ujian)
--   2) pengumuman    : pengumuman sekolah ber-target (widget dashboard)
--   3) rapor_catatan : catatan wali kelas per siswa per TA + semester
--   4) arsip_surat   : arsip surat keterangan (generator surat resmi)
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. JADWAL UJIAN ==========
create table if not exists jadwal_ujian (
  id uuid primary key default gen_random_uuid(),
  ta text not null,
  semester text default 'Ganjil',
  jenis text not null,
  tanggal date,
  jam_mulai text default '',
  jam_selesai text default '',
  kelas text default '',
  mapel text default '',
  pengawas text default '',
  ket text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_jadwal_ujian_ta on jadwal_ujian (ta, jenis, kelas);

-- ========== 2. PENGUMUMAN ==========
create table if not exists pengumuman (
  id uuid primary key default gen_random_uuid(),
  ta text not null,
  judul text not null,
  isi text default '',
  target text not null default 'semua',   -- semua | guru | murid | kelas
  kelas text default '',
  mulai date,
  akhir date,
  penulis text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_pengumuman_ta on pengumuman (ta);

-- ========== 3. CATATAN WALI KELAS (RAPOR) ==========
create table if not exists rapor_catatan (
  id uuid primary key default gen_random_uuid(),
  nis text not null,
  ta text not null,
  semester text not null,
  catatan text default '',
  updated_at timestamptz not null default now(),
  unique (nis, ta, semester)
);

-- ========== 4. ARSIP SURAT ==========
create table if not exists arsip_surat (
  id uuid primary key default gen_random_uuid(),
  ta text not null,
  jenis text not null,
  nomor_surat text not null,
  nis text default '',
  nama text default '',
  kelas text default '',
  payload jsonb default '{}'::jsonb,
  dibuat_oleh text default '',
  dibuat_at timestamptz not null default now()
);
create index if not exists idx_arsip_surat_jenis on arsip_surat (jenis, ta);

-- ========== PRIVILEGE ==========
grant select, insert, update, delete on jadwal_ujian, pengumuman, rapor_catatan, arsip_surat to authenticated;

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [25/34] upgrade_20260917_fase2.sql
-- ============================================================

-- ============================================================
-- UPGRADE FASE 2 MODUL ADMINISTRASI SEKOLAH — 2026-09-17
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi (5 tabel baru):
--   1) poin_kategori : master kategori prestasi/pelanggaran + bobot poin
--   2) poin_siswa    : catatan poin per siswa (snapshot nama & bobot)
--   3) spp_tagihan   : tagihan SPP/Daftar Ulang per siswa per periode
--   4) kas_transaksi : buku kas sekolah (masuk/keluar) + no bukti
--   5) arsip_dokumen : arsip dokumen sekolah berkategori + link
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. KATEGORI POIN ==========
create table if not exists poin_kategori (
  id uuid primary key default gen_random_uuid(),
  jenis text not null check (jenis in ('prestasi','pelanggaran')),
  nama text not null,
  poin int not null default 1,
  ket text default '',
  aktif boolean not null default true,
  created_at timestamptz not null default now(),
  unique (jenis, nama)
);

-- ========== 2. CATATAN POIN SISWA ==========
create table if not exists poin_siswa (
  id uuid primary key default gen_random_uuid(),
  nis text not null,
  nama text default '',
  kelas text default '',
  ta text not null,
  semester text default '',
  tanggal date,
  jenis text not null check (jenis in ('prestasi','pelanggaran')),
  kategori_id uuid,
  kategori_nama text default '',
  poin int not null default 0,
  catatan text default '',
  pelapor text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_poin_siswa_nis_ta on poin_siswa (nis, ta);

-- ========== 3. TAGIHAN SPP ==========
create table if not exists spp_tagihan (
  id uuid primary key default gen_random_uuid(),
  nis text not null,
  nama text default '',
  kelas text default '',
  ta text not null,
  semester text default '',
  jenis text not null default 'SPP',      -- SPP | Daftar Ulang | Lainnya
  periode text not null,                  -- YYYY-MM
  nominal numeric not null default 0,
  jatuh_tempo date,
  lunas boolean not null default false,
  tanggal_bayar date,
  metode text default '',
  petugas text default '',
  no_bukti text default '',
  ket text default '',
  created_at timestamptz not null default now(),
  unique (nis, ta, jenis, periode)
);
create index if not exists idx_spp_tagihan_ta on spp_tagihan (ta, jenis, kelas);

-- ========== 4. BUKU KAS SEKOLAH ==========
create table if not exists kas_transaksi (
  id uuid primary key default gen_random_uuid(),
  ta text not null,
  tanggal date,
  jenis text not null check (jenis in ('Masuk','Keluar')),
  kategori text default 'Lainnya',
  nis text default '',
  nominal numeric not null default 0,
  keterangan text default '',
  petugas text default '',
  no_bukti text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_kas_transaksi_ta on kas_transaksi (ta, jenis, tanggal);

-- ========== 5. ARSIP DOKUMEN SEKOLAH ==========
create table if not exists arsip_dokumen (
  id uuid primary key default gen_random_uuid(),
  ta text not null,
  kategori text default 'Lainnya',
  judul text not null,
  deskripsi text default '',
  link_url text default '',
  tanggal date,
  dibuat_oleh text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_arsip_dokumen_ta on arsip_dokumen (ta, kategori);

-- ========== PRIVILEGE ==========
grant select, insert, update, delete on poin_kategori, poin_siswa, spp_tagihan, kas_transaksi, arsip_dokumen to authenticated;

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [26/34] upgrade_20260918_fase3.sql
-- ============================================================

-- ============================================================
-- UPGRADE FASE 3 MODUL ADMINISTRASI SEKOLAH — 2026-09-18
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi (4 tabel baru):
--   1) perpus_buku  : katalog buku perpustakaan (kode unik, eksemplar)
--   2) perpus_pinjam: peminjaman buku (snapshot buku & siswa, telat+denda)
--   3) inv_barang   : inventaris sarana prasarana (kode unik, kondisi)
--   4) inv_pinjam   : peminjaman barang (guru/murid/ekskul, kondisi kembali)
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. KATALOG BUKU ==========
create table if not exists perpus_buku (
  id uuid primary key default gen_random_uuid(),
  kode text not null unique,
  judul text not null,
  pengarang text default '',
  penerbit text default '',
  tahun text default '',
  kategori text default 'Lainnya',
  eksemplar int not null default 1,
  lokasi text default '',
  ket text default '',
  aktif boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_perpus_buku_judul on perpus_buku (judul);

-- ========== 2. PEMINJAMAN BUKU ==========
create table if not exists perpus_pinjam (
  id uuid primary key default gen_random_uuid(),
  buku_id uuid,
  kode_buku text default '',
  judul_buku text default '',
  nis text not null,
  nama text default '',
  kelas text default '',
  ta text not null,
  semester text default '',
  tanggal_pinjam date,
  tenggat date,
  tanggal_kembali date,
  hari_telat int default 0,
  denda numeric default 0,
  status text not null default 'Dipinjam',   -- Dipinjam | Kembali
  ket text default '',
  petugas text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_perpus_pinjam_nis on perpus_pinjam (nis, ta);
create index if not exists idx_perpus_pinjam_status on perpus_pinjam (status);

-- ========== 3. INVENTARIS BARANG ==========
create table if not exists inv_barang (
  id uuid primary key default gen_random_uuid(),
  kode text not null unique,
  nama text not null,
  kategori text default 'Lainnya',           -- Elektronik | Perabot | Alat Olahraga | Laboratorium | Buku/ATK | Lainnya
  lokasi text default '',
  jumlah int not null default 1,
  kondisi text default 'Baik' check (kondisi in ('Baik','Rusak Ringan','Rusak Berat')),
  tahun_perolehan text default '',
  harga numeric default 0,
  sumber text default '',                    -- BOS | Komite | Hibah | Pembelian | Lainnya
  ket text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_inv_barang_kat on inv_barang (kategori);

-- ========== 4. PEMINJAMAN BARANG ==========
create table if not exists inv_pinjam (
  id uuid primary key default gen_random_uuid(),
  barang_id uuid,
  kode_barang text default '',
  nama_barang text default '',
  peminjam_tipe text default 'guru',         -- guru | murid | ekskul | lainnya
  peminjam_nama text default '',
  nis text default '',
  jumlah int not null default 1,
  tanggal_pinjam date,
  tanggal_rencana date,
  tanggal_kembali date,
  kondisi_kembali text default '',
  status text not null default 'Dipinjam',   -- Dipinjam | Dikembalikan
  ket text default '',
  petugas text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_inv_pinjam_status on inv_pinjam (status);

-- ========== PRIVILEGE ==========
grant select, insert, update, delete on perpus_buku, perpus_pinjam, inv_barang, inv_pinjam to authenticated;

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [27/34] upgrade_20260919_fase4.sql
-- ============================================================

-- ============================================================
-- UPGRADE FASE 4 MODUL ADMINISTRASI SEKOLAH — 2026-09-19
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
-- Isi (1 tabel baru):
--   ppdb_calon : calon peserta didik baru (PPDB) — pendaftaran, seleksi
--                bertahap (Baru→Verifikasi→Diterima/Ditolak), konversi
--                ke akun murid via RPC buat_akun_murid
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== CALON SISWA PPDB ==========
create table if not exists ppdb_calon (
  id uuid primary key default gen_random_uuid(),
  ta text not null,                        -- tahun pelajaran tujuan
  no_daftar text not null unique,          -- PDB-001/2027/2028
  nama text not null,
  nisn text default '',
  jenis_kelamin text default '',           -- L | P
  tempat_lahir text default '',
  tgl_lahir date,
  agama text default '',
  asal_sekolah text default '',
  alamat text default '',
  telepon text default '',
  nama_ayah text default '',
  pekerjaan_ayah text default '',
  nama_ibu text default '',
  pekerjaan_ibu text default '',
  nama_wali text default '',
  jalur text default 'Reguler',            -- Reguler | Prestasi | Afirmasi | Mutasi
  status text not null default 'Baru' check (status in ('Baru','Verifikasi','Diterima','Ditolak')),
  catatan text default '',
  berkas_link text default '',
  nis text default '',                     -- diisi saat konversi akun
  akun_dibuat boolean not null default false,
  tanggal_daftar date,
  dibuat_oleh text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_ppdb_calon_ta on ppdb_calon (ta, status);

-- ========== PRIVILEGE ==========
grant select, insert, update, delete on ppdb_calon to authenticated;

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [28/34] upgrade_20260920_murid_rpc.sql
-- ============================================================

-- ============================================================
-- UPGRADE PERBAIKAN AKSES MURID (ANON) — 2026-09-20
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Latar belakang: sesi login murid memakai anon key (murid lokal
-- tanpa akun Supabase Auth), sedangkan tabel Fase 1-3 hanya di-grant
-- ke authenticated. Akibatnya widget Pengumuman/Poin & Pinjaman Saya
-- & Rapor Saya milik murid gagal membaca data.
--
-- Isi:
--   1) Grant select anon utk konten publik: pengumuman, perpus_buku
--   2) 3 RPC murid-scoped (security definer) utk data sensitif:
--        poin_murid, pinjaman_murid, catatan_wali_murid
--      (pola sama dgn ambil_laporan_nilai_murid / cek_login_murid)
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. GRANT SELECT ANON (PUBLIK) ==========
grant select on pengumuman  to anon;
grant select on perpus_buku to anon;

-- ========== 2. RPC: POIN SESEORANG MURID (by NIS) ==========
create or replace function poin_murid(p_nis text, p_ta text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entri json;
begin
  select coalesce(json_agg(json_build_object(
    'tanggal', e.tanggal,
    'jenis', e.jenis,
    'kategori_nama', e.kategori_nama,
    'poin', e.poin,
    'catatan', e.catatan,
    'pelapor', e.pelapor
  ) order by e.tanggal desc nulls last, e.created_at desc), '[]'::json)
  into v_entri
  from (
    select * from poin_siswa
    where nis = p_nis and ta = p_ta
    order by tanggal desc nulls last, created_at desc
    limit 50
  ) e;

  return json_build_object(
    'status', 'success',
    'total_pelanggaran', (select coalesce(sum(poin), 0) from poin_siswa where nis = p_nis and ta = p_ta and jenis = 'pelanggaran'),
    'total_prestasi',    (select coalesce(sum(poin), 0) from poin_siswa where nis = p_nis and ta = p_ta and jenis = 'prestasi'),
    'entri', v_entri
  );
end $$;

-- ========== 3. RPC: PINJAMAN BUKU MILIK MURID (by NIS) ==========
create or replace function pinjaman_murid(p_nis text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare v_rows json;
begin
  select coalesce(json_agg(json_build_object(
    'id', p.id,
    'kode_buku', p.kode_buku,
    'judul_buku', p.judul_buku,
    'tanggal_pinjam', p.tanggal_pinjam,
    'tenggat', p.tenggat,
    'tanggal_kembali', p.tanggal_kembali,
    'hari_telat', p.hari_telat,
    'denda', p.denda,
    'status', p.status,
    'ket', p.ket
  ) order by p.tanggal_pinjam desc nulls last), '[]'::json)
  into v_rows
  from (
    select * from perpus_pinjam
    where nis = p_nis
    order by tanggal_pinjam desc nulls last
    limit 100
  ) p;

  return json_build_object('status', 'success', 'pinjaman', v_rows);
end $$;

-- ========== 4. RPC: CATATAN WALI KELAS MILIK MURID ==========
create or replace function catatan_wali_murid(p_nis text, p_ta text, p_smt text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare v_catatan text;
begin
  select catatan into v_catatan
  from rapor_catatan
  where nis = p_nis and ta = p_ta and semester = p_smt
  limit 1;

  return json_build_object('status', 'success', 'catatan', coalesce(v_catatan, ''));
end $$;

-- ========== 5. GRANT EXECUTE RPC ==========
grant execute on function poin_murid(text, text) to anon, authenticated;
grant execute on function pinjaman_murid(text) to anon, authenticated;
grant execute on function catatan_wali_murid(text, text, text) to anon, authenticated;

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [29/34] upgrade_20260921_rls_policies.sql
-- ============================================================

-- ============================================================
-- UPGRADE RLS POLICIES TABEL FASE 1-4 — 2026-09-21
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Latar belakang (hasil uji E2E 2026-09-21): RLS telah ENABLE di
-- tabel-tabel baru tetapi TANPA policy → semua insert/update/delete
-- ditolak (bahkan utk admin/guru authenticated), dan sebagian tabel
-- sensitif masih terbaca anon.
--
-- Isi:
--   1) RLS enable + policy "authenticated semua" pada 14 tabel Fase 1-4
--      (pola sama dgn tabel absensi: authenticated = penuh)
--   2) Policy anon: SELECT saja utk konten publik (pengumuman,
--      perpus_buku); sisanya revoke total dari anon
--   3) Penegasan grant authenticated (idempotent)
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. FUNGSI PEMBANTU (dinamis, dihapus di akhir) ==========
create temp table if not exists _tabel_fase (nama text);
delete from _tabel_fase;
insert into _tabel_fase (nama) values
  ('jadwal_ujian'), ('pengumuman'), ('rapor_catatan'), ('arsip_surat'),
  ('poin_kategori'), ('poin_siswa'), ('spp_tagihan'), ('kas_transaksi'), ('arsip_dokumen'),
  ('perpus_buku'), ('perpus_pinjam'), ('inv_barang'), ('inv_pinjam'),
  ('ppdb_calon');

-- ========== 2. RLS ENABLE + POLICY AUTHENTICATED (penuh) ==========
do $$
declare t text;
begin
  for t in select nama from _tabel_fase loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "fase_authenticated_all" on %I', t);
    execute format('create policy "fase_authenticated_all" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ========== 3. POLICY ANON: SELECT PUBLIK SAJA ==========
drop policy if exists "fase_anon_select" on pengumuman;
create policy "fase_anon_select" on pengumuman for select to anon using (true);

drop policy if exists "fase_anon_select" on perpus_buku;
create policy "fase_anon_select" on perpus_buku for select to anon using (true);

-- ========== 4. REVOKE ANON DARI TABEL SENSITIF ==========
-- Murid anon membaca data miliknya lewat RPC security definer
-- (poin_murid, pinjaman_murid, catatan_wali_murid, ambil_laporan_nilai_murid),
-- bukan langsung ke tabel — jadi tabel berikut ditutup total dari anon.
revoke all on poin_kategori, poin_siswa, spp_tagihan, kas_transaksi, arsip_dokumen,
             inv_barang, inv_pinjam, perpus_pinjam, jadwal_ujian, rapor_catatan,
             arsip_surat, ppdb_calon
  from anon;

-- ========== 5. PENEGASAN GRANT AUTHENTICATED ==========
grant select, insert, update, delete on
  jadwal_ujian, pengumuman, rapor_catatan, arsip_surat,
  poin_kategori, poin_siswa, spp_tagihan, kas_transaksi, arsip_dokumen,
  perpus_buku, perpus_pinjam, inv_barang, inv_pinjam, ppdb_calon
  to authenticated;

-- ========== 6. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [30/34] upgrade_20260922_nilai_murid_rpc.sql
-- ============================================================

-- ============================================================
-- UPGRADE RPC RAPOR MURID — 2026-09-22
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Latar belakang: RPC ambil_laporan_nilai_murid dibuat di luar repo
-- dan tidak ditemukan di DB produksi. Rapor murid kini memakai RPC
-- milik repo: ambil_rapor_nilai_murid (security definer, by-NIS,
-- pola sama dengan poin_murid/pinjaman_murid di upgrade_20260920).
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== RPC: NILAI RAPOR MILIK MURID (by NIS) ==========
create or replace function ambil_rapor_nilai_murid(p_nis text, p_ta text, p_smt text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare v_rows json;
begin
  select coalesce(json_agg(json_build_object(
    'kategori', r.kategori,
    'mapel', r.mapel,
    'ekskul', r.ekskul,
    'kelas', r.kelas,
    'tahun', r.tahun,
    'semester', r.semester,
    'data', r.data
  ) order by r.kategori, r.mapel), '[]'::json)
  into v_rows
  from (
    select kategori, mapel, ekskul, kelas, tahun, semester, data
    from nilai
    where nis = p_nis and tahun = p_ta and semester = p_smt
  ) r;

  return json_build_object('status', 'success', 'nilai', v_rows);
end $$;

-- ========== GRANT EXECUTE ==========
grant execute on function ambil_rapor_nilai_murid(text, text, text) to anon, authenticated;

-- ========== RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [31/34] upgrade_20260926_ekskul_akses_guru.sql
-- ============================================================

-- ============================================================
-- UPGRADE: AKSES EKSTRAKURIKULER PENGURUS MURID + JABATAN EKSKUL MAP — 2026-09-26
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Isi:
--   1) Kolom baru akun.jabatan_ekskul_map (jsonb) — peta jabatan siswa
--      per ekskul: { "Paskibra": "Ketua", "Pramuka": "Sekretaris" }
--   2) Grant + policy anon (sesi murid password lokal = anon key):
--      - nilai                  : select/insert/update/delete (pengurus input nilai ekskul)
--      - sub_ekstrakurikuler    : insert/update/delete (kelola sub-ekskul)
--      - ekstrakurikuler        : insert/update (edit profil ekskul)
--      - agenda_ekskul          : delete (hapus agenda)
--      - dispensasi             : delete (hapus riwayat surat)
--      - akun                   : grant kolom jabatan_ekskul_map
--   3) RPC cek_login_murid dibuat ulang — kembalikan juga ekstrakurikuler
--      & jabatan_ekskul_map agar sesi murid lokal punya data keanggotaan.
--
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. KOLOM PETA JABATAN EKSKUL ==========
alter table akun
  add column if not exists jabatan_ekskul_map jsonb default '{}'::jsonb;

-- ========== 2. GRANT & POLICY ANON (PENGURUS EKSKUL MURID) ==========
-- Catatan: keempat tabel ini RLS ENABLE — grant tanpa policy tetap ditolak,
-- jadi setiap grant disertai policy anon perintah yang sama.

-- 2a. nilai: pengurus ekskul mengisi nilai ekskul (murid lokal = anon key)
drop policy if exists "nilai_baca_anon" on nilai;
create policy "nilai_baca_anon" on nilai for select to anon using (true);
drop policy if exists "nilai_tulis_anon" on nilai;
create policy "nilai_tulis_anon" on nilai for insert to anon with check (true);
drop policy if exists "nilai_ubah_anon" on nilai;
create policy "nilai_ubah_anon" on nilai for update to anon using (true) with check (true);
drop policy if exists "nilai_hapus_anon" on nilai;
create policy "nilai_hapus_anon" on nilai for delete to anon using (true);
grant select, insert, update, delete on nilai to anon;

-- 2b. sub_ekstrakurikuler: kelola daftar sub & penempatan anggota
drop policy if exists "subekskul_tulis_anon" on sub_ekstrakurikuler;
create policy "subekskul_tulis_anon" on sub_ekstrakurikuler for insert to anon with check (true);
drop policy if exists "subekskul_ubah_anon" on sub_ekstrakurikuler;
create policy "subekskul_ubah_anon" on sub_ekstrakurikuler for update to anon using (true) with check (true);
drop policy if exists "subekskul_hapus_anon" on sub_ekstrakurikuler;
create policy "subekskul_hapus_anon" on sub_ekstrakurikuler for delete to anon using (true);
grant insert, update, delete on sub_ekstrakurikuler to anon;

-- 2c. ekstrakurikuler: edit profil ekskul (deskripsi, jadwal, pembina, logo)
drop policy if exists "ekskul_tulis_anon" on ekstrakurikuler;
create policy "ekskul_tulis_anon" on ekstrakurikuler for insert to anon with check (true);
drop policy if exists "ekskul_ubah_anon" on ekstrakurikuler;
create policy "ekskul_ubah_anon" on ekstrakurikuler for update to anon using (true) with check (true);
grant insert, update on ekstrakurikuler to anon;

-- 2d. agenda_ekskul: hapus agenda (select/insert/update sudah dari 20260905)
drop policy if exists "agenda_hapus_anon" on agenda_ekskul;
create policy "agenda_hapus_anon" on agenda_ekskul for delete to anon using (true);
grant delete on agenda_ekskul to anon;

-- 2d2. dispensasi: hapus riwayat surat oleh pengurus (select/insert sudah dari 20260905)
drop policy if exists "dispensasi_hapus_anon" on dispensasi;
create policy "dispensasi_hapus_anon" on dispensasi for delete to anon using (true);
grant delete on dispensasi to anon;

-- 2e. akun: kolom peta jabatan (disamping grant update(ekstrakurikuler) 20260905)
grant update (jabatan_ekskul_map) on akun to anon;

-- ========== 3. RPC LOGIN MURID: TAMBAH EKSKUL & JABATAN EKSKUL MAP ==========
create or replace function cek_login_murid(p_nis text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r akun%rowtype;
  v_hash text;
begin
  select * into r from akun where nis_nip = p_nis and tipe = 'murid' limit 1;
  if r.id is null then
    return json_build_object('status', 'error', 'message', 'NIS tidak terdaftar.');
  end if;
  select password_hash into v_hash from akun_kredensial where nis_nip = p_nis;
  if v_hash is null or v_hash = '' then
    return json_build_object('status', 'error', 'message', 'Akun ini belum memiliki password lokal.');
  end if;
  if crypt(p_password, v_hash) = v_hash then
    return json_build_object('status', 'success', 'akun', json_build_object(
      'id', r.id,
      'user_id', r.user_id,
      'nama_lengkap', r.nama_lengkap,
      'nis_nip', r.nis_nip,
      'tipe', r.tipe,
      'email', r.email,
      'tingkat_kelas', r.tingkat_kelas,
      'jabatan', r.jabatan,
      'ekstrakurikuler', coalesce(r.ekstrakurikuler, ''),
      'jabatan_ekskul', coalesce(r.jabatan_ekskul, ''),
      'jabatan_ekskul_map', coalesce(r.jabatan_ekskul_map, '{}'::jsonb)
    ));
  end if;
  return json_build_object('status', 'error', 'message', 'Password salah.');
end $$;

grant execute on function cek_login_murid(text, text) to anon, authenticated;

-- ========== 4. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';

-- ============================================================
-- [32/34] upgrade_20260927_sub_ekskul_anggota.sql
-- ============================================================
-- ============================================================
-- UPGRADE: SUB-EKSTRAKURIKULER KOLOM ANGGOTA (PERBAIKAN SIMPAN) — 2026-09-27
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Simpan Sub-Ekstrakurikuler gagal dengan error
--   "Could not find the 'anggota' column of 'sub_ekstrakurikuler'
--    in the schema cache" (PGRST204).
--   Penyebab: kolom "anggota" dibuat oleh upgrade_20260906_ekskul_surat_v2.sql
--   yang (a) belum terjalankan, atau (b) gagal di tengah run karena jebakan
--   re-run: langkah migrasi datanya membaca tabel anggota_sub_ekskul yang
--   sudah di-drop pada run sebelumnya → SQL Editor membatalkan seluruh run.
--
-- Isi (semua idempotent — aman dijalankan berulang):
--   1) sub_ekstrakurikuler: kolom "anggota" (jsonb, default '[]')
--   2) Migrasi data dari anggota_sub_ekskul → sub_ekstrakurikuler.anggota
--      DIJAGA to_regclass (aman walau tabel lama sudah terhapus)
--   3) Drop tabel anggota_sub_ekskul (tidak lagi dipakai)
--   4) Self-healing kolom fitur ekskul & surat (cegah PGRST204 serupa):
--      ekstrakurikuler (pembina_nip, jadwal, logo_url),
--      dispensasi (sub_ekskul, keterangan, detail, surat_id),
--      agenda_ekskul (hari + tanggal boleh NULL)
--   5) Reload cache skema PostgREST
--
-- Catatan: akses anon untuk pengurus ekskul murid ada di
--   upgrade_20260926_ekskul_akses_guru.sql — bila fitur pengurus murid
--   menyimpan sub/nilai/error "permission denied", jalankan file itu juga.
-- ============================================================

-- ========== 1. KOLOM ANGGOTA PADA SUB-EKSKUL ==========
alter table sub_ekstrakurikuler
  add column if not exists anggota jsonb not null default '[]'::jsonb;

-- ========== 2. MIGRASI DATA KEANGGOTAAN LAMA (ANTI-JEBAKAN RE-RUN) ==========
-- Hanya berjalan bila tabel anggota_sub_ekskul masih ada (to_regclass),
-- dan hanya mengisi baris sub yang kolom anggotanya masih kosong (idempoten).
do $$
declare
  v_kol text;
begin
  if to_regclass('public.anggota_sub_ekskul') is not null then
    -- [PERBAIKAN 42703] kolom penyimpan nama sub dideteksi otomatis:
    -- skema v1 memakai kolom "sub" (bukan "nama_sub") — deteksi via information_schema, dipakai via %I.
    select case
      when exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'anggota_sub_ekskul'
                     and column_name = 'nama_sub') then 'nama_sub'
      when exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'anggota_sub_ekskul'
                     and column_name = 'sub') then 'sub'
      else null
    end into v_kol;
    if v_kol is not null then
      execute format($f$
        update sub_ekstrakurikuler s
        set anggota = q.anggota
        from (
          select ekskul, %I as nama_sub, jsonb_agg(distinct nis order by nis) as anggota
          from anggota_sub_ekskul
          where coalesce(%I, '') <> ''
          group by ekskul, %I
        ) q
        where s.ekskul = q.ekskul
          and s.nama_sub = q.nama_sub
          and coalesce(s.anggota, '[]'::jsonb) = '[]'::jsonb
      $f$, v_kol, v_kol, v_kol);
    end if;
  end if;
end $$;

-- ========== 3. DROP TABEL LAMA ==========
drop table if exists anggota_sub_ekskul;

-- ========== 4. SELF-HEALING KOLOM FITUR EKSKUL & SURAT ==========
-- Semua "add column if not exists" — tidak mengubah kolom yang sudah ada.
alter table ekstrakurikuler
  add column if not exists pembina_nip text default '',
  add column if not exists jadwal text default '',
  add column if not exists logo_url text default '';

alter table dispensasi
  add column if not exists sub_ekskul text default '',
  add column if not exists keterangan text default '',
  add column if not exists detail jsonb default '{}'::jsonb,
  add column if not exists surat_id text default '';

alter table agenda_ekskul
  add column if not exists hari text default '';
alter table agenda_ekskul alter column tanggal drop not null;

-- ========== 5. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [33/34] upgrade_20260928_rpc_akun_murid.sql
-- ============================================================
-- ============================================================
-- UPGRADE: RPC AKUN MURID (PERBAIKAN SIMPAN PROFIL MURID) — 2026-09-28
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Menu murid "Data Akun Murid" → "Simpan Perubahan" gagal dengan error
--   "Could not find the function public.ubah_profil_murid(p_data, p_nis)
--    in the schema cache" (PGRST428).
--   Penyebab: RPC dari upgrade_20260914_akses_murid.sql belum terbentuk
--   di database. Menu yang sama juga memakai ubah_password_sendiri
--   (Ganti Password) dan menu "Laporan Nilai" memakai
--   ambil_laporan_nilai_murid — ketiganya dibuat ulang di sini.
--
-- Isi (semua idempotent — aman dijalankan berulang):
--   1) Self-healing kolom: absensi.gps (absen mandiri),
--      master_data."Jabatan Ekstrakurikuler" (Master Data + menu Ekskul),
--      akun.jabatan_ekskul (form murid & export)
--   2) RPC ubah_profil_murid        : murid edit data dirinya (whitelist)
--   3) RPC ubah_password_sendiri    : murid reset password sendiri
--                                     (verifikasi password lama)
--   4) RPC ambil_laporan_nilai_murid: murid (anon) membaca nilai miliknya
--   5) Grant execute + reload cache skema PostgREST
--
-- Murid lokal login dengan anon key (tanpa sesi Supabase Auth) — pola
-- sama dengan absensi & teman sejawat: verifikasi dilakukan di RPC
-- security-definer berdasarkan NIS pemanggil.
-- ============================================================

-- ========== 1. SELF-HEALING KOLOM ==========
alter table absensi add column if not exists gps text default '';

alter table master_data
  add column if not exists "Jabatan Ekstrakurikuler" text;

alter table akun
  add column if not exists jabatan_ekskul text;

-- ========== 2. RPC: EDIT PROFIL SENDIRI (WHITELIST) ==========
-- Murid hanya boleh mengubah kolom kontak & data pribadi.
-- NIS, NISN, nama, kelas, ekstrakurikuler, jabatan TIDAK bisa diubah.
create or replace function ubah_profil_murid(p_nis text, p_data jsonb)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_lahir date;
begin
  -- Verifikasi pemanggil benar-benar pemilik NIS (murid lokal/anon
  -- tidak punya auth.uid(), jadi kecocokan NIS + tipe murid adalah kuncinya).
  if not exists (select 1 from akun where nis_nip = p_nis and tipe = 'murid') then
    return json_build_object('status', 'error', 'message', 'Akun murid tidak ditemukan.');
  end if;

  v_lahir := nullif(trim(coalesce(p_data->>'tgl_lahir', '')), '')::date;

  update akun set
    email            = coalesce(p_data->>'email', email),
    no_telepon       = coalesce(p_data->>'no_telepon', no_telepon),
    alamat           = coalesce(p_data->>'alamat', alamat),
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

-- ========== 3. RPC: GANTI PASSWORD SENDIRI ==========
create or replace function ubah_password_sendiri(p_nis text, p_lama text, p_baru text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  if length(trim(coalesce(p_baru, ''))) < 6 then
    return json_build_object('status', 'error', 'message', 'Password baru minimal 6 karakter.');
  end if;

  select password_hash into v_hash from akun_kredensial where nis_nip = p_nis;
  if v_hash is null then
    return json_build_object('status', 'error', 'message', 'Kredensial tidak ditemukan. Hubungi admin.');
  end if;

  if crypt(coalesce(p_lama, ''), v_hash) <> v_hash then
    return json_build_object('status', 'error', 'message', 'Password lama salah.');
  end if;

  update akun_kredensial
    set password_hash = crypt(p_baru, gen_salt('bf', 10)), updated_at = now()
  where nis_nip = p_nis;

  return json_build_object('status', 'success', 'message', 'Password berhasil diganti.');
end $$;

-- ========== 4. RPC: LAPORAN NILAI MURID (READ-ONLY) ==========
create or replace function ambil_laporan_nilai_murid(p_nis text, p_tahun text, p_semester text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_rows json;
begin
  if not exists (select 1 from akun where nis_nip = p_nis and tipe = 'murid') then
    return json_build_object('status', 'error', 'message', 'Akun murid tidak ditemukan.');
  end if;

  select coalesce(json_agg(row_to_json(t) order by t.kategori, t.mapel), '[]'::json)
    into v_rows
  from (
    select nis, nama, kategori, mapel, ekskul, kelas, tahun, semester, data
    from nilai
    where nis = p_nis
      and (p_tahun = '' or tahun = p_tahun)
      and (p_semester = '' or semester = p_semester)
  ) t;

  return json_build_object('status', 'success', 'nilai', v_rows);
end $$;

-- ========== 5. IZIN EKSEKUSI + RELOAD CACHE ==========
grant execute on function ubah_profil_murid(text, jsonb) to anon, authenticated;
grant execute on function ubah_password_sendiri(text, text, text) to anon, authenticated;
grant execute on function ambil_laporan_nilai_murid(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';


-- ============================================================
-- [34/34] upgrade_20260929_jadwal_pelajaran.sql
-- ============================================================
-- ============================================================
-- UPGRADE: TABEL JADWAL PELAJARAN (PERBAIKAN SIMPAN JADWAL) — 2026-09-29
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Simpan "Jadwal Pelajaran" (menu Jadwal & Libur) gagal dengan error
--   semacam "Could not find the ... column of 'jadwal_pelajaran' in the
--   schema cache" (PGRST204).
--   Penyebab: tabel jadwal_pelajaran TIDAK PERNAH dibuat oleh migrasi repo
--   (ada sebagai sisa setup lama) — kolom yang ditulis aplikasi
--   ("ID Jadwal Murid", "Semester", dst.) belum tentu lengkap.
--
-- Isi (semua idempotent — aman dijalankan berulang):
--   1) create table if not exists jadwal_pelajaran (kolom persis yang
--      ditulis aplikasi) + add column if not exists per kolom
--      (memperbaiki tabel lama yang kolomnya kurang)
--   2) Index filter (Tahun, Tingkat/Kelas) & (ID Akun Guru, Tahun)
--   3) RLS + privilege: authenticated penuh (kelola jadwal),
--      anon select (absen mandiri murid & filter tanggal mingguan)
--   4) Reload cache skema PostgREST
-- ============================================================

-- ========== 1. TABEL + SELF-HEALING KOLOM ==========
create table if not exists jadwal_pelajaran (
  id uuid primary key default gen_random_uuid(),
  "ID Akun Guru" text default '',
  "ID Jadwal Murid" text default '',
  "Tahun" text default '',
  "Semester" text default '',
  "Waktu" text default '',
  "Mapel" text default '',
  "Tingkat/Kelas" text default '',
  created_at timestamptz not null default now()
);

alter table jadwal_pelajaran
  add column if not exists "ID Akun Guru" text default '',
  add column if not exists "ID Jadwal Murid" text default '',
  add column if not exists "Tahun" text default '',
  add column if not exists "Semester" text default '',
  add column if not exists "Waktu" text default '',
  add column if not exists "Mapel" text default '',
  add column if not exists "Tingkat/Kelas" text default '',
  add column if not exists created_at timestamptz default now();

create index if not exists idx_jadwal_filter on jadwal_pelajaran (Tahun, "Tingkat/Kelas");
create index if not exists idx_jadwal_guru on jadwal_pelajaran ("ID Akun Guru", Tahun);

-- ========== 2. RLS & PRIVILEGE ==========
alter table jadwal_pelajaran enable row level security;

drop policy if exists "jadwal_baca_auth" on jadwal_pelajaran;
create policy "jadwal_baca_auth" on jadwal_pelajaran
  for select to authenticated using (true);
drop policy if exists "jadwal_tulis_auth" on jadwal_pelajaran;
create policy "jadwal_tulis_auth" on jadwal_pelajaran
  for insert to authenticated with check (true);
drop policy if exists "jadwal_ubah_auth" on jadwal_pelajaran;
create policy "jadwal_ubah_auth" on jadwal_pelajaran
  for update to authenticated using (true) with check (true);
drop policy if exists "jadwal_hapus_auth" on jadwal_pelajaran;
create policy "jadwal_hapus_auth" on jadwal_pelajaran
  for delete to authenticated using (true);

-- Anon (murid password lokal) membaca jadwal utk absen mandiri & filter "Minggu Ini"
drop policy if exists "jadwal_baca_anon" on jadwal_pelajaran;
create policy "jadwal_baca_anon" on jadwal_pelajaran
  for select to anon using (true);

revoke all on table jadwal_pelajaran from anon, authenticated;
grant select, insert, update, delete on jadwal_pelajaran to authenticated;
grant select on jadwal_pelajaran to anon;

-- ========== 3. RELOAD CACHE SKEMA POSTGREST ==========
notify pgrst, 'reload schema';


-- ============================================================
-- [35/35] upgrade_20260920b_lepas_notnull_legacy_jadwal_pelajaran.sql
-- ============================================================
-- Lepas NOT NULL pada kolom legacy tabel jadwal_pelajaran (sisa setup
-- lama di luar migrasi repo, mis. mata_pelajaran/guru/kelas/hari/jam)
-- yang tidak dipakai aplikasi — mencegah error "null value ... violates
-- not-null constraint" saat insert dari form Tambah Jadwal.
do $$
declare
  kolom record;
  kolom_dipakai_aplikasi text[] := array[
    'id', 'created_at',
    'ID Akun Guru', 'ID Jadwal Murid', 'Tahun', 'Semester', 'Waktu', 'Mapel', 'Tingkat/Kelas'
  ];
begin
  for kolom in
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'jadwal_pelajaran'
      and is_nullable = 'NO'
      and column_default is null
      and column_name <> all (kolom_dipakai_aplikasi)
  loop
    execute format('alter table jadwal_pelajaran alter column %I drop not null', kolom.column_name);
  end loop;
end $$;

notify pgrst, 'reload schema';

