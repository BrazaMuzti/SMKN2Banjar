-- ============================================================
-- UPGRADE: RPC ABSEN MANDIRI (PERBAIKAN TIDAK TERSIMPAN) — 2026-10-14
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- LATAR BELAKANG:
--   Menu "Absen Mandiri" murid menampilkan "Berhasil Absen" namun baris
--   tidak/belum tampil di database. Sebelumnya penulisan dilakukan
--   LANGSUNG dari browser:
--     supaClient.from('absensi').upsert(...)
--   sehingga bergantung pada: (a) state browser (currentTahun/currentBulan
--   yang bisa basi → tanggal/tahun pelajaran salah), (b) hak tulis anon
--   pada tabel absensi, dan (c) validasi captcha client-side (membaca kolom
--   akun.captcha sebagai anon).
--
-- SOLUSI:
--   1) RPC `absen_mandiri` (security definer) — satu-satunya pintu tulis
--      absen mandiri:
--        * tanggal SELALU otomatis = hari ini WIB (bukan turunan bulan/tahun
--          dari browser);
--        * validasi captcha & sesi guru BUKA dilakukan DI SERVER (captcha
--          tidak lagi perlu dibaca klien → menutup kebocoran nilai captcha
--          ke peran anon);
--        * upsert ON CONFLICT (nis, tanggal, mapel) aman & idempotent;
--        * kolom wajah_cocok menampung verifikasi face scan (opsional).
--   2) Kolom baru absensi.wajah_cocok untuk face scan Absen Mandiri.
--   3) Self-healing kolom + RLS/grant tabel absensi (pola sama dengan
--      upgrade_20260928_rpc_akun_murid.sql).
--
-- Semua idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
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
-- ========== 3. RPC: ABSEN MANDIRI (SECURITY DEFINER) ==========
-- Parameter:
--   p_nis         → NIS murid pemanggil (identitas utk verifikasi)
--   p_nama, p_kelas → label untuk baris absensi
--   p_tahun       → label Tahun Pelajaran (mis. "2026/2027"); bila basi/tidak
--                   masuk akal, diturunkan otomatis dari tanggal
--   p_bulan       → label bulan Indonesia; bila basi, diganti dari tanggal
--   p_mapel       → mapel/ekstrakurikuler (dari jadwal murid)
--   p_captcha     → kode yang diumumkan guru pengampu (sesi kunci_absen 'BUKA')
--   p_gps         → koordinat GPS (opsional, teks)
--   p_wajah_cocok → true bila identitas diverifikasi face scan (opsional)
--   p_tanggal     → tanggal absen; default HARI INI WIB (biasanya tidak
--                   perlu dikirim — disediakan untuk pengujian/fleksibilitas)
create or replace function absen_mandiri(
  p_nis text,
  p_nama text default '',
  p_kelas text default '',
  p_tahun text default '',
  p_bulan text default '',
  p_mapel text default '',
  p_captcha text default '',
  p_gps text default '',
  p_wajah_cocok boolean default false,
  p_tanggal date default (now() at time zone 'Asia/Jakarta')::date
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tanggal date;
  v_tahun_tgl int;
  v_bulan text;
  v_semester text;
  v_tahun text;
  v_ketemu boolean;
  v_metode text;
  arr_bulan text[] := array['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
begin
  p_nis     := trim(coalesce(p_nis, ''));
  p_mapel   := trim(coalesce(p_mapel, ''));
  p_captcha := upper(trim(coalesce(p_captcha, '')));

  if p_nis = '' then
    return json_build_object('status', 'error', 'message', 'NIS wajib diisi.');
  end if;
  if p_mapel = '' then
    return json_build_object('status', 'error', 'message', 'Pilih mapel/ekstrakurikuler dulu.');
  end if;
  if p_captcha = '' then
    return json_build_object('status', 'error', 'message', 'Kode captcha wajib diisi.');
  end if;

  -- Identitas: harus akun murid yang benar-benar ada
  if not exists (select 1 from akun where nis_nip = p_nis and tipe = 'murid') then
    return json_build_object('status', 'error', 'message', 'Akun murid tidak ditemukan.');
  end if;

  -- Tanggal: OTOMATIS hari ini WIB — tidak percaya bulan/tahun dari browser
  v_tanggal   := coalesce(p_tanggal, (now() at time zone 'Asia/Jakarta')::date);
  v_tahun_tgl := extract(year from v_tanggal);

  -- Bulan label (nama bulan Indonesia) — koreksi otomatis bila basi
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
    (p_nis, p_nama, v_tanggal, 'H', '', p_mapel, p_mapel, p_kelas, v_tahun, v_semester, v_bulan, v_metode, p_gps, coalesce(p_wajah_cocok, false))
  on conflict (nis, tanggal, mapel) do update set
    nama       = excluded.nama,
    status     = 'H',
    keterangan = '',
    kelas      = excluded.kelas,
    tahun      = excluded.tahun,
    semester   = excluded.semester,
    bulan      = excluded.bulan,
    metode     = excluded.metode,
    gps        = excluded.gps,
    wajah_cocok = excluded.wajah_cocok;

  return json_build_object(
    'status',   'success',
    'tanggal',  to_char(v_tanggal, 'YYYY-MM-DD'),
    'bulan',    v_bulan,
    'semester', v_semester,
    'tahun',    v_tahun,
    'metode',   v_metode
  );
end $$;

-- ========== 4. IZIN EKSEKUSI + RELOAD CACHE ==========
grant execute on function absen_mandiri(text, text, text, text, text, text, text, text, boolean, date) to anon, authenticated;

notify pgrst, 'reload schema';