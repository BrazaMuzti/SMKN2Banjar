-- ============================================================
-- UPGRADE: PENDAFTARAN WAJAH (FACE RECOGNITION) — 2026-10-14
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Isi:
--   1) Kolom baru tabel akun:
--        wajah_descriptor jsonb  → vektor 128 angka (deskriptor wajah face-api.js)
--        wajah_status    text    → 'aktif' | 'nonaktif' | NULL (belum terdaftar)
--   2) RPC baru simpan_wajah_murid: satu-satunya pintu penulisan kolom wajah
--      (verifikasi: admin ATAU murid pemilik NIS).
--
-- Catatan desain:
--   * Pencocokan wajah dilakukan SEPENUHNYA di sisi client (face-api.js + jarak
--     Euclidean) — tidak perlu pgvector. Kolom jsonb hanya menyimpan hasil
--     ekstraksi descriptor dari browser.
--   * Kolom tidak memiliki RLS khusus: RPC security definer adalah satu-satunya
--     penulisnya.
--
-- Idempotent — aman dijalankan berulang. Data lama tidak tersentuh.
-- ============================================================

-- ========== 1. KOLOM BARU ==========
alter table akun
  add column if not exists wajah_descriptor jsonb,
  add column if not exists wajah_status text;

-- ========== 2. RPC: SIMPAN / HAPUS DATA WAJAH MURID ==========
-- p_status:
--   'aktif'     → daftarkan/mutakhirkan wajah (p_descriptor wajib array 128 angka)
--   'nonaktif'  → nonaktifkan tanpa menghapus (descriptor lama tetap, tidak dipakai)
--   NULL/''     → hapus seluruh data wajah murid
-- Otorisasi: admin ATAU murid pemilik NIS (untuk keperluan kelola mandiri).
create or replace function simpan_wajah_murid(
  p_nis text,
  p_descriptor jsonb default null,
  p_status text default 'aktif',
  p_pemanggil_nis text default null,
  p_pemanggil_tipe text default null
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ada boolean;
  v_idx int;
  v_elemen jsonb;
  v_ok boolean := true;
begin
  p_nis := trim(coalesce(p_nis, ''));
  p_status := lower(trim(coalesce(p_status, '')));

  if p_nis = '' then
    return json_build_object('status', 'error', 'message', 'NIS wajib diisi.');
  end if;

  select exists (select 1 from akun where nis_nip = p_nis and tipe = 'murid') into v_ada;
  if not v_ada then
    return json_build_object('status', 'error', 'message', 'Data murid tidak ditemukan.');
  end if;

  if p_pemanggil_tipe <> 'admin'
     and not (p_pemanggil_tipe = 'murid' and p_pemanggil_nis = p_nis) then
    return json_build_object('status', 'error', 'message', 'Tidak berhak mengubah data wajah murid ini.');
  end if;

  -- Validasi descriptor bila ingin menyimpan: harus array 128 angka
  if p_status = 'aktif' and p_descriptor is not null then
    if jsonb_typeof(p_descriptor) <> 'array' or jsonb_array_length(p_descriptor) <> 128 then
      return json_build_object('status', 'error', 'message', 'Deskriptor wajah harus berupa array 128 angka.');
    end if;
    for v_idx in 0 .. 127 loop
      v_elemen := p_descriptor->v_idx;
      if jsonb_typeof(v_elemen) not in ('number') or not (v_elemen #>> '{}')::double precision between -10 and 10 then
        v_ok := false;
        exit;
      end if;
    end loop;
    if not v_ok then
      return json_build_object('status', 'error', 'message', 'Deskriptor wajah berisi nilai tidak valid.');
    end if;
  end if;

  if p_status = 'aktif' and p_descriptor is not null then
    update akun
       set wajah_descriptor = p_descriptor,
           wajah_status     = 'aktif'
     where nis_nip = p_nis and tipe = 'murid';
    return json_build_object('status', 'success', 'message', 'Data wajah murid tersimpan.');
  elsif p_status = 'nonaktif' then
    update akun
       set wajah_status = 'nonaktif'
     where nis_nip = p_nis and tipe = 'murid';
    return json_build_object('status', 'success', 'message', 'Data wajah murid dinonaktifkan.');
  else
    -- hapus total (p_status NULL/'' atau p_descriptor NULL)
    update akun
       set wajah_descriptor = null,
           wajah_status     = null
     where nis_nip = p_nis and tipe = 'murid';
    return json_build_object('status', 'success', 'message', 'Data wajah murid dihapus.');
  end if;
end $$;

-- ========== 3. IZIN EKSEKUSI + RELOAD CACHE ==========
grant execute on function simpan_wajah_murid(text, jsonb, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';