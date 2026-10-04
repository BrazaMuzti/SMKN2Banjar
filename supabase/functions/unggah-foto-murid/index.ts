// Edge Function: unggah-foto-murid
// Upload foto siswa ke Google Drive (Service Account) lalu menyimpan URL-nya
// ke tabel akun.url_foto — integrasi penuh Google Drive API untuk "Data Akun Murid".
//
// KENAPA verify_jwt = false:
//   Murid "lokal" (login NIS+password, bukan akun Supabase Auth/Google) hanya punya
//   token sesi aplikasi `lokal-*` yang tidak bisa diverifikasi sebagai JWT Supabase.
//   Karena itu gateway tidak menolak request (verify_jwt = false) dan otorisasi
//   ditangani bertingkat di dalam fungsi:
//     1. Bila Authorization = JWT Supabase yang valid (RS256) → identitas pemanggil
//        benar-benar diketahui dari auth.getUser().
//     2. Bila bukan JWT (token lokal) → klaim pemanggil (NIS + tipe dari frontend)
//        diverifikasi ULANG di RPC simpan_foto_murid (security definer) sebelum
//        url_foto ditulis — pemanggil harus admin ATAU murid pemilik NIS. Kunci
//        service account Google Drive tidak pernah keluar dari server.
//
// FILENAME: {nis}_{TA}_{kelas}.jpg (disanitasi) — contoh: 12045_2026-2027_XII-TKJ-1.jpg
//
// Secret yang harus diset (supabase secrets set ...):
//   DRIVE_SERVICE_ACCOUNT_JSON → isi JSON kunci service account ("client_email",
//                                "private_key", "token_uri")
//   DRIVE_MURID_FOLDER_ID      → ID folder Google Drive tujuan foto siswa
//                                (bagikan folder ke email service account dgn role Editor)
//
// Deploy:
//   npx supabase functions deploy unggah-foto-murid --project-ref <PROJECT_REF>

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Batas ukuran foto: 3,5 MB (data:image base64 ≈ 4,6 juta karakter). */
const BATAS_BASE64 = 4_700_000;

// ============ Helper base64url (bisa diterima browser & Deno) ============
function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ============ Autentikasi Google Service Account (RS256, WebCrypto) ============
async function imporKunciPrivat(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function buatJwtServiceAccount(svc: Record<string, string>): Promise<string> {
  const header = b64uEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const sekarang = Math.floor(Date.now() / 1000);
  const payload = b64uEncode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: svc.client_email,
        scope: "https://www.googleapis.com/auth/drive.file",
        aud: svc.token_uri,
        iat: sekarang,
        exp: sekarang + 3600,
      }),
    ),
  );
  const input = `${header}.${payload}`;
  const kunci = await imporKunciPrivat(svc.private_key);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    kunci,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64uEncode(new Uint8Array(sig))}`;
}

async function aksesTokenDrive(svc: Record<string, string>): Promise<string> {
  const jwt = await buatJwtServiceAccount(svc);
  const res = await fetch(svc.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  const r = await res.json();
  if (!r.access_token) {
    throw new Error(r.error_description || r.error || "Gagal mengambil token Drive.");
  }
  return r.access_token;
}

// ============ Google Drive: upload multipart + akses publik ============
async function unggahKeDrive(
  token: string,
  folderId: string,
  namaFile: string,
  bytes: Uint8Array,
): Promise<string> {
  const boundary = `SISIPFoto${Date.now().toString(36)}`;
  const meta = JSON.stringify({
    name: namaFile,
    parents: [folderId],
    mimeType: "image/jpeg",
  });
  const te = new TextEncoder();
  const parts: Uint8Array[] = [];
  parts.push(te.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`));
  parts.push(te.encode(`--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`));
  parts.push(bytes);
  parts.push(te.encode(`\r\n--${boundary}--\r\n`));

  const body = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.length;
  }

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const r = await res.json();
  if (!r.id) {
    throw new Error((r.error && (r.error.message || r.error.code)) || "Upload ke Google Drive gagal.");
  }
  return r.id;
}

async function bukaAksesPublik(token: string, fileId: string): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    },
  );
  const r = await res.json();
  if (r.error) throw new Error(r.error.message || "Gagal mengatur akses file Drive.");
}

/** URL thumbnail Drive (cepat & stabil untuk <img> dan cetak; butuh file ala 'anyone'). */
function urlThumbnailDrive(fileId: string): string {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`;
}

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
    const { data: akun } = await admin
      .from("akun")
      .select("nis_nip, tipe")
      .eq("user_id", me.user.id)
      .maybeSingle();
    return akun ? { nis_nip: String(akun.nis_nip || ""), tipe: String(akun.tipe || "") } : null;
  } catch (e) {
    console.warn("identifikasiPemanggil:", e);
    return null;
  }
}

/** Cek pemanggil boleh (admin) ATAU pemilik NIS — via DB (service role). */
async function pemanggilDiizinkan(
  admin: ReturnType<typeof createClient>,
  p_nis: string,
  caller: { nis_nip: string; tipe: string } | null,
  klaim: { tipe?: string; nisNip?: string },
): Promise<{ ok: boolean; tipe: string; nis_nip: string; alasan?: string }> {
  if (caller) {
    if (caller.tipe === "admin") return { ok: true, ...caller };
    if (caller.tipe === "murid" && caller.nis_nip === p_nis) return { ok: true, ...caller };
    return { ok: false, tipe: caller.tipe, nis_nip: caller.nis_nip, alasan: "Hanya admin atau murid pemilik NIS yang boleh." };
  }
  // Token bukan JWT (murid lokal) → klaim dari frontend; verifikasi baris akun
  const tipe = String(klaim?.tipe || "");
  const nisP = String(klaim?.nisNip || "");
  if (tipe !== "murid" || nisP !== p_nis) {
    return { ok: false, tipe, nis_nip: nisP, alasan: "Sesi tidak terverifikasi." };
  }
  const { data: baris } = await admin
    .from("akun")
    .select("nis_nip")
    .eq("nis_nip", p_nis)
    .eq("tipe", "murid")
    .maybeSingle();
  if (!baris) return { ok: false, tipe, nis_nip: nisP, alasan: "Data murid tidak ditemukan." };
  return { ok: true, tipe, nis_nip: nisP };
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

    const nis = String(body.nis ?? "").trim();
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

    // 2. Mode HAPUS foto (tanpa upload file baru)
    if (body.hapus === true) {
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
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

    // 4. Secret Google Drive (harus sudah diset di Supabase)
    const svcJson = Deno.env.get("DRIVE_SERVICE_ACCOUNT_JSON") || "";
    const folderId = (Deno.env.get("DRIVE_MURID_FOLDER_ID") || "").trim();
    if (!svcJson || !folderId) {
      return json({ status: "error", message: "Google Drive belum dikonfigurasi admin." }, 500);
    }
    let svc: Record<string, string>;
    try {
      svc = JSON.parse(svcJson);
    } catch (e) {
      console.error("DRIVE_SERVICE_ACCOUNT_JSON bukan JSON valid:", e);
      return json({ status: "error", message: "Konfigurasi Drive tidak valid." }, 500);
    }

    // 5. Upload ke Drive + akses "anyone with link" (reader)
    const tokenDrive = await aksesTokenDrive(svc);
    const tahun = sanitasiNama(String(body.tahun ?? "").replace(/\//g, "-"));
    const kelas = sanitasiNama(String(body.kelas ?? ""));
    const namaFile = `${sanitasiNama(nis)}_${tahun || "TA"}_${kelas || "kelas"}.jpg`;
    const fileId = await unggahKeDrive(tokenDrive, folderId, namaFile, bytes);
    await bukaAksesPublik(tokenDrive, fileId);
    const urlFoto = urlThumbnailDrive(fileId);

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