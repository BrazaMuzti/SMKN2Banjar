-- ============================================================
-- UPGRADE 2026-10-01: KAS EKSTRAKURIKULER (Kas Umum + Kas Anggota)
-- Jalankan SELURUH file ini di Supabase Dashboard -> SQL Editor -> Run
--
-- LATAR BELAKANG:
--   Menu Ekstrakurikuler perlu 2 tab baru: "Kas Umum" (pemasukan/pengeluaran
--   operasional ekskul: belanja alat, konsumsi, dana BOS, sponsorship) dan
--   "Kas Anggota" (tagihan & pembayaran iuran harian/mingguan/bulanan siswa).
--
-- Akses (ditegakkan di client, web/js/app.js -> hakAksesKasUntuk):
--   - admin / guru (pembina ekskul terkait)      -> baca, tulis, edit
--   - murid dengan jabatan mengandung "Bendahara" -> baca, tulis, edit
--   - murid anggota biasa ekskul tsb              -> baca saja
--
-- Isi file ini:
--   1) Tabel kategori_kas       -- master kategori transaksi
--   2) Tabel kas_umum           -- transaksi kas operasional per ekskul
--   3) Tabel iuran_anggota      -- pembayaran iuran per anggota per periode
--   4) Trigger sync_iuran_ke_kas_umum -- iuran anggota otomatis tercatat sbg
--      pemasukan Kas Umum (sumber='iuran_anggota', ref_iuran_id)
--   5) RPC hitung_saldo_kas_umum(p_ekskul)       -- ringkasan Kas Umum
--   6) RPC matriks_iuran_anggota(p_ekskul, p_tahun, p_bulan) -- data matriks
--   7) Grant + RLS dasar (anon = sesi murid password lokal, sama seperti
--      modul ekskul lain di proyek ini)
--
-- CATATAN MANUAL (bukan SQL, lakukan di Supabase Dashboard):
--   Buat Storage bucket "kas-bukti" (public bucket, untuk lampiran nota/bukti
--   transaksi) melalui Dashboard -> Storage -> New bucket -> set Public.
-- ============================================================

-- ========== 1. TABEL KATEGORI_KAS ==========
create table if not exists kategori_kas (
  id uuid primary key default gen_random_uuid(),
  nama text not null unique,
  jenis text not null check (jenis in ('masuk', 'keluar', 'both')),
  aktif boolean not null default true,
  created_at timestamptz not null default now()
);

insert into kategori_kas (nama, jenis) values
  ('Iuran Anggota', 'masuk'),
  ('Dana BOS/Sekolah', 'masuk'),
  ('Sponsorship', 'masuk'),
  ('Donasi', 'masuk'),
  ('Belanja Alat', 'keluar'),
  ('Konsumsi', 'keluar'),
  ('Transport', 'keluar'),
  ('Lain-lain', 'both')
on conflict (nama) do nothing;

-- ========== 2. TABEL KAS_UMUM ==========
create table if not exists kas_umum (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  tanggal date not null default current_date,
  kategori_id uuid references kategori_kas(id) on delete set null,
  keterangan text,
  no_bukti text,
  bukti_url text,
  jumlah_masuk numeric(14, 2) not null default 0,
  jumlah_keluar numeric(14, 2) not null default 0,
  -- visibilitas: kombinasi dari 'pembina_jabatan','anggota','siswa_sekolah','guru','umum'
  visibilitas text[] not null default '{pembina_jabatan,anggota}',
  sumber text not null default 'manual' check (sumber in ('manual', 'iuran_anggota')),
  ref_iuran_id uuid,
  dibuat_oleh text,
  created_at timestamptz not null default now()
);
create index if not exists idx_kas_umum_ekskul_tgl on kas_umum (ekskul, tanggal desc);
create index if not exists idx_kas_umum_kategori on kas_umum (kategori_id);

-- Self-healing: kalau tabel sudah pernah dibuat versi lama, tambahkan kolom yang belum ada.
alter table kas_umum add column if not exists visibilitas text[] not null default '{pembina_jabatan,anggota}';
alter table kas_umum add column if not exists sumber text not null default 'manual';
alter table kas_umum add column if not exists ref_iuran_id uuid;
alter table kas_umum add column if not exists bukti_url text;

-- ========== 3. TABEL IURAN_ANGGOTA ==========
create table if not exists iuran_anggota (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  nis_nip text not null,
  periode_tipe text not null check (periode_tipe in ('harian', 'mingguan', 'bulanan')),
  periode_label text not null, -- contoh: 'M1', '2026-W05', '2026-01-15'
  tahun int not null,
  bulan int, -- 1-12
  nominal numeric(14, 2) not null,
  status text not null default 'lunas' check (status in ('lunas', 'menunggak')),
  tanggal_bayar date,
  metode text,
  dicatat_oleh text,
  created_at timestamptz not null default now(),
  unique (ekskul, nis_nip, periode_tipe, periode_label, tahun)
);
create index if not exists idx_iuran_ekskul_periode on iuran_anggota (ekskul, tahun, bulan);
create index if not exists idx_iuran_nis on iuran_anggota (nis_nip);

-- ========== 4. TRIGGER: SYNC IURAN ANGGOTA -> KAS UMUM ==========
create or replace function sync_iuran_ke_kas_umum()
returns trigger as $$
declare
  v_kat_id uuid;
begin
  select id into v_kat_id from kategori_kas where nama = 'Iuran Anggota' limit 1;
  insert into kas_umum (
    ekskul, tanggal, kategori_id, keterangan, jumlah_masuk,
    visibilitas, sumber, ref_iuran_id, dibuat_oleh
  ) values (
    new.ekskul,
    coalesce(new.tanggal_bayar, current_date),
    v_kat_id,
    'Iuran ' || new.periode_label || ' - ' || new.nis_nip,
    new.nominal,
    '{pembina_jabatan,anggota}',
    'iuran_anggota',
    new.id,
    new.dicatat_oleh
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_sync_iuran_kas_umum on iuran_anggota;
create trigger trg_sync_iuran_kas_umum
  after insert on iuran_anggota
  for each row execute function sync_iuran_ke_kas_umum();

-- Hapus baris iuran -> hapus juga baris kas_umum turunannya (jaga konsistensi saldo)
create or replace function sync_hapus_iuran_kas_umum()
returns trigger as $$
begin
  delete from kas_umum where ref_iuran_id = old.id and sumber = 'iuran_anggota';
  return old;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_sync_hapus_iuran_kas_umum on iuran_anggota;
create trigger trg_sync_hapus_iuran_kas_umum
  after delete on iuran_anggota
  for each row execute function sync_hapus_iuran_kas_umum();

-- ========== 5. RPC: RINGKASAN KAS UMUM ==========
create or replace function hitung_saldo_kas_umum(p_ekskul text)
returns json as $$
declare
  v_masuk numeric(14, 2);
  v_keluar numeric(14, 2);
begin
  select coalesce(sum(jumlah_masuk), 0), coalesce(sum(jumlah_keluar), 0)
    into v_masuk, v_keluar
    from kas_umum
   where ekskul = p_ekskul;

  return json_build_object(
    'ekskul', p_ekskul,
    'total_masuk', v_masuk,
    'total_keluar', v_keluar,
    'saldo', v_masuk - v_keluar
  );
end;
$$ language plpgsql stable security definer;

-- ========== 6. RPC: MATRIKS IURAN ANGGOTA ==========
-- Mengembalikan status pembayaran per anggota untuk tahun/bulan tertentu
-- (dipakai untuk render tabel matriks di tab "Kas Anggota" tanpa N+1 query).
create or replace function matriks_iuran_anggota(p_ekskul text, p_tahun int, p_bulan int)
returns json as $$
declare
  v_result json;
begin
  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_result
  from (
    select
      nis_nip,
      periode_tipe,
      periode_label,
      nominal,
      status,
      tanggal_bayar
    from iuran_anggota
    where ekskul = p_ekskul
      and tahun = p_tahun
      and (p_bulan is null or bulan = p_bulan)
    order by nis_nip, periode_label
  ) t;
  return v_result;
end;
$$ language plpgsql stable security definer;


-- ========== 7. GRANT + RLS (anon = sesi murid password lokal, pola proyek ini) ==========
alter table kategori_kas enable row level security;
alter table kas_umum enable row level security;
alter table iuran_anggota enable row level security;

drop policy if exists kategori_kas_select_all on kategori_kas;
create policy kategori_kas_select_all on kategori_kas for select using (true);

drop policy if exists kas_umum_select_all on kas_umum;
create policy kas_umum_select_all on kas_umum for select using (true);
drop policy if exists kas_umum_insert_all on kas_umum;
create policy kas_umum_insert_all on kas_umum for insert with check (true);
drop policy if exists kas_umum_update_all on kas_umum;
create policy kas_umum_update_all on kas_umum for update using (true);
drop policy if exists kas_umum_delete_all on kas_umum;
create policy kas_umum_delete_all on kas_umum for delete using (true);

drop policy if exists iuran_anggota_select_all on iuran_anggota;
create policy iuran_anggota_select_all on iuran_anggota for select using (true);
drop policy if exists iuran_anggota_insert_all on iuran_anggota;
create policy iuran_anggota_insert_all on iuran_anggota for insert with check (true);
drop policy if exists iuran_anggota_update_all on iuran_anggota;
create policy iuran_anggota_update_all on iuran_anggota for update using (true);
drop policy if exists iuran_anggota_delete_all on iuran_anggota;
create policy iuran_anggota_delete_all on iuran_anggota for delete using (true);

grant select on kategori_kas to anon, authenticated;
grant select, insert, update, delete on kas_umum to anon, authenticated;
grant select, insert, update, delete on iuran_anggota to anon, authenticated;
grant execute on function hitung_saldo_kas_umum(text) to anon, authenticated;
grant execute on function matriks_iuran_anggota(text, int, int) to anon, authenticated;

-- Reload cache skema PostgREST
notify pgrst, 'reload schema';

