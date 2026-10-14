-- ============================================================
-- UPGRADE 2026-10-02: KAS EKSTRAKURIKULER v2 + MASTER DATA DRIVE LINKS
-- Jalankan SELURUH file ini di Supabase Dashboard -> SQL Editor -> Run
--
-- LATAR BELAKANG:
--   Lanjutan upgrade_20261001_kas_ekstrakurikuler.sql. Menambahkan:
--   1) Kolom link Google Drive manual (per kategori) di master_data,
--      dipakai al. sebagai target tombol "Upload Nota" di Kas Umum.
--   2) Kolom "deskripsi" pada kategori_kas (dipakai tombol "Kategori").
--   3) Tabel baru deskripsi_iuran (master judul+deskripsi iuran, dipakai
--      tombol "Deskripsi Iuran" & pilihan deskripsi pembayaran).
--   4) Kolom nama_siswa pada kas_umum (pengganti tampilan NIS di kolom
--      Keterangan) + kolom deskripsi_pembayaran pada iuran_anggota.
--   5) Update trigger sync_iuran_ke_kas_umum agar mengisi nama_siswa.
--   6) Tabel notifikasi (notifikasi transaksi kas ke murid/pembina/bendahara).
--
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. MASTER DATA: KOLOM LINK GOOGLE DRIVE (per kategori) ==========
alter table master_data add column if not exists "Drive Akun Murid" text;
alter table master_data add column if not exists "Drive Akun Guru" text;
alter table master_data add column if not exists "Drive Mata Pelajaran" text;
alter table master_data add column if not exists "Drive Ekstrakurikuler" text;
alter table master_data add column if not exists "Drive Administrasi Sekolah" text;

-- ========== 2. KATEGORI_KAS: KOLOM DESKRIPSI ==========
alter table kategori_kas add column if not exists deskripsi text default '';

-- ========== 3. TABEL DESKRIPSI_IURAN ==========
create table if not exists deskripsi_iuran (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  judul text not null,
  deskripsi text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_deskripsi_iuran_ekskul on deskripsi_iuran (ekskul);

-- ========== 4. KAS_UMUM: KOLOM NAMA_SISWA ==========
alter table kas_umum add column if not exists nama_siswa text;

-- ========== 5. IURAN_ANGGOTA: KOLOM DESKRIPSI_PEMBAYARAN ==========
alter table iuran_anggota add column if not exists deskripsi_pembayaran text default '';

-- ========== 6. UPDATE TRIGGER: SYNC IURAN ANGGOTA -> KAS UMUM (isi nama_siswa) ==========
create or replace function sync_iuran_ke_kas_umum()
returns trigger as $$
declare
  v_kat_id uuid;
  v_nama text;
begin
  select id into v_kat_id from kategori_kas where nama = 'Iuran Anggota' limit 1;
  select nama_lengkap into v_nama from akun where nis_nip = new.nis_nip and tipe = 'murid' limit 1;
  insert into kas_umum (
    ekskul, tanggal, kategori_id, keterangan, nama_siswa, jumlah_masuk,
    visibilitas, sumber, ref_iuran_id, dibuat_oleh
  ) values (
    new.ekskul,
    coalesce(new.tanggal_bayar, current_date),
    v_kat_id,
    coalesce(new.deskripsi_pembayaran, '') || ' Iuran ' || new.periode_label,
    coalesce(v_nama, new.nis_nip),
    new.nominal,
    '{pembina_jabatan,anggota}',
    'iuran_anggota',
    new.id,
    new.dicatat_oleh
  );
  return new;
end;
$$ language plpgsql security definer;

-- ========== 7. TABEL NOTIFIKASI ==========
create table if not exists notifikasi (
  id uuid primary key default gen_random_uuid(),
  ekskul text,
  target_nis_nip text,       -- nis siswa yang disebut dalam transaksi (kosong = notifikasi umum ekskul)
  untuk_peran text[] not null default '{}', -- kombinasi: 'murid','pembina','bendahara'
  judul text not null,
  pesan text not null,
  dibaca boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifikasi_target on notifikasi (target_nis_nip);
create index if not exists idx_notifikasi_ekskul on notifikasi (ekskul, created_at desc);

-- ========== 8. GRANT + RLS ==========
alter table deskripsi_iuran enable row level security;
alter table notifikasi enable row level security;

drop policy if exists deskripsi_iuran_select_all on deskripsi_iuran;
create policy deskripsi_iuran_select_all on deskripsi_iuran for select using (true);
drop policy if exists deskripsi_iuran_insert_all on deskripsi_iuran;
create policy deskripsi_iuran_insert_all on deskripsi_iuran for insert with check (true);
drop policy if exists deskripsi_iuran_update_all on deskripsi_iuran;
create policy deskripsi_iuran_update_all on deskripsi_iuran for update using (true);
drop policy if exists deskripsi_iuran_delete_all on deskripsi_iuran;
create policy deskripsi_iuran_delete_all on deskripsi_iuran for delete using (true);

drop policy if exists notifikasi_select_all on notifikasi;
create policy notifikasi_select_all on notifikasi for select using (true);
drop policy if exists notifikasi_insert_all on notifikasi;
create policy notifikasi_insert_all on notifikasi for insert with check (true);
drop policy if exists notifikasi_update_all on notifikasi;
create policy notifikasi_update_all on notifikasi for update using (true);
drop policy if exists notifikasi_delete_all on notifikasi;
create policy notifikasi_delete_all on notifikasi for delete using (true);

grant select, insert, update, delete on deskripsi_iuran to anon, authenticated;
grant select, insert, update, delete on notifikasi to anon, authenticated;

-- Reload cache skema PostgREST
notify pgrst, 'reload schema';
