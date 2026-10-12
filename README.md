# Administrasi-Sekolah

**SISIP** — Sistem Informasi Sekolah Indonesia pintar

Aplikasi web statis (HTML + JS + Tailwind CSS v4) yang terhubung **langsung ke Supabase**
(PostgreSQL + RLS + RPC). Tidak ada backend terpisah — seluruh API memakai Supabase
PostgREST & fungsi RPC.

| Bagian | Lokasi | Keterangan |
|---|---|---|
| Frontend | `web/` | HTML + JS murni + Tailwind v4, `@supabase/supabase-js` via CDN |
| Database | `supabase/sql/` | Skema SQL + upgrade berkala; versi lengkap di `supabase/sql/versi-sekarang/` |
| Deploy | GitHub Pages (default) / Vercel (alternatif) | GitHub Pages: otomatis saat push ke `main` (workflow `.github/workflows/static.yml`, folder `web/`). Vercel: lihat [bagian 5](#5-deploy--vercel-alternatif) |

## Menjalankan Lokal

```bash
npm install            # pasang Tailwind CLI
npm run build:css      # kompilasi Tailwind -> web/css/style.css
npm run dev:css        # (opsional) mode watch saat develop

npx serve web          # buka aplikasi (atau server statis apa pun)
```

> Koneksi database bisa diarahkan ke project Supabase mana pun lewat panel
> **Konfigurasi Server** (ikon gear di kartu login) — lihat bagian
> [Menghubungkan Aplikasi ke Supabase](#3-menghubungkan-aplikasi-ke-supabase).

---

## 1. Tutorial Upload ke GitHub

Repo: <https://github.com/BrazaMuzti/Administrasi-Sekolah>

### a. Sekali saja — inisialisasi & koneksi remote

```bash
git init                       # bila belum jadi repo
git branch -M main             # pastikan nama cabang utama = main
git remote add origin https://github.com/BrazaMuzti/Administrasi-Sekolah.git
```

### b. Setiap kali selesai mengubah kode

```bash
git add .                      # atau pilih file tertentu: git add web/ supabase/
git commit -m "deskripsi perubahan"
git push origin main           # dorong ke GitHub
```

### c. Push pertama kali dari komputer baru

```bash
git clone https://github.com/BrazaMuzti/Administrasi-Sekolah.git
cd Administrasi-Sekolah
npm install
```

> **Autentikasi push:** GitHub tidak lagi menerima password. Gunakan
> **Personal Access Token** (Settings → Developer settings → PAT) sebagai pengganti
> password, atau login via `gh auth login` (GitHub CLI), atau SSH key.

Setelah push ke `main`, **GitHub Pages otomatis ter-deploy** (lihat bagian
[Deploy](#4-deploy--github-pages-otomatis)) — cek tab **Actions** di repo untuk progres.

---

## 2. Tutorial Upload SQL ke Supabase

### a. Buat project Supabase (sekali saja)

1. Login ke <https://supabase.com> → **New project**.
2. Isi nama (mis. `siakad`), password database (SIMPAN — tidak bisa dilihat lagi),
   region terdekat (mis. Singapore) → **Create new project**.
3. Tunggu ± 2 menit sampai project aktif.

### b. Jalankan skema database

1. Menu kiri: **SQL Editor** → **New query**.
2. Pilih file SQL sesuai kondisi database:

| Kondisi | File yang dijalankan |
|---|---|
| **Project baru / kosong** | `supabase/sql/versi-sekarang/gabungan.sql` — gabungan seluruh 30 upgrade (2026-09-03 s.d. 2026-09-22), sekali jalan |
| **Project sudah berjalan**, tertinggal beberapa upgrade | file satu-persatu di `supabase/sql/`, **urut tanggal**, hanya yang belum ada di database |

3. Salin seluruh isi file ke SQL Editor (atau pakai tombol **upload** file `.sql`)
   → klik **Run** (`Ctrl+Enter`).
4. Verifikasi: buka **Table Editor** — semua tabel & kolom harus sudah muncul
   (`akun`, `master_data`, `absensi`, `nilai`, `ekstrakurikuler`, dst.).

> Semua file SQL **idempotent** (aman dijalankan berulang). Daftar lengkap isi &
> urutan 30 file ada di `supabase/sql/versi-sekarang/README.md`.
> File `uji_data.sql` / `uji_bersih.sql` khusus pengujian E2E — jangan dijalankan di produksi.

---

## 3. Menghubungkan Aplikasi ke Supabase

Aplikasi butuh dua kredensial dari project Supabase:

1. Buka dashboard Supabase → **Project Settings** (ikon gear) → **API** (atau **Data API**).
2. Salin:
   - **Project URL** — bentuk `https://xxxxxxxx.supabase.co`
   - **Publishable / anon key** — kunci publik (`sb_publishable_...` atau `eyJ...`)

### a. Cara bawaan (default tertanam)

Nilai default sudah tertanam di `web/js/utils.js`:

```js
const SUPABASE_URL_DEFAULT = 'https://xxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY_DEFAULT = 'sb_publishable_...';
```

Ganti dua baris ini **sebelum deploy** bila memakai project Supabase lain.

### b. Override tanpa ubah kode (per browser)

Di kartu login, klik **ikon gear** (kanan atas) → modal **Konfigurasi Server**:

- **URL**: `https://xxxxxxxx.supabase.co`
- **Anon key**: `sb_publishable_...` / `eyJ...`
- (Opsional) **Client ID Google** untuk fitur sinkron Google Calendar.

Simpan → tersimpan di `localStorage` browser tersebut, langsung terpakai tanpa reload.

### c. Aktifkan penyedia login (OAuth)

Bila memakai login Google/GitHub:

1. Supabase → **Authentication → Sign In / Providers**.
2. Aktifkan provider (Google / GitHub), isi Client ID & Secret dari
   Google Cloud Console / GitHub OAuth App.
3. Tambahkan domain Pages ke **Authentication → URL Configuration → Redirect URLs**,
   mis. `https://brazamuzti.github.io/Administrasi-Sekolah/**`.

### Catatan keamanan

Anon/publishable key memang **publik** — keamanan data dijaga oleh **Row Level
Security (RLS)** dan RPC yang sudah dikonfigurasi di file SQL. Jangan pernah
menaruh `service_role key` di kode frontend.

---

## 4. Deploy — GitHub Pages (Otomatis)

Deploy frontend tidak butuh perintah apa pun:

1. `git push origin main` → workflow **Deploy static content to Pages** berjalan otomatis
   (cek tab **Actions** di repo).
2. Aplikasi terbit di:
   `https://brazamuzti.github.io/Administrasi-Sekolah/`
3. Workflow mem-publish folder **`web/`** apa adanya — jadi pastikan `web/css/style.css`
   hasil `npm run build:css` sudah ter-commit setiap kali kelas utilitas Tailwind berubah.
4. Deploy ulang manual: repo → **Actions** → pilih workflow → **Run workflow**.

## 5. Deploy — Vercel (Alternatif)

Selain GitHub Pages, aplikasi ini juga bisa di-deploy ke **Vercel**. Repo sudah
menyertakan `vercel.json` dan `scripts/generate-utils.mjs` yang meng-generate
`web/js/utils.js` (di-gitignore) dari template `web/js/utils.example.js` +
Environment Variables saat build — jadi kredensial Supabase tidak perlu
di-commit ke repo.

### a. Import project

1. Login ke <https://vercel.com> → **Add New… → Project**.
2. Pilih **Import Git Repository** → hubungkan akun GitHub bila belum →
   pilih repo `BrazaMuzti/Administrasi-Sekolah`.
3. Pada layar konfigurasi:
   - **Framework Preset**: `Other` (situs statis biasa).
   - **Build Command**: `npm run build:css && node scripts/generate-utils.mjs`
     (sudah otomatis terbaca dari `vercel.json`, tidak perlu diisi manual).
   - **Output Directory**: `web` (juga sudah otomatis dari `vercel.json`).

### b. Set Environment Variables

Di layar yang sama (atau di **Project Settings → Environment Variables**
setelah project dibuat), tambahkan:

| Key | Value | Environment |
|---|---|---|
| `SUPABASE_URL` | `https://xxxxxxxx.supabase.co` (Project URL Supabase) | Production, Preview, Development |
| `SUPABASE_ANON_KEY` | `sb_publishable_...` / `eyJ...` (Publishable/anon key) | Production, Preview, Development |

> Tanpa kedua variabel ini, build **akan gagal** — `scripts/generate-utils.mjs`
> sengaja keluar dengan error jelas bila salah satu kosong, supaya deploy tidak
> pernah menghasilkan `utils.js` yang rusak/kosong.

### c. Deploy

1. Klik **Deploy** → tunggu build selesai.
2. Aplikasi terbit di URL bawaan Vercel, mis. `https://administrasi-sekolah.vercel.app`
   (bisa diganti custom domain di **Project Settings → Domains**).
3. Deploy ulang otomatis setiap `git push` ke branch yang di-tracking Vercel
   (default `main`); Preview Deployment otomatis dibuat untuk branch/PR lain.
4. Deploy manual via CLI (opsional):
   ```bash
   npm i -g vercel        # sekali saja
   vercel login
   vercel --prod          # deploy ke production
   ```

## 6. Fitur Foto Siswa, Media Sosial & Alamat Maps (Data Akun Murid)

Data Akun Murid kini mendukung **foto siswa di Google Drive** (integrasi via Service Account +
Google Drive API v3 langsung dari Edge Function — *bukan* GAS Web App, yang terbukti menolak
DriveApp untuk pemanggil anonim), **media sosial** (jsonb), **alamat Google Maps** (tautan,
dibuka tab baru — iframe tidak dipasang karena kebijakan CSP `frame-ancestors`), **dropdown
agama** pada profil murid, **tampilan jabatan ekstrakurikuler**, dan **cetak lembar foto siswa**.

### Persyaratan (sekali saja)

1. **Database** — jalankan `supabase/sql/upgrade_20261011_akun_murid_foto_medsos.sql`
   di Supabase SQL Editor (kolom `url_foto`, `alamat_maps`, `media_sosial` + RPC
   `simpan_foto_murid`).
2. **Service Account Google** — ikuti panduan `supabase/functions/unggah-foto-murid/README.md`:
   buat service account di project GCP `sisip-510803` (kunci JSON), **pindahkan folder**
   **"Foto Siswa"** (`1jDdMHiMJI_eCmj4pxxL0E0yRw5jqtNb_`) ke **Google Shared Drive** dan
   bagikan shared drive ke email SA sebagai **Content manager**, pastikan **Google Drive API**
   enabled. ⚠️ SA **tidak punya kuota My Drive** — folder tujuan wajib di Shared Drive,
   kalau tidak Google menolak upload dengan `403 Service Accounts do not have storage quota`.
3. **Secret & deploy Edge Function**:
   ```bash
   supabase secrets set GOOGLE_SA_JSON='<isi lengkap file JSON kunci service account>'
   supabase secrets set DRIVE_FOLDER_ID='1jDdMHiMJI_eCmj4pxxL0E0yRw5jqtNb_'
   npx supabase functions deploy unggah-foto-murid --project-ref <PROJECT_REF>
   ```
   > Untuk `GOOGLE_SA_JSON` lebih aman tempel utuh lewat Dashboard → *Edge Functions → Secrets*
   > (menghindari masalah quoting JSON bertingkat di shell).

### Keamanan

- Edge Function `unggah-foto-murid` memakai `verify_jwt = false` karena murid "lokal"
  (login NIS+password) tidak punya JWT Supabase; otorisasi dijaga bertingkat:
  verifikasi JWT RS256 bila ada **dan** RPC `simpan_foto_murid` (security definer)
  yang hanya mengizinkan **admin** atau **murid pemilik NIS** untuk menulis `url_foto`.
- Kunci privat service account **tidak pernah** keluar dari server (hanya di Supabase secret
  `GOOGLE_SA_JSON`; file JSON asli jangan di-commit ke repo).
- File foto diberi izin "Siapa saja yang memiliki link – Pembaca" agar bisa tampil di
  `<img>`/cetak; nama file `{NIS}_{TA}_{Kelas}.jpg`.

### Perintah Cepat

```bash
npm run build:css      # build CSS produksi (minify)
npm run dev:css        # watch mode CSS
npm run test:e2e       # uji E2E API (butuh kredensial & data uji terpasang)
npm run deploy         # sama dengan build:css
```
---

## 7. Sumber Referensi — Face Scanner (Absensi Wajah)

Fitur face scan (registrasi wajah & pencocokan descriptor) diadaptasi dari proyek open
source berikut. **Tekniknya** yang diadopsi, sedangkan **penyimpanan data tetap memakai
Supabase** (bukan Google Sheets / Apps Script seperti repo aslinya).

- **Repo referensi**: <https://github.com/ManageWithNoobItGuy/GAS-attendance-facescanner-with-gps-V2>
- **Yang diadopsi**:
  - Registrasi wajah **beberapa pose** per murid (deskriptor 128D per pose), bukan satu foto.
  - Pencocokan **jarak Euclidean minimum** terhadap seluruh sampel milik seorang murid.
  - **Ambang kesamaan (threshold)** untuk memutuskan cocok / tidak dikenali.
- **Yang tidak diadopsi**:
  - Google Apps Script & Google Sheets — semua data tetap tersimpan di **Supabase**.
  - Fitur GPS geofencing — bukan kebutuhan aplikasi sekolah saat ini (bisa ditambah belakangan).
- **Implementasi di proyek ini**: `web/js/face.js` (face-api.js + model lokal `web/models/`,
  offline-friendly); penyimpanan descriptor di kolom `akun.wajah_descriptor` lewat RPC
  `simpan_wajah_murid` (lihat `supabase/sql/versi-sekarang/upgrade_20261014_wajah.sql`).
- **Migrasi multi-sampel & tuning startup**: `supabase/sql/versi-sekarang/upgrade_20261014e_wajah_multi.sql`
  — `wajah_descriptor` flat `[128 angka]` → array-of-arrays (maks 6 sampel/murid), RPC
  `simpan_wajah_murid` + `p_mode 'ganti'/'tambah'`; frontend: registrasi multi-pose + min-distance
  matching + kamera fallback & pre-warm model.
