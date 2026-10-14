-- ============================================================
-- UPGRADE 2026-10-08: MENU EKSTRAKURIKULER LENGKAP
-- Jalankan SELURUH file ini di Supabase Dashboard -> SQL Editor -> Run
--
-- LATAR BELAKANG:
--   Menu Ekstrakurikuler dirombak jadi 5 grup tab baru + fitur Info Ekskul:
--   A) Info Ekskul: Pengumuman & Berita per-ekskul, notifikasi in-app untuk
--      Pengumuman/Agenda/Materi/Sertifikat, icon link folder Google Drive.
--   B) Grup tab baru (menggantikan tab lama, isi lama TIDAK dipindah datanya,
--      hanya diakses dari lokasi baru di UI):
--      1. "Persuratan & Proposal": arsip surat masuk/keluar, generator surat
--         otomatis, Surat Dispensasi (tabel lama dipakai ulang), Proposal
--         Kegiatan, LPJ.
--      2. "Profil & Anggota": tambah profil Pelatih + Formulir/Berkas
--         Pendaftaran anggota baru.
--      3. "Keuangan & Kas": Kas Umum & Kas Anggota (tabel lama dipakai ulang),
--         Inventaris ekskul (barang, kondisi, buku peminjaman alat).
--      4. "Jurnal & Program Kerja": Program Kerja, Jurnal Kegiatan/Logbook,
--         Modul/Materi Pembelajaran (tabel materi_tugas_ekskul dipakai ulang).
--      5. "Arsip & Penilaian": Nilai (RPC lama dipakai ulang via UI), Buku
--         Prestasi/Penghargaan (tabel sertifikat_prestasi_ekskul dipakai ulang).
--
-- Akses ditegakkan di client (web/js/app.js -> hakAksesEkskulUntuk), pola sama
-- dengan tabel ekskul lain di proyek ini: admin/guru/pengurus(pembina/pejabat)
-- = tulis+edit+baca, anggota = baca saja, RLS di DB longgar (anon = sesi murid
-- password lokal, sama seperti modul ekskul lain).
--
-- Isi file ini (semua idempotent — aman dijalankan berulang):
--   1) ekstrakurikuler: kolom drive_url, pelatih (jsonb array)
--   2) pengumuman_ekskul     -- Pengumuman & Berita per ekskul
--   3) materi_tugas_ekskul   -- Materi & Tugas / Modul Pembelajaran
--   4) sertifikat_prestasi_ekskul -- Sertifikat & Prestasi / Buku Prestasi
--   5) arsip_surat_ekskul    -- Arsip Surat Masuk & Keluar + Surat Otomatis
--   6) proposal_kegiatan_ekskul -- Proposal Kegiatan
--   7) lpj_ekskul            -- Laporan Pertanggungjawaban
--   8) pendaftaran_ekskul    -- Formulir & Berkas Pendaftaran anggota baru
--   9) proker_ekskul         -- Program Kerja Tahunan/Semester
--  10) jurnal_ekskul         -- Jurnal Kegiatan / Buku Harian (Logbook)
--  11) inventaris_ekskul + peminjaman_alat_ekskul -- Inventaris & peminjaman
--  12) RPC catat_notifikasi_ekskul(...) -- helper insert ke tabel notifikasi
--  13) Grant + RLS (anon & authenticated = penuh, sama pola modul ekskul lain)
--
-- CATATAN MANUAL (bukan SQL, lakukan di Supabase Dashboard):
--   Buat Storage bucket "ekskul-berkas" (public) untuk lampiran berkas
--   pendaftaran, bukti LPJ, lampiran proposal, dsb.
-- ============================================================

-- ========== 1. EKSTRAKURIKULER: kolom baru ==========
alter table ekstrakurikuler add column if not exists drive_url text default '';
alter table ekstrakurikuler add column if not exists pelatih jsonb not null default '[]'::jsonb;
-- pelatih: [{ "nama": "...", "spesialisasi": "...", "no_telepon": "...", "keterangan": "..." }, ...]

-- ========== 2. PENGUMUMAN & BERITA PER EKSKUL ==========
create table if not exists pengumuman_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  judul text not null,
  isi text default '',
  lampiran_url text default '',
  penulis text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pengumuman_ekskul_ekskul on pengumuman_ekskul (ekskul, created_at desc);

-- ========== 3. MATERI & TUGAS / MODUL PEMBELAJARAN ==========
create table if not exists materi_tugas_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  jenis text not null default 'materi' check (jenis in ('materi', 'tugas')),
  judul text not null,
  deskripsi text default '',
  file_url text default '',
  tenggat date,
  penulis text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_materi_tugas_ekskul_ekskul on materi_tugas_ekskul (ekskul, created_at desc);

-- ========== 4. SERTIFIKAT & PRESTASI / BUKU PRESTASI ==========
create table if not exists sertifikat_prestasi_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  nis_nip text default '',
  nama text not null,
  jenis text not null default 'prestasi' check (jenis in ('prestasi', 'sertifikat')),
  judul text not null,
  tingkat text default '',
  peringkat text default '',
  tanggal date,
  file_url text default '',
  keterangan text default '',
  penulis text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_sertifikat_prestasi_ekskul_ekskul on sertifikat_prestasi_ekskul (ekskul, tanggal desc);

-- ========== 5. ARSIP SURAT MASUK & KELUAR + SURAT OTOMATIS ==========
create table if not exists arsip_surat_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  arah text not null default 'keluar' check (arah in ('masuk', 'keluar')),
  jenis text default '',            -- utk surat keluar otomatis: kode template
  nomor_surat text default '',
  perihal text not null,
  tanggal date not null default current_date,
  asal_tujuan text default '',      -- asal (surat masuk) / tujuan (surat keluar)
  isi_ringkas text default '',
  payload jsonb default '{}'::jsonb, -- data pengisi template surat otomatis
  file_url text default '',
  dibuat_oleh text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_arsip_surat_ekskul_ekskul on arsip_surat_ekskul (ekskul, tanggal desc);

-- ========== 6. PROPOSAL KEGIATAN ==========
create table if not exists proposal_kegiatan_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  judul_kegiatan text not null,
  latar_belakang text default '',
  tujuan text default '',
  waktu_tempat text default '',
  anggaran numeric(14, 2) default 0,
  status text not null default 'diajukan' check (status in ('diajukan', 'disetujui', 'ditolak', 'selesai')),
  file_url text default '',
  dibuat_oleh text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_proposal_kegiatan_ekskul_ekskul on proposal_kegiatan_ekskul (ekskul, created_at desc);

-- ========== 7. LAPORAN PERTANGGUNGJAWABAN (LPJ) ==========
create table if not exists lpj_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  proposal_id uuid references proposal_kegiatan_ekskul(id) on delete set null,
  judul_kegiatan text not null,
  ringkasan_pelaksanaan text default '',
  realisasi_anggaran numeric(14, 2) default 0,
  file_url text default '',
  dibuat_oleh text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_lpj_ekskul_ekskul on lpj_ekskul (ekskul, created_at desc);


-- ========== 8. FORMULIR & BERKAS PENDAFTARAN ANGGOTA BARU ==========
create table if not exists pendaftaran_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  nis_nip text default '',
  nama text not null,
  kelas text default '',
  no_telepon text default '',
  alasan text default '',
  berkas_url text default '',
  status text not null default 'menunggu' check (status in ('menunggu', 'diterima', 'ditolak')),
  catatan text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_pendaftaran_ekskul_ekskul on pendaftaran_ekskul (ekskul, created_at desc);

-- ========== 9. PROGRAM KERJA (PROKER) TAHUNAN/SEMESTER ==========
create table if not exists proker_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  ta text default '',
  semester text default '',
  program text not null,
  tujuan text default '',
  sasaran text default '',
  jadwal_rencana text default '',
  penanggung_jawab text default '',
  status text not null default 'rencana' check (status in ('rencana', 'berjalan', 'selesai', 'batal')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_proker_ekskul_ekskul on proker_ekskul (ekskul, ta, semester);

-- ========== 10. JURNAL KEGIATAN / BUKU HARIAN (LOGBOOK) ==========
create table if not exists jurnal_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  tanggal date not null default current_date,
  kegiatan text not null,
  catatan text default '',
  jumlah_hadir int default 0,
  penulis text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_jurnal_ekskul_ekskul on jurnal_ekskul (ekskul, tanggal desc);

-- ========== 11. INVENTARIS EKSKUL + BUKU PEMINJAMAN ALAT ==========
create table if not exists inventaris_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  nama_barang text not null,
  kode text default '',
  jumlah int not null default 1,
  kondisi text not null default 'Baik' check (kondisi in ('Baik', 'Rusak Ringan', 'Rusak Berat', 'Hilang')),
  lokasi text default '',
  tahun_perolehan int,
  keterangan text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_inventaris_ekskul_ekskul on inventaris_ekskul (ekskul);

create table if not exists peminjaman_alat_ekskul (
  id uuid primary key default gen_random_uuid(),
  ekskul text not null,
  barang_id uuid references inventaris_ekskul(id) on delete set null,
  nama_barang_snapshot text default '',
  peminjam text not null,
  jumlah int not null default 1,
  tanggal_pinjam date not null default current_date,
  tanggal_kembali date,
  kondisi_kembali text default '',
  status text not null default 'dipinjam' check (status in ('dipinjam', 'kembali')),
  catatan text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_peminjaman_alat_ekskul_ekskul on peminjaman_alat_ekskul (ekskul, status);

-- ========== 12. RPC: CATAT NOTIFIKASI EKSKUL (in-app, bukan push OS) ==========
-- Dipakai saat ada Pengumuman & Berita / Agenda Kegiatan / Materi & Tugas /
-- Sertifikat & Prestasi baru pada suatu ekskul, agar anggota melihatnya lewat
-- widget notifikasi dashboard (tabel "notifikasi" sudah ada sejak
-- upgrade_20261002_kas_masterdata_v2.sql).
create or replace function catat_notifikasi_ekskul(
  p_ekskul text, p_judul text, p_pesan text, p_untuk_peran text[] default '{murid}'
)
returns void as $$
begin
  insert into notifikasi (judul, pesan, ekskul, untuk_peran, created_at)
  values (p_judul, p_pesan, p_ekskul, p_untuk_peran, now());
end;
$$ language plpgsql security definer;

-- ========== 13. GRANT + RLS (anon = sesi murid password lokal, pola proyek ini) ==========
alter table pengumuman_ekskul enable row level security;
alter table materi_tugas_ekskul enable row level security;
alter table sertifikat_prestasi_ekskul enable row level security;
alter table arsip_surat_ekskul enable row level security;
alter table proposal_kegiatan_ekskul enable row level security;
alter table lpj_ekskul enable row level security;
alter table pendaftaran_ekskul enable row level security;
alter table proker_ekskul enable row level security;
alter table jurnal_ekskul enable row level security;
alter table inventaris_ekskul enable row level security;
alter table peminjaman_alat_ekskul enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'pengumuman_ekskul', 'materi_tugas_ekskul', 'sertifikat_prestasi_ekskul',
    'arsip_surat_ekskul', 'proposal_kegiatan_ekskul', 'lpj_ekskul',
    'pendaftaran_ekskul', 'proker_ekskul', 'jurnal_ekskul',
    'inventaris_ekskul', 'peminjaman_alat_ekskul'
  ]
  loop
    execute format('drop policy if exists %I_select_all on %I', t, t);
    execute format('create policy %I_select_all on %I for select using (true)', t, t);
    execute format('drop policy if exists %I_insert_all on %I', t, t);
    execute format('create policy %I_insert_all on %I for insert with check (true)', t, t);
    execute format('drop policy if exists %I_update_all on %I', t, t);
    execute format('create policy %I_update_all on %I for update using (true)', t, t);
    execute format('drop policy if exists %I_delete_all on %I', t, t);
    execute format('create policy %I_delete_all on %I for delete using (true)', t, t);
    execute format('grant select, insert, update, delete on %I to anon, authenticated', t);
  end loop;
end $$;

grant execute on function catat_notifikasi_ekskul(text, text, text, text[]) to anon, authenticated;

-- Reload cache skema PostgREST
notify pgrst, 'reload schema';


