#!/usr/bin/env node
// ============================================================
// SISIP CEK ARG-RPC — penjaga regresi "PGRST202"
// Membandingkan argumen setiap panggilan RPC di frontend
// (`web/js/app.js`, `utils.js`, `face.js`, `utils.example.js`)
// dengan daftar parameter `create [or replace] function` di
// `supabase/sql/*.sql`.
//
// LATAR BELAKANG
//   PostgREST mencocokkan NAMA setiap argumen dengan nama parameter
//   fungsi. Satu argumen yang tidak dideklarasikan membuat seluruh
//   fungsi dianggap tidak ada → error PGRST202 ("Could not find the
//   function … in the schema cache"). Ini persis yang mematahkan tombol
//   "Simpan Perubahan" di menu Data Akun Murid: klien mengirim
//   `p_klaim_nis` ke `ubah_profil_murid` yang hanya punya
//   (p_nis, p_data, p_token) — lihat `upgrade_20261028b2_token_rpc_murid.sql`.
//
// Cara menjalankan:
//   npm run test:rpc-args
//   node scripts/cek-arg-rpc.mjs [--js-dir web/js] [--sql-dir supabase/sql]
//
// Keluaran:
//   ❌ ERROR → argumen tak dikenal, ATAU argumen wajib (tanpa `default`) tidak
//              dikirim. Dua-duanya membuat PostgREST gagal mencocokkan fungsi
//              (PGRST202) → exit code 1.
//   ⚠  WARN  → payload tak terbaca statis (periksa manual), atau fungsi tak ada
//              di `supabase/sql`.
//   self-test → menyuntikkan 3 pola bug ke SALINAN TEKS berkas nyata (berkas
//              asli tidak diubah) untuk membuktikan detektor ini benar bekerja;
//              bila pola tidak lagi terdeteksi, skrip ikut gagal (exit code 1).
//   Pemeriksaan "argumen wajib" hanya dilakukan bila payload terbaca statis
//   (literal objek / Object.assign) supaya objek variabel yang diisi bertahap
//   tidak memicu alarm palsu.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const ambilOpsi = (nama, bawaan) => {
  const i = process.argv.indexOf(nama);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : bawaan;
};
const JS_DIR = path.resolve(root, ambilOpsi('--js-dir', 'web/js'));
const SQL_DIR = path.resolve(root, ambilOpsi('--sql-dir', 'supabase/sql'));
// `utils.example.js` ikut diperiksa supaya salinan user tidak pernah drift.
const JS_FILES = ['app.js', 'utils.js', 'face.js', 'utils.example.js'];

/** Helper parameter majemuk di frontend: nama fungsi JS → parameter RPC yang disuntikkan.
 *  Tambahkan di sini bila ada helper baru; helper tak dikenal hanya memicu WARN. */
const HELPER_PARAMS = {
  sesiRpc: ['p_token', 'p_klaim_nis']
};

/** Token nama yang boleh muncul sebagai param RPC. */
const IDENT = /[A-Za-z_$][\w$]*/;

// ============================================================
// 1. DAFTAR PARAMETER FUNGSI DARI supabase/sql/*.sql
//    Definisi "terakhir menang" (berkas diurutkan naik, jadi migrasi
//    bertanggal lebih baru menimpa `gabungan.sql`/berkas lama).
// ============================================================
function pisahParam(isi) {
  const bagian = [];
  let buf = '';
  let depth = 0;
  for (const c of isi) {
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { bagian.push(buf); buf = ''; continue; }
    buf += c;
  }
  bagian.push(buf);
  return bagian
    .map((s) => {
      const m = s.match(new RegExp('^(?:in|out|inout)?\\s*(' + IDENT.source + ')\\s+[A-Za-z]', 'i'));
      if (!m) return null;
      // Parameter ber-`default` boleh tidak dikirim klien; yang tidak punya default WAJIB dikirim
      // (kalau tidak, PostgREST juga gagal mencocokkan fungsi → PGRST202).
      return { nama: m[1].toLowerCase(), adaDefault: /\bdefault\b/i.test(s) };
    })
    .filter(Boolean);
}

/** Ambil daftar parameter dari tanda '(' signatur fungsi. */
function paramDariSignatur(src, openIdx) {
  let i = openIdx + 1;
  let depth = 1;
  let buf = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') { const e = src.indexOf('\n', i); if (e < 0) return null; i = e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) return null; i = e + 2; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return pisahParam(buf);
    }
    buf += c;
    i++;
  }
  return null;
}

function daftarFungsiSql() {
  const peta = new Map();
  for (const namaBerkas of fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const src = fs.readFileSync(path.join(SQL_DIR, namaBerkas), 'utf8');
    const re = /create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*)\s*\(/gi;
    let m;
    while ((m = re.exec(src))) {
      const param = paramDariSignatur(src, re.lastIndex - 1);
      if (param === null) continue;
      peta.set(m[1].toLowerCase(), {
        params: param.map((p) => p.nama),
        wajib: param.filter((p) => !p.adaDefault).map((p) => p.nama),
        file: namaBerkas
      });
    }
  }
  return peta;
}

// ============================================================
// 2. PEMBACA STATIS OBJEK ARGUMEN DI FRONTEND
// ============================================================
const buka = { '(': ')', '[': ']', '{': '}' };

/** Lewati string ('…', "…", `…` termasuk ${…}) mulai index i → index setelah penutup. */
function lewatiString(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      // Template literal ber-interpolasi: lompati isi ${ … } (bisa memuat brace).
      let depth = 1;
      j += 2;
      while (j < src.length && depth > 0) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\'' || d === '"' || d === '`') { j = lewatiString(src, j); continue; }
        if (d === '{') depth++;
        else if (d === '}') depth--;
        j++;
      }
      continue;
    }
    j++;
  }
  return src.length;
}

/** Lewati spasi + komentar mulai index i → index karakter berikutnya. */
function lewatiSampah(src, i) {
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    break;
  }
  return i;
}

/** Index tanda penutup yang sepadan dengan tanda buka di openIdx. */
function cariPenutup(src, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') { i = lewatiString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** Ambil nama key tingkat-atas dari literal objek `{ … }` (openIdx = index '{'). */
function keyLiteral(src, openIdx) {
  const keys = [];
  let dinamis = false;
  const tutupIdx = cariPenutup(src, openIdx);
  let i = openIdx + 1;
  let depth = 1;
  let harapKey = true;
  while (i < (tutupIdx < 0 ? src.length : tutupIdx)) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      const akhirStr = lewatiString(src, i);
      if (depth === 1 && harapKey) {
        const j = lewatiSampah(src, akhirStr);
        if (src[j] === ':') { keys.push(src.slice(i + 1, akhirStr - 1)); harapKey = false; i = j + 1; continue; }
      }
      harapKey = false;
      i = akhirStr;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') { depth++; if (harapKey && depth === 2) dinamis = true; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; i++; continue; }
    if (depth === 1) {
      if (c === ',') { harapKey = true; i++; continue; }
      if (harapKey) {
        const s = lewatiSampah(src, i);
        if (s !== i) { i = s; continue; }
        if (src.startsWith('...', i)) { dinamis = true; harapKey = false; i += 3; continue; }
        const m = new RegExp('^' + IDENT.source).exec(src.slice(i));
        if (m) {
          const j = lewatiSampah(src, i + m[0].length);
          if (src[j] === ':') { keys.push(m[0]); harapKey = false; i = j + 1; continue; }
          if (src[j] === ',' || src[j] === '}') { keys.push(m[0]); harapKey = false; i = j; continue; }
          dinamis = true; harapKey = false; i = j; continue;
        }
        dinamis = true; harapKey = false; i++; continue;
      }
    }
    i++;
  }
  return { keys, dinamis };
}



/** Cari `const/let/var IDENT = { … }` terdekat SEBELUM batas → key statisnya. */
function keyDariVariabel(src, ident, sebelumIdx) {
  const re = new RegExp('(?:const|let|var)\\s+' + ident.replace(/\$/g, '\\$') + '\\s*=\\s*\\{', 'g');
  let terakhir = null;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > sebelumIdx) break;
    terakhir = m;
  }
  if (!terakhir) return null;
  const openIdx = terakhir.index + terakhir[0].length - 1;
  const isi = keyLiteral(src, openIdx);
  // Nilai variabel bisa diubah belakangan (mis. `payload.x = …`) → cukup key statisnya.
  return { keys: isi.keys, dinamis: isi.dinamis, sumber: 'variabel', catatan: 'objek variabel ' + ident };
}

/** Baca daftar argumen setelah nama RPC (mulai tepat setelah tanda kutip penutup).
 *  `sumber`: 'literal' = key terbaca pasti (literal objek / Object.assign / tanpa argumen),
 *            'variabel' = objek variabel (bisa ditambah field setelah deklarasi),
 *            'unknown'  = tak terbaca. */
function bacaArgumen(src, mulai) {
  let i = lewatiSampah(src, mulai);
  if (src[i] === ')') return { keys: [], dinamis: false, sumber: 'literal', catatan: 'tanpa argumen' };
  if (src[i] !== ',') return { keys: [], dinamis: true, sumber: 'unknown', catatan: 'bentuk argumen tidak dikenali' };
  i = lewatiSampah(src, i + 1);
  if (src[i] === '{') {
    const isi = keyLiteral(src, i);
    return { keys: isi.keys, dinamis: isi.dinamis, sumber: 'literal', catatan: 'literal objek' };
  }
  if (src.startsWith('Object.assign', i)) return bacaObjectAssign(src, i, mulai);
  const m = new RegExp('^' + IDENT.source).exec(src.slice(i));
  if (m) {
    const viaVar = keyDariVariabel(src, m[0], mulai);
    if (viaVar) return viaVar;
    return { keys: [], dinamis: true, sumber: 'unknown', catatan: 'variabel tak ditemukan: ' + m[0] };
  }
  return { keys: [], dinamis: true, sumber: 'unknown', catatan: 'bentuk argumen tidak dikenali' };
}

/** Object.assign({ … }, sesiRpc()) → gabungan key literal + parameter helper. */
function bacaObjectAssign(src, i, mulai) {
  const openIdx = src.indexOf('(', i);
  const tutupIdx = cariPenutup(src, openIdx);
  if (tutupIdx < 0) return { keys: [], dinamis: true, sumber: 'unknown', catatan: 'Object.assign tidak lengkap' };
  const isi = src.slice(openIdx + 1, tutupIdx);
  const keys = [];
  let dinamis = false;
  let variabel = false;   // ada argumen berupa objek variabel → key bisa bertambah setelah deklarasi
  let j = 0;
  while (j < isi.length) {
    j = lewatiSampah(isi, j);
    if (isi[j] === ',') { j++; continue; }   // pemisah antar-argumen Object.assign
    if (isi[j] === '{') {
      const bagian = keyLiteral(isi, j);
      keys.push(...bagian.keys);
      if (bagian.dinamis) dinamis = true;
      j = cariPenutup(isi, j) + 1;
      continue;
    }
    const m = new RegExp('^' + IDENT.source).exec(isi.slice(j));
    if (!m) break;
    const k = lewatiSampah(isi, j + m[0].length);
    if (isi[k] === '(') {
      const helper = HELPER_PARAMS[m[0]];
      if (helper) keys.push(...helper);
      else dinamis = true;
      j = cariPenutup(isi, k) + 1;
      continue;
    }
    // Argumen objek variabel lain (mis. Object.assign(payload, { … })).
    const viaVar = keyDariVariabel(src, m[0], mulai);
    if (viaVar) { keys.push(...viaVar.keys); dinamis = true; variabel = true; }
    else dinamis = true;
    j = k;
  }
  return { keys, dinamis, sumber: variabel ? 'variabel' : 'literal', catatan: 'Object.assign' };
}

/** Semua panggilan RPC ber-nama literal di satu berkas JS. */
function panggilanRpc(src) {
  const hasil = [];
  const re = /(?:\bsupaRpc|\brpc)\s*\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g;
  let m;
  while ((m = re.exec(src))) {
    const info = bacaArgumen(src, re.lastIndex);
    hasil.push({
      line: src.slice(0, m.index).split('\n').length,
      nama: m[1],
      keys: [...new Set(info.keys.map((k) => k.toLowerCase()))],
      dinamis: info.dinamis,
      sumber: info.sumber,
      catatan: info.catatan
    });
  }
  return hasil;
}

// ============================================================
// 3. PERBANDINGAN & LAPORAN
// ============================================================
const fungsiSql = daftarFungsiSql();

/** Periksa satu berkas JS (teks) → daftar temuan. Dipakai untuk berkas nyata & self-test. */
function periksaSumber(namaBerkas, src) {
  const temuan = [];
  for (const situs of panggilanRpc(src)) {
    const def = fungsiSql.get(situs.nama);
    if (!def) {
      temuan.push({ tingkat: 'WARN', berkas: namaBerkas, line: situs.line, nama: situs.nama,
        pesan: 'fungsi tidak ditemukan di supabase/sql (mungkin dibuat di luar repo/Edge Function)' });
      continue;
    }
    const asing = situs.keys.filter((k) => !def.params.includes(k));
    if (asing.length) {
      temuan.push({ tingkat: 'ERROR', berkas: namaBerkas, line: situs.line, nama: situs.nama,
        pesan: 'argumen tidak dikenal: ' + asing.join(', ')
          + ' → signature ' + situs.nama + '(' + def.params.join(', ') + ')'
          + ' [' + def.file + ']  ⇒ PostgREST akan menjawab PGRST202 (function not found)',
        detail: 'kirim hanya: ' + def.params.join(', ') });
      continue;
    }
    // Argumen WAJIB (tanpa `default`) yang tidak dikirim juga membuat PostgREST gagal
    // mencocokkan fungsi. Hanya diperiksa bila payload benar-benar terbaca statis.
    const kurang = situs.sumber === 'literal'
      ? def.wajib.filter((p) => !situs.keys.includes(p))
      : [];
    if (kurang.length) {
      temuan.push({ tingkat: 'ERROR', berkas: namaBerkas, line: situs.line, nama: situs.nama,
        pesan: 'argumen wajib belum dikirim: ' + kurang.join(', ')
          + ' → signature ' + situs.nama + '(' + def.params.join(', ') + ')'
          + ' [' + def.file + ']  ⇒ juga memicu PGRST202',
        detail: 'tambahkan: ' + kurang.join(', ') });
      continue;
    }
    if (situs.dinamis) {
      temuan.push({ tingkat: 'WARN', berkas: namaBerkas, line: situs.line, nama: situs.nama,
        pesan: 'argumen tak terbaca penuh secara statis (' + situs.catatan + ') — periksa manual' });
    }
  }
  return temuan;
}

const laporan = [];
let jmlSitus = 0;
for (const namaBerkas of JS_FILES) {
  const jalur = path.join(JS_DIR, namaBerkas);
  if (!fs.existsSync(jalur)) continue;
  const src = fs.readFileSync(jalur, 'utf8');
  jmlSitus += panggilanRpc(src).length;
  laporan.push(...periksaSumber(namaBerkas, src));
}
let jmlError = laporan.filter((l) => l.tingkat === 'ERROR').length;
let jmlWarn = laporan.filter((l) => l.tingkat === 'WARN').length;

// SELF-TEST: buktikan pemeriksa ini benar-benar menangkap PGRST202, bukan selalu "✅".
// Disuntikkan ke SALINAN TEKS berkas nyata (berkas asli tidak diubah) dengan tiga
// pola bug: (1) argumen asing pada RPC tanpa parameter, (2) `p_klaim_nis` ke RPC
// Fase B2 lewat sesiRpc() (bug tombol "Simpan Perubahan"), (3) argumen wajib hilang.
const selfTest = [];
const KASUS_SELF_TEST = [
  { berkas: 'utils.js', nama: 'hitung_akun', label: 'pola 1: argumen asing pada RPC tanpa parameter',
    cari: /supaRpc\('hitung_akun'\)/,
    ganti: "supaRpc('hitung_akun', { p_klaim_nis: 'X' })",
    pola: /p_klaim_nis/ },
  { berkas: 'app.js', nama: 'ubah_profil_murid', label: 'pola 2: `p_klaim_nis` ke RPC Fase B2',
    cari: /supaClient\.rpc\('ubah_profil_murid',\s*\{[\s\S]*?\}\s*\)/,
    ganti: "supaClient.rpc('ubah_profil_murid', Object.assign({ p_nis: 'X', p_data: {} }, sesiRpc()))",
    pola: /p_klaim_nis/ },
  { berkas: 'app.js', nama: 'ubah_profil_murid', label: 'pola 3: argumen wajib tidak dikirim',
    cari: /supaClient\.rpc\('ubah_profil_murid',\s*\{[\s\S]*?\}\s*\)/,
    ganti: "supaClient.rpc('ubah_profil_murid', { p_nis: 'X' })",
    pola: /wajib belum dikirim: p_data/ }
];
for (const kasus of KASUS_SELF_TEST) {
  const jalur = path.join(JS_DIR, kasus.berkas);
  if (!fs.existsSync(jalur) || !fungsiSql.get(kasus.nama)) continue;   // berkas/fungsi tak ada → lewati
  const asli = fs.readFileSync(jalur, 'utf8');
  const rusak = asli.replace(kasus.cari, kasus.ganti);
  if (rusak === asli) {
    selfTest.push(kasus.label + ' — teks acuan tidak ditemukan di ' + kasus.berkas + ' (perbarui self-test)');
    continue;
  }
  const kena = periksaSumber('self-test', rusak)
    .some((t) => t.tingkat === 'ERROR' && t.nama === kasus.nama && kasus.pola.test(t.pesan));
  if (!kena) selfTest.push(kasus.label + ' TIDAK terdeteksi');
}
if (selfTest.length) {
  jmlError += selfTest.length;
  console.log('\nSELF-TEST');
  for (const s of selfTest) console.log('  ❌ ' + s);
}

for (const namaBerkas of JS_FILES) {
  const bagian = laporan.filter((l) => l.berkas === namaBerkas);
  if (!bagian.length) continue;
  console.log('\n' + namaBerkas);
  for (const l of bagian.sort((a, b) => a.line - b.line)) {
    console.log('  ' + (l.tingkat === 'ERROR' ? '❌' : '⚠ ') + ' ' + l.tingkat + ' baris ' + l.line
      + ' → ' + l.nama + '\n     ' + l.pesan + (l.detail ? '\n     ' + l.detail : ''));
  }
}

console.log('\n' + '='.repeat(60));
console.log('RPC diperiksa: ' + jmlSitus + ' situs | fungsi SQL terbaca: ' + fungsiSql.size
  + ' | ❌ ERROR: ' + jmlError + ' | ⚠ WARN: ' + jmlWarn
  + ' | self-test: ' + (selfTest.length ? '❌ GAGAL' : '✅ OK'));
if (jmlError) {
  console.log('❌ Ada argumen RPC yang tidak sesuai signature SQL (pasti PGRST202).');
  console.log('   Perbaiki nama argumen di frontend ATAU signature di supabase/sql,');
  console.log('   lalu jalankan ulang skrip ini. Ingat: RPC Fase B2 hanya menerima `p_token`.');
  process.exit(1);
}
console.log('✅ Semua argumen RPC cocok dengan signature SQL di repo.');

