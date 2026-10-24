#!/usr/bin/env node
/**
 * scripts/generate-utils.mjs
 *
 * Generate web/js/utils.js dari template web/js/utils.example.js dengan
 * mengganti placeholder kredensial menggunakan environment variables:
 *   - SUPABASE_URL
 *   - SUPABASE_ANON_KEY
 *
 * Dipakai oleh:
 *   - Deploy Vercel (lihat vercel.json -> buildCommand)
 *   - Bisa juga dipakai manual: `SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/generate-utils.mjs`
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TEMPLATE_PATH = join(ROOT, 'web', 'js', 'utils.example.js');
const OUTPUT_PATH = join(ROOT, 'web', 'js', 'utils.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    '[generate-utils] ERROR: Environment variable SUPABASE_URL dan/atau ' +
    'SUPABASE_ANON_KEY belum diatur. Set keduanya di dashboard Vercel ' +
    '(Project Settings -> Environment Variables) atau di GitHub Actions secrets.'
  );
  process.exit(1);
}

const PLACEHOLDER_URL = "ISI SUPABASE URL INI! https://xxxxx.supabase.co";
const PLACEHOLDER_KEY = "ISI SUPABASE ANON KEY INI! sb_publishable_... / anon key";

let template = readFileSync(TEMPLATE_PATH, 'utf8');

if (!template.includes(PLACEHOLDER_URL) || !template.includes(PLACEHOLDER_KEY)) {
  console.error('[generate-utils] ERROR: Placeholder tidak ditemukan di utils.example.js — cek apakah template berubah.');
  process.exit(1);
}

const output = template
  .replaceAll(PLACEHOLDER_URL, SUPABASE_URL)
  .replaceAll(PLACEHOLDER_KEY, SUPABASE_ANON_KEY);

writeFileSync(OUTPUT_PATH, output, 'utf8');
console.log(`[generate-utils] Berhasil menulis ${OUTPUT_PATH}`);
