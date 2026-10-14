-- ============================================================
-- UPGRADE: WAJAH MULTI-SAMPEL (AKURASI FACE SCAN) — 2026-10-14e
-- Jalankan SELURUH file ini di Supabase Dashboard → SQL Editor → Run
--
-- Isi:
--   1) Migrasi data: `wajah_descriptor` yang lama berbentuk FLAT [128 angka]
--      dibungkus menjadi array-of-arrays [[128 angka], ...] — format multi-sampel.
--   2) RPC `simpan_wajah_murid` dibuat ulang dengan parameter baru `p_mode`:
--        'ganti'  → timpa SELURUH data wajah murid (terima 1 ATAU beberapa sampel)
--        'tambah' → sisipkan 1 sampel di belakang data yang ada
--      cap 6 sampel per murid (validasi ketat di sisi server).
--   3) Overload RPC v1 (5 parameter) di-drop; grant + reload cache.
--
-- Catatan desain:
--   * Pencocokan tetap SEPENUHNYA di browser (face-api.js): jarak MINIMUM ke
--     semua sampel per murid (min-distance matching), terinspirasi repo referensi
--     ManageWithNoobItGuy/GAS-attendance-facescanner-with-gps-V2 — TANPA Google
--     Sheets/Apps Script/GPS; data wajah tetap 100% disimpan di Supabase.
--   * Data lama yang masih flat TIDAK perlu didaftarkan ulang (kompatibel mundur:
--     frontend membaca flat maupun array-of-arrays).
--
-- Idempotent — aman dijalankan berulang.
-- ============================================================

-- ========== 1. MIGRASI DATA: FLAT → ARRAY-OF-ARRAYS ==========
-- Baris berformat LAMA: wajah_descriptor = [a1..a128] (elemen pertama angka).
-- Baris berformat BARU: wajah_descriptor = [[a1..a128], ...] (elemen pertama array).
update akun
   set wajah_descriptor = jsonb_build_array(wajah_descriptor)
 where wajah_descriptor is not null
   and jsonb_typeof(wajah_descriptor) = 'array'
   and jsonb_array_length(wajah_descriptor) = 128
   and jsonb_typeof(wajah_descriptor -> 0) = 'number';

-- ========== 2. RPC: SIMPAN / HAPUS DATA WAJAH (MULTI-SAMPEL) ==========
-- p_mode:
--   'ganti'  → mengganti seluruh koleksi sampel murid (p_descriptor boleh satu
--              vektor 128 ATAU array-of-arrays; maks 6 sampel).
--   'tambah' → menyisipkan SATU sampel (p_descriptor array 128) di belakang data
--              yang ada (otomatis membungkus data lama yang masih flat; cap 6).
-- p_status:
--   'aktif'     → daftarkan/mutakhirkan wajah (p_descriptor wajib terisi)
--   'nonaktif'  → nonaktifkan tanpa menghapus (sampel lama tetap, tidak dipakai)
--   NULL/''     → hapus seluruh data wajah murid
-- Otorisasi: admin ATAU murid pemilik NIS (untuk keperluan kelola mandiri).
create or replace function simpan_wajah_murid(
  p_nis text,
  p_descriptor jsonb default null,
  p_status text default 'aktif',
  p_pemanggil_nis text default null,
  p_pemanggil_tipe text default null,
  p_mode text default 'ganti'
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ada boolean;
  v_list jsonb;
  v_lama jsonb;
  v_baru jsonb;
  v_jumlah int;
  v_jumlah_lama int;
  v_i int;
  v_j int;
  v_sampel jsonb;
  v_elemen jsonb;
begin
  p_nis := trim(coalesce(p_nis, ''));
  p_status := lower(trim(coalesce(p_status, '')));
  p_mode := lower(trim(coalesce(p_mode, 'ganti')));

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

  -- ===== Normalisasi + validasi p_descriptor =====
  if p_descriptor is not null then
    if jsonb_typeof(p_descriptor) <> 'array' then
      return json_build_object('status', 'error', 'message', 'Deskriptor wajah harus berupa array 128 angka (atau array dari array semacam itu).');
    end if;
    -- Klien lama/kirimanku masih BISA mengirim flat [128 angka] → bungkus sekali.
    if jsonb_array_length(p_descriptor) = 128 and jsonb_typeof(p_descriptor -> 0) = 'number' then
      v_list := jsonb_build_array(p_descriptor);
    else
      v_list := p_descriptor;
    end if;

    v_jumlah := jsonb_array_length(v_list);
    if v_jumlah < 1 then
      return json_build_object('status', 'error', 'message', 'Minimal satu sampel wajah diperlukan.');
    end if;
    if p_mode = 'tambah' and v_jumlah <> 1 then
      return json_build_object('status', 'error', 'message', 'Mode tambah menerima tepat satu sampel (array 128 angka).');
    end if;
    if p_mode = 'ganti' and v_jumlah > 6 then
      return json_build_object('status', 'error', 'message', 'Maksimal 6 sampel wajah per murid (' || v_jumlah || ' diberikan).');
    end if;

    for v_i in 0 .. v_jumlah - 1 loop
      v_sampel := v_list -> v_i;
      if jsonb_typeof(v_sampel) <> 'array' or jsonb_array_length(v_sampel) <> 128 then
        return json_build_object('status', 'error', 'message', 'Setiap sampel wajah harus berupa array 128 angka.');
      end if;
      for v_j in 0 .. 127 loop
        v_elemen := v_sampel -> v_j;
        if jsonb_typeof(v_elemen) not in ('number') or not (v_elemen #>> '{}')::double precision between -10 and 10 then
          return json_build_object('status', 'error', 'message', 'Deskriptor wajah berisi nilai tidak valid.');
        end if;
      end loop;
    end loop;
  end if;

-- ===== Terapkan =====
  if p_status = 'aktif' and p_descriptor is not null then
    if p_mode = 'tambah' then
      select coalesce(wajah_descriptor, '[]'::jsonb) into v_lama
        from akun where nis_nip = p_nis and tipe = 'murid';
      -- Baris lama yang belum sempat dimigrasi (flat) → bungkus dulu sebelum append.
      if jsonb_typeof(v_lama) = 'array' and jsonb_array_length(v_lama) = 128 and jsonb_typeof(v_lama -> 0) = 'number' then
        v_lama := jsonb_build_array(v_lama);
      end if;
      if jsonb_typeof(v_lama) <> 'array' then
        v_lama := '[]'::jsonb;
      end if;
      v_jumlah_lama := jsonb_array_length(v_lama);
      if v_jumlah_lama + 1 > 6 then
        return json_build_object('status', 'error', 'message', 'Maksimal 6 sampel wajah per murid — gunakan mode ganti untuk mengganti seluruh data.');
      end if;
      v_baru := v_lama || v_list;
      update akun
         set wajah_descriptor = v_baru,
             wajah_status     = 'aktif'
       where nis_nip = p_nis and tipe = 'murid';
      return json_build_object('status', 'success', 'message', 'Data wajah murid tersimpan (' || jsonb_array_length(v_baru) || ' sampel).');
    else
      update akun
         set wajah_descriptor = v_list,
             wajah_status     = 'aktif'
       where nis_nip = p_nis and tipe = 'murid';
      return json_build_object('status', 'success', 'message', 'Data wajah murid tersimpan (' || jsonb_array_length(v_list) || ' sampel).');
    end if;
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

-- ========== 3. DROP OVERLOAD LAMA + IZIN + RELOAD CACHE ==========
drop function if exists simpan_wajah_murid(text, jsonb, text, text, text);

grant execute on function simpan_wajah_murid(text, jsonb, text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';