// Edge Function: sinkron-foto-drive
// Sinkronkan URL foto siswa (akun.url_foto) dari file foto di Google Drive.
//
// Tujuan (Req: "Auto-update foto murid dari Google Drive"):
//   Folder Google Shared Drive berisi file berformat:
//       "{NISN} {Nama siswa}.jpg"    (contoh: 310012 12045 Budi Santoso.jpg)
//   ATAU fallback bila NISN kosong:
//       "{NIS} {Nama siswa}.jpg"
//   Fungsi ini:
//     1) Autentikasi pemanggil sebagai ADMIN ATAU GURU (wali kelas / pembina ekskul)
//        yang berhak — via JWT Supabase ATAU klaim `pemanggil`{tipe,nisNip} yang
//        diverifikasi ulang ke tabel akun.
//     2) List folder DRIVE_FOLDER_ID via Drive API v3 `files.list`
//        (`supportsAllDrives=true&includeItemsFromAllDrives=true`).
//     3) Parsing tiap nama file → NISN (fallback NIS) → cocokkan ke tabel akun
//        (tipe='murid') memakai service role (hanya baca; aman karena secret server).
//     4) Update akun.url_foto bila berbeda (skip yang sama) — service role langsung
//        (aman: rahasia tidak pernah keluar dari server).
//     5) Kembalikan laporan {dipindai, terpasang, diperbarui, sama, tidak_cocok, gagal}.
//
// KENAPA reuse secret unggah-foto-murid: GOOGLE_SA_JSON (service account) &
//   DRIVE_FOLDER_ID (Shared Drive) sudah terkonfigurasi di project. Pastikan
//   Shared Drive membagikan folder ke email service account sebagai "Content
//   Manager" agar files.list dapat membaca seluruh berkasnya.
//
// URL foto yang disimpan memakai thumbnail Google Drive (tampil tanpa login):
//   https://drive.google.com/thumbnail?id={fileId}&sz=w1000
//   (identik dengan yang diunggah oleh unggah-foto-murid → konsisten.)
//
// Deploy:
//   npx supabase functions deploy sinkron-foto-drive --project-ref <PROJECT_REF>
// Env (sudah ada): GOOGLE_SA_JSON, DRIVE_FOLDER_ID, SUPABASE_URL,
//                  SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.

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

/** Tukar JWT service account (RS256) dengan access token OAuth2 Google. */
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
    scope: "https://www.googleapis.com/auth/drive.readonly",
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
/** Parsing "310012 12045 Budi Santoso.jpg" → segmen pertama (sebelum spasi):
 *  NISN, atau angka NIS. Dipakai sebagai kunci pencocokan (NISN dulu, fallback NIS). */
function ambilIdentitasDepan(namaFile: string): string {
  return String(namaFile || "").split(/\s+/)[0] || "";
}

/** List semua file (metadata) di DRIVE_FOLDER_ID via Drive API v3, termasuk Shared Drive. */
async function listFileFolder(
  token: string,
  folderId: string,
): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const hasil: Array<{ id: string; name: string; mimeType?: string }> = [];
  let pageToken: string | null = null;
  do {
    const usp = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) usp.set("pageToken", pageToken);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?${usp.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Google Drive menolak list folder (${res.status}): ${t.slice(0, 300)}`);
    }
    const r: { files?: Array<{ id: string; name: string; mimeType?: string }>; nextPageToken?: string } =
      await res.json();
    hasil.push(...(r.files || []));
    pageToken = r.nextPageToken || null;
  } while (pageToken);
  return hasil;
}

/** Identifikasi pemanggil berhak (ADMIN, atau GURU wali kelas / pembina ekskul).
 *  Jalur 1: Authorization = JWT Supabase (RS256) → auth.getUser() → akun.tipe='admin'
 *           ATAU akun.tipe='guru' dengan wali_kelas/ekstrakurikuler terisi.
 *  Jalur 2: klaim `pemanggil`{tipe, nisNip} diverifikasi ulang ke baris akun (service role). */
async function pemanggilDiizinkan(
  token: string,
  klaim: { tipe?: string; nisNip?: string },
): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Guru berhak bila punya penugasan wali kelas / pembina ekskul (seperti
  // bisaImportMuridAktif() di frontend). Di sini dipakai untuk SINKRON global seluruh murid,
  // jadi cukup cek kolom flat wali_kelas/ekstrakurikuler pada baris akun guru.
  const guruBerhak = (row: { tipe?: string; wali_kelas?: string; ekstrakurikuler?: string }) =>
    row.tipe === "guru" &&
    (String(row.wali_kelas || "").trim() !== "" ||
      String(row.ekstrakurikuler || "").trim() !== "");

  // Jalur 1: JWT valid
  if (token && token.split(".").length === 3) {
    try {
      const klien = createClient(url, anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false },
      });
      const { data: me, error: meErr } = await klien.auth.getUser();
      if (!meErr && me?.user) {
        const { data: akun } = await admin
          .from("akun")
          .select("tipe, wali_kelas, ekstrakurikuler")
          .eq("user_id", me.user.id)
          .maybeSingle();
        if (akun && (akun.tipe === "admin" || guruBerhak(akun))) return true;
        if (me.user.email) {
          const { data: akunE } = await admin
            .from("akun")
            .select("tipe, wali_kelas, ekstrakurikuler")
            .eq("email", me.user.email)
            .maybeSingle();
          if (akunE && (akunE.tipe === "admin" || guruBerhak(akunE))) return true;
        }
      }
    } catch (e) {
      console.warn("sinkron-foto-drive/pemanggilDiizinkan/jwt:", e);
    }
  }

  // Jalur 2: klaim admin/guru lokal (login aplikasi NIS+NIP+password) — verifikasi baris akun
  const tipeKlaim = String(klaim?.tipe || "");
  const idKlaim = String(klaim?.nisNip || "");
  if (idKlaim) {
    const { data: baris } = await admin
      .from("akun")
      .select("tipe, wali_kelas, ekstrakurikuler")
      .eq("nis_nip", idKlaim)
      .maybeSingle();
    if (baris) {
      if (tipeKlaim === "admin" && baris.tipe === "admin") return true;
      if (tipeKlaim === "guru" && guruBerhak(baris)) return true;
    }
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    if (req.method !== "POST") return json({ status: "error", message: "Metode tidak didukung." }, 405);

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

    const body = await req.json().catch(() => ({})) as {
      pemanggil?: { tipe?: string; nisNip?: string };
    };

    // 1. Otorisasi admin / guru (wali kelas / pembina ekskul)
    if (!(await pemanggilDiizinkan(token, body.pemanggil || {}))) {
      return json({ status: "error", message: "Akses khusus admin, wali kelas, atau pembina ekskul." }, 403);
    }

    const saJson = (Deno.env.get("GOOGLE_SA_JSON") || "").trim();
    const folderId = (Deno.env.get("DRIVE_FOLDER_ID") || "").trim();
    if (!saJson || !folderId) {
      return json({ status: "error", message: "Sinkronisasi Drive belum dikonfigurasi admin." }, 503);
    }
    let sa: { client_email?: string; private_key?: string };
    try {
      sa = JSON.parse(saJson);
    } catch {
      return json({ status: "error", message: "GOOGLE_SA_JSON bukan JSON yang valid." }, 503);
    }
    if (!sa.client_email || !sa.private_key) {
      return json({ status: "error", message: "GOOGLE_SA_JSON tidak memuat client_email/private_key." }, 503);
    }

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
      auth: { persistSession: false },
    });

    // 2. Muat peta murid: { NISN → { nis_nip, url_foto } } dengan fallback { NIS → ... }
    const { data: muridRows, error: mErr } = await admin
      .from("akun")
      .select("nis_nip, nisn, url_foto")
      .eq("tipe", "murid");
    if (mErr) throw new Error("Gagal memuat data murid: " + (mErr.message || ""));

    const byNISN = new Map<string, { nis: string; url: string | null }>();
    const byNIS = new Map<string, { nis: string; url: string | null }>();
    for (const m of (muridRows || [])) {
      const nis = String(m.nis_nip || "").trim();
      const nisn = String(m.nisn || "").trim();
      if (!nis) continue;
      const rec = { nis, url: m.url_foto ? String(m.url_foto) : null };
      if (nisn) byNISN.set(nisn, rec);
      byNIS.set(nis, rec);
    }

    // 3. List file di folder Drive
    const tokenGa = await aksesTokenServiceAccount(sa.client_email, sa.private_key);
    const files = await listFileFolder(tokenGa, folderId);

    const laporan = {
      dipindai: files.length,
      terpasang: 0,
      diperbarui: 0,
      sama: 0,
      tidak_cocok: 0,
      gagal: 0,
      rincian: [] as { file: string; status: string; nis?: string }[],
    };

    // 4. Cocokkan tiap file → update url_foto bila berubah
    for (const f of files) {
      const nama = String(f.name || "").trim();
      const identitas = ambilIdentitasDepan(nama);
      if (!identitas) {
        laporan.tidak_cocok++;
        laporan.rincian.push({ file: nama, status: "tanpa-nomor" });
        continue;
      }

      const fileId = String(f.id || "");
      const urlBaru = `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1000`;

      // Prioritas NISN, lalu NIS (nis_nip)
      const temuan = byNISN.get(identitas) || byNIS.get(identitas);
      if (!temuan) {
        laporan.tidak_cocok++;
        laporan.rincian.push({ file: nama, status: "tidak-cocok" });
        continue;
      }

      if (temuan.url === urlBaru) {
        laporan.sama++;
        laporan.rincian.push({ file: nama, status: "sama", nis: temuan.nis });
        continue;
      }
      try {
        const { error: upErr } = await admin
          .from("akun")
          .update({ url_foto: urlBaru })
          .eq("nis_nip", temuan.nis);
        if (upErr) {
          laporan.gagal++;
          laporan.rincian.push({ file: nama, status: "gagal", nis: temuan.nis });
          console.warn("sinkron-foto-drive/update:", upErr.message);
          continue;
        }
        const status = temuan.url === null ? "baru" : "diperbarui";
        laporan.terpasang++;
        laporan.rincian.push({ file: nama, status, nis: temuan.nis });
        if (status === "diperbarui") laporan.diperbarui++;
      } catch (e) {
        laporan.gagal++;
        laporan.rincian.push({ file: nama, status: "gagal", nis: temuan.nis });
        console.warn("sinkron-foto-drive/update:", e);
      }
    }

    return json({
      status: "success",
      message: `Sinkronisasi selesai: ${laporan.terpasang} foto dipasang/diperbarui dari ${laporan.dipindai} berkas.`,
      laporan,
    });
  } catch (e) {
    const pesan = e instanceof Error ? e.message : "Terjadi kesalahan server.";
    console.error("sinkron-foto-drive:", e);
    return json({ status: "error", message: pesan }, 500);
  }
});

