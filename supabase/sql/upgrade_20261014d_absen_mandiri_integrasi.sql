-- ============================================================
-- UPGRADE: ABSEN MANDIRI v2 — INTEGRASI KE REKAP GURU
-- (MATA PELAJARAN & EKSTRAKURIKULER) — 2026-10-14
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Setelah upgrade_20261014c, absen mandiri murid menampilkan "Berhasil"
--   dan barisnya MASUK tabel absensi, namun TIDAK MUNCUL di rekap guru
--   Mapel/Ekskul. Akar masalah (terbaca di web/js/utils.example.js →
--   get_dashboard_data):
--     1) Ekskul: rekap guru memfilter absensi dengan
--          .eq('kelas','Semua Kelas')
--        sedangkan RPC v1 menulis kelas = kelas asli siswa → baris absen
--        mandiri ekskul tidak pernah tampil di rekap ekstrakurikuler guru.
--     2) Mapel: rekap guru memfilter dengan KELAS EFEKTIF TA yang diambil
--        dari akun.riwayat_kelas[tahun].kelas (fallback tingkat_kelas),
--        sedangkan RPC v1 menulis p_kelas = akun.tingkat_kelas statis dari
--        sesi murid → setelah kenaikan/pindah kelas, baris tak muncul di
--        rekap mapel guru.
--     3) RPC v1 masih percaya p_tanggal dari browser
--        (v_tanggal := coalesce(p_tanggal, server)) padahal komentarnya
--        mengklaim "selalu WIB" → gadget dengan jam meleset menulis baris di
--        tanggal yang berada di luar rentang filter bulan guru.
--
-- SOLUSI:
--   1) `absen_mandiri` dibuat ulang dengan SIGNATURE BARU (overload v1
--      DIBUANG agar tidak bisa dipanggil lagi):
--        * parameter baru p_jenis ('Mapel'/'Ekskul') menentukan bucket kelas;
--        * tanggal SELALU (now() at time zone 'Asia/Jakarta')::date —
--          p_tanggal tetap diterima (kompatibilitas klien lama) tapi DIIGNOR;
--        * nama diambil dari akun.nama_lengkap;
--        * kelas Mapel = akun.riwayat_kelas[p_tahun]->>'kelas' (fallback
--          tingkat_kelas dari p_kelas), siswa non-Aktif di TA ditolak —
--          PERSIS logika get_dashboard_data → baris langsung muncul di rekap
--          guru pengampu;
--        * kelas Ekskul = 'Semua Kelas' + keanggotaan murid di ekskul itu
--          diverifikasi (akun.ekstrakurikuler) → tolak bila bukan anggota;
--        * captcha & sesi guru Kunci Absen 'BUKA' diverifikasi server
--          (dipertahankan dari v1).
--   2) Self-healing kolom/RLS/grant (pola sama dengan 14c) — idempotent.
--
-- Semua idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- Baris yang tadinya mendarat di kelas/tanggal salah (dari RPC v1) bisa
-- diperbaiki manual — lihat bagian 6 (diagnosa, tidak otomatis).
-- ============================================================

-- ========== 1. SELF-HEALING KOLOM ==========
alter table absensi add column if not exists gps text default '';
alter table absensi add column if not exists metode text default 'Manual / QR';
alter table absensi add column if not exists wajah_cocok boolean not null default false;

-- ========== 2. RLS + GRANT TABEL ABSENSI (kembalikan ke baseline) ==========
-- Murid lokal memakai anon key — absen mandiri kini lewat RPC, tapi
-- SELECT tetap dibuka untuk anon (baca dashboard/laporan murid) dan tulis
-- tetap dibuka untuk authenticated (guru/admin via save_absen_masal).
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

drop policy if exists "absensi_hapus_semua" on absensi;
create policy "absensi_hapus_semua" on absensi
  for delete using (true);

revoke all on table absensi from anon, authenticated;
grant select, insert, update, delete on absensi to anon, authenticated;

-- ========== 3. RPC ABSEN MANDIRI v2 (SECURITY DEFINER) ==========
-- BUANG overload v1 (10 arg: ... boolean wajah_cocok, date p_tanggal) agar
-- payload lama tidak bisa lagi menulis dengan logika kelas statis.
drop function if exists absen_mandiri(text, text, text, text, text, text, text, text, boolean, date);

create or replace function absen_mandiri(
  p_nis text,
  p_nama text,
  p_kelas text,
  p_tahun text,
  p_bulan text,
  p_mapel text,
  p_captcha text,
  p_gps text,
  p_wajah_cocok boolean default false,
  p_tanggal date default null,   -- DITERIMA untuk kompatibilitas klien lama, TAPI DIIGNOR
  p_jenis text default 'Mapel'   -- 'Mapel' | 'Ekskul' → menentukan bucket kelas
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tanggal date;
  v_tahun_tgl int;
  v_bulan text;
  v_semester text;
  v_tahun text;
  v_ketemu boolean;
  v_metode text;
  v_kelas text := '';
  v_nama text := '';
  v_jenis text;
  v_riwayat jsonb;
  arr_bulan text[] := '{"Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"}';
begin
  -- Normalisasi masukan (pola 14c): captcha & mapel di-trim, captcha di-upper-case
  p_nis     := trim(coalesce(p_nis, ''));
  p_mapel   := trim(coalesce(p_mapel, ''));
  p_captcha := upper(trim(coalesce(p_captcha, '')));

  v_jenis := upper(coalesce(nullif(trim(p_jenis), ''), 'MAPEL'));
  if v_jenis not in ('MAPEL', 'EKSKUL') then
    return json_build_object('status', 'error', 'message', 'Jenis absen tidak valid (Mapel atau Ekskul).');
  end if;

  if p_nis = '' then
    return json_build_object('status', 'error', 'message', 'NIS wajib diisi.');
  end if;
  if p_mapel = '' then
    return json_build_object('status', 'error', 'message', 'Pilih mata pelajaran / ekstrakurikuler terlebih dahulu.');
  end if;
  if p_captcha = '' then
    return json_build_object('status', 'error', 'message', 'Kode captcha wajib diisi.');
  end if;

  -- Identitas murid + data akun (nama & riwayat kelas DARI SERVER)
  select m.nama_lengkap, coalesce(m.riwayat_kelas, '{}'::jsonb)
    into v_nama, v_riwayat
    from akun m
   where m.nis_nip = p_nis and m.tipe = 'murid';
  if not found then
    return json_build_object('status', 'error', 'message', 'Akun murid tidak ditemukan.');
  end if;
  v_nama := coalesce(nullif(trim(v_nama), ''), p_nama);

  -- Tanggal: SELALU hari ini WIB (Asia/Jakarta) — p_tanggal dari browser DIIGNOR
  v_tanggal   := (now() at time zone 'Asia/Jakarta')::date;
  v_tahun_tgl := extract(year from v_tanggal);

  -- Bulan label (nama bulan Indonesia) — dipakai konsistensi pelaporan
  v_bulan := nullif(trim(coalesce(p_bulan, '')), '');
  if v_bulan is null or array_position(arr_bulan, v_bulan) is null then
    v_bulan := arr_bulan[extract(month from v_tanggal)::int];
  end if;

  -- Semester mengikuti bulan tanggal (Jul–Des = Ganjil, Jan–Jun = Genap)
  v_semester := case when extract(month from v_tanggal) >= 7 then 'Ganjil' else 'Genap' end;

  -- Tahun Pelajaran: pakai label klien bila format YYYY/YYYY dan memuat
  -- tahun tanggal atau tahun berikutnya; jika tidak, turunkan dari tanggal.
  v_tahun := nullif(trim(coalesce(p_tahun, '')), '');
  begin
    if v_tahun is null
       or v_tahun !~ '^[0-9]{4}/[0-9]{4}$'
       or ((split_part(v_tahun, '/', 1))::int not in (v_tahun_tgl, v_tahun_tgl + 1)
           and (split_part(v_tahun, '/', 2))::int not in (v_tahun_tgl, v_tahun_tgl + 1)) then
      v_tahun := v_tahun_tgl || '/' || (v_tahun_tgl + 1);
    end if;
  exception when others then
    v_tahun := v_tahun_tgl || '/' || (v_tahun_tgl + 1);
  end;

  -- KELAS: ditentukan SERVER dengan logika yang sama persis dengan
  -- get_dashboard_data (web/js/utils.example.js):
  --   * Ekskul → 'Semua Kelas' (rekap guru memakai .eq('kelas','Semua Kelas'))
  --   * Mapel  → riwayat_kelas[p_tahun].kelas; bila belum ada riwayat utk TA
  --              tsb, pakai tingkat_kelas (p_kelas dari sesi). Siswa non-Aktif
  --              pada TA ditolak (senada filter statusSiswa !== 'Aktif').
  if v_jenis = 'EKSKUL' then
    v_kelas := 'Semua Kelas';
    -- Keanggotaan: murid harus tercatat di akun.ekstrakurikuler
    if not exists (
      select 1
        from unnest(string_to_array(coalesce(
          (select m.ekstrakurikuler from akun m where m.nis_nip = p_nis and m.tipe = 'murid')
        , ''), ',')) u
       where upper(trim(u)) = upper(trim(p_mapel))
    ) then
      return json_build_object('status', 'error', 'message', 'Siswa bukan anggota ekstrakurikuler ' || p_mapel || '.');
    end if;
  else
    if v_riwayat ? v_tahun then
      if coalesce(v_riwayat->v_tahun->>'status', 'Aktif') <> 'Aktif' then
        return json_build_object('status', 'error', 'message', 'Siswa berstatus tidak aktif pada tahun pelajaran ' || v_tahun || '.');
      end if;
      v_kelas := coalesce(nullif(v_riwayat->v_tahun->>'kelas', ''), '');
    else
      v_kelas := coalesce(p_kelas, '');
    end if;
    if v_kelas = '' then
      return json_build_object('status', 'error', 'message', 'Kelas efektif siswa untuk ' || v_tahun || ' tidak ditemukan (riwayat_kelas/tingkat_kelas). Hubungi admin.');
    end if;
  end if;

  -- Validasi captcha DI SERVER: guru/admin yang membuka sesi (kunci_absen 'BUKA')
  -- dengan mapel/ekstrakurikuler cocok. Kolom akun.captcha tidak dibaca klien.
  select exists (
    select 1 from akun g
     where g.tipe in ('guru', 'admin')
       and g.kunci_absen = 'BUKA'
       and upper(coalesce(g.captcha, '')) = p_captcha
       and (g.mapel ilike '%' || p_mapel || '%' or g.ekstrakurikuler ilike '%' || p_mapel || '%')
  ) into v_ketemu;

  if not coalesce(v_ketemu, false) then
    return json_build_object('status', 'error', 'message', 'Captcha salah atau sesi absen belum dibuka guru.');
  end if;

  v_metode := case when coalesce(p_wajah_cocok, false)
    then 'Absen Mandiri (Wajah+GPS)' else 'Absen Mandiri (GPS)' end;

  insert into absensi
    (nis, nama, tanggal, status, keterangan, mapel, ekskul, kelas, tahun, semester, bulan, metode, gps, wajah_cocok)
  values
    (p_nis, v_nama, v_tanggal, 'H', '', p_mapel, p_mapel, v_kelas, v_tahun, v_semester, v_bulan, v_metode, p_gps, coalesce(p_wajah_cocok, false))
  on conflict (nis, tanggal, mapel) do update set
    nama        = excluded.nama,
    status      = 'H',
    keterangan  = '',
    kelas       = excluded.kelas,
    tahun       = excluded.tahun,
    semester    = excluded.semester,
    bulan       = excluded.bulan,
    metode      = excluded.metode,
    gps         = excluded.gps,
    wajah_cocok = excluded.wajah_cocok;

  return json_build_object(
    'status',   'success',
    'tanggal',  to_char(v_tanggal, 'YYYY-MM-DD'),
    'bulan',    v_bulan,
    'semester', v_semester,
    'tahun',    v_tahun,
    'kelas',    v_kelas,
    'jenis',    v_jenis,
    'metode',   v_metode
  );
end $$;

-- ========== 4. IZIN EKSEKUSI + RELOAD CACHE ==========
grant execute on function absen_mandiri(text, text, text, text, text, text, text, text, boolean, date, text) to anon, authenticated;

notify pgrst, 'reload schema';

-- ========== 5. VERIFIKASI CEPAT (opsional) ==========
-- Setelah frontend di-deploy & murid absen lagi, baris baru harus memakai
-- bucket yang benar (Ekskul → 'Semua Kelas'; Mapel → kelas efektif TA):
--   select nis, nama, tanggal, mapel, kelas, tahun, semester, bulan, metode
--     from absensi
--    where metode like 'Absen Mandiri%'
--      and tanggal >= date_trunc('month', (now() at time zone 'Asia/Jakarta')::date)
--    order by tanggal desc, nis;

-- ========== 6. DIAGNOSA BARIS TERSESAT DARI RPC v1 (opsional) ==========
-- JALANKAN MANUAL — bukan bagian dari upgrade. Menampilkan semua absen mandiri
-- beserta bucket yang ditulis RPC v1. Baris "tersesat":
--   * mapel = nama ekstrakurikuler tetapi kelas <> 'Semua Kelas'; atau
--   * tanggal di luar bulan berjalan (gadget murid pernah meleset).
-- Admin cukup meng-update kelas/tanggal baris tersebut secara manual.
--   select nis, nama, tanggal, mapel, kelas, tahun, semester, bulan, metode
--     from absensi
--    where metode like 'Absen Mandiri%'
--    order by tanggal desc, nis;