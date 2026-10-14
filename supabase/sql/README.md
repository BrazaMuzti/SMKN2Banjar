# SQL Supabase — Versi Sekarang

Folder ini berisi skema database **versi terkini** untuk SIAKAD/SISIP.

## Isi folder

| File | Keterangan |
|---|---|
| `gabungan.sql` | **Gabungan seluruh 30 file upgrade** (2026-09-03 s.d. 2026-09-22) dalam satu file, urut tanggal pengembangan, **tanpa data uji**. |
| `upgrade_*.sql` / `fix_*.sql` | Salinan file satu-persatu (nama & isi sama dengan `../`), urut tanggal. |
| `uji_data.sql` / `uji_bersih.sql` | Tidak ikut di folder ini — masih ada di `supabase/sql/` (khusus pengujian E2E). |

## Kapan pakai yang mana?

- **Project Supabase BARU** (kosong) → jalankan **`gabungan.sql`** sekali jalan di SQL Editor. Selesai.
- **Project yang SUDAH berjalan** dan hanya tertinggal beberapa upgrade → jalankan **file satu-persatu** yang belum ada di database, **urut tanggal** (jangan acak, jangan ulang gabungan).

Semua file idempotent (aman dijalankan berulang), tapi untuk project hidup tetap jalankan hanya yang dibutuhkan.

## Urutan file satu-persatu (30 file)

1. `upgrade_20260903.sql` — kolom profil akun + tabel master_data (13 kolom gaya Sheets) + RLS
2. `fix_20260903_kredensial.sql` — kredensial murid & RPC (pengganti bagian 20260903)
3. `fix_master_data_insert.sql` — perbaikan insert master_data (400 Bad Request)
4. `upgrade_20260904_akun.sql` — gelar guru, NISN, status, foto, dsb.
5. `upgrade_20260904_master_data_tambahan.sql` — 12 kolom daftar baru
6. `upgrade_20260904_absensi.sql` — recreate tabel absensi (kolom lengkap + unique)
7. `upgrade_20260904_absensi_d.sql` — status 'D' (Dispen)
8. `upgrade_20260904_jurnal.sql` — tabel jurnal_guru
9. `upgrade_20260904_nilai.sql` — recreate tabel nilai (JSONB)
10. `upgrade_20260904_ekskul.sql` — pembina_nip & jadwal ekstrakurikuler
11. `upgrade_20260905_ekskul_pengurus.sql` — agenda_ekskul + pengurus
12. `upgrade_20260906_sikap_teman.sql` — nilai_teman_sejawat + jurnal sikap
13. `upgrade_20260906_ekskul_surat.sql` — logo_url + surat dispensasi + sub_ekskul
14. `upgrade_20260906_ekskul_surat_v2.sql` — kolom anggota (JSONB) sub_ekskul
15. `upgrade_20260908_kalender.sql` — kalender_pendidikan
16. `upgrade_20260909_administrasi_guru.sql` — administrasi guru lainnya
17. `upgrade_20260910_penugasan_guru.sql` — penugasan guru per TA
18. `upgrade_20260911_riwayat_siswa.sql` — riwayat kelas & status siswa per TA
19. `upgrade_20260912_nisn_sync.sql` — sinkronisasi NISN
20. `upgrade_20260913_jabatan_ekskul.sql` — jabatan ekstrakurikuler
21. `upgrade_20260914_akses_murid.sql` — akses murid + kolom GPS absensi
22. `upgrade_20260914_absensi_delete.sql` — policy RLS DELETE absensi
23. `upgrade_20260915_proses_kenaikan_rpc.sql` — RPC proses_kenaikan_kelas
24. `upgrade_20260916_fase1.sql` — fase 1: jadwal_ujian, leger, arsip, kartu
25. `upgrade_20260917_fase2.sql` — fase 2: poin, surat, pengumuman, SPP, kas
26. `upgrade_20260918_fase3.sql` — fase 3: perpus_buku, perpus_pinjam, inventaris
27. `upgrade_20260919_fase4.sql` — fase 4: ppdb_calon
28. `upgrade_20260920_murid_rpc.sql` — RPC akses murid (anon)
29. `upgrade_20260921_rls_policies.sql` — RLS policies tabel fase 1-4
30. `upgrade_20260922_nilai_murid_rpc.sql` — RPC ambil_rapor_nilai_murid
31. `upgrade_20260926_ekskul_akses_guru.sql` — akses ekskul pengurus murid + jabatan_ekskul_map
32. `upgrade_20260927_sub_ekskul_anggota.sql` — kolom anggota (jsonb) sub_ekstrakurikuler
33. `upgrade_20260928_rpc_akun_murid.sql` — RPC ubah_profil_murid, ubah_password_sendiri, ambil_laporan_nilai_murid
34. `upgrade_20260929_jadwal_pelajaran.sql` — tabel jadwal_pelajaran + RLS
35. `upgrade_20260930_pengurus_tambah_anggota.sql` — RPC daftar_anggota_ekskul_baru (siswa baru langsung jadi anggota)
36. `upgrade_20260930b_fix_akun_grant_anon.sql` — perbaikan "permission denied for table akun" saat pengurus ekskul murid (anon) menambahkan anggota existing (grant select/update kolom akun ke anon)
37. `upgrade_20261001_kas_ekstrakurikuler.sql` — tab Kas Umum & Kas Anggota di modul Ekstrakurikuler: tabel `kategori_kas`, `kas_umum`, `iuran_anggota`, trigger auto-posting iuran → kas umum, RPC `hitung_saldo_kas_umum` & `matriks_iuran_anggota`. **Manual:** buat Storage bucket `kas-bukti` (public) di Dashboard.
38. `upgrade_20261002_kas_masterdata_v2.sql` — link Google Drive manual per kategori di Master Data (murid/guru/mapel/ekskul/administrasi), kolom `deskripsi` di `kategori_kas`, tabel `deskripsi_iuran`, kolom `nama_siswa` di `kas_umum` & `deskripsi_pembayaran` di `iuran_anggota`, update trigger sync agar mengisi `nama_siswa`, tabel `notifikasi`.
39. `upgrade_20261003_kas_anggota_rentang.sql` — RPC `iuran_anggota_rentang(p_ekskul, p_dari, p_sampai)` untuk filter tab Kas Anggota berbasis rentang tanggal (Dari/Sampai) menggantikan filter Tahun+Bulan.
40. `upgrade_20261005_kas_anggota_cicil.sql` — status `'cicil'` pada `iuran_anggota.status`, kolom `nominal_dibayar` (akumulasi dibayar) & `tanggal_akhir_bayar` (tenggat), update RPC `iuran_anggota_rentang` agar menyertakan kolom baru.
41. `upgrade_20261006_import_murid_akses_guru.sql` — RPC `import_akun_murid` dibuat ulang agar guru wali kelas/pembina ekskul (selain admin) juga boleh import Data Akun Murid.
42. `upgrade_20261007_kalender_tipe_custom.sql` — kolom `tipe_custom` di `kalender_pendidikan` untuk nama kategori bebas saat tipe = `custom` (form Kalender Pendidikan & tampilan tabel/legenda).
43. `upgrade_20261007_akun_hp_ortu.sql` — kolom `no_telepon_ortu` (No HP Orang Tua) tabel `akun`, RPC `buat_akun_murid` dibuat ulang agar menyimpan kolom baru ini.
44. `upgrade_20261007_jadwal_guru_custom.sql` — kolom `"Guru Custom"` di `jadwal_pelajaran`, untuk slot jadwal yang diajar guru tanpa akun (nama diketik manual, dipakai di legenda per Jurusan tampilan Lihat Jadwal).
45. `upgrade_20261008_ekskul_menu_lengkap.sql` — perombakan Menu Ekstrakurikuler: kolom `drive_url` & `pelatih` (jsonb) di `ekstrakurikuler`; tabel baru `pengumuman_ekskul`, `materi_tugas_ekskul`, `sertifikat_prestasi_ekskul`, `arsip_surat_ekskul`, `proposal_kegiatan_ekskul`, `lpj_ekskul`, `pendaftaran_ekskul`, `proker_ekskul`, `jurnal_ekskul`, `inventaris_ekskul`, `peminjaman_alat_ekskul`; RPC `catat_notifikasi_ekskul` (insert ke tabel `notifikasi` — notifikasi in-app, bukan push OS handphone). UI di `web/js/app.js`: menu dirombak jadi 5 tab grup (Persuratan & Proposal, Profil & Anggota, Keuangan & Kas, Jurnal & Program Kerja, Arsip & Penilaian) dengan sub-tab per grup, engine CRUD generik `KONFIG_SUBEKSKUL`/`renderSubEkskulCrud`/`formSubEkskulCrud`, widget Pengumuman & link Drive + profil Pelatih di Info Ekskul. **Manual:** buat Storage bucket `ekskul-berkas` (public) di Dashboard.
46. `upgrade_20261010_jadwal_piket_ekskul.sql` — sub-tab "Jadwal Piket" di Jurnal & Program Kerja: tabel `jadwal_piket_ekskul` (1 baris per ekskul, `hari` jsonb + `piket` jsonb) + RLS. UI: custom hari, generate otomatis (anggota merata 1×/minggu), tabel draggable di halaman, kartu read-only di Info Ekskul (di atas Pengurus).
47. `upgrade_20261011_akun_murid_foto_medsos.sql` — Data Akun Murid: kolom `url_foto` (foto siswa — di-upload via Edge Function `unggah-foto-murid` ke Google Drive, lihat README bagian foto), `alamat_maps` (tautan Google Maps) & `media_sosial` (jsonb array). RPC `buat_akun_murid` & `ubah_profil_murid` dibuat ulang (menyimpan kolom baru), RPC baru `simpan_foto_murid` = satu-satunya penulis `url_foto` (verifikasi admin/murid pemilik NIS). **Manual:** ikuti `supabase/functions/unggah-foto-murid/README.md` — buat Web App Google Apps Script (GAS) berisi `Code.gs` (DriveApp, *Execute as: Me*; BUKAN service account), set Script Properties `UPLOAD_TOKEN` + `DRIVE_FOLDER_ID`, set secret Supabase `GAS_UPLOAD_URL` + `GAS_UPLOAD_TOKEN`, lalu deploy Edge Function. Metode lama `DRIVE_SERVICE_ACCOUNT_JSON` + `DRIVE_MURID_FOLDER_ID` sudah TIDAK dipakai — jangan ikuti tutorial service account (memicu error "Service accounts do not have storage quota").

> **Fungsi baru `sinkron-foto-drive`** (2026-10-14, tanpa SQL tambahan): auto-update URL foto murid dari file Google Drive. Edge Function `supabase/functions/sinkron-foto-drive/index.ts` membaca folder `DRIVE_FOLDER_ID` via Drive API v3 `files.list` (`supportsAllDrives=true&includeItemsFromAllDrives=true`), mencocokkan nama file **"{NISN} {Nama siswa}.jpg"** (fallback **"{NIS} {Nama siswa}.jpg"**) ke tabel `akun` (tipe='murid', service role), lalu memperbarui `akun.url_foto` bila berbeda. Dipicu manual lewat tombol "Sinkron Foto" (khusus admin) di toolbar Data Akun Murid. Deploy: `npx supabase functions deploy sinkron-foto-drive --project-ref <PROJECT_REF>`; secret yang dipakai sama dengan `unggah-foto-murid` (`GOOGLE_SA_JSON`, `DRIVE_FOLDER_ID`).

48. `upgrade_20261006b_add_anggota_akses_admin_pembina.sql` — RPC security definer `ubah_anggota_ekskul(p_pemanggil, p_ekskul, p_nis_list, p_tambah)` mengganti SELECT+UPDATE langsung di `terapkanKeanggotaanEkskul()`: admin selalu boleh, guru (pembina) bila kolom `ekstrakurikuler` memuat ekskul, pengurus murid bila `jabatan_ekskul_map->>ekskul` terisi; menyembuhkan error "permission denied for table akun" pada sesi `authenticated` (admin/pembina). Frontend pakai RPC dulu, fallback jalur lama bila RPC belum ada.
49. `upgrade_20261006c_kunci_absen_ekskul_pengurus.sql` — RPC `ganti_kunci_absen_ekskul(p_pemanggil, p_ekskul, p_captcha, p_kunci)` agar murid pengurus ekskul bisa membuka panel "Kunci Absen Siswa (Captcha)" dan mengganti kunci/captcha baris **pembina** (kecocokan `ekstrakurikuler`/`mapel` sama dengan validasi `absen_mandiri`).

50. `upgrade_20261013_akun_murid_keterangan_maps.sql` — Data Akun Murid: RPC `ubah_profil_murid` dibuat ulang — whitelist + `no_telepon_ortu` (isian "No HP/WA Orang Tua/Wali") & `catatan_khusus` (isian "Keterangan"; keduanya kolom lama, tanpa migrasi) + verifikasi kepemilikan (hanya admin/murid pemilik NIS). UI: pratinjau iframe Google Maps + tombol "Buka Google Maps" di form murid; CSP `frame-src` untuk `maps.google.com`/`www.google.com` ditambahkan di `web/index.html`.

51. `upgrade_20261014_wajah.sql` — Pengenalan wajah (face scan): kolom `wajah_descriptor jsonb` (128 angka deskriptor wajah face-api.js) + `wajah_status text` ('aktif'/'nonaktif'/NULL) di `akun`; RPC security definer `simpan_wajah_murid(p_nis, p_descriptor, p_status, p_pemanggil_nis, p_pemanggil_tipe)` = satu-satunya penulis kolom wajah (admin ATAU murid pemilik NIS; validasi array 128 angka; `p_status` NULL/'' menghapus). Frontend: `web/vendor/face-api.min.js` + `web/models/` (lokal, offline-friendly) dimuat di `index.html`; `web/js/face.js` menyediakan tab "Registrasi Wajah" di Manajemen Akun Murid (daftar + status + kelola per murid via foto Drive CORS-safe lh3 ATAU kamera) dan tombol "Face Scan" di modal absensi (pencocokan jarak Euclidean client-side → set radio "H" tanpa kirim foto; simpan tetap lewat `save_absen_masal` yang ada).

52. `upgrade_20261014b_fix_nilai_grant.sql` — perbaikan menu **Input Nilai** gagal memuat semua kategori (Pengetahuan/Keterampilan/Sikap/Ekstrakurikuler) dengan pesan "Gagal memuat data. Periksa koneksi internet Anda." Penyebab asli di Network tab: HTTP 401 — `permission denied for table nilai_konfigurasi` (Postgres 42501) karena GRANT privilege tabel untuk role API belum (lengkap) ter-apply di database hidup (RLS policy saja tidak cukup). Grant `select, insert, update, delete` untuk `authenticated` pada `nilai_konfigurasi`, `nilai_teman_sejawat`, `jurnal_sikap` + reload cache PostgREST. Idempotent.

> **Catatan:** `gabungan.sql` saat ini hanya mencakup s.d. file #30 (2026-09-22). Untuk project BARU, jalankan `gabungan.sql` lalu jalankan file #31-55 secara terpisah, urut tanggal.

## Cara menjalankan di Supabase

1. Login ke [supabase.com](https://supabase.com) → pilih project.
2. Menu kiri: **SQL Editor** → **New query**.
3. **Salin seluruh isi** file SQL (atau klik ikon upload untuk memasang file `.sql`).
4. Klik **Run** (atau `Ctrl+Enter`).
5. Verifikasi lewat **Table Editor**: semua tabel & kolom sudah muncul.

53. `upgrade_20261014c_absen_mandiri_rpc.sql` — perbaikan absen mandiri yang tampak "Berhasil" tapi tidak tersimpan: RPC security definer `absen_mandiri(p_nis, p_nama, p_kelas, p_tahun, p_bulan, p_mapel, p_captcha, p_gps, p_wajah_cocok, p_tanggal)` = satu-satunya pintu tulis absen mandiri. Tanggal SELALU hari ini WIB (bukan turunan currentTahun/currentBulan browser yang basi), validasi captcha + sesi guru Kunci Absen BUKA DI SERVER (kolom akun.captcha tak lagi dibaca klien), upsert ON CONFLICT (nis,tanggal,mapel), kolom baru `absensi.wajah_cocok` utk verifikasi face scan opsional, semester/bulan/tahun-pelajaran diturunkan dari tanggal bila label klien basi. Frontend (`web/js/utils.js`/`utils.example.js`): pakai RPC dulu, fallback lama bila PGRST202. `web/js/app.js`: tombol opsional "Pindai Wajah Saya" di panel absen mandiri + badge terverifikasi. `web/js/face.js`: export `FaceWajah.pindaiWajahMandiri` (single-label matcher, kamera depan, ambang 0.5).

54. `upgrade_20261014d_absen_mandiri_integrasi.sql` — integrasi Absen Mandiri ke rekap guru Mapel & Ekskul: RPC `absen_mandiri` dibuat ulang dengan parameter baru `p_jenis` ('Mapel'/'Ekskul'); tanggal SELALU `(now() at time zone 'Asia/Jakarta')::date` — `p_tanggal` browser kini DIIGNOR; nama diambil server dari `akun.nama_lengkap`; kelas Mapel = `akun.riwayat_kelas[TA]->>'kelas'` (fallback `tingkat_kelas`, siswa non-Aktif di TA ditolak) — PERSIS logika `get_dashboard_data` sehingga baris langsung tampil di rekap guru; kelas Ekskul = `'Semua Kelas'` + validasi keanggotaan (`akun.ekstrakurikuler`); overload v1 di-`drop`. Frontend (`web/js/utils.js`/`utils.example.js`): kirim `p_jenis`; fallback Ekskul menulis `kelas:'Semua Kelas'`; `web/js/app.js`: toast sukses menampilkan Mapel/Ekskul • kelas • bulan • tahun dari respons server.

55. `upgrade_20261014e_wajah_multi.sql` — akurasi & kenyamanan face scan (Fase 1–2; teknik multi-pose/min-distance diadopsi dari repo `ManageWithNoobItGuy/GAS-attendance-facescanner-with-gps-V2`, **data tetap 100% di Supabase**): migrasi data `akun.wajah_descriptor` dari FLAT `[128 angka]` → ARRAY-OF-ARRAYS (multi-sampel, maks 6) — baris lama di-`update` sekali (idempotent); RPC `simpan_wajah_murid` dibuat ulang + parameter `p_mode` (`'ganti'` = timpa seluruh sampel, terima 1 vektor ATAU daftar; `'tambah'` = sisipkan 1 sampel di belakang data lama yang otomatis dibungkus; cap 6 di server), overload v1 (5 param) di-`drop`. Frontend (`web/js/face.js`): `normalisasiDescriptorWajah` kompatibel mundur (flat & array-of-arrays), `buatMatcherDariPeta` memakai SEMUA sampel per NIS (min-distance via FaceMatcher), registrasi multi-pose di modal (tiap "Deteksi dari Kamera" MENAMBAH sampel + saran pose bergilir + jarak ke sampel terdekat & % kemiripan + hapus semua), % kemiripan ditampilkan saat scan; startup lebih cepat — model dimuat PARALEL dengan buka kamera (fallback berantai environment→user→default, dropdown pilih kamera, indikator progres unduhan), pre-warm model saat halaman idle, retry unduhan ber-backoff (3×), loop deteksi lebih ringan (TinyFaceDetector inputSize 224, jeda 400 ms vs 320/180).