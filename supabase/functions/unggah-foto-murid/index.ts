// Edge Function: unggah-foto-murid
// Upload foto siswa ke Google Drive via Service Account (Drive API v3), lalu
// menyimpan URL-nya ke akun.url_foto.
//
// KENAPA SERVICE ACCOUNT (bukan GAS Web App / DriveApp anonim):
//   Web App GAS dengan "Execute as Me" menolak akses DriveApp untuk pemanggil
//   ANONIM (terbukti: "Access denied: DriveApp"), padahal Edge Function memanggil
//   tanpa login Google. Service account menandatangani JWT sendiri (RS256),
//   menukarnya dengan OAuth access token, lalu upload langsung ke Drive API v3 —
//   tanpa consent screen dan tanpa batasan pemanggil anonim.
//
// KENAPA verify_jwt = false:
//   Murid "lokal" (login NIS+password) hanya punya token sesi aplikasi `lokal-*`
//   yang tidak bisa diverifikasi sebagai JWT Supabase. Otorisasi ditangani
//   bertingkat di dalam fungsi:
//     1. Bila Authorization = JWT Supabase valid (RS256) → identitas pemanggil
//        benar-benar diketahui dari auth.getUser().
//     2. Bila bukan JWT (token lokal) → klaim pemanggil (NIS + tipe dari frontend)
//        diverifikasi ULANG di RPC simpan_foto_murid (security definer) sebelum
//        url_foto ditulis — pemanggil harus admin ATAU murid pemilik NIS.
//
// FILENAME: {nis}_{TA}_{kelas}.jpg — contoh: 12045_2026-2027_XII-TKJ-1.jpg
//
// Secret yang harus diset di Supabase:
//   GOOGLE_SA_JSON   → isi file JSON kunci service account (memuat client_email
//                      & private_key) — DASHBOARD → Edge Functions → Secrets
//   DRIVE_FOLDER_ID  → ID folder tujuan. PENTING: folder HARUS berada di Google
//                      Shared Drive (bukan My Drive), karena Service Account
//                      tidak punya kuota penyimpanan sendiri — Google menolak
//                      penulisan ke My Drive dengan 403 "Service Accounts do
//                      not have storage quota".
//
// Persiapan service account (sekali saja):
//   1. console.cloud.google.com/iam-admin/serviceaccounts?project=sisip-510803
//      → Create service account → Actions (⋯) → Manage keys → ADD KEY → Create
//      new key → JSON → unduh filenya.
//   2. Buat/pindahkan folder tujuan ke Google Shared Drive (Drive web → Shared
//      drives → + New → pindahkan folder ke dalamnya), lalu bagikan Shared Drive
//      ke email service account (<nama>@sisip-510803.iam.gserviceaccount.com)
//      sebagai Content Manager.
//   3. Pastikan Google Drive API sudah Enable di project itu, dan kebijakan
//      organisasi mengizinkan "Anyone with the link" (dibutuhkan agar foto
//      tampil tanpa login di aplikasi).
//
// Deploy:
//   npx supabase functions deploy unggah-foto-murid --project-ref <PROJECT_REF>
//
// (Arsip: pendekatan lama GAS Web App ada di Code.gs — tidak dipakai lagi.)

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Batas ukuran foto: 3,5 MB (data:image base64 ≈ 4,6 juta karakter). */
const BATAS_BASE64 = 4_700_000;

/** Sanitasi segmen nama file: karakter bahaya → '-', sisakan alfanumerik/-/_. */
function sanitasiNama(s: string): string {
  return String(s || "")
    .replace(/[\/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 80) || "foto";
}

// ============ Identifikasi pemanggil ============
/** Coba verifikasi Authorization sebagai JWT Supabase (RS256 oleh Auth) → profil pemanggil. */
async function identifikasiPemanggil(token: string): Promise<{ nis_nip: string; tipe: string } | null> {
  if (!token || token.split(".").length !== 3) return null;
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  try {
    const klien = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: me, error: meErr } = await klien.auth.getUser();
    if (meErr || !me?.user) return null;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    // 1) Pilih lewat user_id (baris akun tertaut Auth). Service role → lolos RLS.
    let akun: { nis_nip?: string | null; tipe?: string | null } | null = null;
    ({ data: akun } = await admin
      .from("akun")
      .select("nis_nip, tipe")
      .eq("user_id", me.user.id)
      .maybeSingle());

    // 2) Baris lama/belum tertaut user_id → cocokkan email (mirror alur
    //    best-effort login di frontend). Tetap aman: email unique dari Auth.
    if (!akun && me.user.email) {
      ({ data: akun } = await admin
        .from("akun")
        .select("nis_nip, tipe")
        .eq("email", me.user.email)
        .maybeSingle());
    }
    return akun ? { nis_nip: String(akun.nis_nip || ""), tipe: String(akun.tipe || "") } : null;
  } catch (e) {
    console.warn("identifikasiPemanggil:", e);
    return null;
  }
}

/** Cek pemanggil boleh (admin) ATAU pemilik NIS — via DB (service role). */
async function pemanggilDiizinkan(
  admin: SupabaseClient<any, "public", any>,
  p_nis: string,
  caller: { nis_nip: string; tipe: string } | null,
  klaim: { tipe?: string; nisNip?: string },
): Promise<{ ok: boolean; tipe: string; nis_nip: string; alasan?: string }> {
  if (caller) {
    if (caller.tipe === "admin") return { ok: true, ...caller };
    if (caller.tipe === "murid" && caller.nis_nip === p_nis) return { ok: true, ...caller };
    return { ok: false, tipe: caller.tipe, nis_nip: caller.nis_nip, alasan: "Hanya admin atau murid pemilik NIS yang boleh." };
  }
  // Token bukan JWT (sesi aplikasi lokal) → klaim dari frontend; verifikasi baris
  // akun di DB — mirror logika RPC simpan_foto_murid (admin ATAU murid pemilik NIS).
  // RPC security definer tetap menjadi pengadil akhir saat url_foto ditulis.
  const tipe = String(klaim?.tipe || "");
  const nisP = String(klaim?.nisNip || "");
  if (tipe === "murid" && nisP === p_nis) {
    const { data: baris } = await admin
      .from("akun")
      .select("nis_nip")
      .eq("nis_nip", p_nis)
      .eq("tipe", "murid")
      .maybeSingle();
    if (!baris) return { ok: false, tipe, nis_nip: nisP, alasan: "Data murid tidak ditemukan." };
    return { ok: true, tipe, nis_nip: nisP };
  }
  if (tipe === "admin") {
    // Admin lokal: verifikasi klaim NIS/NIP-nya ke baris akun ber-tipe admin.
    const { data: baris } = await admin
      .from("akun")
      .select("nis_nip")
      .eq("nis_nip", nisP)
      .eq("tipe", "admin")
      .maybeSingle();
    if (!baris) return { ok: false, tipe, nis_nip: nisP, alasan: "Akun admin tidak terverifikasi." };
    return { ok: true, tipe, nis_nip: nisP };
  }
  return { ok: false, tipe, nis_nip: nisP, alasan: "Sesi tidak terverifikasi." };
}

// ============ Upload ke Google Drive (Service Account) ============
// Alur: tanda tangani JWT RS256 (client_email + private_key dari GOOGLE_SA_JSON)
//   → tukar dengan OAuth access token (oauth2.googleapis.com/token)
//   → upload base64 via Drive API v3 (multipart) ke DRIVE_FOLDER_ID
//   → buka akses publik "siapa saja → Pembaca" agar <img>/cetak tampil tanpa login.

const _teks = new TextEncoder();

/** Pemangkas PEM (strip header/footer + spasi) lalu decode base64 → DER. */
function derFromPem(pem: string): ArrayBuffer {
  const bersih = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(bersih);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer as ArrayBuffer;
}

/** Uint8Array → base64url (tanpa padding) — untuk bagian JWT & signature. */
function base64url(u8: Uint8Array): string {
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Decode base64 (standar mau pun base64url) → bytes gambar. */
function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Tukar JWT service account (RS256) dengan akses token OAuth2 Google. */
async function aksesTokenServiceAccount(
  clientEmail: string,
  privateKeyPem: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    derFromPem(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const kini = Math.floor(Date.now() / 1000);
  const header = base64url(_teks.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const klaim = base64url(_teks.encode(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: kini,
    exp: kini + 3600,
  })));
  const input = `${header}.${klaim}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, _teks.encode(input)));
  const jwt = `${input}.${base64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  const teksRes = await res.text();
  let r: { access_token?: string; error?: string; error_description?: string };
  try {
    r = JSON.parse(teksRes);
  } catch {
    throw new Error("Respons token Google tidak terbaca: " + teksRes.slice(0, 300));
  }
  if (!r.access_token) {
    throw new Error(`Gagal mendapat token Google: ${r.error ?? "?"} ${r.error_description ?? ""}`.trim());
  }
  return r.access_token;
}

/** Upload base64 ke Drive via Drive API v3, lalu buka akses publik (anyone → reader).
 *  Menargetkan Google Shared Drive: `supportsAllDrives=true` wajib — Service
 *  Account tidak punya kuota My Drive sendiri (tanpa ini Google balas 403). */
async function unggahViaDrive(
  namaFile: string,
  mimeType: string,
  b64: string,
): Promise<{ fileUrl: string; fileId: string }> {
  const saJson = (Deno.env.get("GOOGLE_SA_JSON") || "").trim();
  const folderId = (Deno.env.get("DRIVE_FOLDER_ID") || "").trim();
  if (!saJson || !folderId) {
    throw new Error("Upload Drive belum dikonfigurasi admin.");
  }
  let sa: { client_email?: string; private_key?: string };
  try {
    sa = JSON.parse(saJson);
  } catch {
    throw new Error("GOOGLE_SA_JSON bukan JSON yang valid.");
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GOOGLE_SA_JSON tidak memuat client_email/private_key.");
  }

  // Validasi dini MIME — tolak selain jpeg/png/webp/gif sebelum memakai kuota API.
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) {
    throw new Error("Tipe file tidak diizinkan (jpeg/png/webp/gif).");
  }

  const token = await aksesTokenServiceAccount(sa.client_email, sa.private_key);

  // Upload multipart: bagian "metadata" (JSON) + bagian "file" (byte gambar).
  const fd = new FormData();
  fd.append(
    "metadata",
    new Blob([JSON.stringify({ name: namaFile, parents: [folderId], mimeType })], {
      type: "application/json; charset=UTF-8",
    }),
  );
  fd.append("file", new Blob([decodeBase64(b64)], { type: mimeType }));

  const up = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd },
  );
  const upTeks = await up.text();
  if (!up.ok) {
    throw new Error(`Google Drive menolak upload (${up.status}): ${upTeks.slice(0, 300)}`);
  }
  const fileId = (JSON.parse(upTeks) as { id?: string }).id || "";
  if (!fileId) throw new Error("Google Drive tidak mengembalikan fileId.");

  // Akses publik: "siapa saja → Pembaca" (setara setSharing ANYONE_WITH_LINK).
  // supportsAllDrives=true juga wajib di sini karena file berada di Shared Drive.
  const perms = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    },
  );
  if (!perms.ok) {
    const pt = await perms.text();
    throw new Error(`Gagal membuka akses publik file Drive: ${pt.slice(0, 300)}`);
  }

  return {
    fileId,
    fileUrl: `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1000`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

    const body = await req.json().catch(() => ({})) as {
      nis?: unknown; nama?: unknown; tahun?: unknown; kelas?: unknown;
      foto?: unknown; hapus?: unknown; pemanggil?: { tipe?: string; nisNip?: string };
    };

    const nis = String(body.nis ?? new URL(req.url).searchParams.get("nis") ?? "").trim();
    if (!nis) return json({ status: "error", message: "NIS wajib diisi." }, 400);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // 1. Siapa pemanggil (JWT bila valid; klaim frontend untuk murid lokal)
    const caller = await identifikasiPemanggil(token);
    const izin = await pemanggilDiizinkan(admin, nis, caller, body.pemanggil || {});
    if (!izin.ok) {
      return json({ status: "error", message: izin.alasan || "Tidak berhak." }, 403);
    }

    // 2. Mode HAPUS foto (tanpa upload file baru).
    //    Dipicu salah satu: method DELETE, body `hapus: true`, atau query `?hapus=1`
    //    pada `{nis}/foto`. Hanya menghapus URL di DB (akun.url_foto = NULL) — file
    //    Drive lama sengaja dipertahankan agar tidak ada penghapusan permanen tak disengaja.
    const hapus =
      body.hapus === true ||
      req.method === "DELETE" ||
      new URL(req.url).searchParams.get("hapus") === "1";
    if (hapus) {
      const { data: rpc } = await admin.rpc("simpan_foto_murid", {
        p_nis: nis,
        p_url: "",
        p_pemanggil_nis: izin.nis_nip,
        p_pemanggil_tipe: izin.tipe,
      });
      if (!rpc || rpc.status !== "success") {
        return json({ status: "error", message: (rpc && rpc.message) || "Gagal menghapus foto." }, 400);
      }
      return json({ status: "success", message: "Foto murid dihapus.", url: "" });
    }

    // 3. Validasi payload foto (data URL gambar)
    const foto = String(body.foto ?? "");
    if (!/^data:image\/(jpeg|png|webp|gif);base64,/i.test(foto)) {
      return json({ status: "error", message: "File harus berupa data URL gambar." }, 400);
    }
    const b64 = foto.split(",", 2)[1];
    if (!b64 || b64.length < 100) {
      return json({ status: "error", message: "Foto kosong atau tidak terbaca." }, 400);
    }
    if (b64.length > BATAS_BASE64) {
      return json({ status: "error", message: "Ukuran foto melebihi 3,5 MB." }, 400);
    }

    // 4-5. Upload ke Google Drive (Service Account) — nama file disanitasi.
    //      Folder tujuan DB baca lewat DRIVE_FOLDER_ID; upload + akses publik
    //      ditangani unggahViaDrive (JWT SA → Drive API v3).
    const tahun = sanitasiNama(String(body.tahun ?? "").replace(/\//g, "-"));
    const kelas = sanitasiNama(String(body.kelas ?? ""));
    const mimeType = String(foto.split(";", 1)[0].replace("data:", "") || "image/jpeg");
    const ext =
      mimeType === "image/png" ? "png" :
      mimeType === "image/webp" ? "webp" :
      mimeType === "image/gif" ? "gif" : "jpg";
    const namaFile = `${sanitasiNama(nis)}_${tahun || "TA"}_${kelas || "kelas"}.${ext}`;
    const { fileUrl: urlFoto, fileId } = await unggahViaDrive(namaFile, mimeType, b64);

    // 6. Simpan URL ke akun.url_foto (RPC security definer = jaring pengaman otorisasi)
    const { data: rpcSave } = await admin.rpc("simpan_foto_murid", {
      p_nis: nis,
      p_url: urlFoto,
      p_pemanggil_nis: izin.nis_nip,
      p_pemanggil_tipe: izin.tipe,
    });
    if (!rpcSave || rpcSave.status !== "success") {
      return json({ status: "error", message: (rpcSave && rpcSave.message) || "Gagal menyimpan URL foto." }, 400);
    }

    return json({ status: "success", message: "Foto berhasil diunggah.", url: urlFoto, fileId });
  } catch (e) {
    const pesan = e instanceof Error ? e.message : "Terjadi kesalahan server.";
    console.error("unggah-foto-murid:", e);
    return json({ status: "error", message: pesan }, 500);
  }
});