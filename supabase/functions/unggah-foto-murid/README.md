# unggah-foto-murid — Setup Manual (Google Drive API)

Edge Function ini mengunggah foto siswa ke **Google Drive** (bukan Supabase Storage)
menggunakan service account, lalu menyimpan URL hasilnya ke `akun.url_foto`.

> Prasyarat database: jalankan `supabase/sql/upgrade_20261011_akun_murid_foto_medsos.sql`
> (membuat kolom `url_foto`, `alamat_maps`, `media_sosial` + RPC `simpan_foto_murid`).

## 1. Aktifkan Google Drive API

1. Buka <https://console.cloud.google.com/> → buat/pilih project (mis. `sisip-drive`).
2. Menu **APIs & Services → Library** → cari **Google Drive API** → **Enable**.
3. (Opsional) Tampilkan halaman utama Drive API untuk mengecek kuota.

## 2. Buat Service Account + kunci JSON

1. **APIs & Services → Credentials → Create Credentials → Service Account**.
   - Nama: `sisip-drive-sa` → **Create and Continue** → tanpa role → **Done**.
2. Klik service account → tab **Keys → Add Key → Create new key → JSON → Create**.
   Sebuah file `.json` terunduh — isinya nanti disimpan sebagai secret
   `DRIVE_SERVICE_ACCOUNT_JSON` (petik-json sekali dengan `''` di shell).
3. Catat **email service account** (format `sisip-drive-sa@<project>.iam.gserviceaccount.com`).

## 3. Buat folder tujuan & bagikan ke service account

1. Di Google Drive biasa: buat folder, mis. **Foto Siswa**.
2. Buka folder → **Share** → masukkan email service account → role **Editor**
   (perlu permission: service account harus bisa mengupload & membuat file).
3. Salin **ID folder** dari URL: `https://drive.google.com/drive/folders/<FOLDER_ID>`.

## 4. Set secret di Supabase

Dua secret wajib diset: `DRIVE_SERVICE_ACCOUNT_JSON` (isi file kunci JSON hasil
unduhan service account) dan `DRIVE_MURID_FOLDER_ID` (ID folder tujuan foto siswa).

### Cara 1 — lewat CLI (opsional)

```
supabase secrets set DRIVE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...","client_email":"sisip-drive-sa@...iam.gserviceaccount.com","token_uri":"https://oauth2.googleapis.com/token",...}'
supabase secrets set DRIVE_MURID_FOLDER_ID='<FOLDER_ID>'
```

### Cara 2 — lewat Dashboard (tanpa login CLI)

1. Buka Dashboard → pilih project → menu **Edge Functions** → tab **Secrets**.
2. Klik **New secret** → isi *Name* `DRIVE_SERVICE_ACCOUNT_JSON`, *Value* diisi
   **seluruh isi file kunci JSON** service account (buka file `.json` di text editor,
   salin semua, tempel apa adanya).
3. Klik **New secret** lagi → *Name* `DRIVE_MURID_FOLDER_ID`, *Value* = ID folder
   (mis. `1AbC...xyz` dari URL `https://drive.google.com/drive/folders/<FOLDER_ID>`).
4. Setelah secret diset, **deploy ulang fungsi** (lihat langkah 5) — secret baru
   terbaca oleh fungsi yang sudah berjalan hanya setelah deploy baru.

> ⚠️ **Tempel apa adanya, JANGAN reformat / pretty-print JSON-nya.** Nilai
> `private_key` berisi urutan `\n` (dua karakter: backslash + n) yang harus tetap
> berbentuk `\n` di dalam string. Kalau dipecah menjadi baris baru sungguhan,
> `JSON.parse` di fungsi gagal dan upload membalas `500 "Konfigurasi Drive tidak valid"`.

## 5. Deploy

> **Fungsi yang belum di-deploy = HTTP 404.** Set secret saja TIDAK membuat fungsi
> muncul di `https://<ref>.supabase.co/functions/v1/unggah-foto-murid`. Wajib deploy
> dulu, baru upload dari browser bisa jalan.

### Cara 1 — lewat CLI

```
npx supabase functions deploy unggah-foto-murid --project-ref <PROJECT_REF>
```

### Cara 2 — lewat Dashboard (tanpa login CLI)

1. Dashboard → pilih project → menu **Edge Functions** → tombol **Deploy a function**.
2. Bila diminta, hubungkan repositori GitHub (pilih repo & folder yang memuat
   `supabase/functions`).
3. Pilih fungsi `unggah-foto-murid` → **Deploy**, lalu tunggu status
   **Deploying → Ready**.

> Setiap kali `index.ts` diubah, wajib deploy ulang (CLI atau Dashboard) agar versi
> terbaru (termasuk perbaikan CORS/OPTIONS) terpasang.

> `config.toml` sudah memuat `[functions.unggah-foto-murid] verify_jwt = false`
> — wajib karena murid lokal (login NIS+password) tidak punya JWT Supabase.
> Otorisasi tetap dijaga: RPC `simpan_foto_murid` hanya mengizinkan **admin** atau
> **murid pemilik NIS**, dan kunci private service account tidak pernah keluar server.

## Pemecahan Masalah

| Gejala | Penyebab | Solusi |
|---|---|---|
| 404 `NOT_FOUND` di URL fungsi | Fungsi belum di-deploy | `npx supabase functions deploy unggah-foto-murid --project-ref <PROJECT_REF>` atau Dashboard → Edge Functions → Deploy. |
| CORS preflight gagal (browser: "Status code: 404") | Akibat 404 di atas — browser tak bisa preflight ke fungsi yang belum ada | Deploy dulu. Fungsi ini menangani `OPTIONS` (balas 200 + `Access-Control-Allow-Origin: *`), jadi preflight sukses setelah deploy. |
| 401 `Unauthorized` | Header `apikey`/`Authorization` tidak terkirim | Frontend sudah mengirim keduanya; pastikan `web/js/utils.js` berisi `SUPABASE_URL` & anon key project yang sama dengan ref deploy. |
| 500 `Google Drive belum dikonfigurasi admin` | Salah satu secret belum ada | Set `DRIVE_SERVICE_ACCOUNT_JSON` & `DRIVE_MURID_FOLDER_ID` (Cara 1/2 di atas) lalu **deploy ulang**. |
| 500 `Konfigurasi Drive tidak valid` | Isi secret JSON ter-reformat / `private_key` kepecah jadi baris sungguhan | Tempel ulang isi file kunci **apa adanya** (jangan di-pretty-print) → deploy ulang. |
| 403 dari Google Drive saat upload | Folder tujuan tidak dibagikan ke service account | Share folder Drive → email `client_email` service account → role **Editor**. |
| Error jaringan tidak jelas di browser | Halaman dibuka lewat `file://` | Buka lewat server `python3 -m http.server 3007 -d web` atau GitHub Pages. |

## Prilaku

- Nama file: `{NIS}_{TA}_{Kelas}.jpg` (disanitasi) — contoh `12045_2026-2027_XII-TKJ-1.jpg`.
- File di-upload dengan izin **"Siapa saja yang memiliki link → Pembaca"** (anyone reader),
  sehingga `<img>` di aplikasi & lembar cetak bisa menampilkannya tanpa login Google.
- URL yang disimpan: `https://drive.google.com/thumbnail?id=<FILE_ID>&sz=w1000`.
- File Drive lama tidak dihapus otomatis saat foto diganti (agar aman/unreversible); hapus
  manual di folder bila perlu.