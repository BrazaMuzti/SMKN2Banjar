#!/usr/bin/env node
// ============================================================
// SISIP BUILD IKON PWA — membuat ikon PNG dari `web/assets/logo.svg`
//
// LATAR BELAKANG
//   `web/manifest.json` dulu hanya memuat ikon SVG (`sizes: "any"`).
//   Chrome/Edge/Opera **menolak** menawarkan "Install aplikasi" bila
//   manifest tidak punya ikon PNG 192 & 512 (plus varian `maskable`
//   agar ikon tidak terpotong saat dipasang di launcher Android).
//   Skrip ini menghasilkan ikon-ikon itu dari satu sumber (logo.svg)
//   supaya tampilan konsisten dan tidak perlu file biner manual.
//
// Hasil (di `web/assets/`):
//   icon-192.png            → ikon "any" 192 (favicon Android & manifest)
//   icon-512.png            → ikon "any" 512 (splash / daftar aplikasi)
//   icon-192-maskable.png   → maskable 192 (safe zone 80%)
//   icon-512-maskable.png   → maskable 512
//   apple-touch-icon.png    → 180 × 180, latar PENUH (iOS: layar utama)
//
// Cara menjalankan:
//   npm run build:icons     → tulis ulang ikon
//   npm run check:icons     → hanya periksa (exit 1 bila ikon hilang/ukuran salah)
//
// Butuh perender SVG: `rsvg-convert` (disarankan) atau `magick`.
// ImageMagick wajib ada untuk komposisi maskable. Bila belum terpasang:
//   Arch/CachyOS : sudo pacman -S imagemagick librsvg
//   Debian/Ubuntu: sudo apt install imagemagick librsvg2-bin
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const ASET = path.join(root, 'web', 'assets');
const SUMBER = path.join(ASET, 'logo.svg');
const MODE_CHECK = process.argv.includes('--check');

/** Warna latar maskable/apple-touch — sama dengan `theme_color` manifest. */
const WARNA_LATAR = '#2563eb';

/** Ikon yang wajib ada: [nama berkas, ukuran sisi (px)]. */
const IKON = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-192-maskable.png', 192],
  ['icon-512-maskable.png', 512],
  ['apple-touch-icon.png', 180]
];

/** Jalankan perintah; kembalikan stdout (stderr ImageMagick dibuang). */
function jalan(bin, argumen) {
  return execFileSync(bin, argumen, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Cari biner di PATH (kembalikan null bila tidak ada). */
function cariBiner(nama) {
  try {
    jalan('bash', ['-lc', 'command -v ' + nama]);
    return nama;
  } catch (e) { return null; }
}

/** Ukuran (lebar × tinggi) sebuah PNG via ImageMagick `identify`. */
function ukuranPng(jalur, magick) {
  const keluar = jalan(magick, ['identify', '-format', '%wx%h', jalur]);
  const [w, h] = keluar.trim().split('x').map(Number);
  return { w, h };
}

const magick = cariBiner('magick') || cariBiner('convert');
if (!magick) {
  console.error('[build-icons] ❌ ImageMagick tidak ditemukan (`magick`/`convert`).');
  console.error('  Arch/CachyOS : sudo pacman -S imagemagick librsvg');
  console.error('  Debian/Ubuntu: sudo apt install imagemagick librsvg2-bin');
  process.exit(1);
}
const rsvg = cariBiner('rsvg-convert');

// ============================================================
// MODE CHECK — tidak menulis apa pun
// ============================================================
if (MODE_CHECK) {
  const masalah = [];
  for (const [nama, sisi] of IKON) {
    const jalur = path.join(ASET, nama);
    if (!fs.existsSync(jalur)) { masalah.push('hilang: assets/' + nama); continue; }
    try {
      const { w, h } = ukuranPng(jalur, magick);
      if (w !== sisi || h !== sisi) {
        masalah.push('ukuran salah: assets/' + nama + ' = ' + w + 'x' + h + ' (harus ' + sisi + ')');
      }
    } catch (e) { masalah.push('gagal dibaca: assets/' + nama); }
  }
  if (masalah.length) {
    console.log('❌ Ikon PWA bermasalah:');
    for (const m of masalah) console.log('   • ' + m);
    console.log('   Jalankan: npm run build:icons');
    process.exit(1);
  }
  console.log('✅ Ikon PWA lengkap (' + IKON.length + ' berkas, ukuran benar).');
  process.exit(0);
}

// ============================================================
// BUILD
// ============================================================
if (!fs.existsSync(SUMBER)) {
  console.error('[build-icons] ❌ Sumber tidak ada: ' + SUMBER);
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sisip-ikon-'));

/** Render logo.svg ke PNG transparan berukuran `sisi`. */
function renderLogo(jalur, sisi) {
  if (rsvg) jalan(rsvg, ['-w', String(sisi), '-h', String(sisi), SUMBER, '-o', jalur]);
  else jalan(magick, ['-background', 'none', '-density', '384', SUMBER, '-resize', sisi + 'x' + sisi, jalur]);
  return jalur;
}

/** Ikon "latar penuh" (maskable & apple-touch): kanvas berwarna + logo 62%. */
function renderLatarPenuh(jalur, sisi) {
  const inti = Math.round(sisi * 0.62);            // aman di dalam safe zone 80% maskable
  const intiPng = renderLogo(path.join(tmp, 'inti-' + sisi + '.png'), inti);
  jalan(magick, ['-size', sisi + 'x' + sisi, 'xc:' + WARNA_LATAR, intiPng,
    '-gravity', 'center', '-composite', '-alpha', 'remove', '-alpha', 'off', jalur]);
  return jalur;
}

try {
  console.log('[build-icons] perender SVG: ' + (rsvg ? 'rsvg-convert' : 'magick (fallback)')
    + ' | komposisi: ' + magick);

  // Ikon "any": logo apa adanya (sudut membulat, latar transparan).
  renderLogo(path.join(ASET, 'icon-512.png'), 512);
  renderLogo(path.join(ASET, 'icon-192.png'), 192);
  // Maskable + apple-touch: latar penuh (tepi tidak boleh transparan).
  renderLatarPenuh(path.join(ASET, 'icon-512-maskable.png'), 512);
  renderLatarPenuh(path.join(ASET, 'icon-192-maskable.png'), 192);
  renderLatarPenuh(path.join(ASET, 'apple-touch-icon.png'), 180);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* abaikan */ }
}

let gagal = 0;
for (const [nama, sisi] of IKON) {
  const jalur = path.join(ASET, nama);
  const { w, h } = ukuranPng(jalur, magick);
  const kb = (fs.statSync(jalur).size / 1024).toFixed(1);
  const ok = (w === sisi && h === sisi);
  if (!ok) gagal++;
  console.log('  ' + (ok ? '✅' : '❌') + ' assets/' + nama + ' — ' + w + 'x' + h + ' (' + kb + ' KB)');
}
if (gagal) {
  console.error('❌ ' + gagal + ' ikon berukuran salah.');
  process.exit(1);
}
console.log('✅ Ikon PWA dibuat dari web/assets/logo.svg (latar: ' + WARNA_LATAR + ').');
