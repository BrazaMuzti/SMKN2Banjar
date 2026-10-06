# unggah-foto-murid — Setup Manual (Google Drive via Service Account)

Edge Function ini mengunggah foto siswa ke **Google Drive** (bukan Supabase Storage)
via **Google Drive API v3**, lalu menyimpan URL hasilnya ke `akun.url_foto`.

> **Kenapa Service Account (bukan GAS Web App)?** (Keputusan 2026-10-06 — didokumentasikan;
> GAS sebelumnya dipakai, tapi: Web App GAS "Execute as Me" menolak akses DriveApp untuk
> pemanggil ANONIM — terbukti `Access denied: DriveApp` pada curl/Edge Function, padahal
> Boundary sudah benar. Service account menandatangani JWT sendiri (RS256), menukarnya
> dengan akses token OAuth2, lalu upload via Drive API — tanpa consent screen dan tanpa
> batasan pemanggil anonim.)

> **Prasyarat database:** jalankan `supabase/sql/upgrade_20261011_akun_murid_foto_medsos.sql`
> (membuat kolom `url_foto`, `alamat_maps`, `media_sosial` + RPC `simpan_foto_murid`).

## Siapkan Service Account (sekali saja, ±5 menit)

1. Buka <https://console.cloud.google.com/iam-admin/serviceaccounts?project=sisip-510803>
   (project yang sama tempat Drive API sudah di-enable).
2. **Create service account** — beri nama mis. `supabase-drive-upload`, klik Done.
3. Di baris SA → menu **⋯** (Actions) → **Manage keys** → **ADD KEY → Create new key** →
   pilih **JSON** → **Create** → file `.json` terunduh. ⚠️ Simpan aman; file ini berisi kunci
   privat. Jangan commit ke repo.
4. **Google Shared Drive (wajib untuk kuota SA)**: Service Account **tidak punya
   kuota penyimpanan My Drive** — menulis ke folder di My Drive mana pun selalu
   ditolak Google dengan `403 "Service Accounts do not have storage quota"`.
   Maka folder tujuan **harus berada di Google Shared Drive**:
   - Buka <https://drive.google.com> → kiri **Shared drives** → pakai/buat drive
     (project ini memakai **`SISIP`**, drive ID `0ACjDwF0G1CkUUk9PVA`).
   - Buat **folder baru di dalam shared drive** (klik kanan di area drive →
     **New folder**; mis. `Foto Siswa`). Catat ID-nya dari URL — contoh
     `1jDdMHiMJI_eCmj4pxxL0E0yRw5jqtNb_` — lalu set ke secret `DRIVE_FOLDER_ID`.
     ⚠️ **Jangan** cukup "share" folder dari My Drive (403 kuota tetap muncul);
     folder harus benar-benar *berada* di dalam shared drive.
   - Di halaman shared drive → **Share drive** → tambahkan **email service account**
     (`<nama>@sisip-510803.iam.gserviceaccount.com`) → peran **Content manager**
     (minimal Contributor cukup untuk upload+share; Content manager agar bisa hapus/kelola).
   - Pastikan kebijakan shared drive mengizinkan **"Anyone with the link"** —
     fungsi membuka akses `anyone → reader` agar foto tampil tanpa login.
   - Verifikasi dari kode/SA: daftarkan isi shared drive (`corpora=drive`,
     `includeItemsFromAllDrives=true`, `supportsAllDrives=true`) — folder harus
     muncul di daftar. Catatan: folder yang baru dibuat bisa butuh beberapa detik
     sebelum terlihat SA (jeda propagasi; sempat `404` sesaat).
5. Pastikan **Google Drive API** berstatus Enabled: *APIs & Services → Library* → cari
   "Google Drive API" → jika belum, klik Enable.

### Set secret di Supabase

| Secret | Isi |
|---|---|
| `GOOGLE_SA_JSON` | **Isi (teks)** file JSON kunci service account yang diunduh — memuat `client_email` & `private_key`. Set via Dashboard → *Edge Functions* → *Secrets* (tempel utuh). |
| `DRIVE_FOLDER_ID` | `1jDdMHiMJI_eCmj4pxxL0E0yRw5jqtNb_` (folder "Foto Siswa" **di dalam shared drive `SISIP`**) |

Cara lama `GAS_UPLOAD_URL` / `GAS_UPLOAD_TOKEN` sudah tidak dipakai — boleh dihapus dari secret.

## (Arsip) Cara lama — Google Apps Script (GAS) Web App

> Disimpan untuk referensi/historis. GAS **tidak dipakai lagi** karena batasan DriveApp
> untuk pemanggil anonim. Kode tetap ada di `Code.gs`.

1. Buka <https://script.google.com/> dan buat proyek baru.
2. Beri nama proyek, lalu masukkan kode script berikut untuk menerima file upload:

```javascript
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // 1. (DISARANKAN) Verifikasi token rahasia — cegah orang asing mengisi Drive.
    //    Set Script Property "UPLOAD_TOKEN" dulu (lihat langkah 3).
    var tokenBenar = PropertiesService.getScriptProperties().getProperty("UPLOAD_TOKEN");
    if (!tokenBenar || data.token !== tokenBenar) {
      return kirimJson({ status: "error", message: "Token tidak valid." });
    }

    // 2. (DISARANKAN) Validasi tipe file & ukuran
    var mime = String(data.mimeType || "");
    if (["image/jpeg", "image/png", "image/webp", "image/gif"].indexOf(mime) === -1) {
      return kirimJson({ status: "error", message: "Tipe file tidak diizinkan." });
    }
    var b64 = String(data.base64 || "");
    if (!b64 || b64.length < 100) return kirimJson({ status: "error", message: "Foto kosong." });
    if (b64.length > 4700000) return kirimJson({ status: "error", message: "Ukuran foto melebihi 3,5 MB." });

    var folderId = "MASUKKAN_FOLDER_ID_GOOGLE_DRIVE_ANDA_DI_SINI"; // ID folder tujuan di Drive
    var folder = DriveApp.getFolderById(folderId);

    // Decode data base64 gambar
    var decodedData = Utilities.base64Decode(b64);
    var blob = Utilities.newBlob(decodedData, mime, String(data.filename || "foto.jpg"));

    // Simpan file ke Google Drive
    var file = folder.createFile(blob);

    // Set agar file bisa diakses publik (opsional, jika ingin link gambarnya bisa langsung dibuka)
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return kirimJson({
      status: "success",
      fileId: file.getId(),
      fileUrl: "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w1000",
      viewUrl: file.getUrl(),
      downloadUrl: file.getDownloadUrl()
    });
  } catch (error) {
    return kirimJson({ status: "error", message: error.toString() });
  }
}

function kirimJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

> **Catatan:** versi lengkap + berkomentar ada di file `Code.gs` di folder fungsi ini
> (ID folder & token dibaca dari Script Properties, bukan hardcode). File `index.ts`
> di repo mengirim `{ filename, mimeType, base64, token }` — bila snippet di atas
> disederhanakan, pastikan nama field tetap sama.

3. **Ganti folder ID**: ganti literal `"MASUKKAN_FOLDER_ID_GOOGLE_DRIVE_ANDA_DI_SINI"`
   dengan **ID folder** tujuan — hanya potongan 33 karakter setelah `/folders/` di URL
   Drive (mis. `1AbC...xyz`), **BUKAN URL lengkap** dari address bar.
4. **(Disarankan) Pasang token**: buka **Project Settings → Script Properties** →
   tambahkan `UPLOAD_TOKEN` dengan token acak ±32 karakter (mis. `openssl rand -hex 24`).
   Token ini HARUS sama dengan secret `GAS_UPLOAD_TOKEN` di Supabase.
5. **Deploy**: **Deploy → New deployment → Web app**:
   - *Description*: `unggah-foto-murid`
   - *Execute as*: **Me**
   - *Who has access*: **Anyone** (wajib agar bisa dipanggil programatik dari Edge Function)
   - Salin **URL `/exec`** (mis. `https://script.google.com/macros/s/XXXXXXXX/exec`).
6. Setiap kali kode script **diedit**, wajib buat **versi baru**
   (Deploy → Manage deployments → Edit → **New version**) — perubahan tidak aktif otomatis.

## Set secret di Supabase

Dua secret wajib: `GOOGLE_SA_JSON` (isi JSON kunci service account) dan `DRIVE_FOLDER_ID`
(ID folder tujuan).

### Cara 1 — lewat CLI

```
supabase secrets set DRIVE_FOLDER_ID='1jDdMHiMJI_eCmj4pxxL0E0yRw5jqtNb_'
supabase secrets set GOOGLE_SA_JSON='<isi lengkap file JSON kunci service account>'
```

### Cara 2 — lewat Dashboard (tanpa login CLI)

1. Dashboard → pilih project → menu **Edge Functions** → tab **Secrets**.
2. Klik **New secret** → *Name* `GOOGLE_SA_JSON`, *Value* = tempel **seluruh isi** file
   JSON kunci service account (memuat `client_email` & `private_key`).
3. Klik **New secret** → *Name* `DRIVE_FOLDER_ID`, *Value* = `1jDdMHiMJI_eCmj4pxxL0E0yRw5jqtNb_`.
4. Setelah secret diset, **deploy ulang fungsi** (lihat bagian "Deploy") — secret baru
   terbaca oleh fungsi yang berjalan hanya setelah deploy ulang.

> Secret lama `GAS_UPLOAD_URL` / `GAS_UPLOAD_TOKEN` (metode GAS) tidak dipakai lagi —
> boleh dihapus dari Dashboard bila ingin.

## Deploy

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
3. Pilih fungsi `unggah-foto-murid` → **Deploy**, lalu tunggu status **Deploying → Ready**.

> `config.toml` sudah memuat `[functions.unggah-foto-murid] verify_jwt = false`
> — wajib karena murid lokal (login NIS+password) tidak punya JWT Supabase.
> Otorisasi tetap dijaga: RPC `simpan_foto_murid` hanya mengizinkan **admin** atau
> **murid pemilik NIS**, dan kunci privat service account tidak pernah keluar server.

## Pemecahan Masalah

| Gejala | Penyebab | Solusi |
|---|---|---|
| 404 `NOT_FOUND` di URL fungsi | Fungsi belum di-deploy | `npx supabase functions deploy unggah-foto-murid --project-ref <PROJECT_REF>` atau Dashboard → Edge Functions → Deploy. |
| CORS preflight gagal (browser: "Status code: 404") | Akibat 404 di atas — browser tak bisa preflight ke fungsi yang belum ada | Deploy dulu. Fungsi menangani `OPTIONS` (balas 200 + `Access-Control-Allow-Origin: *`). |
| 401 `Unauthorized` | Header `apikey`/`Authorization` tidak terkirim | Pastikan `web/js/utils.js` berisi `SUPABASE_URL` & anon key project yang sama dengan ref deploy. |
| 500 `Upload Drive belum dikonfigurasi admin` | `GOOGLE_SA_JSON` / `DRIVE_FOLDER_ID` belum diset | Set `DRIVE_FOLDER_ID` & tempel isi JSON kunci SA ke `GOOGLE_SA_JSON`, lalu **deploy ulang**. |
| Token Google: `invalid_grant` | Kunci SA salah/kedaluwarsa atau `GOOGLE_SA_JSON` tidak utuh | Unduh ulang kunci JSON, set ulang secret; pastikan `client_email` & `private_key` ada di dalamnya. |
| 403 `Service Accounts do not have storage quota` | Folder tujuan masih berada di **My Drive** — SA tidak punya kuota sendiri | Pindahkan folder ke **Google Shared Drive** & bagikan shared drive ke SA (Content manager). ID folder tidak berubah. |
| Drive menolak upload: 403 `The caller does not have permission` | SA bukan member shared drive / folder belum dipindah | Pastikan folder di Shared Drive & SA diberi **Content manager** di {shared drive → Share drive}. |
| `Gagal membuka akses publik file Drive` | Kebijakan Workspace memblokir sharing "anyone" | Gunakan `role: reader` `type: domain` (anggota domain sekolah), atau minta admin izinkan "Anyone with the link"; bila kritis → pindah ke Supabase Storage. |
| 429/403 kuota Drive API | Kuota harian project terlampaui | Upload memakai kuota project GCP; tunggu reset atau naikkan kuota di *IAM & Admin → Quotas*. |
| Gejala GAS web app (`Token tidak valid`, `Respons ... tidak terbaca`, `storage quota`) | Metode GAS sudah diganti Service Account | Lihat arsip `Code.gs`. Metode GAS tidak dipakai lagi — jangan andalkan URL `/exec` untuk upload. |
| Error jaringan tidak jelas di browser | Halaman dibuka lewat `file://` | Buka lewat server `python3 -m http.server 3007 -d web` atau GitHub Pages. |

## Menghapus Foto Murid (DELETE / `?hapus=1`)

Endpoint yang sama bisa dipakai untuk **menghapus foto** (tanpa upload file baru).
Otorisasi identik dengan upload: hanya **admin** atau **murid pemilik NIS** yang boleh
(RPC `simpan_foto_murid` yang memutuskannya). `verify_jwt = false`, header `Authorization`
& `apikey` tetap wajib dikirim.

Mode hapus terpicu bila salah satu kondisi ini terpenuhi:

1. **Method `DELETE`** — NIS bisa di body maupun query:
   ```bash
   # NIS di body JSON (gaya yang dipakai frontend)
   curl -X DELETE "https://<REF>.supabase.co/functions/v1/unggah-foto-murid" \
     -H "Authorization: Bearer <TOKEN>" -H "apikey: <ANON_KEY>" \
     -H "Content-Type: application/json" \
     -d '{"nis":"12045","pemanggil":{"tipe":"murid","nisNip":"12045"}}'

   # NIS di query string (DELETE tanpa body)
   curl -X DELETE "https://<REF>.supabase.co/functions/v1/unggah-foto-murid?nis=12045" \
     -H "Authorization: Bearer <TOKEN>" -H "apikey: <ANON_KEY>"
   ```
2. **Query `?hapus=1`** pada method `POST`:
   ```bash
   curl -X POST "https://<REF>.supabase.co/functions/v1/unggah-foto-murid?hapus=1" \
     -H "Authorization: Bearer <TOKEN>" -H "apikey: <ANON_KEY>" \
     -H "Content-Type: application/json" \
     -d '{"nis":"12045","pemanggil":{"tipe":"murid","nisNip":"12045"}}'
   ```
3. **Body `{"hapus": true, ...}`** pada method `POST` — ini yang dipakai frontend:
   `web/js/app.js` → `hapusFotoSaya()` memanggil `unggahFotoMurid({ nis, hapus: true })`,
   lalu `unggahFotoMurid()` mengirim `hapus: true` di body.

Yang terjadi saat mode hapus:

- RPC `simpan_foto_murid` dipanggil dengan `p_url = ''` → kolom `akun.url_foto` di-set
  `NULL` (lihat `upgrade_20261011_akun_murid_foto_medsos.sql`).
- **File di Google Drive lama tetap ada** — tidak dihapus otomatis (keputusan sengaja
  demi keamanan). Hapus manual di folder bila benar-benar ingin dibersihkan.
- Respons sukses: `{ "status": "success", "message": "Foto murid dihapus.", "url": "" }`.
- CORS `Access-Control-Allow-Methods` sudah memuat `DELETE`, jadi preflight browser aman.

## Perilaku

- Nama file: `{NIS}_{TA}_{Kelas}.jpg` (disanitasi) — contoh `12045_2026-2027_XII-TKJ-1.jpg`.
- File di-upload dengan izin **"Siapa saja yang memiliki link → Pembaca"** (anyone reader),
  sehingga `<img>` di aplikasi & lembar cetak bisa menampilkannya tanpa login Google.
- URL yang disimpan: `https://drive.google.com/thumbnail?id=<FILE_ID>&sz=w1000`.
- File Drive lama tidak dihapus otomatis saat foto diganti (agar aman); hapus manual
  di folder bila perlu.