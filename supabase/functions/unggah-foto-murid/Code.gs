/**
 * ⚠️ ARSIP — TIDAK DIPAKAI LAGI (per 2026-10-06).
 * --------------------------------------------------------------
 * Pendekatan unggah-foto-murid SEKARANG memakai SERVICE ACCOUNT
 * + Google Drive API v3 langsung dari Edge Function (lihat index.ts).
 * Alasan: Web App GAS "Execute as Me" menolak akses DriveApp untuk
 * pemanggil ANONIM ("Access denied: DriveApp"), padahal Supabase
 * memanggil tanpa login Google.
 * File ini dipertahankan hanya sebagai referensi historis.
 *
 * ---- KONTEKS LAMA (valid saat masih dipakai) ----
 * GAS Web App — "unggah-foto-murid"
 * -------------------------------------------------------------
 * Menerima foto (base64) dari Supabase Edge Function, menyimpan ke
 * folder Google Drive tujuan, membuka akses "siapa saja dengan link →
 * Pembaca", lalu membalas JSON { status, fileUrl, fileId }.
 *
 * Versi lengkap dari snippet ringkas di README.md (token & folder ID
 * dibaca dari Script Properties, bukan hardcode).
 *
 * DEPLOY (setiap kali file DIEDIT wajib buat versi baru):
 *   Deploy → New deployment → Web app
 *     - Description      : unggah-foto-murid
 *     - Execute as       : Me
 *     - Who has access   : Anyone
 *   Salin URL /exec → jadi secret GAS_UPLOAD_URL di Supabase.
 *
 * SCRIPT PROPERTIES (Project Settings → Script Properties):
 *   UPLOAD_TOKEN     = token rahasia BEBAS (±32+ karakter acak)
 *                      HARUS sama dengan secret GAS_UPLOAD_TOKEN di Supabase.
 *   DRIVE_FOLDER_ID  = ID folder Drive tujuan (33 karakter, mis. 1AbC...xyz)
 *                      BUKAN URL lengkap dari address bar.
 */

var BATAS_BASE64   = 4700000;                      // ≈ 3,5 MB data foto
var MIME_DIIZINKAN = ["image/jpeg", "image/png", "image/webp", "image/gif"];

function doGet() {
  // Tangani kunjungan manual ke /exec dengan sopan (bukan stack trace HTML)
  return kirimJson({ status: "error", message: "Gunakan metode POST." });
}

function doPost(e) {
  try {
    // 1. Baca & parse JSON body
    var raw = (e && e.postData && e.postData.contents) || "";
    var body = {};
    try { body = JSON.parse(raw || "{}"); }
    catch (err) { return kirimJson({ status: "error", message: "Body harus berupa JSON." }); }

    // 2. Verifikasi token rahasia (pengganti "kunci API" — aman karena
    //    token hanya disimpan di Supabase secret, tidak pernah di browser)
    var tokenBenar = PropertiesService.getScriptProperties().getProperty("UPLOAD_TOKEN");
    if (!tokenBenar || body.token !== tokenBenar) {
      return kirimJson({ status: "error", message: "Token tidak valid." });
    }

    // 3. Validasi konten
    var mime = String(body.mimeType || "");
    if (MIME_DIIZINKAN.indexOf(mime) === -1) {
      return kirimJson({ status: "error", message: "Tipe file tidak diizinkan." });
    }
    var b64 = String(body.base64 || "");
    if (b64.length < 100) {
      return kirimJson({ status: "error", message: "Foto kosong atau tidak terbaca." });
    }
    if (b64.length > BATAS_BASE64) {
      return kirimJson({ status: "error", message: "Ukuran foto melebihi 3,5 MB." });
    }
    var namaFile = String(body.filename || "")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 100) || "foto.jpg";

    // 4. Folder tujuan (dari Script Properties)
    //    Respons "belum dikonfigurasi" ikut memantulkan nilai MENTAH property
    //    (JSON.stringify) supaya mudah terlihat spasi tersembunyi/typo key saat debug.
    var rawFolder = PropertiesService.getScriptProperties().getProperty("DRIVE_FOLDER_ID") || "";
    var folderId = rawFolder.trim();
    if (!folderId) {
      var baca = JSON.stringify({ n: "DRIVE_FOLDER_ID", v: rawFolder });
      return kirimJson({ status: "error", message: "Folder Drive belum dikonfigurasi. (baca=" + baca + ")" });
    }

    // 5. Tulis file ke Google Drive
    var bytes  = Utilities.base64Decode(b64);           // base64 → byte[]
    var blob   = Utilities.newBlob(bytes, mime, namaFile);
    var folder = DriveApp.getFolderById(folderId);
    var file   = folder.createFile(blob);

    // 6. Akses publik "siapa saja dengan link → Pembaca" supaya <img> di
    //    aplikasi & lembar cetak bisa menampilkan tanpa login Google.
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    // Catatan: bila domain Workspace memblokir "anyone with link",
    // gunakan Drive API advanced service (aktifkan di editor script):
    //   Drive.Permissions.insert({ role: 'reader', type: 'anyone' }, file.getId());

    var fileId  = file.getId();
    var fileUrl = "https://drive.google.com/thumbnail?id=" + encodeURIComponent(fileId) + "&sz=w1000";

    return kirimJson({
      status: "success",
      message: "Foto berhasil diunggah.",
      fileId: fileId,
      fileUrl: fileUrl,
      viewUrl: "https://drive.google.com/open?id=" + encodeURIComponent(fileId)
    });
  } catch (err) {
    return kirimJson({ status: "error", message: "Gagal mengunggah: " + err.message });
  }
}

/** Bungkus respons sebagai JSON dengan header CORS yang benar. */
function kirimJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}