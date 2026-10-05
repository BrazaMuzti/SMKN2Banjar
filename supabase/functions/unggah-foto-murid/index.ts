// Edge Function: unggah-foto-murid
// Upload foto siswa ke Google Drive lewat perantara Google Apps Script (GAS) Web App,
// lalu menyimpan URL-nya ke akun.url_foto.
//
// KENAPA VIA GAS (bukan Google Drive API langsung):
//   - Menghindari kuota Google Drive API standar; unggahan "dicatut" lewat akun
//     Google pemilik script (execute as Me).
//   - Kredensial Google (folder tujuan, akses publik) tersimpan di GAS; URL Web App
//     + token rahasia hanya hidup di Supabase secret, tidak pernah sampai ke browser.
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
// Secret yang harus diset (supabase secrets set ...):
//   GAS_UPLOAD_URL   → URL Web App GAS (https://script.google.com/macros/s/.../exec)
//   GAS_UPLOAD_TOKEN → token rahasia, HARUS sama dengan Script Property
//                      UPLOAD_TOKEN di project Google Apps Script.
//
// Deploy:
//   npx supabase functions deploy unggah-foto-murid --project-ref <PROJECT_REF>
//
// Kode Google Apps Script: lihat file Code.gs di folder yang sama.

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

// ============ Upload via Google Apps Script Web App ============
/** Kirim base64 ke GAS → dapatkan fileUrl Drive. GAS yang memegang folder tujuan,
 *  penulisan file, dan pengaturan akses publik ("siapa saja dengan link → Pembaca"). */
async function unggahViaGAS(
  gasUrl: string,
  gasToken: string,
  namaFile: string,
  mimeType: string,
  b64: string,
): Promise<{ fileUrl: string; fileId: string }> {
  const res = await fetch(gasUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: namaFile, mimeType, base64: b64, token: gasToken }),
  });

  const teks = await res.text();
  let r: { status?: string; message?: string; fileUrl?: string; fileId?: string };
  try {
    r = JSON.parse(teks);
  } catch (e) {
    console.error("Respons GAS bukan JSON:", teks.slice(0, 500));
    throw new Error("Respons Google Apps Script tidak terbaca.");
  }
  if (!r || r.status !== "success" || !r.fileUrl) {
    throw new Error((r && r.message) || "Google Apps Script menolak unggahan.");
  }
  const url = String(r.fileUrl).trim();
  if (!/^https:\/\/drive\.google\.com\//.test(url) && !/^https:\/\/lh[0-9]*\.googleusercontent\.com\//.test(url)) {
    throw new Error("fileUrl dari Google Apps Script tidak valid.");
  }
  return { fileUrl: url, fileId: String(r.fileId || "") };
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

    // 4. Secret Google Apps Script (harus sudah diset di Supabase)
    const gasUrl = (Deno.env.get("GAS_UPLOAD_URL") || "").trim();
    const gasToken = (Deno.env.get("GAS_UPLOAD_TOKEN") || "").trim();
    if (!gasUrl || !gasToken) {
      return json({ status: "error", message: "Upload Drive belum dikonfigurasi admin." }, 500);
    }

    // 5. Upload ke Drive via GAS (nama file disanitasi; ekstensi mengikuti mimeType)
    const tahun = sanitasiNama(String(body.tahun ?? "").replace(/\//g, "-"));
    const kelas = sanitasiNama(String(body.kelas ?? ""));
    const mimeType = String(foto.split(";", 1)[0].replace("data:", "") || "image/jpeg");
    const ext =
      mimeType === "image/png" ? "png" :
      mimeType === "image/webp" ? "webp" :
      mimeType === "image/gif" ? "gif" : "jpg";
    const namaFile = `${sanitasiNama(nis)}_${tahun || "TA"}_${kelas || "kelas"}.${ext}`;
    const { fileUrl: urlFoto, fileId } = await unggahViaGAS(gasUrl, gasToken, namaFile, mimeType, b64);

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
