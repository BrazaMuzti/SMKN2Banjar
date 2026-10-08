// ambil-foto-drive — Proxy unduhan foto Google Drive melalui Service Account.
//
// Masalah yang dipecahkan: <img> pratinjau ikut membawa cookie login Google, tetapi
// fetch() lintas-origin untuk pembacaan pixel wajah TIDAK membawa cookie → foto tampil
// di pratinjau namun unduhan anonim diblokir (server mengirim halaman verifikasi HTML,
// sering berstatus 200). Beberapa organisasi Google Workspace bahkan menonaktifkan
// berbagi "siapa saja → lihat" untuk anonim, sehingga belum ada kandidat URL
// client-side yang menembus.
//
// Fungsi ini memakai Service Account yang sudah dipakai unggah-foto-murid (secret
// GOOGLE_SA_JSON) untuk mengambil file via Drive API v3 `alt=media`. SA tampil sebagai
// identitas Google yang sah → dapat membaca file publik "siapa saja" yang sekalipun
// ditolak untuk anonim browser. File yang dibatasi khusus staf@org (tanpa berbagi ke SA)
// tetap ditolak Google (403) → frontend menampilkan pesan tersebut.
//
// Keamanan: verify_jwt=false + hanya GET read-only; file yang dapat diambil hanyalah
// yang SA berhak baca (publik "siapa saja" atau milik SA/Shared Drive aplikasi).
//
// Deploy:
//   npx supabase functions deploy ambil-foto-drive --project-ref <PROJECT_REF>
// Env: GOOGLE_SA_JSON (sudah ada untuk unggah-foto-murid).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

/** Tebak MIME gambar dari byte awal (Drive kadang membalas application/octet-stream). */
function sentuhMime(u8: Uint8Array): string | null {
  if (u8.length < 12) return null;
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return "image/jpeg";
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return "image/png";
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return "image/gif";
  if (
    u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
    u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50
  ) return "image/webp";
  return null;
}

/** Batas ukuran foto profil: 15 MB sudah sangat longgar, mencegah proxy disalahgunakan jadi pipeline file raksasa. */
const BATAS_UKURAN = 15 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    if (req.method !== "GET") {
      return json({ status: "error", message: "Metode tidak didukung." }, 405);
    }
    const fileId = (new URL(req.url).searchParams.get("fileId") || "").trim();
    if (!/^[A-Za-z0-9_-]{6,200}$/.test(fileId)) {
      return json({ status: "error", message: "fileId Google Drive tidak valid." }, 400);
    }

    const saJson = (Deno.env.get("GOOGLE_SA_JSON") || "").trim();
    let sa: { client_email?: string; private_key?: string };
    try {
      sa = saJson ? JSON.parse(saJson) : {};
    } catch {
      return json({ status: "error", message: "Konfigurasi layanan foto belum benar (GOOGLE_SA_JSON tidak valid). Hubungi admin." }, 503);
    }
    if (!sa.client_email || !sa.private_key) {
      return json({ status: "error", message: "Layanan foto belum dikonfigurasi admin (GOOGLE_SA_JSON kosong). Hubungi admin." }, 503);
    }

    const token = await aksesTokenServiceAccount(sa.client_email, sa.private_key);
    const dl = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (dl.status === 404) {
      return json({ status: "error", message: "File Google Drive tidak ditemukan atau sudah dihapus." }, 404);
    }
    if (dl.status === 403) {
      return json({
        status: "error",
        message: "Layanan foto tidak diberi izin membaca file Google Drive ini (403). Kemungkinan: file dibatasi khusus pemilik/staf tertentu, atau berbagi \"Siapa saja yang memiliki tautan\" dinonaktifkan oleh kebijakan organisasi. Minta pemilik file membagikannya ke akun layanan, atau unggah ulang foto lewat aplikasi.",
      }, 403);
    }
    if (!dl.ok) {
      return json({ status: "error", message: `Google Drive menolak unduhan (${dl.status}). Coba lagi sebentar lagi.` }, 502);
    }

    const xPanjang = dl.headers.get("content-length");
    if (xPanjang && /^\d+$/.test(xPanjang) && Number(xPanjang) > BATAS_UKURAN) {
      return json({ status: "error", message: "Ukuran file Google Drive terlalu besar untuk diproses aplikasi." }, 413);
    }
    const u8 = new Uint8Array(await dl.arrayBuffer());
    if (u8.length === 0) {
      return json({ status: "error", message: "File Google Drive kosong atau tidak terbaca." }, 502);
    }
    if (u8.length > BATAS_UKURAN) {
      return json({ status: "error", message: "Ukuran file Google Drive terlalu besar untuk diproses aplikasi." }, 413);
    }

    const headerCt = (dl.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const mime = /^image\//.test(headerCt) ? headerCt : (sentuhMime(u8) || "image/jpeg");
    return new Response(u8, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": mime,
        "Content-Length": String(u8.length),
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    console.error("ambil-foto-drive:", e);
    return json({ status: "error", message: e instanceof Error ? e.message : "Terjadi kesalahan server." }, 500);
  }
});