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
